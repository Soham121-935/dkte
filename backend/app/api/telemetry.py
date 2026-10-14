from __future__ import annotations

from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import Response
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..core.deps import read_access
from ..db.models import Device, SensorReading
from ..db.session import get_db
from ..services import analytics
from ..services.control import resolve_targets
from ..services.telemetry import last_reading, reading_to_dict
from ..services.validation import SENSOR_FIELDS, UNITS
from .common import parse_range

router = APIRouter(prefix="/api/telemetry", tags=["telemetry"])


def _device(db: Session, device_id: str) -> Device:
    d = db.get(Device, device_id)
    if d is None:
        raise HTTPException(status_code=404, detail="Device not found")
    return d


def normalize_reading(r: SensorReading) -> list[dict]:
    """Expand a wide reading row into per-sensor entries."""
    q = r.quality or {}
    out = []
    for field in SENSOR_FIELDS:
        out.append({"device_id": r.device_id, "sensor_type": field, "value": getattr(r, field), "unit": UNITS[field],
                    "measured_at": r.measured_at.isoformat(), "received_at": r.received_at.isoformat() if r.received_at else None,
                    "quality": q.get(field, "unknown"), "source": r.source, "message_id": r.message_id})
    for actuator in ("fan_state", "heater_state", "humidifier_state"):
        out.append({"device_id": r.device_id, "sensor_type": actuator, "value": getattr(r, actuator), "unit": "bool",
                    "measured_at": r.measured_at.isoformat(), "received_at": r.received_at.isoformat() if r.received_at else None,
                    "quality": q.get(actuator, "unknown"), "source": r.source, "message_id": r.message_id})
    return out


@router.get("/latest")
def latest(device_id: str, _=Depends(read_access), db: Session = Depends(get_db)):
    d = _device(db, device_id)
    r = last_reading(db, d.id)
    return {"device_id": d.id, "connection_status": d.connection_status, "reading": reading_to_dict(r) if r else None,
            "sensors": normalize_reading(r) if r else [], "targets": resolve_targets(db, d)}


@router.get("/readings")
def readings(
    device_id: str,
    _=Depends(read_access),
    db: Session = Depends(get_db),
    rng: tuple[datetime, datetime] = Depends(parse_range),
    limit: int = Query(default=200, ge=1, le=5000),
    normalized: bool = False,
):
    _device(db, device_id)
    start, end = rng
    rows = db.execute(
        select(SensorReading).where(SensorReading.device_id == device_id, SensorReading.measured_at >= start, SensorReading.measured_at <= end)
        .order_by(SensorReading.measured_at.desc()).limit(limit)
    ).scalars().all()
    rows.reverse()
    if normalized:
        return {"device_id": device_id, "from": start.isoformat(), "to": end.isoformat(), "items": [e for r in rows for e in normalize_reading(r)]}
    return {"device_id": device_id, "from": start.isoformat(), "to": end.isoformat(), "items": [reading_to_dict(r) for r in rows]}


@router.get("/series")
def series(
    device_id: str,
    _=Depends(read_access),
    db: Session = Depends(get_db),
    rng: tuple[datetime, datetime] = Depends(parse_range),
    max_points: int = Query(default=400, ge=20, le=5000),
):
    d = _device(db, device_id)
    start, end = rng
    bucket = analytics.choose_bucket_seconds(start, end, max_points)
    rows = analytics.fetch_readings(db, device_id, start, end)
    points = analytics.bucketize(rows, bucket)
    sources = sorted({r.source for r in rows})
    return {"device_id": device_id, "from": start.isoformat(), "to": end.isoformat(), "bucket_seconds": bucket,
            "n_readings": len(rows), "sources": sources, "points": points, "targets": resolve_targets(db, d)}


@router.get("/export.csv")
def export_csv(device_id: str, _=Depends(read_access), db: Session = Depends(get_db), rng: tuple[datetime, datetime] = Depends(parse_range)):
    _device(db, device_id)
    start, end = rng
    rows = analytics.fetch_readings(db, device_id, start, end)
    csv_text = analytics.readings_csv(rows)
    filename = f"myco_{device_id}_{start.strftime('%Y%m%dT%H%M')}_{end.strftime('%Y%m%dT%H%M')}.csv"
    return Response(content=csv_text, media_type="text/csv", headers={"Content-Disposition": f'attachment; filename="{filename}"'})
