"""Device-facing HTTP transport (alternative to MQTT).

All endpoints require the per-device token in ``X-Device-Token``.
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter, Body, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..core.deps import get_device_from_token
from ..db.models import ActuatorCommand, Device
from ..db.session import get_db
from ..schemas.telemetry import CommandV1
from ..services.pipeline import command_to_dict, pipeline

router = APIRouter(prefix="/api/ingest", tags=["device-ingest"])


@router.post("/telemetry", status_code=202)
async def ingest_telemetry(payload: dict[str, Any] = Body(...), device: Device = Depends(get_device_from_token)):
    payload.pop("device_token", None)
    if payload.get("device_id") not in (None, device.id):
        raise HTTPException(status_code=403, detail="device_id does not match the authenticated device")
    payload.setdefault("device_id", device.id)
    result = await pipeline.process_telemetry(payload, transport="http", device_id=device.id)
    if result is None:
        raise HTTPException(status_code=422, detail="telemetry rejected by validation (see system events)")
    return {"accepted": True, **result}


@router.post("/status", status_code=202)
async def ingest_status(payload: dict[str, Any] = Body(...), device: Device = Depends(get_device_from_token)):
    payload.pop("device_token", None)
    payload.setdefault("device_id", device.id)
    if payload["device_id"] != device.id:
        raise HTTPException(status_code=403, detail="device_id does not match the authenticated device")
    await pipeline.process_device_status(payload)
    return {"accepted": True}


@router.get("/commands")
def pending_commands(device: Device = Depends(get_device_from_token), db: Session = Depends(get_db)):
    now = datetime.now(timezone.utc)
    cmds = db.execute(
        select(ActuatorCommand).where(ActuatorCommand.device_id == device.id, ActuatorCommand.status == "pending")
        .order_by(ActuatorCommand.created_at.asc())
    ).scalars().all()
    out = []
    for c in cmds:
        c.status = "sent"
        c.sent_at = now
        out.append(CommandV1(command_id=c.command_id, device_id=device.id, actuator=c.actuator, state=c.requested_state,
                             origin=c.origin, reason=c.reason, timestamp=c.created_at).model_dump(mode="json"))  # type: ignore[arg-type]
    device.last_seen_at = now
    db.commit()
    return {"device_id": device.id, "commands": out}


@router.post("/command-status", status_code=202)
async def command_status(payload: dict[str, Any] = Body(...), device: Device = Depends(get_device_from_token)):
    payload.pop("device_token", None)
    payload.setdefault("device_id", device.id)
    if payload["device_id"] != device.id:
        raise HTTPException(status_code=403, detail="device_id does not match the authenticated device")
    await pipeline.process_command_status(payload, device_id=device.id)
    return {"accepted": True}


@router.get("/commands/recent")
def recent_commands(device: Device = Depends(get_device_from_token), db: Session = Depends(get_db)):
    cmds = db.execute(select(ActuatorCommand).where(ActuatorCommand.device_id == device.id).order_by(ActuatorCommand.created_at.desc()).limit(20)).scalars().all()
    return [command_to_dict(c) for c in cmds]
