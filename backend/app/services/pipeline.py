"""Async orchestration around the synchronous services.

Every transport (simulator, MQTT, HTTP ingest) hands raw payloads to
``pipeline.process_telemetry``; the pipeline runs validation, storage, alert
rules and the control service inside one transaction and then publishes the
resulting events to WebSocket clients.
"""
from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any

from sqlalchemy import select

from ..config import get_settings
from ..core.events import bus
from ..db.models import Device, SensorReading
from ..db.session import session_scope
from . import control, prediction, settings_store
from .alerts import Outbox, engine as alert_engine
from .notifications import dispatch_external
from .telemetry import (
    MessageRejected,
    device_to_dict,
    handle_device_status,
    ingest_telemetry,
    log_event,
    mark_offline_devices,
    publish_reading_events,
    record_command_status,
)

log = logging.getLogger(__name__)


async def _flush_outbox(outbox: Outbox) -> None:
    settings_min = "warning"
    for event_type, payload in outbox:
        await bus.publish(event_type, payload)
        if event_type == "alert" and payload.get("notify"):
            try:
                await dispatch_external(payload["alert"], settings_min)
            except Exception:  # pragma: no cover - defensive
                log.exception("external notification failed")


class Pipeline:
    async def process_telemetry(self, payload: Any, *, transport: str, device_id: str | None = None) -> dict[str, Any] | None:
        now = datetime.now(timezone.utc)
        outbox: Outbox = []
        reading: SensorReading | None = None
        evaluation = None
        rejected: dict[str, Any] | None = None
        with session_scope() as db:
            device = db.get(Device, device_id) if device_id else None
            try:
                reading = ingest_telemetry(db, payload, transport=transport, device=device, now=now)
            except MessageRejected as exc:
                rejected = {"reason": exc.reason, "code": exc.code, "transport": transport,
                            "device_id": device_id or (payload.get("device_id") if isinstance(payload, dict) else None)}
            else:
                device = db.get(Device, reading.device_id)
                assert device is not None
                try:
                    alert_engine.evaluate_reading(db, device, reading, now, outbox)
                    alert_engine.auto_resolve(db, now, outbox, device_id=device.id)
                except Exception:  # pragma: no cover - alerts must never break ingest
                    log.exception("alert evaluation failed")
                try:
                    evaluation = control.run_for_device(db, device, reading, now)
                except Exception:  # pragma: no cover
                    log.exception("control evaluation failed")
                    log_event(db, "control", "control evaluation raised an exception; see logs", level="error", device_id=device.id)
                device_snapshot = device_to_dict(device)
        if rejected:
            log.warning("telemetry rejected (%s): %s", rejected["code"], rejected["reason"])
            await bus.publish("telemetry_rejected", rejected)
            return None
        assert reading is not None
        await publish_reading_events(reading)
        if evaluation is not None:
            await bus.publish("control", {"device_id": reading.device_id, "evaluation": evaluation.to_dict(), "device": device_snapshot})
        await _flush_outbox(outbox)
        return {"reading_id": reading.id, "device_id": reading.device_id}

    async def process_command_status(self, payload: Any, *, device_id: str | None = None) -> None:
        outbox: Outbox = []
        with session_scope() as db:
            device = db.get(Device, device_id) if device_id else None
            try:
                cmd = record_command_status(db, payload, device=device)
            except Exception as exc:
                log.warning("command-status rejected: %s", exc)
                return
            if cmd is not None:
                outbox.append(("command", {"command": command_to_dict(cmd)}))
                dev = db.get(Device, cmd.device_id)
                if dev is not None:
                    outbox.append(("actuator_status", {"device_id": dev.id, "actuator": cmd.actuator,
                                                       "state": cmd.result_state, "device": device_to_dict(dev)}))
        await _flush_outbox(outbox)

    async def process_device_status(self, payload: Any) -> None:
        with session_scope() as db:
            try:
                device = handle_device_status(db, payload)
            except Exception as exc:
                log.warning("device status rejected: %s", exc)
                return
            snapshot = device_to_dict(device) if device else None
        if snapshot:
            await bus.publish("device_status", {"device": snapshot})

    async def periodic_tick(self) -> None:
        settings = get_settings()
        now = datetime.now(timezone.utc)
        outbox: Outbox = []
        changed_devices: list[dict[str, Any]] = []
        with session_scope() as db:
            for d in mark_offline_devices(db, settings.device_offline_after_seconds, now):
                changed_devices.append(device_to_dict(d))
            cfg = settings_store.get_section(db, "alerts")
            try:
                control.expire_commands(db, float(cfg["command_timeout_seconds"]), now)
                alert_engine.evaluate_periodic(db, now, outbox)
            except Exception:  # pragma: no cover
                log.exception("periodic alert evaluation failed")
            # safety re-evaluation (stale sensors -> safe state) for every device
            for device in db.execute(select(Device).where(Device.is_enabled.is_(True))).scalars().all():
                try:
                    ev = control.run_for_device(db, device, None, now)
                    if ev.commands:
                        outbox.append(("control", {"device_id": device.id, "evaluation": ev.to_dict(), "device": device_to_dict(device)}))
                except Exception:  # pragma: no cover
                    log.exception("periodic control evaluation failed for %s", device.id)
        for snapshot in changed_devices:
            await bus.publish("device_status", {"device": snapshot})
        await _flush_outbox(outbox)

    async def prediction_tick(self) -> dict[str, int]:
        with session_scope() as db:
            stats = prediction.run_periodic(db)
        await bus.publish("prediction", {"stats": stats})
        return stats


def command_to_dict(cmd) -> dict[str, Any]:
    return {
        "id": cmd.id, "command_id": cmd.command_id, "device_id": cmd.device_id, "actuator": cmd.actuator,
        "requested_state": cmd.requested_state, "reason": cmd.reason, "origin": cmd.origin, "requested_by": cmd.requested_by,
        "control_mode": cmd.control_mode, "status": cmd.status, "validation": cmd.validation, "result_state": cmd.result_state,
        "error": cmd.error, "created_at": cmd.created_at.isoformat() if cmd.created_at else None,
        "sent_at": cmd.sent_at.isoformat() if cmd.sent_at else None,
        "confirmed_at": cmd.confirmed_at.isoformat() if cmd.confirmed_at else None,
    }


pipeline = Pipeline()
