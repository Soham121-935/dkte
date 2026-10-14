"""Request/response models for the REST API (validation at the API boundary)."""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Literal

from pydantic import BaseModel, Field, field_validator, model_validator


def _aware(v: datetime | None) -> datetime | None:
    if v is None:
        return None
    return v.replace(tzinfo=timezone.utc) if v.tzinfo is None else v.astimezone(timezone.utc)


# ------------------------------------------------------------------ auth
class LoginRequest(BaseModel):
    username: str = Field(min_length=1, max_length=64)
    password: str = Field(min_length=1, max_length=256)


class UserCreate(BaseModel):
    username: str = Field(min_length=3, max_length=64, pattern=r"^[a-zA-Z0-9_.\-]+$")
    password: str = Field(min_length=8, max_length=256)
    role: Literal["admin", "operator", "viewer"] = "viewer"


class UserUpdate(BaseModel):
    role: Literal["admin", "operator", "viewer"] | None = None
    is_active: bool | None = None
    password: str | None = Field(default=None, min_length=8, max_length=256)


class PasswordChange(BaseModel):
    current_password: str
    new_password: str = Field(min_length=8, max_length=256)


# --------------------------------------------------------------- devices
class DeviceCreate(BaseModel):
    id: str = Field(min_length=3, max_length=64, pattern=r"^[a-zA-Z0-9_\-]+$")
    name: str = Field(min_length=1, max_length=128)
    kind: Literal["hardware", "simulated"] = "hardware"
    transport: Literal["mqtt", "http", "simulator"] = "mqtt"
    hardware_notes: str | None = Field(default=None, max_length=2000)
    control_mode: Literal["monitor", "auto", "manual"] = "monitor"


class DeviceUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=128)
    transport: Literal["mqtt", "http", "simulator"] | None = None
    hardware_notes: str | None = Field(default=None, max_length=2000)
    is_enabled: bool | None = None
    firmware_version: str | None = Field(default=None, max_length=64)


# --------------------------------------------------------------- batches
class TargetSet(BaseModel):
    temperature_min_c: float | None = Field(default=None, ge=-10, le=60)
    temperature_max_c: float | None = Field(default=None, ge=-10, le=60)
    humidity_min_percent: float | None = Field(default=None, ge=0, le=100)
    humidity_max_percent: float | None = Field(default=None, ge=0, le=100)
    moisture_min_raw: float | None = Field(default=None, ge=0, le=4095)
    fae_cycle_minutes: float | None = Field(default=None, ge=0, le=1440)
    fae_duration_minutes: float | None = Field(default=None, ge=0, le=1440)

    @model_validator(mode="after")
    def _ordered(self) -> "TargetSet":
        if self.temperature_min_c is not None and self.temperature_max_c is not None and self.temperature_min_c >= self.temperature_max_c:
            raise ValueError("temperature_min_c must be lower than temperature_max_c")
        if self.humidity_min_percent is not None and self.humidity_max_percent is not None and self.humidity_min_percent >= self.humidity_max_percent:
            raise ValueError("humidity_min_percent must be lower than humidity_max_percent")
        if (self.fae_duration_minutes or 0) > (self.fae_cycle_minutes or 0) and (self.fae_cycle_minutes or 0) > 0:
            raise ValueError("fae_duration_minutes cannot exceed fae_cycle_minutes")
        return self


class StageDefinition(BaseModel):
    key: str = Field(min_length=1, max_length=64, pattern=r"^[a-z0-9_]+$")
    name: str = Field(min_length=1, max_length=128)
    description: str = ""
    milestone: bool = False
    typical_duration_days: dict[str, float] | None = None
    targets: TargetSet = Field(default_factory=TargetSet)
    observable_signs: list[str] = Field(default_factory=list)
    transition_criteria: str = ""
    requires_confirmation: bool = True

    @field_validator("typical_duration_days")
    @classmethod
    def _duration(cls, v: dict[str, float] | None) -> dict[str, float] | None:
        if v is None:
            return None
        lo, hi = float(v.get("min", 0)), float(v.get("max", 0))
        if lo < 0 or hi < 0 or lo > hi:
            raise ValueError("typical_duration_days must satisfy 0 <= min <= max")
        return {"min": lo, "max": hi}


class ProfileCreate(BaseModel):
    name: str = Field(min_length=1, max_length=128)
    species: str = Field(min_length=1, max_length=128)
    strain: str | None = Field(default=None, max_length=128)
    cultivation_method: str | None = Field(default=None, max_length=128)
    substrate_type: str | None = Field(default=None, max_length=128)
    source: Literal["user", "reference"] = "user"
    source_notes: str | None = Field(default=None, max_length=2000)
    stages: list[StageDefinition] = Field(min_length=1)

    @field_validator("stages")
    @classmethod
    def _unique_keys(cls, v: list[StageDefinition]) -> list[StageDefinition]:
        keys = [s.key for s in v]
        if len(keys) != len(set(keys)):
            raise ValueError("stage keys must be unique")
        return v


class ProfileUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=128)
    species: str | None = Field(default=None, min_length=1, max_length=128)
    strain: str | None = Field(default=None, max_length=128)
    cultivation_method: str | None = Field(default=None, max_length=128)
    substrate_type: str | None = Field(default=None, max_length=128)
    source_notes: str | None = Field(default=None, max_length=2000)
    stages: list[StageDefinition] | None = None


class BatchCreate(BaseModel):
    name: str = Field(min_length=1, max_length=128)
    species: str = Field(min_length=1, max_length=128)
    strain: str | None = Field(default=None, max_length=128)
    substrate_type: str | None = Field(default=None, max_length=128)
    substrate_details: str | None = Field(default=None, max_length=2000)
    inoculation_date: datetime | None = None
    spawn_details: str | None = Field(default=None, max_length=2000)
    profile_id: int | None = None
    device_id: str | None = None
    status: Literal["planned", "active", "harvested", "failed", "archived"] = "active"
    initial_stage_key: str | None = None
    notes: str | None = Field(default=None, max_length=4000)
    expected_harvest_start: datetime | None = None
    expected_harvest_end: datetime | None = None
    target_overrides: dict[str, TargetSet] = Field(default_factory=dict)

    _tz = field_validator("inoculation_date", "expected_harvest_start", "expected_harvest_end")(_aware)

    @model_validator(mode="after")
    def _window(self) -> "BatchCreate":
        if self.expected_harvest_start and self.expected_harvest_end and self.expected_harvest_start > self.expected_harvest_end:
            raise ValueError("expected_harvest_start must be before expected_harvest_end")
        if self.inoculation_date and self.inoculation_date > datetime.now(timezone.utc).replace(hour=23, minute=59):
            raise ValueError("inoculation_date cannot be in the future")
        return self


class BatchUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=128)
    species: str | None = Field(default=None, min_length=1, max_length=128)
    strain: str | None = Field(default=None, max_length=128)
    substrate_type: str | None = Field(default=None, max_length=128)
    substrate_details: str | None = Field(default=None, max_length=2000)
    inoculation_date: datetime | None = None
    spawn_details: str | None = Field(default=None, max_length=2000)
    profile_id: int | None = None
    device_id: str | None = None
    status: Literal["planned", "active", "harvested", "failed", "archived"] | None = None
    notes: str | None = Field(default=None, max_length=4000)
    expected_harvest_start: datetime | None = None
    expected_harvest_end: datetime | None = None
    target_overrides: dict[str, TargetSet] | None = None
    outcome: dict[str, Any] | None = None

    _tz = field_validator("inoculation_date", "expected_harvest_start", "expected_harvest_end")(_aware)


class StageConfirm(BaseModel):
    stage_key: str = Field(min_length=1, max_length=64)
    started_at: datetime | None = None
    note: str | None = Field(default=None, max_length=2000)

    _tz = field_validator("started_at")(_aware)


class ObservationCreate(BaseModel):
    observed_at: datetime | None = None
    kind: Literal["note", "stage_confirmation", "contamination", "harvest", "measurement", "photo"] = "note"
    note: str | None = Field(default=None, max_length=4000)
    stage_key: str | None = Field(default=None, max_length=64)
    data: dict[str, Any] | None = None

    _tz = field_validator("observed_at")(_aware)

    @model_validator(mode="after")
    def _content(self) -> "ObservationCreate":
        if not (self.note or self.data):
            raise ValueError("an observation needs a note or data")
        return self


# --------------------------------------------------------------- control
class ModeChange(BaseModel):
    mode: Literal["monitor", "auto", "manual"]


class CommandRequest(BaseModel):
    actuator: Literal["fan", "heater", "humidifier"]
    state: bool
    reason: str = Field(default="manual command from dashboard", max_length=300)


class ControlConfigUpdate(BaseModel):
    hysteresis_temp_c: float | None = Field(default=None, ge=0.1, le=5)
    hysteresis_rh: float | None = Field(default=None, ge=0.5, le=20)
    min_switch_interval_seconds: int | None = Field(default=None, ge=5, le=3600)
    heater_max_runtime_seconds: int | None = Field(default=None, ge=60, le=4 * 3600)
    heater_cooldown_seconds: int | None = Field(default=None, ge=30, le=3600)
    heater_absolute_max_temp_c: float | None = Field(default=None, ge=20, le=45)
    stale_sensor_timeout_seconds: int | None = Field(default=None, ge=30, le=3600)
    targets: TargetSet | None = None


# ---------------------------------------------------------------- alerts
class AlertAction(BaseModel):
    note: str | None = Field(default=None, max_length=500)


# -------------------------------------------------------------------- AI
class ConversationCreate(BaseModel):
    device_id: str | None = None
    batch_id: int | None = None
    title: str | None = Field(default=None, max_length=160)


class ChatMessageCreate(BaseModel):
    content: str = Field(min_length=1, max_length=4000)


# ------------------------------------------------------------- simulator
class ScenarioRequest(BaseModel):
    scenario: Literal["high_temperature", "low_humidity", "sensor_fault", "device_offline", "actuator_failure", "watering", "recover"]
    duration_minutes: float | None = Field(default=None, ge=0, le=720)


# -------------------------------------------------------------- settings
class SettingsUpdate(BaseModel):
    value: dict[str, Any]
