from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..core.deps import CurrentUser, read_access, require_role
from ..db.models import CultivationBatch, Device, Prediction
from ..db.session import get_db
from ..services import prediction
from ..services.pipeline import pipeline

router = APIRouter(prefix="/api/predictions", tags=["predictions"])


def _device(db: Session, device_id: str) -> Device:
    d = db.get(Device, device_id)
    if d is None:
        raise HTTPException(status_code=404, detail="Device not found")
    return d


@router.get("/forecast")
def forecast(device_id: str, _=Depends(read_access), db: Session = Depends(get_db), window_minutes: int = Query(default=60, ge=20, le=720)):
    _device(db, device_id)
    return prediction.environmental_forecast(db, device_id, window_minutes=window_minutes)


@router.get("/stage")
def stage(batch_id: int, _=Depends(read_access), db: Session = Depends(get_db)):
    b = db.get(CultivationBatch, batch_id)
    if b is None:
        raise HTTPException(status_code=404, detail="Batch not found")
    return prediction.stage_estimate(db, b)


@router.get("/anomalies")
def anomalies(device_id: str, _=Depends(read_access), db: Session = Depends(get_db), hours: int = Query(default=24, ge=1, le=24 * 30)):
    d = _device(db, device_id)
    return prediction.detect_anomalies(db, d, hours=hours)


@router.get("/recommendations")
def recommendations(device_id: str, _=Depends(read_access), db: Session = Depends(get_db)):
    d = _device(db, device_id)
    return prediction.recommendations(db, d)


@router.get("/accuracy")
def accuracy(device_id: str, _=Depends(read_access), db: Session = Depends(get_db), days: int = Query(default=7, ge=1, le=90)):
    _device(db, device_id)
    return prediction.forecast_accuracy(db, device_id, days=days)


@router.get("/history")
def history(
    _=Depends(read_access),
    db: Session = Depends(get_db),
    device_id: str | None = None,
    batch_id: int | None = None,
    kind: str | None = None,
    evaluated: bool | None = None,
    limit: int = Query(default=100, ge=1, le=1000),
):
    stmt = select(Prediction).order_by(Prediction.generated_at.desc()).limit(limit)
    if device_id:
        stmt = stmt.where(Prediction.device_id == device_id)
    if batch_id:
        stmt = stmt.where(Prediction.batch_id == batch_id)
    if kind:
        stmt = stmt.where(Prediction.kind == kind)
    if evaluated is True:
        stmt = stmt.where(Prediction.evaluated_at.isnot(None))
    elif evaluated is False:
        stmt = stmt.where(Prediction.evaluated_at.is_(None))
    return [prediction.prediction_to_dict(p) for p in db.execute(stmt).scalars()]


@router.post("/run")
async def run_now(_: CurrentUser = Depends(require_role("operator"))):
    return await pipeline.prediction_tick()
