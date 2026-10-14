from __future__ import annotations

from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import Response
from sqlalchemy.orm import Session

from ..core.deps import read_access
from ..db.models import CultivationBatch, Device
from ..db.session import get_db
from ..services import analytics
from ..services.control import resolve_targets
from .common import parse_range

router = APIRouter(prefix="/api/analytics", tags=["analytics"])


def _device(db: Session, device_id: str) -> Device:
    d = db.get(Device, device_id)
    if d is None:
        raise HTTPException(status_code=404, detail="Device not found")
    return d


@router.get("/summary")
def summary(device_id: str, _=Depends(read_access), db: Session = Depends(get_db), rng: tuple[datetime, datetime] = Depends(parse_range)):
    d = _device(db, device_id)
    start, end = rng
    return analytics.summarize(db, d.id, start, end, resolve_targets(db, d))


@router.get("/periodic")
def periodic(device_id: str, _=Depends(read_access), db: Session = Depends(get_db), rng: tuple[datetime, datetime] = Depends(parse_range),
             period: str = Query(default="day", pattern="^(day|week)$")):
    d = _device(db, device_id)
    start, end = rng
    return {"device_id": d.id, "period": period, "from": start.isoformat(), "to": end.isoformat(),
            "items": analytics.daily_summaries(db, d.id, start, end, resolve_targets(db, d), period)}


@router.get("/periodic.csv")
def periodic_csv(device_id: str, _=Depends(read_access), db: Session = Depends(get_db), rng: tuple[datetime, datetime] = Depends(parse_range),
                 period: str = Query(default="day", pattern="^(day|week)$")):
    d = _device(db, device_id)
    start, end = rng
    items = analytics.daily_summaries(db, d.id, start, end, resolve_targets(db, d), period)
    return Response(content=analytics.summaries_csv(items), media_type="text/csv",
                    headers={"Content-Disposition": f'attachment; filename="myco_{d.id}_{period}_summary.csv"'})


@router.get("/stage-environment")
def stage_environment(batch_id: int, _=Depends(read_access), db: Session = Depends(get_db)):
    b = db.get(CultivationBatch, batch_id)
    if b is None:
        raise HTTPException(status_code=404, detail="Batch not found")
    return analytics.stage_environment_table(db, b)
