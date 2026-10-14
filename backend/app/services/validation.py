"""Telemetry validation.

Two layers:

* **Message level** – schema errors, unknown/disabled device, duplicate
  ``message_id``, stale or future timestamps -> the whole message is rejected
  and a ``validation`` system event is recorded.
* **Field level** – each sensor value is checked against configurable
  plausibility limits, the sensor's rated range and a maximum rate of change.
  Invalid values are stored as ``null`` with quality ``invalid``; values that
  are plausible but outside the sensor's rated range (or jumping unusually
  fast) are kept with quality ``suspect``.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any

from pydantic import ValidationError

from ..schemas.telemetry import TelemetryV1

SENSOR_FIELDS = ("temperature_c", "relative_humidity_percent", "substrate_moisture_raw")
UNITS = {"temperature_c": "°C", "relative_humidity_percent": "%", "substrate_moisture_raw": "raw"}


def fields_for_sensor_error(entry: str) -> tuple[str, ...]:
    """Map a ``sensor_errors`` entry (field name or sensor name) to affected fields."""
    e = entry.lower()
    if e in SENSOR_FIELDS:
        return (e,)
    if e.startswith("dht") or e.startswith("sht") or "temp" in e or "humid" in e:
        return ("temperature_c", "relative_humidity_percent")
    if "moist" in e or "soil" in e or "substrate" in e:
        return ("substrate_moisture_raw",)
    return ()


class MessageRejected(Exception):
    def __init__(self, reason: str, code: str, details: dict[str, Any] | None = None) -> None:
        super().__init__(reason)
        self.reason = reason
        self.code = code
        self.details = details or {}


@dataclass
class ValidatedTelemetry:
    message: TelemetryV1
    measured_at: datetime
    values: dict[str, float | None]
    quality: dict[str, Any]
    warnings: list[str] = field(default_factory=list)

    @property
    def has_valid_temperature(self) -> bool:
        return self.values.get("temperature_c") is not None and self.quality.get("temperature_c") in ("ok", "suspect")


def parse_telemetry(payload: Any) -> TelemetryV1:
    if not isinstance(payload, dict):
        raise MessageRejected("payload must be a JSON object", "malformed")
    try:
        return TelemetryV1.model_validate(payload)
    except ValidationError as exc:
        errors = [f"{'.'.join(str(p) for p in e['loc'])}: {e['msg']}" for e in exc.errors()]
        raise MessageRejected("schema validation failed: " + "; ".join(errors), "schema", {"errors": errors}) from exc


def validate_telemetry(
    message: TelemetryV1,
    rules: dict[str, Any],
    *,
    previous: dict[str, Any] | None = None,
    now: datetime | None = None,
) -> ValidatedTelemetry:
    """Apply message- and field-level validation rules.

    ``previous`` may contain ``measured_at`` and the last accepted values so the
    rate-of-change rule can be applied.
    """
    now = now or datetime.now(timezone.utc)
    quality: dict[str, Any] = {}
    warnings: list[str] = []

    # ---- timestamp handling -------------------------------------------------
    if message.timestamp is None:
        if not rules.get("accept_unsynced_clock", True):
            raise MessageRejected("timestamp missing and unsynced clocks are not accepted", "timestamp")
        measured_at = now
        quality["time"] = "device_clock_unsynced"
        warnings.append("device clock not synchronised; server receive time used")
    else:
        measured_at = message.timestamp
        age = (now - measured_at).total_seconds()
        if age > float(rules.get("max_message_age_seconds", 300)):
            raise MessageRejected(
                f"stale message: measured {age:.0f}s ago (limit {rules.get('max_message_age_seconds', 300)}s)",
                "stale",
                {"age_seconds": age},
            )
        if age < -float(rules.get("max_future_skew_seconds", 60)):
            raise MessageRejected(
                f"timestamp is {-age:.0f}s in the future (limit {rules.get('max_future_skew_seconds', 60)}s)",
                "future_timestamp",
                {"skew_seconds": -age},
            )
        quality["time"] = "ok"

    # ---- sensor fields ----------------------------------------------------------
    values: dict[str, float | None] = {}
    reported_errors = set(message.sensor_errors or [])
    minutes_since_prev = None
    if previous and previous.get("measured_at"):
        delta = (measured_at - previous["measured_at"]).total_seconds()
        if delta > 0:
            minutes_since_prev = delta / 60.0

    errored_fields = {f for entry in reported_errors for f in fields_for_sensor_error(entry)}
    for field_name in SENSOR_FIELDS:
        value = getattr(message, field_name)
        rule = rules.get(field_name, {})
        if field_name in errored_fields or value is None:
            values[field_name] = None
            quality[field_name] = "sensor_error" if field_name in errored_fields else "missing"
            continue
        if value < float(rule.get("min", -1e9)) or value > float(rule.get("max", 1e9)):
            values[field_name] = None
            quality[field_name] = "invalid"
            warnings.append(f"{field_name}={value} outside plausible range [{rule.get('min')}, {rule.get('max')}]")
            continue
        status = "ok"
        if value < float(rule.get("sensor_min", -1e9)) or value > float(rule.get("sensor_max", 1e9)):
            status = "suspect"
            warnings.append(f"{field_name}={value} outside sensor rated range")
        if minutes_since_prev is not None and previous and previous.get(field_name) is not None:
            max_step = float(rule.get("max_step_per_minute", 1e9)) * max(minutes_since_prev, 1.0)
            if abs(value - float(previous[field_name])) > max_step:
                status = "suspect"
                warnings.append(f"{field_name} changed by {abs(value - float(previous[field_name])):.2f} since last reading")
        values[field_name] = value
        quality[field_name] = status

    for actuator in ("fan_state", "heater_state", "humidifier_state"):
        quality[actuator] = "ok" if getattr(message, actuator) is not None else "unknown"

    return ValidatedTelemetry(message=message, measured_at=measured_at, values=values, quality=quality, warnings=warnings)


def is_stale(last_measured_at: datetime | None, timeout_seconds: float, now: datetime | None = None) -> bool:
    if last_measured_at is None:
        return True
    now = now or datetime.now(timezone.utc)
    return now - last_measured_at > timedelta(seconds=timeout_seconds)
