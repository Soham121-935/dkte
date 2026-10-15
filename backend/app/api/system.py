from __future__ import annotations

from datetime import datetime, timezone

from fastapi import APIRouter, Depends, Query
from sqlalchemy import select
from sqlalchemy.orm import Session

from .. import __version__
from ..ai.service import ai_service
from ..config import get_settings
from ..core.deps import read_access
from ..db.models import Alert, Device, SystemEvent
from ..db.session import get_db
from ..iot.mqtt import mqtt_status
from ..iot.simulator import simulator
from ..iot.transport import registry
from ..services.notifications import channels_status
from ..services.telemetry import device_to_dict

router = APIRouter(prefix="/api/system", tags=["system"])


def compute_mode(devices: list[Device]) -> dict:
    hardware_online = [d for d in devices if d.kind == "hardware" and d.connection_status == "online" and d.is_enabled]
    sim_online = [d for d in devices if d.kind == "simulated" and d.connection_status == "online" and d.is_enabled]
    if hardware_online:
        return {"mode": "live", "label": "LIVE – hardware telemetry", "detail": f"{len(hardware_online)} hardware device(s) online"
                + (f", {len(sim_online)} simulated device(s) also online" if sim_online else "")}
    if sim_online:
        return {"mode": "demo", "label": "DEMO MODE – simulated data", "detail": "No hardware device online; readings come from the simulator"}
    return {"mode": "disconnected", "label": "DISCONNECTED – no device online", "detail": "No telemetry source is online"}


@router.get("/health")
def health():
    return {"status": "ok", "time": datetime.now(timezone.utc).isoformat(), "version": __version__}


@router.get("/status")
def status(_=Depends(read_access), db: Session = Depends(get_db)):
    settings = get_settings()
    devices = db.execute(select(Device).order_by(Device.created_at)).scalars().all()
    active_alerts = db.execute(select(Alert).where(Alert.status.in_(("active", "acknowledged")))).scalars().all()
    return {
        "app": settings.app_name,
        "version": __version__,
        "environment": settings.app_env,
        "server_time": datetime.now(timezone.utc).isoformat(),
        **compute_mode(devices),
        "devices": [device_to_dict(d) for d in devices],
        "alerts": {"active": sum(1 for a in active_alerts if a.status == "active"),
                   "acknowledged": sum(1 for a in active_alerts if a.status == "acknowledged"),
                   "critical": sum(1 for a in active_alerts if a.severity == "critical")},
        "transports": registry.statuses(),
        "mqtt": mqtt_status(),
        "simulator": {"enabled": settings.simulator_enabled, **simulator.status()},
        "ai": ai_service.status(),
        "notifications": channels_status(),
        "public_read": settings.public_read,
        "open_access": settings.open_access,
    }


@router.get("/events")
def events(
    _=Depends(read_access),
    db: Session = Depends(get_db),
    category: str | None = None,
    device_id: str | None = None,
    level: str | None = None,
    limit: int = Query(default=100, ge=1, le=1000),
):
    stmt = select(SystemEvent).order_by(SystemEvent.created_at.desc()).limit(limit)
    if category:
        stmt = stmt.where(SystemEvent.category == category)
    if device_id:
        stmt = stmt.where(SystemEvent.device_id == device_id)
    if level:
        stmt = stmt.where(SystemEvent.level == level)
    return [{"id": e.id, "created_at": e.created_at.isoformat(), "device_id": e.device_id, "category": e.category,
             "level": e.level, "message": e.message, "data": e.data} for e in db.execute(stmt).scalars()]
