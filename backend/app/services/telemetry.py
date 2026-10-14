"""Telemetry ingest pipeline shared by every transport (simulator, MQTT, HTTP).

    payload -> parse -> device lookup -> validation -> append reading
            -> update device + actuator confirmations -> publish events
            -> alert evaluation -> control decision
"""
from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..core.events import bus
from ..db.models import ActuatorCommand, ActuatorStatusEvent, Device, SensorReading, SystemEvent
from ..schemas.telemetry import ACTUATORS, CommandStatusV1, DeviceStatusV1, TelemetryV1
from . import settings_store
from .validation import MessageRejected, ValidatedTelemetry, parse_telemetry, validate_telemetry

log = logging.getLogger(__name__)


# --------------------------------------------------------------------------- helpers
def reading_to_dict(r: SensorReading) -> dict[str, Any]:
    return {
        "id": r.id,
        "device_id": r.device_id,
        "measured_at": r.measured_at.isoformat(),
        "received_at": r.received_at.isoformat() if r.received_at else None,
        "message_id": r.message_id,
        "schema_version": r.schema_version,
        "source": r.source,
        "temperature_c": r.temperature_c,
        "relative_humidity_percent": r.relative_humidity_percent,
        "substrate_moisture_raw": r.substrate_moisture_raw,
        "fan_state": r.fan_state,
        "heater_state": r.heater_state,
        "humidifier_state": r.humidifier_state,
        "quality": r.quality or {},
    }


def device_to_dict(d: Device) -> dict[str, Any]:
    return {
        "id": d.id,
        "name": d.name,
        "kind": d.kind,
        "transport": d.transport,
        "firmware_version": d.firmware_version,
        "hardware_notes": d.hardware_notes,
        "is_enabled": d.is_enabled,
        "has_token": bool(d.token_hash),
        "connection_status": d.connection_status,
        "last_seen_at": d.last_seen_at.isoformat() if d.last_seen_at else None,
        "last_telemetry_at": d.last_telemetry_at.isoformat() if d.last_telemetry_at else None,
        "control_mode": d.control_mode,
        "control_config": d.control_config or {},
        "control_state": d.control_state or {},
        "actuator_state": d.actuator_state or {},
        "stats": d.stats or {},
        "created_at": d.created_at.isoformat() if d.created_at else None,
    }


def log_event(
    db: Session,
    category: str,
    message: str,
    *,
    level: str = "info",
    device_id: str | None = None,
    data: dict[str, Any] | None = None,
) -> SystemEvent:
    ev = SystemEvent(category=category, level=level, message=message, device_id=device_id, data=data)
    db.add(ev)
    return ev


def _bump_stat(device: Device, key: str, inc: int = 1) -> None:
    stats = dict(device.stats or {})
    stats[key] = int(stats.get(key, 0)) + inc
    device.stats = stats


def last_reading(db: Session, device_id: str) -> SensorReading | None:
    return db.execute(
        select(SensorReading).where(SensorReading.device_id == device_id).order_by(SensorReading.measured_at.desc()).limit(1)
    ).scalar_one_or_none()


# ------------------------------------------------------------------- actuator state
def _update_actuator_states(
    db: Session, device: Device, message: TelemetryV1, measured_at: datetime, source_tag: str
) -> list[dict[str, Any]]:
    """Update confirmed actuator state from telemetry; confirm matching pending commands."""
    state = dict(device.actuator_state or {})
    changes: list[dict[str, Any]] = []
    for actuator in ACTUATORS:
        reported = getattr(message, f"{actuator}_state")
        entry = dict(state.get(actuator, {}))
        if reported is None:
            entry["status"] = "unknown"
            state[actuator] = entry
            continue
        previous = entry.get("confirmed")
        entry["confirmed"] = reported
        entry["confirmed_at"] = measured_at.isoformat()
        if previous != reported or not entry.get("since"):
            entry["since"] = measured_at.isoformat()
        requested = entry.get("requested")
        if requested is None or requested == reported:
            entry["status"] = "confirmed"
        else:
            # Device reports something different from what we asked for.
            requested_at = entry.get("requested_at")
            try:
                req_dt = datetime.fromisoformat(requested_at) if requested_at else None
            except ValueError:
                req_dt = None
            grace = timedelta(seconds=15)
            if req_dt and measured_at - req_dt < grace:
                entry["status"] = "pending"
            else:
                entry["status"] = "mismatch"
        state[actuator] = entry
        if previous != reported:
            db.add(
                ActuatorStatusEvent(
                    device_id=device.id, actuator=actuator, state=reported, observed_at=measured_at, source=source_tag
                )
            )
            changes.append({"actuator": actuator, "state": reported})
        # confirm pending commands that match the observed state
        pending = db.execute(
            select(ActuatorCommand)
            .where(
                ActuatorCommand.device_id == device.id,
                ActuatorCommand.actuator == actuator,
                ActuatorCommand.status.in_(("pending", "sent")),
            )
            .order_by(ActuatorCommand.created_at.desc())
        ).scalars().all()
        for cmd in pending:
            if cmd.requested_state == reported:
                cmd.status = "confirmed"
                cmd.result_state = reported
                cmd.confirmed_at = measured_at
    device.actuator_state = state
    return changes


# --------------------------------------------------------------------------- ingest
def ingest_telemetry(
    db: Session,
    payload: Any,
    *,
    transport: str,
    device: Device | None = None,
    now: datetime | None = None,
) -> SensorReading:
    """Validate and persist one telemetry message.

    Raises ``MessageRejected`` for anything that must not be stored.  The caller
    is responsible for committing the session; events are queued on the bus
    via ``publish_reading_events`` after commit.
    """
    now = now or datetime.now(timezone.utc)
    message = parse_telemetry(payload)

    if device is None:
        device = db.get(Device, message.device_id)
    if device is None:
        log_event(db, "validation", f"telemetry from unregistered device '{message.device_id}' rejected",
                  level="warning", device_id=message.device_id, data={"transport": transport})
        raise MessageRejected(f"unknown device '{message.device_id}'", "unknown_device")
    if device.id != message.device_id:
        _bump_stat(device, "messages_rejected")
        log_event(db, "validation", "device_id in payload does not match authenticated device", level="warning",
                  device_id=device.id, data={"payload_device_id": message.device_id, "transport": transport})
        raise MessageRejected("device_id mismatch", "device_mismatch")
    if not device.is_enabled:
        _bump_stat(device, "messages_rejected")
        raise MessageRejected(f"device '{device.id}' is disabled", "device_disabled")

    # The server – not the payload – decides whether data is simulated.
    source = "simulation" if device.kind == "simulated" else "hardware"

    dup = db.execute(
        select(SensorReading.id).where(SensorReading.device_id == device.id, SensorReading.message_id == message.message_id)
    ).first()
    if dup:
        _bump_stat(device, "messages_duplicate")
        raise MessageRejected(f"duplicate message_id {message.message_id}", "duplicate")

    rules = settings_store.get_section(db, "validation")
    prev = last_reading(db, device.id)
    previous = None
    if prev is not None:
        previous = {
            "measured_at": prev.measured_at,
            "temperature_c": prev.temperature_c,
            "relative_humidity_percent": prev.relative_humidity_percent,
            "substrate_moisture_raw": prev.substrate_moisture_raw,
        }
    try:
        validated: ValidatedTelemetry = validate_telemetry(message, rules, previous=previous, now=now)
    except MessageRejected as exc:
        _bump_stat(device, "messages_rejected")
        log_event(db, "validation", f"telemetry rejected: {exc.reason}", level="warning", device_id=device.id,
                  data={"code": exc.code, "transport": transport, **exc.details})
        device.last_seen_at = now
        raise

    reading = SensorReading(
        device_id=device.id,
        measured_at=validated.measured_at,
        received_at=now,
        message_id=message.message_id,
        schema_version=message.schema_version,
        source=source,
        temperature_c=validated.values["temperature_c"],
        relative_humidity_percent=validated.values["relative_humidity_percent"],
        substrate_moisture_raw=validated.values["substrate_moisture_raw"],
        fan_state=message.fan_state,
        heater_state=message.heater_state,
        humidifier_state=message.humidifier_state,
        quality={**validated.quality, "warnings": validated.warnings, "transport": transport},
        raw=payload if isinstance(payload, dict) else None,
    )
    db.add(reading)

    if validated.warnings:
        _bump_stat(device, "field_warnings", len(validated.warnings))
    _bump_stat(device, "messages_accepted")
    was_offline = device.connection_status != "online"
    device.connection_status = "online"
    device.last_seen_at = now
    device.last_telemetry_at = validated.measured_at
    if message.firmware_version:
        device.firmware_version = message.firmware_version
    actuator_changes = _update_actuator_states(db, device, message, validated.measured_at, "simulation" if source == "simulation" else "telemetry")
    if was_offline:
        log_event(db, "connection", f"device {device.id} is online ({transport})", device_id=device.id)
    db.flush()
    reading._events = {  # type: ignore[attr-defined]
        "device_status_changed": was_offline,
        "actuator_changes": actuator_changes,
        "device": device_to_dict(device),
    }
    return reading


async def publish_reading_events(reading: SensorReading) -> None:
    meta = getattr(reading, "_events", {}) or {}
    await bus.publish("telemetry", {"reading": reading_to_dict(reading), "device": meta.get("device")})
    if meta.get("device_status_changed"):
        await bus.publish("device_status", {"device": meta.get("device")})
    for change in meta.get("actuator_changes", []):
        await bus.publish("actuator_status", {"device_id": reading.device_id, **change, "device": meta.get("device")})


# -------------------------------------------------------------------- command status
def record_command_status(db: Session, payload: Any, *, device: Device | None = None) -> ActuatorCommand | None:
    status = CommandStatusV1.model_validate(payload)
    if device is None:
        device = db.get(Device, status.device_id)
    if device is None or device.id != status.device_id:
        raise MessageRejected("unknown device in command status", "unknown_device")
    cmd = db.execute(select(ActuatorCommand).where(ActuatorCommand.command_id == status.command_id)).scalar_one_or_none()
    now = datetime.now(timezone.utc)
    observed = status.timestamp or now
    if cmd is None:
        log_event(db, "control", f"command-status for unknown command {status.command_id}", level="warning", device_id=device.id)
        return None
    if status.status == "applied":
        cmd.status = "confirmed"
        cmd.result_state = status.result_state if status.result_state is not None else status.requested_state
        cmd.confirmed_at = observed
    else:
        cmd.status = "failed"
        cmd.result_state = status.result_state
        cmd.error = status.error or status.status
    state = dict(device.actuator_state or {})
    entry = dict(state.get(status.actuator, {}))
    if status.result_state is not None:
        prev = entry.get("confirmed")
        entry["confirmed"] = status.result_state
        entry["confirmed_at"] = observed.isoformat()
        if prev != status.result_state or not entry.get("since"):
            entry["since"] = observed.isoformat()
        entry["status"] = "confirmed" if status.result_state == entry.get("requested", status.result_state) else "mismatch"
        if prev != status.result_state:
            db.add(ActuatorStatusEvent(device_id=device.id, actuator=status.actuator, state=status.result_state,
                                       observed_at=observed, source="command_status", command_id=status.command_id))
    elif status.status != "applied":
        entry["status"] = "unknown"
    state[status.actuator] = entry
    device.actuator_state = state
    device.last_seen_at = now
    if status.status != "applied":
        log_event(db, "control", f"command {status.command_id} ({status.actuator}) {status.status}: {status.error or ''}",
                  level="warning", device_id=device.id, data={"command_id": status.command_id})
    db.flush()
    return cmd


def handle_device_status(db: Session, payload: Any) -> Device | None:
    status = DeviceStatusV1.model_validate(payload)
    device = db.get(Device, status.device_id)
    if device is None:
        return None
    now = datetime.now(timezone.utc)
    changed = device.connection_status != status.status
    device.connection_status = status.status
    device.last_seen_at = now
    if status.firmware_version:
        device.firmware_version = status.firmware_version
    if changed:
        log_event(db, "connection", f"device {device.id} reported {status.status}", device_id=device.id,
                  data={"ip": status.ip, "rssi_dbm": status.rssi_dbm})
    if status.status == "offline":
        state = dict(device.actuator_state or {})
        for actuator in ACTUATORS:
            entry = dict(state.get(actuator, {}))
            entry["status"] = "unknown"
            state[actuator] = entry
        device.actuator_state = state
    db.flush()
    return device


def mark_offline_devices(db: Session, offline_after_seconds: int, now: datetime | None = None) -> list[Device]:
    """Mark devices offline when no telemetry/status has arrived for a while."""
    now = now or datetime.now(timezone.utc)
    changed: list[Device] = []
    for device in db.execute(select(Device)).scalars():
        if device.connection_status != "online":
            continue
        last = device.last_seen_at
        if last is None or (now - last).total_seconds() > offline_after_seconds:
            device.connection_status = "offline"
            state = dict(device.actuator_state or {})
            for actuator in ACTUATORS:
                entry = dict(state.get(actuator, {}))
                entry["status"] = "unknown"
                state[actuator] = entry
            device.actuator_state = state
            log_event(db, "connection", f"device {device.id} marked offline (no data for >{offline_after_seconds}s)",
                      level="warning", device_id=device.id)
            changed.append(device)
    db.flush()
    return changed
