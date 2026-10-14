from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..core.deps import CurrentUser, read_access, require_role
from ..core.events import bus
from ..db.models import Alert
from ..db.session import get_db
from ..schemas.api import AlertAction
from ..services import settings_store
from ..services.alerts import alert_to_dict, engine
from ..services.notifications import channels_status

router = APIRouter(prefix="/api/alerts", tags=["alerts"])


@router.get("")
def list_alerts(
    _=Depends(read_access),
    db: Session = Depends(get_db),
    status: str | None = Query(default=None, description="active|acknowledged|resolved|open (active+acknowledged)"),
    device_id: str | None = None,
    severity: str | None = None,
    limit: int = Query(default=100, ge=1, le=1000),
):
    stmt = select(Alert).order_by(Alert.opened_at.desc()).limit(limit)
    if status == "open":
        stmt = stmt.where(Alert.status.in_(("active", "acknowledged")))
    elif status:
        stmt = stmt.where(Alert.status == status)
    if device_id:
        stmt = stmt.where(Alert.device_id == device_id)
    if severity:
        stmt = stmt.where(Alert.severity == severity)
    return [alert_to_dict(a) for a in db.execute(stmt).scalars()]


@router.get("/summary")
def summary(_=Depends(read_access), db: Session = Depends(get_db)):
    rows = db.execute(select(Alert.status, Alert.severity, func.count(Alert.id)).group_by(Alert.status, Alert.severity)).all()
    out = {"by_status": {}, "by_severity_open": {}, "total": 0}
    for status, severity, count in rows:
        out["by_status"][status] = out["by_status"].get(status, 0) + count
        if status in ("active", "acknowledged"):
            out["by_severity_open"][severity] = out["by_severity_open"].get(severity, 0) + count
        out["total"] += count
    out["thresholds"] = settings_store.get_section(db, "alerts")
    return out


@router.get("/channels")
def channels(_=Depends(read_access)):
    return channels_status()


@router.post("/{alert_id}/acknowledge")
async def acknowledge(alert_id: int, body: AlertAction | None = None, actor: CurrentUser = Depends(require_role("operator")), db: Session = Depends(get_db)):
    a = db.get(Alert, alert_id)
    if a is None:
        raise HTTPException(status_code=404, detail="Alert not found")
    engine.acknowledge(db, a, actor.username)
    if body and body.note:
        a.data = {**(a.data or {}), "ack_note": body.note}
    db.commit()
    await bus.publish("alert", {"alert": alert_to_dict(a), "action": "acknowledged"})
    return alert_to_dict(a)


@router.post("/{alert_id}/resolve")
async def resolve(alert_id: int, body: AlertAction | None = None, actor: CurrentUser = Depends(require_role("operator")), db: Session = Depends(get_db)):
    a = db.get(Alert, alert_id)
    if a is None:
        raise HTTPException(status_code=404, detail="Alert not found")
    engine.resolve(db, a, actor.username, reason=(body.note if body and body.note else "resolved by user"))
    db.commit()
    await bus.publish("alert", {"alert": alert_to_dict(a), "action": "resolved"})
    return alert_to_dict(a)
