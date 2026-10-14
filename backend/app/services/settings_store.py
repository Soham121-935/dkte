"""Persisted application settings with typed defaults.

Settings are stored as JSON documents in ``app_settings`` keyed by section.
Defaults are merged so new keys appear automatically after upgrades.
"""
from __future__ import annotations

import copy
from typing import Any

from sqlalchemy.orm import Session

from ..db.models import AppSetting

DEFAULTS: dict[str, dict[str, Any]] = {
    "validation": {
        # Hard physical plausibility limits: outside -> field rejected (stored as null, quality "invalid")
        "temperature_c": {"min": -10.0, "max": 60.0, "sensor_min": 0.0, "sensor_max": 50.0, "max_step_per_minute": 5.0},
        "relative_humidity_percent": {"min": 0.0, "max": 100.0, "sensor_min": 20.0, "sensor_max": 95.0, "max_step_per_minute": 20.0},
        "substrate_moisture_raw": {"min": 0.0, "max": 4095.0, "sensor_min": 0.0, "sensor_max": 4095.0, "max_step_per_minute": 1500.0},
        "max_message_age_seconds": 300,
        "max_future_skew_seconds": 60,
        "accept_unsynced_clock": True,
    },
    "alerts": {
        "cooldown_seconds": 600,
        "auto_resolve_after_seconds": 120,
        "out_of_range_grace_seconds": 180,
        "stale_telemetry_seconds": 120,
        "heater_max_runtime_seconds": 1800,
        "rapid_temp_rise_c_per_10min": 3.0,
        "fluctuation_std_c_15min": 1.5,
        "rapid_switching_count_15min": 10,
        "command_timeout_seconds": 45,
        "notify_min_severity": "warning",
    },
    "control_defaults": {
        "hysteresis_temp_c": 0.5,
        "hysteresis_rh": 3.0,
        "min_switch_interval_seconds": 60,
        "heater_max_runtime_seconds": 1800,
        "heater_cooldown_seconds": 300,
        "heater_absolute_max_temp_c": 32.0,
        "stale_sensor_timeout_seconds": 120,
        "default_targets": {
            "temperature_min_c": 20.0,
            "temperature_max_c": 24.0,
            "humidity_min_percent": 85.0,
            "humidity_max_percent": 95.0,
            "moisture_min_raw": None,
            "fae_cycle_minutes": 0,
            "fae_duration_minutes": 0,
        },
    },
    "display": {
        "timezone": "UTC",
        "temperature_unit": "C",
    },
}


def _merge(defaults: dict[str, Any], override: dict[str, Any] | None) -> dict[str, Any]:
    result = copy.deepcopy(defaults)
    if not override:
        return result
    for key, value in override.items():
        if isinstance(value, dict) and isinstance(result.get(key), dict):
            result[key] = _merge(result[key], value)
        else:
            result[key] = value
    return result


def get_section(db: Session, section: str) -> dict[str, Any]:
    if section not in DEFAULTS:
        raise KeyError(section)
    row = db.get(AppSetting, section)
    return _merge(DEFAULTS[section], row.value if row else None)


def get_all(db: Session) -> dict[str, dict[str, Any]]:
    return {section: get_section(db, section) for section in DEFAULTS}


class SettingsValidationError(ValueError):
    """Raised when a settings patch contains unknown keys or implausible values."""


# keys that may legitimately be null
_NULLABLE = {"moisture_min_raw"}
# keys whose numeric value must stay non-negative (seconds, counts, hysteresis widths, ...)
_NON_NEGATIVE_HINTS = ("seconds", "count", "minutes", "hysteresis", "per_10min", "std_c", "max_step")
_ENUMS = {"notify_min_severity": {"info", "warning", "critical"}, "temperature_unit": {"C", "F"}}


def _validate_patch(path: str, reference: Any, value: Any) -> None:
    key = path.rsplit(".", 1)[-1]
    if isinstance(reference, dict):
        if not isinstance(value, dict):
            raise SettingsValidationError(f"{path}: expected an object")
        for k, v in value.items():
            if k not in reference:
                raise SettingsValidationError(f"{path}.{k}: unknown setting")
            _validate_patch(f"{path}.{k}", reference[k], v)
        return
    if value is None:
        if key in _NULLABLE or reference is None:
            return
        raise SettingsValidationError(f"{path}: value may not be null")
    if isinstance(reference, bool) or (reference is None and isinstance(value, bool)):
        if not isinstance(value, bool):
            raise SettingsValidationError(f"{path}: expected true/false")
        return
    if isinstance(reference, (int, float)) or (reference is None and key in _NULLABLE):
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            raise SettingsValidationError(f"{path}: expected a number")
        if value != value or value in (float("inf"), float("-inf")):
            raise SettingsValidationError(f"{path}: must be finite")
        if any(h in key for h in _NON_NEGATIVE_HINTS) and value < 0:
            raise SettingsValidationError(f"{path}: must not be negative")
        if key.endswith("_percent") and not 0 <= value <= 100:
            raise SettingsValidationError(f"{path}: must be between 0 and 100")
        return
    if isinstance(reference, str):
        if not isinstance(value, str) or not value.strip() or len(value) > 64:
            raise SettingsValidationError(f"{path}: expected a short non-empty string")
        if key in _ENUMS and value not in _ENUMS[key]:
            raise SettingsValidationError(f"{path}: must be one of {sorted(_ENUMS[key])}")
        return
    raise SettingsValidationError(f"{path}: unsupported value")


def update_section(db: Session, section: str, value: dict[str, Any]) -> dict[str, Any]:
    if section not in DEFAULTS:
        raise KeyError(section)
    _validate_patch(section, DEFAULTS[section], value)
    merged = _merge(get_section(db, section), value)
    row = db.get(AppSetting, section)
    if row is None:
        row = AppSetting(key=section, value=merged)
        db.add(row)
    else:
        row.value = merged
    db.flush()
    return merged
