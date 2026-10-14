"""Versioned IoT message schemas (telemetry v1, command v1, command-status v1,
status v1).  These are the contract between the backend, the hardware
simulator and the ESP32 firmware.  JSON Schema copies live in /schemas.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

ACTUATORS = ("fan", "heater", "humidifier")
Actuator = Literal["fan", "heater", "humidifier"]
Source = Literal["hardware", "simulation"]


def _new_message_id() -> str:
    return uuid.uuid4().hex


class TelemetryV1(BaseModel):
    """Telemetry message published on ``myco/{device_id}/telemetry``."""

    model_config = ConfigDict(extra="allow")

    schema_version: int = Field(default=1, ge=1, le=1)
    device_id: str = Field(min_length=3, max_length=64, pattern=r"^[a-zA-Z0-9_\-]+$")
    message_id: str = Field(default_factory=_new_message_id, min_length=4, max_length=64)
    timestamp: datetime | None = Field(
        default=None,
        description="Measurement time (ISO-8601). May be null when the device clock is not synchronised.",
    )
    uptime_ms: int | None = Field(default=None, ge=0)
    temperature_c: float | None = None
    relative_humidity_percent: float | None = None
    substrate_moisture_raw: float | None = None
    fan_state: bool | None = None
    heater_state: bool | None = None
    humidifier_state: bool | None = None
    sensor_errors: list[str] = Field(default_factory=list)
    firmware_version: str | None = Field(default=None, max_length=64)
    source: Source = "hardware"
    rssi_dbm: int | None = None

    @field_validator("timestamp")
    @classmethod
    def _tz(cls, v: datetime | None) -> datetime | None:
        if v is None:
            return None
        if v.tzinfo is None:
            raise ValueError("timestamp must include a timezone offset (use UTC, e.g. 2026-01-01T12:00:00Z)")
        return v.astimezone(timezone.utc)

    @field_validator("temperature_c", "relative_humidity_percent", "substrate_moisture_raw", mode="before")
    @classmethod
    def _numeric(cls, v: Any) -> Any:
        if v is None:
            return None
        if isinstance(v, bool):
            raise ValueError("boolean is not a valid sensor value")
        if isinstance(v, (int, float)):
            if v != v or v in (float("inf"), float("-inf")):
                raise ValueError("non-finite sensor value")
            return float(v)
        raise ValueError("sensor values must be numeric")


class CommandV1(BaseModel):
    """Command published on ``myco/{device_id}/commands``."""

    schema_version: int = 1
    command_id: str = Field(default_factory=_new_message_id)
    device_id: str
    timestamp: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
    actuator: Actuator
    state: bool
    origin: Literal["auto", "manual", "safety", "simulator"] = "auto"
    reason: str = ""
    ttl_seconds: int = Field(default=60, ge=5, le=600, description="Device must ignore the command after this age.")


class CommandStatusV1(BaseModel):
    """Acknowledgement published by the device on ``myco/{device_id}/command-status``."""

    model_config = ConfigDict(extra="allow")

    schema_version: int = 1
    device_id: str
    command_id: str
    message_id: str = Field(default_factory=_new_message_id)
    timestamp: datetime | None = None
    actuator: Actuator
    requested_state: bool
    result_state: bool | None = None
    status: Literal["applied", "rejected", "failed"]
    error: str | None = None

    @field_validator("timestamp")
    @classmethod
    def _tz(cls, v: datetime | None) -> datetime | None:
        if v is None:
            return None
        if v.tzinfo is None:
            raise ValueError("timestamp must include a timezone offset")
        return v.astimezone(timezone.utc)


class DeviceStatusV1(BaseModel):
    """Retained status message on ``myco/{device_id}/status`` (also used as MQTT last-will)."""

    model_config = ConfigDict(extra="allow")

    schema_version: int = 1
    device_id: str
    status: Literal["online", "offline"]
    timestamp: datetime | None = None
    firmware_version: str | None = None
    ip: str | None = None
    rssi_dbm: int | None = None
    local_safety: dict[str, Any] | None = None
