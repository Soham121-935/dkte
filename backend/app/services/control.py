"""Deterministic environmental control service.

Rules (per device, evaluated on every accepted reading and on a periodic tick):

* Targets come from the active batch's cultivation profile stage, a batch
  override, a device override, or the global defaults – always with a source
  label.
* Heater, fan and humidifier use hysteresis bands and a minimum switching
  interval so that relays are not cycled rapidly.
* Safety interlocks (applied in every mode, with ``origin="safety"``):
    - stale or invalid temperature  -> heater OFF, humidifier OFF (safe state)
    - absolute maximum temperature  -> heater OFF, fan ON
    - maximum continuous heater runtime -> heater OFF + cooldown
    - device offline                -> no commands except nothing (device-side logic applies)
* Manual commands are validated against the same interlocks.
* The LLM never calls into this module; it may only produce recommendations
  that a human confirms through the manual command endpoint.

A command being sent does not prove the actuator switched.  Confirmation
comes from telemetry / command-status messages (see services.telemetry).
"""
from __future__ import annotations

import logging
import uuid
from dataclasses import asdict, dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..db.models import ActuatorCommand, CultivationBatch, Device, SensorReading
from ..iot.transport import TransportError, registry
from ..schemas.telemetry import ACTUATORS, CommandV1
from . import settings_store
from .telemetry import last_reading, log_event

log = logging.getLogger(__name__)

MODES = ("monitor", "auto", "manual")


@dataclass
class Decision:
    actuator: str
    desired: bool | None  # None = leave unchanged
    reason: str
    origin: str = "auto"  # auto|safety


@dataclass
class Evaluation:
    device_id: str
    mode: str
    evaluated_at: str
    targets: dict[str, Any]
    inputs: dict[str, Any]
    interlocks: list[str] = field(default_factory=list)
    decisions: list[dict[str, Any]] = field(default_factory=list)
    commands: list[str] = field(default_factory=list)
    notes: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


def _parse_dt(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        dt = datetime.fromisoformat(value)
    except ValueError:
        return None
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


# ---------------------------------------------------------------------- targets
def active_batch_for_device(db: Session, device_id: str) -> CultivationBatch | None:
    return db.execute(
        select(CultivationBatch)
        .where(CultivationBatch.device_id == device_id, CultivationBatch.status == "active")
        .order_by(CultivationBatch.started_at.desc().nullslast(), CultivationBatch.id.desc())
        .limit(1)
    ).scalar_one_or_none()


def stage_definition(profile_stages: list[dict[str, Any]], stage_key: str | None) -> dict[str, Any] | None:
    if not stage_key:
        return None
    for stage in profile_stages or []:
        if stage.get("key") == stage_key:
            return stage
    return None


def resolve_targets(db: Session, device: Device) -> dict[str, Any]:
    defaults = settings_store.get_section(db, "control_defaults")["default_targets"]
    result: dict[str, Any] = {**defaults, "source": "default", "source_label": "Global default targets",
                              "batch_id": None, "batch_code": None, "stage_key": None, "profile_name": None}
    batch = active_batch_for_device(db, device.id)
    if batch is not None:
        result.update({"batch_id": batch.id, "batch_code": batch.code, "stage_key": batch.current_stage_key})
        if batch.profile is not None:
            stage = stage_definition(batch.profile.stages, batch.current_stage_key)
            if stage and stage.get("targets"):
                result.update({k: v for k, v in stage["targets"].items() if v is not None or k not in result})
                result["source"] = "profile_reference" if batch.profile.source == "reference" else "profile_user"
                result["source_label"] = (
                    f"Profile '{batch.profile.name}' ({'reference ranges – verify for your strain' if batch.profile.source == 'reference' else 'user-defined'})"
                )
                result["profile_name"] = batch.profile.name
        overrides = (batch.target_overrides or {}).get(batch.current_stage_key or "", {})
        if overrides:
            result.update({k: v for k, v in overrides.items() if v is not None})
            result["source"] = "batch_override"
            result["source_label"] = f"Batch {batch.code} user override"
        return result
    device_targets = (device.control_config or {}).get("targets")
    if device_targets:
        result.update({k: v for k, v in device_targets.items() if v is not None})
        result["source"] = "device"
        result["source_label"] = "Device-level user targets"
    return result


def effective_config(db: Session, device: Device) -> dict[str, Any]:
    cfg = settings_store.get_section(db, "control_defaults")
    merged = {k: v for k, v in cfg.items() if k != "default_targets"}
    for k, v in (device.control_config or {}).items():
        if k != "targets" and v is not None:
            merged[k] = v
    return merged


# ------------------------------------------------------------------- evaluation
def _current_state(device: Device, actuator: str) -> tuple[bool | None, str]:
    entry = (device.actuator_state or {}).get(actuator, {})
    status = entry.get("status", "unknown")
    if entry.get("confirmed") is not None and status in ("confirmed", "mismatch"):
        return bool(entry["confirmed"]), status
    if entry.get("requested") is not None:
        return bool(entry["requested"]), "pending"
    return None, "unknown"


def evaluate(db: Session, device: Device, reading: SensorReading | None, now: datetime | None = None) -> Evaluation:
    now = now or datetime.now(timezone.utc)
    cfg = effective_config(db, device)
    targets = resolve_targets(db, device)
    mode = device.control_mode if device.control_mode in MODES else "monitor"
    if reading is None:
        reading = last_reading(db, device.id)

    temp = reading.temperature_c if reading is not None else None
    rh = reading.relative_humidity_percent if reading is not None else None
    measured_at = reading.measured_at if reading is not None else None
    temp_quality = (reading.quality or {}).get("temperature_c") if reading is not None else None
    rh_quality = (reading.quality or {}).get("relative_humidity_percent") if reading is not None else None
    stale = measured_at is None or (now - measured_at).total_seconds() > float(cfg["stale_sensor_timeout_seconds"])
    temp_valid = temp is not None and temp_quality in ("ok", "suspect") and not stale
    rh_valid = rh is not None and rh_quality in ("ok", "suspect") and not stale

    ev = Evaluation(
        device_id=device.id,
        mode=mode,
        evaluated_at=now.isoformat(),
        targets=targets,
        inputs={
            "temperature_c": temp,
            "relative_humidity_percent": rh,
            "measured_at": measured_at.isoformat() if measured_at else None,
            "stale": stale,
            "temperature_valid": temp_valid,
            "humidity_valid": rh_valid,
            "device_online": device.connection_status == "online",
        },
    )

    heater_state, heater_status = _current_state(device, "heater")
    fan_state, _ = _current_state(device, "fan")
    hum_state, _ = _current_state(device, "humidifier")
    heater_entry = (device.actuator_state or {}).get("heater", {})
    cooldown_until = _parse_dt(heater_entry.get("cooldown_until"))

    decisions: list[Decision] = []
    device_online = device.connection_status == "online"

    # ----------------------------------------------------------- interlocks
    heater_blocked_reason: str | None = None
    if not temp_valid:
        ev.interlocks.append("stale_or_invalid_temperature")
        heater_blocked_reason = "temperature reading stale/invalid – automatic heating disabled (safe state)"
        if device_online and (heater_state or heater_status == "unknown"):
            decisions.append(Decision("heater", False, heater_blocked_reason, "safety"))
        if device_online and hum_state:
            decisions.append(Decision("humidifier", False, "sensor data stale/invalid – humidifier set to safe state", "safety"))
    if temp_valid and temp is not None and temp >= float(cfg["heater_absolute_max_temp_c"]):
        ev.interlocks.append("absolute_max_temperature")
        heater_blocked_reason = f"temperature {temp:.1f}°C ≥ absolute cutoff {cfg['heater_absolute_max_temp_c']}°C"
        if heater_state is not False:
            decisions.append(Decision("heater", False, heater_blocked_reason, "safety"))
        if fan_state is not True:
            decisions.append(Decision("fan", True, "absolute temperature cutoff – ventilating", "safety"))
    if heater_state and heater_entry.get("since"):
        since = _parse_dt(heater_entry.get("since"))
        if since and (now - since).total_seconds() > float(cfg["heater_max_runtime_seconds"]):
            ev.interlocks.append("heater_max_runtime")
            heater_blocked_reason = f"heater on continuously for >{int(cfg['heater_max_runtime_seconds']) // 60} min – forced off for cooldown"
            decisions.append(Decision("heater", False, heater_blocked_reason, "safety"))
            heater_entry = dict(heater_entry)
            heater_entry["cooldown_until"] = (now + timedelta(seconds=float(cfg["heater_cooldown_seconds"]))).isoformat()
            state = dict(device.actuator_state or {})
            state["heater"] = heater_entry
            device.actuator_state = state
            cooldown_until = _parse_dt(heater_entry["cooldown_until"])
    if cooldown_until and cooldown_until > now:
        ev.interlocks.append("heater_cooldown")
        heater_blocked_reason = heater_blocked_reason or f"heater cooldown active until {cooldown_until.strftime('%H:%M:%S')} UTC"

    # --------------------------------------------------------- auto control
    if mode == "auto" and device.connection_status == "online":
        t_min = float(targets["temperature_min_c"])
        t_max = float(targets["temperature_max_c"])
        rh_min = float(targets["humidity_min_percent"])
        rh_max = float(targets["humidity_max_percent"])
        hyst_t = float(cfg["hysteresis_temp_c"])
        hyst_rh = float(cfg["hysteresis_rh"])

        # heater
        if temp_valid and heater_blocked_reason is None and temp is not None:
            if temp < t_min and heater_state is not True:
                decisions.append(Decision("heater", True, f"temperature {temp:.1f}°C below target minimum {t_min:.1f}°C"))
            elif temp >= t_min + hyst_t and heater_state is not False:
                decisions.append(Decision("heater", False, f"temperature {temp:.1f}°C reached {t_min + hyst_t:.1f}°C (min + hysteresis)"))
            elif heater_state is True:
                ev.notes.append(f"heater remains on: {temp:.1f}°C is inside hysteresis band [{t_min:.1f}, {t_min + hyst_t:.1f}]°C")
        elif heater_blocked_reason and heater_state is not True:
            ev.notes.append(f"heater held off: {heater_blocked_reason}")

        # fan: cooling, venting, fresh-air exchange cycle. Each reason keeps its own
        # hysteresis latch so e.g. an FAE burst cannot leave the fan stuck on.
        fae_cycle = float(targets.get("fae_cycle_minutes") or 0)
        fae_duration = float(targets.get("fae_duration_minutes") or 0)
        fae_active = False
        if fae_cycle > 0 and fae_duration > 0:
            minute_of_cycle = (now.timestamp() / 60.0) % fae_cycle
            fae_active = minute_of_cycle < fae_duration
        latches = dict((device.control_state or {}).get("latches", {}))
        cooling = bool(latches.get("fan_cooling"))
        venting = bool(latches.get("fan_venting"))
        if temp_valid and temp is not None:
            if temp > t_max:
                cooling = True
            elif temp <= t_max - hyst_t:
                cooling = False
        else:
            cooling = False
        if rh_valid and rh is not None:
            if rh > rh_max:
                venting = True
            elif rh <= rh_max - hyst_rh:
                venting = False
        else:
            venting = False
        latches.update({"fan_cooling": cooling, "fan_venting": venting, "fae_active": fae_active})
        state = dict(device.control_state or {})
        state["latches"] = latches
        device.control_state = state
        venting_needed = venting
        if "absolute_max_temperature" not in ev.interlocks:
            fan_wanted = cooling or venting or fae_active
            if fan_wanted and fan_state is not True:
                why = []
                if cooling:
                    why.append(f"temperature {temp:.1f}°C above maximum {t_max:.1f}°C (fan can only approach ambient)")
                if venting:
                    why.append(f"humidity {rh:.0f}% above maximum {rh_max:.0f}%")
                if fae_active:
                    why.append("scheduled fresh-air exchange")
                decisions.append(Decision("fan", True, "; ".join(why)))
            elif not fan_wanted and fan_state is True:
                decisions.append(Decision("fan", False, "no cooling, venting or fresh-air exchange required (hysteresis satisfied)"))
            elif fan_wanted and fan_state is True:
                ev.notes.append("fan remains on: " + ", ".join(k for k, v in (("cooling", cooling), ("venting", venting), ("fresh-air exchange", fae_active)) if v))

        # humidifier
        if not rh_valid:
            if hum_state is not False:
                decisions.append(Decision("humidifier", False, "humidity reading unavailable – humidifier off (no feedback)", "safety"))
                if "stale_or_invalid_humidity" not in ev.interlocks:
                    ev.interlocks.append("stale_or_invalid_humidity")
        elif rh is not None:
            if rh < rh_min and hum_state is not True and not venting_needed:
                decisions.append(Decision("humidifier", True, f"humidity {rh:.0f}% below target minimum {rh_min:.0f}%"))
            elif (rh >= rh_min + hyst_rh or venting_needed) and hum_state is not False:
                decisions.append(Decision("humidifier", False, f"humidity {rh:.0f}% reached {rh_min + hyst_rh:.0f}% (min + hysteresis)"))
    elif mode == "auto":
        ev.notes.append("device offline – no automatic commands issued; device-side safety logic applies")
    elif mode == "manual":
        ev.notes.append("manual mode – only safety interlocks are applied automatically")
    else:
        ev.notes.append("monitoring only – no automatic actuation; safety interlocks still apply")

    # de-duplicate: later safety decisions take precedence per actuator
    final: dict[str, Decision] = {}
    for d in decisions:
        if d.actuator in final and final[d.actuator].origin == "safety" and d.origin != "safety":
            continue
        final[d.actuator] = d
    ev.decisions = [asdict(d) for d in final.values()]
    return ev


# --------------------------------------------------------------------- commands
def _last_command_time(device: Device, actuator: str) -> datetime | None:
    return _parse_dt((device.actuator_state or {}).get(actuator, {}).get("requested_at"))


def issue_command(
    db: Session,
    device: Device,
    actuator: str,
    state: bool,
    *,
    reason: str,
    origin: str,
    requested_by: str = "control_service",
    now: datetime | None = None,
    enforce_interval: bool = True,
) -> ActuatorCommand:
    """Validate, persist and dispatch an actuator command."""
    now = now or datetime.now(timezone.utc)
    cfg = effective_config(db, device)
    validation: dict[str, Any] = {"checks": []}
    cmd = ActuatorCommand(
        command_id=uuid.uuid4().hex,
        device_id=device.id,
        actuator=actuator,
        requested_state=state,
        reason=reason,
        origin=origin,
        requested_by=requested_by,
        control_mode=device.control_mode,
        created_at=now,
    )

    def reject(msg: str) -> ActuatorCommand:
        cmd.status = "rejected"
        cmd.error = msg
        validation["result"] = "rejected"
        cmd.validation = validation
        db.add(cmd)
        log_event(db, "control", f"command rejected ({actuator}->{'ON' if state else 'OFF'}): {msg}",
                  level="warning", device_id=device.id, data={"origin": origin, "requested_by": requested_by})
        db.flush()
        return cmd

    if actuator not in ACTUATORS:
        return reject(f"unknown actuator '{actuator}'")
    if not device.is_enabled:
        return reject("device is disabled")
    if device.connection_status != "online":
        return reject("device is offline – command would not be delivered (device-side safety logic applies)")
    if origin != "safety" and enforce_interval:
        last = _last_command_time(device, actuator)
        min_interval = float(cfg["min_switch_interval_seconds"])
        if last and (now - last).total_seconds() < min_interval:
            return reject(f"minimum switching interval of {int(min_interval)}s not elapsed for {actuator}")
        validation["checks"].append("min_switch_interval")
    if state and actuator == "heater" and origin != "safety":
        reading = last_reading(db, device.id)
        stale_timeout = float(cfg["stale_sensor_timeout_seconds"])
        if reading is None or reading.temperature_c is None or (now - reading.measured_at).total_seconds() > stale_timeout:
            return reject("heater cannot be switched on without a fresh valid temperature reading")
        if reading.temperature_c >= float(cfg["heater_absolute_max_temp_c"]):
            return reject(f"temperature {reading.temperature_c:.1f}°C is at/above the absolute cutoff")
        cooldown_until = _parse_dt((device.actuator_state or {}).get("heater", {}).get("cooldown_until"))
        if cooldown_until and cooldown_until > now:
            return reject("heater is in cooldown after reaching its maximum runtime")
        validation["checks"].extend(["fresh_temperature", "absolute_max", "cooldown"])
    if state and actuator == "humidifier" and origin == "manual":
        reading = last_reading(db, device.id)
        if reading is None or reading.relative_humidity_percent is None:
            validation["warnings"] = ["no humidity feedback available"]

    validation["result"] = "accepted"
    cmd.validation = validation
    db.add(cmd)

    state_map = dict(device.actuator_state or {})
    entry = dict(state_map.get(actuator, {}))
    entry.update({"requested": state, "requested_at": now.isoformat(), "requested_by": requested_by,
                  "last_reason": reason, "last_origin": origin, "last_command_id": cmd.command_id})
    if entry.get("confirmed") != state:
        entry["status"] = "pending"
    state_map[actuator] = entry
    device.actuator_state = state_map

    message = CommandV1(command_id=cmd.command_id, device_id=device.id, actuator=actuator, state=state,
                        origin=origin, reason=reason, timestamp=now)  # type: ignore[arg-type]
    try:
        result = registry.for_device(device).send_command(device, message)
        cmd.status = "sent" if result == "sent" else "pending"
        cmd.sent_at = now if result == "sent" else None
    except TransportError as exc:
        cmd.status = "failed"
        cmd.error = str(exc)
        entry["status"] = "unknown"
        state_map[actuator] = entry
        device.actuator_state = state_map
        log_event(db, "control", f"command dispatch failed: {exc}", level="error", device_id=device.id,
                  data={"command_id": cmd.command_id})
    db.flush()
    return cmd


def apply_evaluation(db: Session, device: Device, ev: Evaluation, now: datetime | None = None) -> list[ActuatorCommand]:
    now = now or datetime.now(timezone.utc)
    commands: list[ActuatorCommand] = []
    for d in ev.decisions:
        if d["desired"] is None:
            continue
        current, _ = _current_state(device, d["actuator"])
        entry = (device.actuator_state or {}).get(d["actuator"], {})
        if current == d["desired"] and entry.get("requested") == d["desired"] and entry.get("status") != "unknown":
            continue
        last_requested_at = _parse_dt(entry.get("requested_at"))
        if (entry.get("requested") == d["desired"] and last_requested_at is not None
                and (now - last_requested_at).total_seconds() < 30 and entry.get("status") in ("pending", "unknown", "mismatch")):
            ev.notes.append(f"{d['actuator']} -> {'ON' if d['desired'] else 'OFF'} already requested {int((now - last_requested_at).total_seconds())}s ago; waiting for confirmation")
            continue
        if d["origin"] != "safety":
            # Do not create a rejected command record every tick while the
            # minimum switching interval is still running – just note it.
            last = _last_command_time(device, d["actuator"])
            min_interval = float(effective_config(db, device)["min_switch_interval_seconds"])
            if last is not None and (now - last).total_seconds() < min_interval:
                remaining = int(min_interval - (now - last).total_seconds())
                ev.notes.append(f"{d['actuator']} -> {'ON' if d['desired'] else 'OFF'} deferred: minimum switching interval ({remaining}s remaining)")
                continue
        cmd = issue_command(db, device, d["actuator"], bool(d["desired"]), reason=d["reason"], origin=d["origin"], now=now)
        commands.append(cmd)
        ev.commands.append(f"{d['actuator']}->{'ON' if d['desired'] else 'OFF'} [{cmd.status}]")
    state = dict(device.control_state or {})
    state["last_evaluation"] = ev.to_dict()
    device.control_state = state
    db.flush()
    return commands


def run_for_device(db: Session, device: Device, reading: SensorReading | None = None, now: datetime | None = None) -> Evaluation:
    ev = evaluate(db, device, reading, now)
    apply_evaluation(db, device, ev, now)
    return ev


def expire_commands(db: Session, timeout_seconds: float, now: datetime | None = None) -> list[ActuatorCommand]:
    now = now or datetime.now(timezone.utc)
    cutoff = now - timedelta(seconds=timeout_seconds)
    expired = db.execute(
        select(ActuatorCommand).where(ActuatorCommand.status.in_(("pending", "sent")), ActuatorCommand.created_at < cutoff)
    ).scalars().all()
    for cmd in expired:
        cmd.status = "timeout"
        cmd.error = f"no confirmation within {int(timeout_seconds)}s"
        device = db.get(Device, cmd.device_id)
        if device is not None:
            state = dict(device.actuator_state or {})
            entry = dict(state.get(cmd.actuator, {}))
            if entry.get("last_command_id") == cmd.command_id:
                entry["status"] = "unknown" if entry.get("confirmed") is None else "mismatch"
            state[cmd.actuator] = entry
            device.actuator_state = state
        log_event(db, "control", f"command {cmd.command_id} ({cmd.actuator}) timed out without confirmation",
                  level="warning", device_id=cmd.device_id, data={"command_id": cmd.command_id})
    db.flush()
    return expired


def reconcile_after_restart(db: Session, now: datetime | None = None) -> int:
    """Commands that were still awaiting confirmation when the server stopped can
    no longer be matched reliably: mark them 'unknown' (not failed) and flag the
    actuator state as unknown until the device reports again."""
    now = now or datetime.now(timezone.utc)
    pending = db.execute(select(ActuatorCommand).where(ActuatorCommand.status.in_(("pending", "sent")))).scalars().all()
    for cmd in pending:
        cmd.status = "unknown"
        cmd.error = "server restarted before a confirmation was received"
        device = db.get(Device, cmd.device_id)
        if device is not None:
            state = dict(device.actuator_state or {})
            entry = dict(state.get(cmd.actuator, {}))
            if entry.get("last_command_id") == cmd.command_id:
                entry["status"] = "unknown"
            state[cmd.actuator] = entry
            device.actuator_state = state
        log_event(db, "control", f"command {cmd.command_id} ({cmd.actuator}) outcome unknown: server restarted",
                  level="info", device_id=cmd.device_id, data={"command_id": cmd.command_id})
    db.flush()
    return len(pending)


def set_mode(db: Session, device: Device, mode: str, actor: str, now: datetime | None = None) -> Device:
    """Change the control mode.

    Leaving an actuating mode (``auto``/``manual``) while the heater is on would
    leave a bulb burning with nobody in charge of it, so the heater is returned to
    its safe state (OFF) with a ``safety`` command. Fan and humidifier keep their
    state – they are harmless when left running and the operator may want them on.
    """
    if mode not in MODES:
        raise ValueError(f"invalid mode '{mode}'")
    now = now or datetime.now(timezone.utc)
    previous = device.control_mode
    device.control_mode = mode
    log_event(db, "control", f"control mode changed {previous} -> {mode} by {actor}", device_id=device.id)
    if previous != mode and previous in ("auto", "manual"):
        heater_on, _ = _current_state(device, "heater")
        if heater_on and device.connection_status == "online":
            issue_command(db, device, "heater", False, reason=f"control mode changed {previous} -> {mode}; heater returned to safe state",
                          origin="safety", requested_by=actor, now=now)
    db.flush()
    return device
