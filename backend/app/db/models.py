"""Database models.

The schema is append-only for measurements: sensor readings, status events,
commands, predictions and alerts are never overwritten by newer data.
"""
from __future__ import annotations

from datetime import datetime
from typing import Any

from sqlalchemy import (
    JSON,
    Boolean,
    Float,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .base import Base, TZDateTime, utcnow


class User(Base):
    __tablename__ = "users"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    username: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    password_hash: Mapped[str] = mapped_column(String(256))
    role: Mapped[str] = mapped_column(String(16), default="viewer")  # admin|operator|viewer
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = mapped_column(TZDateTime, default=utcnow)


class Device(Base):
    __tablename__ = "devices"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    name: Mapped[str] = mapped_column(String(128))
    kind: Mapped[str] = mapped_column(String(16), default="hardware")  # hardware|simulated
    transport: Mapped[str] = mapped_column(String(16), default="mqtt")  # mqtt|http|simulator
    token_hash: Mapped[str | None] = mapped_column(String(256), nullable=True)
    firmware_version: Mapped[str | None] = mapped_column(String(64), nullable=True)
    hardware_notes: Mapped[str | None] = mapped_column(Text, nullable=True)
    is_enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    connection_status: Mapped[str] = mapped_column(String(16), default="unknown")  # online|offline|unknown
    last_seen_at: Mapped[datetime | None] = mapped_column(TZDateTime, nullable=True)
    last_telemetry_at: Mapped[datetime | None] = mapped_column(TZDateTime, nullable=True)
    control_mode: Mapped[str] = mapped_column(String(16), default="monitor")  # monitor|auto|manual
    control_config: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    control_state: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    actuator_state: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    stats: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    created_at: Mapped[datetime] = mapped_column(TZDateTime, default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(TZDateTime, default=utcnow, onupdate=utcnow)


class SensorReading(Base):
    """One row per accepted telemetry message (wide, time-series friendly)."""

    __tablename__ = "sensor_readings"
    __table_args__ = (
        Index("ix_sensor_readings_device_time", "device_id", "measured_at"),
        UniqueConstraint("device_id", "message_id", name="uq_sensor_readings_device_message"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    device_id: Mapped[str] = mapped_column(ForeignKey("devices.id"), index=True)
    measured_at: Mapped[datetime] = mapped_column(TZDateTime, index=True)
    received_at: Mapped[datetime] = mapped_column(TZDateTime, default=utcnow)
    message_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    schema_version: Mapped[int] = mapped_column(Integer, default=1)
    source: Mapped[str] = mapped_column(String(16))  # hardware|simulation
    temperature_c: Mapped[float | None] = mapped_column(Float, nullable=True)
    relative_humidity_percent: Mapped[float | None] = mapped_column(Float, nullable=True)
    substrate_moisture_raw: Mapped[float | None] = mapped_column(Float, nullable=True)
    fan_state: Mapped[bool | None] = mapped_column(Boolean, nullable=True)
    heater_state: Mapped[bool | None] = mapped_column(Boolean, nullable=True)
    humidifier_state: Mapped[bool | None] = mapped_column(Boolean, nullable=True)
    quality: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    raw: Mapped[dict[str, Any] | None] = mapped_column(JSON, nullable=True)


class SystemEvent(Base):
    __tablename__ = "system_events"
    __table_args__ = (Index("ix_system_events_created", "created_at"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    created_at: Mapped[datetime] = mapped_column(TZDateTime, default=utcnow)
    device_id: Mapped[str | None] = mapped_column(String(64), nullable=True, index=True)
    category: Mapped[str] = mapped_column(String(32))  # validation|connection|control|ai|simulator|auth|system
    level: Mapped[str] = mapped_column(String(16), default="info")
    message: Mapped[str] = mapped_column(Text)
    data: Mapped[dict[str, Any] | None] = mapped_column(JSON, nullable=True)


class CultivationProfile(Base):
    __tablename__ = "cultivation_profiles"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    name: Mapped[str] = mapped_column(String(128))
    species: Mapped[str] = mapped_column(String(128))
    strain: Mapped[str | None] = mapped_column(String(128), nullable=True)
    cultivation_method: Mapped[str | None] = mapped_column(String(128), nullable=True)
    substrate_type: Mapped[str | None] = mapped_column(String(128), nullable=True)
    source: Mapped[str] = mapped_column(String(16), default="user")  # user|reference
    source_notes: Mapped[str | None] = mapped_column(Text, nullable=True)
    stages: Mapped[list[dict[str, Any]]] = mapped_column(JSON, default=list)
    is_builtin: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(TZDateTime, default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(TZDateTime, default=utcnow, onupdate=utcnow)


class CultivationBatch(Base):
    __tablename__ = "cultivation_batches"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    code: Mapped[str] = mapped_column(String(32), unique=True)
    name: Mapped[str] = mapped_column(String(128))
    species: Mapped[str] = mapped_column(String(128))
    strain: Mapped[str | None] = mapped_column(String(128), nullable=True)
    substrate_type: Mapped[str | None] = mapped_column(String(128), nullable=True)
    substrate_details: Mapped[str | None] = mapped_column(Text, nullable=True)
    inoculation_date: Mapped[datetime | None] = mapped_column(TZDateTime, nullable=True)
    spawn_details: Mapped[str | None] = mapped_column(Text, nullable=True)
    profile_id: Mapped[int | None] = mapped_column(ForeignKey("cultivation_profiles.id"), nullable=True)
    device_id: Mapped[str | None] = mapped_column(ForeignKey("devices.id"), nullable=True)
    status: Mapped[str] = mapped_column(String(16), default="active")  # planned|active|harvested|failed|archived
    current_stage_key: Mapped[str | None] = mapped_column(String(64), nullable=True)
    target_overrides: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    notes: Mapped[str | None] = mapped_column(Text, nullable=True)
    expected_harvest_start: Mapped[datetime | None] = mapped_column(TZDateTime, nullable=True)
    expected_harvest_end: Mapped[datetime | None] = mapped_column(TZDateTime, nullable=True)
    started_at: Mapped[datetime | None] = mapped_column(TZDateTime, nullable=True)
    ended_at: Mapped[datetime | None] = mapped_column(TZDateTime, nullable=True)
    outcome: Mapped[dict[str, Any] | None] = mapped_column(JSON, nullable=True)
    is_demo: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(TZDateTime, default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(TZDateTime, default=utcnow, onupdate=utcnow)

    profile: Mapped[CultivationProfile | None] = relationship(CultivationProfile, lazy="joined")
    observations: Mapped[list["BatchObservation"]] = relationship(
        "BatchObservation", back_populates="batch", cascade="all, delete-orphan", lazy="select"
    )
    stage_events: Mapped[list["StageEvent"]] = relationship(
        "StageEvent", back_populates="batch", cascade="all, delete-orphan", lazy="select"
    )


class BatchObservation(Base):
    __tablename__ = "batch_observations"
    __table_args__ = (Index("ix_batch_observations_batch_time", "batch_id", "observed_at"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    batch_id: Mapped[int] = mapped_column(ForeignKey("cultivation_batches.id", ondelete="CASCADE"))
    observed_at: Mapped[datetime] = mapped_column(TZDateTime, default=utcnow)
    kind: Mapped[str] = mapped_column(String(32), default="note")
    note: Mapped[str | None] = mapped_column(Text, nullable=True)
    stage_key: Mapped[str | None] = mapped_column(String(64), nullable=True)
    image_path: Mapped[str | None] = mapped_column(String(256), nullable=True)
    recorded_by: Mapped[str | None] = mapped_column(String(64), nullable=True)
    data: Mapped[dict[str, Any] | None] = mapped_column(JSON, nullable=True)
    created_at: Mapped[datetime] = mapped_column(TZDateTime, default=utcnow)

    batch: Mapped[CultivationBatch] = relationship(CultivationBatch, back_populates="observations")


class StageEvent(Base):
    __tablename__ = "stage_events"
    __table_args__ = (Index("ix_stage_events_batch_time", "batch_id", "started_at"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    batch_id: Mapped[int] = mapped_column(ForeignKey("cultivation_batches.id", ondelete="CASCADE"))
    stage_key: Mapped[str] = mapped_column(String(64))
    started_at: Mapped[datetime] = mapped_column(TZDateTime, default=utcnow)
    source: Mapped[str] = mapped_column(String(16), default="manual")  # manual|initial|system
    confirmed_by: Mapped[str | None] = mapped_column(String(64), nullable=True)
    note: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(TZDateTime, default=utcnow)

    batch: Mapped[CultivationBatch] = relationship(CultivationBatch, back_populates="stage_events")


class Prediction(Base):
    __tablename__ = "predictions"
    __table_args__ = (Index("ix_predictions_kind_time", "kind", "generated_at"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    kind: Mapped[str] = mapped_column(String(32))  # env_forecast|stage_estimate|anomaly|recommendation
    model_name: Mapped[str] = mapped_column(String(64))
    model_version: Mapped[str] = mapped_column(String(32), default="1")
    device_id: Mapped[str | None] = mapped_column(String(64), nullable=True, index=True)
    batch_id: Mapped[int | None] = mapped_column(Integer, nullable=True, index=True)
    generated_at: Mapped[datetime] = mapped_column(TZDateTime, default=utcnow)
    target_time: Mapped[datetime | None] = mapped_column(TZDateTime, nullable=True)
    horizon_minutes: Mapped[int | None] = mapped_column(Integer, nullable=True)
    inputs: Mapped[dict[str, Any] | None] = mapped_column(JSON, nullable=True)
    output: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    uncertainty: Mapped[dict[str, Any] | None] = mapped_column(JSON, nullable=True)
    evaluated_at: Mapped[datetime | None] = mapped_column(TZDateTime, nullable=True)
    actual: Mapped[dict[str, Any] | None] = mapped_column(JSON, nullable=True)
    error: Mapped[dict[str, Any] | None] = mapped_column(JSON, nullable=True)


class Alert(Base):
    __tablename__ = "alerts"
    __table_args__ = (Index("ix_alerts_status_time", "status", "opened_at"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    rule_key: Mapped[str] = mapped_column(String(64), index=True)
    dedup_key: Mapped[str] = mapped_column(String(128), index=True)
    severity: Mapped[str] = mapped_column(String(16), default="warning")  # info|warning|critical
    title: Mapped[str] = mapped_column(String(160))
    message: Mapped[str] = mapped_column(Text)
    device_id: Mapped[str | None] = mapped_column(String(64), nullable=True, index=True)
    batch_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    source: Mapped[str] = mapped_column(String(16), default="system")  # hardware|simulation|system
    status: Mapped[str] = mapped_column(String(16), default="active")  # active|acknowledged|resolved
    opened_at: Mapped[datetime] = mapped_column(TZDateTime, default=utcnow)
    last_seen_at: Mapped[datetime] = mapped_column(TZDateTime, default=utcnow)
    acknowledged_at: Mapped[datetime | None] = mapped_column(TZDateTime, nullable=True)
    acknowledged_by: Mapped[str | None] = mapped_column(String(64), nullable=True)
    resolved_at: Mapped[datetime | None] = mapped_column(TZDateTime, nullable=True)
    resolved_reason: Mapped[str | None] = mapped_column(String(160), nullable=True)
    occurrence_count: Mapped[int] = mapped_column(Integer, default=1)
    notified_at: Mapped[datetime | None] = mapped_column(TZDateTime, nullable=True)
    data: Mapped[dict[str, Any] | None] = mapped_column(JSON, nullable=True)


class ActuatorCommand(Base):
    __tablename__ = "actuator_commands"
    __table_args__ = (Index("ix_actuator_commands_device_time", "device_id", "created_at"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    command_id: Mapped[str] = mapped_column(String(64), unique=True)
    device_id: Mapped[str] = mapped_column(ForeignKey("devices.id"), index=True)
    actuator: Mapped[str] = mapped_column(String(16))  # fan|heater|humidifier
    requested_state: Mapped[bool] = mapped_column(Boolean)
    reason: Mapped[str] = mapped_column(Text, default="")
    origin: Mapped[str] = mapped_column(String(16))  # auto|manual|safety|simulator
    requested_by: Mapped[str] = mapped_column(String(64), default="control_service")
    control_mode: Mapped[str] = mapped_column(String(16), default="monitor")
    status: Mapped[str] = mapped_column(String(16), default="pending")  # rejected|pending|sent|confirmed|failed|timeout
    validation: Mapped[dict[str, Any] | None] = mapped_column(JSON, nullable=True)
    result_state: Mapped[bool | None] = mapped_column(Boolean, nullable=True)
    error: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(TZDateTime, default=utcnow)
    sent_at: Mapped[datetime | None] = mapped_column(TZDateTime, nullable=True)
    confirmed_at: Mapped[datetime | None] = mapped_column(TZDateTime, nullable=True)


class ActuatorStatusEvent(Base):
    __tablename__ = "actuator_status_events"
    __table_args__ = (Index("ix_actuator_status_device_time", "device_id", "observed_at"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    device_id: Mapped[str] = mapped_column(ForeignKey("devices.id"), index=True)
    actuator: Mapped[str] = mapped_column(String(16))
    state: Mapped[bool] = mapped_column(Boolean)
    observed_at: Mapped[datetime] = mapped_column(TZDateTime, default=utcnow)
    source: Mapped[str] = mapped_column(String(16), default="telemetry")  # telemetry|command_status|simulation
    command_id: Mapped[str | None] = mapped_column(String(64), nullable=True)


class AIConversation(Base):
    __tablename__ = "ai_conversations"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    title: Mapped[str] = mapped_column(String(160), default="New conversation")
    user_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    batch_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    device_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    created_at: Mapped[datetime] = mapped_column(TZDateTime, default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(TZDateTime, default=utcnow, onupdate=utcnow)

    messages: Mapped[list["AIMessage"]] = relationship(
        "AIMessage", back_populates="conversation", cascade="all, delete-orphan", order_by="AIMessage.id"
    )


class AIMessage(Base):
    __tablename__ = "ai_messages"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    conversation_id: Mapped[int] = mapped_column(ForeignKey("ai_conversations.id", ondelete="CASCADE"), index=True)
    role: Mapped[str] = mapped_column(String(16))  # user|assistant
    content: Mapped[str] = mapped_column(Text)
    mode: Mapped[str | None] = mapped_column(String(16), nullable=True)  # llm|fallback
    provider: Mapped[str | None] = mapped_column(String(32), nullable=True)
    model: Mapped[str | None] = mapped_column(String(96), nullable=True)
    prompt_tokens: Mapped[int | None] = mapped_column(Integer, nullable=True)
    completion_tokens: Mapped[int | None] = mapped_column(Integer, nullable=True)
    latency_ms: Mapped[int | None] = mapped_column(Integer, nullable=True)
    context_snapshot: Mapped[dict[str, Any] | None] = mapped_column(JSON, nullable=True)
    error: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(TZDateTime, default=utcnow)

    conversation: Mapped[AIConversation] = relationship(AIConversation, back_populates="messages")


class AppSetting(Base):
    __tablename__ = "app_settings"

    key: Mapped[str] = mapped_column(String(64), primary_key=True)
    value: Mapped[Any] = mapped_column(JSON)
    updated_at: Mapped[datetime] = mapped_column(TZDateTime, default=utcnow, onupdate=utcnow)


class CameraCapture(Base):
    """One photo taken by the ESP32-CAM (or uploaded from the browser) and what the recogniser made of it."""

    __tablename__ = "camera_captures"
    __table_args__ = (Index("ix_camera_captures_captured", "captured_at"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    camera_device_id: Mapped[str | None] = mapped_column(String(64), nullable=True, index=True)
    target_device_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    captured_at: Mapped[datetime] = mapped_column(TZDateTime, default=utcnow)
    source: Mapped[str] = mapped_column(String(16), default="esp32cam")  # esp32cam|upload
    trigger: Mapped[str] = mapped_column(String(16), default="auto")  # auto|manual|upload
    image_path: Mapped[str] = mapped_column(String(256))
    width: Mapped[int | None] = mapped_column(Integer, nullable=True)
    height: Mapped[int | None] = mapped_column(Integer, nullable=True)
    size_bytes: Mapped[int | None] = mapped_column(Integer, nullable=True)
    status: Mapped[str] = mapped_column(String(16), default="no_match")  # matched|no_match|unreadable|unavailable
    method: Mapped[str | None] = mapped_column(String(16), nullable=True)  # qr|features
    card_key: Mapped[str | None] = mapped_column(String(64), nullable=True)
    species_key: Mapped[str | None] = mapped_column(String(32), nullable=True)
    phase_key: Mapped[str | None] = mapped_column(String(32), nullable=True)
    stage_key: Mapped[str | None] = mapped_column(String(64), nullable=True)
    confidence: Mapped[str | None] = mapped_column(String(16), nullable=True)  # high|medium|low
    inliers: Mapped[int] = mapped_column(Integer, default=0)
    second_inliers: Mapped[int] = mapped_column(Integer, default=0)
    qr_text: Mapped[str | None] = mapped_column(String(128), nullable=True)
    details: Mapped[dict[str, Any] | None] = mapped_column(JSON, nullable=True)
    applied: Mapped[bool] = mapped_column(Boolean, default=False)
    applied_at: Mapped[datetime | None] = mapped_column(TZDateTime, nullable=True)
    applied_batch_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    applied_stage_key: Mapped[str | None] = mapped_column(String(64), nullable=True)
    applied_by: Mapped[str | None] = mapped_column(String(64), nullable=True)
    apply_note: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(TZDateTime, default=utcnow)
