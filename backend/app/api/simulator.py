from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from ..config import get_settings
from ..core.deps import CurrentUser, read_access, require_role
from ..db.session import get_db
from ..iot.simulator import SCENARIOS, simulator
from ..schemas.api import ScenarioRequest
from ..services.telemetry import log_event

router = APIRouter(prefix="/api/simulator", tags=["simulator"])


@router.get("/status")
def status(_=Depends(read_access)):
    return {"enabled": get_settings().simulator_enabled, **simulator.status(), "scenarios_available": SCENARIOS}


@router.post("/scenario")
def trigger(body: ScenarioRequest, actor: CurrentUser = Depends(require_role("operator")), db: Session = Depends(get_db)):
    if not simulator.status()["available"]:
        raise HTTPException(status_code=409, detail="Simulator is not running")
    try:
        result = simulator.trigger(body.scenario, body.duration_minutes)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc))
    log_event(db, "simulator", f"scenario '{body.scenario}' triggered by {actor.username}", device_id=simulator.device_id,
              data={"duration_minutes": body.duration_minutes})
    db.commit()
    return result


@router.post("/start")
async def start(_: CurrentUser = Depends(require_role("admin"))):
    await simulator.start()
    return simulator.status()


@router.post("/stop")
async def stop(_: CurrentUser = Depends(require_role("admin"))):
    await simulator.stop()
    return simulator.status()
