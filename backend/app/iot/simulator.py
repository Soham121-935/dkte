"""Hardware simulator.

Produces explicitly *simulated* telemetry using the same ``TelemetryV1``
schema the ESP32 publishes, and implements the ``simulator`` transport so
the control service can command it like a real device.  The physics are a
simple lumped model: the chamber relaxes towards ambient, the heater adds
heat, the fan increases exchange with ambient air, the humidifier adds
moisture to the air and the substrate dries slowly.

Scenarios let the user demonstrate alerts and safety behaviour:
``high_temperature``, ``low_humidity``, ``sensor_fault``, ``device_offline``,
``actuator_failure``, ``watering`` and ``recover``.
"""
from __future__ import annotations

import asyncio
import logging
import math
import random
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any, Callable

from ..config import get_settings
from ..core.events import bus
from ..db.models import Device
from ..schemas.telemetry import CommandV1
from .transport import TransportError, registry

log = logging.getLogger(__name__)

SCENARIOS = {
    "high_temperature": "Ambient heat wave: chamber drifts above the target maximum even with the fan running.",
    "low_humidity": "Humidifier reservoir empty: humidity falls although the humidifier reports ON.",
    "sensor_fault": "DHT11 read failures: temperature/humidity reported as sensor errors.",
    "device_offline": "Device stops publishing telemetry (network/power loss).",
    "actuator_failure": "Relay fault: commands are acknowledged as failed and states do not change.",
    "watering": "Substrate watered: moisture reading rises sharply.",
    "recover": "Clear all active scenarios and resume normal operation.",
}


@dataclass
class SimState:
    temperature_c: float = 19.5
    relative_humidity_percent: float = 70.0
    substrate_moisture_raw: float = 2300.0
    ambient_temperature_c: float = 18.5
    ambient_humidity_percent: float = 55.0
    fan: bool = False
    heater: bool = False
    humidifier: bool = False
    scenarios: dict[str, datetime | None] = field(default_factory=dict)  # name -> expiry
    humidifier_effective: bool = True


class ChamberModel:
    """Lumped thermal/humidity model stepped with ``dt`` seconds."""

    def __init__(self, state: SimState | None = None, seed: int | None = None) -> None:
        self.state = state or SimState()
        self.rng = random.Random(seed)

    def ambient(self, t: datetime) -> tuple[float, float]:
        s = self.state
        hour = t.hour + t.minute / 60.0
        diurnal = math.sin((hour - 9.0) / 24.0 * 2 * math.pi)
        temp = s.ambient_temperature_c + 1.2 * diurnal
        rh = s.ambient_humidity_percent - 5.0 * diurnal
        if self.active("high_temperature"):
            temp += 11.0
        if self.active("low_humidity"):
            rh -= 20.0
        return temp, rh

    def active(self, name: str) -> bool:
        return name in self.state.scenarios

    def step(self, dt: float, now: datetime) -> None:
        s = self.state
        amb_t, amb_rh = self.ambient(now)
        # thermal
        k_loss = 1.0 / 2400.0
        k_fan = 1.0 / 360.0
        heater_power = 0.0032  # °C per second (≈1.9 °C / 10 min)
        dT = k_loss * (amb_t - s.temperature_c)
        if s.fan:
            dT += k_fan * (amb_t - s.temperature_c)
        if s.heater:
            dT += heater_power
        s.temperature_c += dT * dt + self.rng.gauss(0, 0.004) * math.sqrt(dt)
        # humidity
        k_rh = 1.0 / 3600.0  # closed bucket loses humidity slowly
        k_fan_rh = 1.0 / 900.0
        hum_rate = 0.25  # %RH per second at 0 % RH, tapering towards saturation
        dRH = k_rh * (amb_rh - s.relative_humidity_percent)
        if s.fan:
            dRH += k_fan_rh * (amb_rh - s.relative_humidity_percent)
        if s.humidifier and s.humidifier_effective and not self.active("low_humidity"):
            dRH += hum_rate * (1.0 - s.relative_humidity_percent / 100.0)
        if s.heater:
            dRH -= 0.004
        dRH += 0.0008 * (s.substrate_moisture_raw / 4095.0)  # substrate evaporation
        s.relative_humidity_percent += dRH * dt + self.rng.gauss(0, 0.03) * math.sqrt(dt)
        # substrate moisture (raw ADC-like units)
        dM = -0.0006  # baseline drying per second (≈ -2 raw/hour)
        if s.heater:
            dM -= 0.0008
        if s.fan:
            dM -= 0.0004
        if s.humidifier and s.relative_humidity_percent > 85:
            dM += 0.0010
        s.substrate_moisture_raw += dM * dt
        if self.active("watering"):
            s.substrate_moisture_raw += 600.0
            s.scenarios.pop("watering", None)
        # clamp
        s.temperature_c = max(2.0, min(48.0, s.temperature_c))
        s.relative_humidity_percent = max(15.0, min(100.0, s.relative_humidity_percent))
        s.substrate_moisture_raw = max(0.0, min(4095.0, s.substrate_moisture_raw))
        # expire scenarios
        for name, expiry in list(s.scenarios.items()):
            if expiry is not None and now >= expiry:
                s.scenarios.pop(name, None)

    def sample(self, now: datetime, device_id: str, firmware: str = "sim-1.0.0") -> dict[str, Any]:
        """Build a TelemetryV1 payload with DHT11-like quantisation (0.1 °C / 0.1 % steps)."""
        s = self.state
        payload: dict[str, Any] = {
            "schema_version": 1,
            "device_id": device_id,
            "message_id": uuid.uuid4().hex,
            "timestamp": now.isoformat(),
            "uptime_ms": int((now.timestamp() % 86400) * 1000),
            "fan_state": s.fan,
            "heater_state": s.heater,
            "humidifier_state": s.humidifier,
            "firmware_version": firmware,
            "source": "simulation",
            "rssi_dbm": -55 + int(self.rng.gauss(0, 3)),
            "sensor_errors": [],
        }
        if self.active("sensor_fault"):
            payload["temperature_c"] = None
            payload["relative_humidity_percent"] = None
            payload["sensor_errors"] = ["dht11_read_failed"]
        else:
            payload["temperature_c"] = round(s.temperature_c + self.rng.gauss(0, 0.15), 1)
            payload["relative_humidity_percent"] = round(min(100.0, s.relative_humidity_percent + self.rng.gauss(0, 0.6)), 1)
        payload["substrate_moisture_raw"] = int(round(s.substrate_moisture_raw + self.rng.gauss(0, 6)))
        return payload


# ------------------------------------------------------------------ service
class SimulatorService:
    name = "simulator"

    def __init__(self) -> None:
        settings = get_settings()
        self.device_id = settings.simulator_device_id
        self.interval = settings.simulator_interval_seconds
        self.model = ChamberModel(seed=42)
        self._task: asyncio.Task | None = None
        self._running = False
        self.last_published_at: datetime | None = None
        self._pending_commands: list[CommandV1] = []
        self.messages_sent = 0
        self.started_at: datetime | None = None

    # -- transport interface ---------------------------------------------------
    def send_command(self, device: Device, command: CommandV1) -> str:
        if not self._running:
            raise TransportError("simulator is not running")
        if self.model.active("device_offline"):
            raise TransportError("simulated device is offline")
        self._pending_commands.append(command)
        return "sent"

    def status(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "available": self._running,
            "detail": "in-process hardware simulator",
            "device_id": self.device_id,
            "interval_seconds": self.interval,
            "scenarios": {k: (v.isoformat() if v else None) for k, v in self.model.state.scenarios.items()},
            "last_published_at": self.last_published_at.isoformat() if self.last_published_at else None,
            "messages_sent": self.messages_sent,
            "started_at": self.started_at.isoformat() if self.started_at else None,
            "state": {
                "temperature_c": round(self.model.state.temperature_c, 2),
                "relative_humidity_percent": round(self.model.state.relative_humidity_percent, 2),
                "substrate_moisture_raw": round(self.model.state.substrate_moisture_raw),
                "ambient_temperature_c": round(self.model.ambient(datetime.now(timezone.utc))[0], 2),
                "fan": self.model.state.fan, "heater": self.model.state.heater, "humidifier": self.model.state.humidifier,
            },
        }

    # -- scenarios -------------------------------------------------------------
    def trigger(self, scenario: str, duration_minutes: float | None = None) -> dict[str, Any]:
        if scenario not in SCENARIOS:
            raise ValueError(f"unknown scenario '{scenario}'")
        now = datetime.now(timezone.utc)
        if scenario == "recover":
            self.model.state.scenarios.clear()
            self.model.state.humidifier_effective = True
        else:
            default = {"high_temperature": 20, "low_humidity": 20, "sensor_fault": 3, "device_offline": 3,
                       "actuator_failure": 10, "watering": 1}.get(scenario, 10)
            minutes = duration_minutes if duration_minutes is not None else default
            self.model.state.scenarios[scenario] = now + timedelta(minutes=minutes) if minutes > 0 else None
        bus.publish_threadsafe("simulator", {"scenario": scenario, "status": self.status()})
        return self.status()

    # -- lifecycle -------------------------------------------------------------
    def _restore_state(self) -> None:
        """Continue from the last persisted reading so a server restart does not
        reset the virtual chamber (a physical device keeps its relay states)."""
        try:
            from ..db.models import Device, SensorReading
            from ..db.session import get_sessionmaker
            from sqlalchemy import select
            with get_sessionmaker()() as db:
                reading = db.execute(
                    select(SensorReading).where(SensorReading.device_id == self.device_id)
                    .order_by(SensorReading.measured_at.desc()).limit(1)
                ).scalar_one_or_none()
                device = db.get(Device, self.device_id)
                if reading is None:
                    return
                age = (datetime.now(timezone.utc) - reading.measured_at).total_seconds()
                st = self.model.state
                if age < 1800:
                    if reading.temperature_c is not None:
                        st.temperature_c = float(reading.temperature_c)
                    if reading.relative_humidity_percent is not None:
                        st.relative_humidity_percent = float(reading.relative_humidity_percent)
                if reading.substrate_moisture_raw is not None:
                    st.substrate_moisture_raw = float(reading.substrate_moisture_raw)
                for actuator in ("fan", "heater", "humidifier"):
                    value = getattr(reading, f"{actuator}_state", None)
                    if value is not None:
                        setattr(st, actuator, bool(value))
                # A real device applies commands it has already received, even if the
                # server never saw the confirmation; mirror that for unconfirmed requests.
                if device is not None:
                    for actuator, entry in (device.actuator_state or {}).items():
                        if actuator in ("fan", "heater", "humidifier") and entry.get("requested") is not None \
                                and entry.get("status") in ("pending", "unknown", "mismatch"):
                            setattr(st, actuator, bool(entry["requested"]))
        except Exception:  # pragma: no cover - restoring state is best effort
            log.exception("simulator could not restore its previous state")

    async def start(self) -> None:
        if self._running:
            return
        self._restore_state()
        self._running = True
        self.started_at = datetime.now(timezone.utc)
        registry.register(self)
        self._task = asyncio.create_task(self._loop(), name="simulator")
        log.info("simulator started for device %s every %.1fs", self.device_id, self.interval)

    async def stop(self) -> None:
        self._running = False
        registry.unregister(self.name)
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except (asyncio.CancelledError, Exception):
                pass
            self._task = None

    def _apply_pending_commands(self, now: datetime) -> list[dict[str, Any]]:
        statuses = []
        while self._pending_commands:
            cmd = self._pending_commands.pop(0)
            if (now - cmd.timestamp).total_seconds() > cmd.ttl_seconds:
                statuses.append(self._status_payload(cmd, "rejected", "command expired (ttl)"))
                continue
            if self.model.active("actuator_failure"):
                statuses.append(self._status_payload(cmd, "failed", "relay_no_response"))
                continue
            setattr(self.model.state, cmd.actuator, cmd.state)
            statuses.append(self._status_payload(cmd, "applied", None))
        return statuses

    def _status_payload(self, cmd: CommandV1, status: str, error: str | None) -> dict[str, Any]:
        return {
            "schema_version": 1, "device_id": self.device_id, "command_id": cmd.command_id, "message_id": uuid.uuid4().hex,
            "timestamp": datetime.now(timezone.utc).isoformat(), "actuator": cmd.actuator, "requested_state": cmd.state,
            "result_state": getattr(self.model.state, cmd.actuator), "status": status, "error": error,
        }

    async def _loop(self) -> None:
        from ..services.pipeline import pipeline  # late import to avoid cycles

        last = datetime.now(timezone.utc)
        while self._running:
            try:
                await asyncio.sleep(self.interval)
                now = datetime.now(timezone.utc)
                dt = (now - last).total_seconds()
                last = now
                self.model.step(dt, now)
                for status in self._apply_pending_commands(now):
                    await pipeline.process_command_status(status, device_id=self.device_id)
                if self.model.active("device_offline"):
                    continue
                payload = self.model.sample(now, self.device_id)
                await pipeline.process_telemetry(payload, transport="simulator", device_id=self.device_id)
                self.last_published_at = now
                self.messages_sent += 1
            except asyncio.CancelledError:
                raise
            except Exception:  # pragma: no cover - keep the loop alive
                log.exception("simulator loop error")


# ------------------------------------------------------------------ backfill
def generate_history(
    model: ChamberModel,
    start: datetime,
    end: datetime,
    step_seconds: int,
    targets_at: Callable[[datetime], dict[str, Any]],
    device_id: str,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """Run the model with a simple hysteresis controller and injected episodes.

    Returns (readings, episodes) where readings are plain dicts ready for bulk
    insert and episodes describe the injected faults (used to seed resolved
    demo alerts).
    """
    s = model.state
    readings: list[dict[str, Any]] = []
    episodes: list[dict[str, Any]] = []
    span = (end - start).total_seconds()
    heater_stuck = (start + timedelta(seconds=span * 0.28), start + timedelta(seconds=span * 0.28 + 40 * 60))
    humidifier_fail = (start + timedelta(seconds=span * 0.55), start + timedelta(seconds=span * 0.55 + 3 * 3600))
    offline = (start + timedelta(seconds=span * 0.70), start + timedelta(seconds=span * 0.70 + 45 * 60))
    glitch = (start + timedelta(seconds=span * 0.86), start + timedelta(seconds=span * 0.86 + 6 * 60))
    episodes.extend([
        {"kind": "heater_stuck", "start": heater_stuck[0], "end": heater_stuck[1]},
        {"kind": "humidifier_failure", "start": humidifier_fail[0], "end": humidifier_fail[1]},
        {"kind": "offline", "start": offline[0], "end": offline[1]},
        {"kind": "sensor_glitch", "start": glitch[0], "end": glitch[1]},
    ])
    t = start
    heater_since: datetime | None = None
    cooling = venting = False
    while t <= end:
        tg = targets_at(t)
        t_min, t_max = float(tg["temperature_min_c"]), float(tg["temperature_max_c"])
        rh_min, rh_max = float(tg["humidity_min_percent"]), float(tg["humidity_max_percent"])
        fae_cycle, fae_dur = float(tg.get("fae_cycle_minutes") or 0), float(tg.get("fae_duration_minutes") or 0)
        # simple controller mirroring services.control
        if heater_stuck[0] <= t < heater_stuck[1]:
            s.heater = True
        else:
            if s.temperature_c < t_min:
                s.heater = True
            elif s.temperature_c >= t_min + 0.5:
                s.heater = False
            if s.heater and heater_since and (t - heater_since).total_seconds() > 1800:
                s.heater = False
        heater_since = heater_since or (t if s.heater else None)
        if not s.heater:
            heater_since = None
        fae_active = fae_cycle > 0 and ((t.timestamp() / 60.0) % fae_cycle) < fae_dur
        if s.temperature_c > t_max:
            cooling = True
        elif s.temperature_c <= t_max - 0.5:
            cooling = False
        if s.relative_humidity_percent > rh_max:
            venting = True
        elif s.relative_humidity_percent <= rh_max - 3:
            venting = False
        s.fan = cooling or venting or fae_active
        if s.relative_humidity_percent < rh_min:
            s.humidifier = True
        elif s.relative_humidity_percent >= rh_min + 3:
            s.humidifier = False
        s.humidifier_effective = not (humidifier_fail[0] <= t < humidifier_fail[1])
        model.step(step_seconds, t)
        if not (offline[0] <= t < offline[1]):
            payload = model.sample(t, device_id)
            quality = {"time": "ok", "temperature_c": "ok", "relative_humidity_percent": "ok", "substrate_moisture_raw": "ok",
                       "fan_state": "ok", "heater_state": "ok", "humidifier_state": "ok", "warnings": [], "transport": "simulator-backfill"}
            if glitch[0] <= t < glitch[1]:
                payload["temperature_c"] = None
                payload["relative_humidity_percent"] = None
                quality["temperature_c"] = "sensor_error"
                quality["relative_humidity_percent"] = "sensor_error"
            readings.append({
                "device_id": device_id, "measured_at": t, "received_at": t, "message_id": payload["message_id"], "schema_version": 1,
                "source": "simulation", "temperature_c": payload["temperature_c"],
                "relative_humidity_percent": payload["relative_humidity_percent"],
                "substrate_moisture_raw": payload["substrate_moisture_raw"], "fan_state": s.fan, "heater_state": s.heater,
                "humidifier_state": s.humidifier, "quality": quality, "raw": None,
            })
        t += timedelta(seconds=step_seconds)
    return readings, episodes


simulator = SimulatorService()
