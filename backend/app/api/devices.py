from __future__ import annotations

from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..core.deps import CurrentUser, read_access, require_role
from ..core.security import generate_device_token, hash_token
from ..db.models import CultivationBatch, Device, SensorReading, SystemEvent
from ..db.session import get_db
from ..schemas.api import DeviceCreate, DeviceUpdate
from ..services.telemetry import device_to_dict, last_reading, log_event, reading_to_dict

router = APIRouter(prefix="/api/devices", tags=["devices"])


def _get(db: Session, device_id: str) -> Device:
    device = db.get(Device, device_id)
    if device is None:
        raise HTTPException(status_code=404, detail="Device not found")
    return device


@router.get("")
def list_devices(_=Depends(read_access), db: Session = Depends(get_db)):
    out = []
    for d in db.execute(select(Device).order_by(Device.created_at)).scalars():
        item = device_to_dict(d)
        batch = db.execute(select(CultivationBatch).where(CultivationBatch.device_id == d.id, CultivationBatch.status == "active")
                           .order_by(CultivationBatch.id.desc()).limit(1)).scalar_one_or_none()
        item["active_batch"] = {"id": batch.id, "code": batch.code, "name": batch.name} if batch else None
        out.append(item)
    return out


@router.get("/{device_id}")
def get_device(device_id: str, _=Depends(read_access), db: Session = Depends(get_db)):
    d = _get(db, device_id)
    item = device_to_dict(d)
    r = last_reading(db, d.id)
    item["last_reading"] = reading_to_dict(r) if r else None
    return item


@router.post("", status_code=201)
def create_device(body: DeviceCreate, actor: CurrentUser = Depends(require_role("admin")), db: Session = Depends(get_db)):
    if db.get(Device, body.id) is not None:
        raise HTTPException(status_code=409, detail="Device id already exists")
    if body.kind == "simulated" and body.transport != "simulator":
        raise HTTPException(status_code=422, detail="simulated devices must use the simulator transport")
    if body.kind == "hardware" and body.transport == "simulator":
        raise HTTPException(status_code=422, detail="hardware devices cannot use the simulator transport")
    d = Device(id=body.id, name=body.name, kind=body.kind, transport=body.transport, hardware_notes=body.hardware_notes,
               control_mode=body.control_mode, connection_status="unknown")
    db.add(d)
    log_event(db, "system", f"device {d.id} registered by {actor.username}", device_id=d.id)
    db.commit()
    return device_to_dict(d)


@router.patch("/{device_id}")
def update_device(device_id: str, body: DeviceUpdate, actor: CurrentUser = Depends(require_role("admin")), db: Session = Depends(get_db)):
    d = _get(db, device_id)
    if body.transport is not None:
        if d.kind == "hardware" and body.transport == "simulator":
            raise HTTPException(status_code=422, detail="hardware devices cannot use the simulator transport")
        if d.kind == "simulated" and body.transport != "simulator":
            raise HTTPException(status_code=422, detail="simulated devices must use the simulator transport")
        d.transport = body.transport
    for field in ("name", "hardware_notes", "is_enabled", "firmware_version"):
        value = getattr(body, field)
        if value is not None:
            setattr(d, field, value)
    log_event(db, "system", f"device {d.id} updated by {actor.username}", device_id=d.id, data=body.model_dump(exclude_none=True))
    db.commit()
    return device_to_dict(d)


@router.post("/{device_id}/token")
def rotate_token(device_id: str, actor: CurrentUser = Depends(require_role("admin")), db: Session = Depends(get_db)):
    d = _get(db, device_id)
    if d.kind == "simulated":
        raise HTTPException(status_code=422, detail="Simulated devices do not use tokens")
    token = generate_device_token()
    d.token_hash = hash_token(token)
    log_event(db, "auth", f"device token rotated for {d.id} by {actor.username}", device_id=d.id)
    db.commit()
    return {"device_id": d.id, "token": token,
            "note": "Store this token in the device firmware now. It is shown only once and stored hashed on the server."}


@router.delete("/{device_id}/token")
def revoke_token(device_id: str, actor: CurrentUser = Depends(require_role("admin")), db: Session = Depends(get_db)):
    d = _get(db, device_id)
    d.token_hash = None
    log_event(db, "auth", f"device token revoked for {d.id} by {actor.username}", device_id=d.id)
    db.commit()
    return {"ok": True}


@router.get("/{device_id}/diagnostics")
def diagnostics(device_id: str, _=Depends(read_access), db: Session = Depends(get_db), limit: int = Query(default=50, ge=1, le=500)):
    d = _get(db, device_id)
    now = datetime.now(timezone.utc)
    day_ago = now - timedelta(hours=24)
    count_24h = db.execute(select(func.count(SensorReading.id)).where(SensorReading.device_id == d.id, SensorReading.measured_at >= day_ago)).scalar_one()
    total = db.execute(select(func.count(SensorReading.id)).where(SensorReading.device_id == d.id)).scalar_one()
    first = db.execute(select(func.min(SensorReading.measured_at)).where(SensorReading.device_id == d.id)).scalar_one()
    events = db.execute(select(SystemEvent).where(SystemEvent.device_id == d.id).order_by(SystemEvent.created_at.desc()).limit(limit)).scalars().all()
    rejected_24h = db.execute(select(func.count(SystemEvent.id)).where(SystemEvent.device_id == d.id, SystemEvent.category == "validation",
                                                                       SystemEvent.created_at >= day_ago)).scalar_one()
    r = last_reading(db, d.id)
    return {
        "device": device_to_dict(d),
        "readings_total": total,
        "readings_24h": count_24h,
        "rejections_24h": rejected_24h,
        "first_reading_at": first.isoformat() if first else None,
        "last_reading": reading_to_dict(r) if r else None,
        "telemetry_age_seconds": int((now - d.last_telemetry_at).total_seconds()) if d.last_telemetry_at else None,
        "events": [{"id": e.id, "created_at": e.created_at.isoformat(), "category": e.category, "level": e.level,
                    "message": e.message, "data": e.data} for e in events],
    }
