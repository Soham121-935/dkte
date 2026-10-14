from __future__ import annotations

from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..core.deps import CurrentUser, read_access, require_role
from ..core.events import bus
from ..db.models import ActuatorCommand, ActuatorStatusEvent, Device
from ..db.session import get_db
from ..schemas.api import CommandRequest, ControlConfigUpdate, ModeChange
from ..services import control
from ..services.pipeline import command_to_dict
from ..services.telemetry import device_to_dict, last_reading, log_event, reading_to_dict

router = APIRouter(prefix="/api/control", tags=["control"])


def _device(db: Session, device_id: str) -> Device:
    d = db.get(Device, device_id)
    if d is None:
        raise HTTPException(status_code=404, detail="Device not found")
    return d


def _status_event_dict(e: ActuatorStatusEvent) -> dict:
    return {"id": e.id, "device_id": e.device_id, "actuator": e.actuator, "state": e.state, "observed_at": e.observed_at.isoformat(),
            "source": e.source, "command_id": e.command_id}


@router.get("/{device_id}")
def control_state(device_id: str, _=Depends(read_access), db: Session = Depends(get_db)):
    d = _device(db, device_id)
    reading = last_reading(db, d.id)
    evaluation = control.evaluate(db, d, reading)  # read-only preview of what the service would do now
    commands = db.execute(select(ActuatorCommand).where(ActuatorCommand.device_id == d.id).order_by(ActuatorCommand.created_at.desc()).limit(25)).scalars().all()
    events = db.execute(select(ActuatorStatusEvent).where(ActuatorStatusEvent.device_id == d.id).order_by(ActuatorStatusEvent.observed_at.desc()).limit(25)).scalars().all()
    return {
        "device": device_to_dict(d),
        "reading": reading_to_dict(reading) if reading else None,
        "targets": control.resolve_targets(db, d),
        "config": control.effective_config(db, d),
        "mode": d.control_mode,
        "modes": list(control.MODES),
        "evaluation_preview": evaluation.to_dict(),
        "last_evaluation": (d.control_state or {}).get("last_evaluation"),
        "actuators": d.actuator_state or {},
        "recent_commands": [command_to_dict(c) for c in commands],
        "recent_status_events": [_status_event_dict(e) for e in events],
        "safety_notes": [
            "Automatic heating is disabled whenever the temperature reading is stale or invalid (safe state).",
            f"Absolute heater cutoff at {control.effective_config(db, d)['heater_absolute_max_temp_c']} °C; maximum continuous heater runtime "
            f"{int(control.effective_config(db, d)['heater_max_runtime_seconds']) // 60} min followed by a cooldown.",
            "A sent command does not prove the actuator switched – wait for the confirmed state reported by the device.",
            "An independent hardware thermal cutoff/fuse for the heater is required; software interlocks are not sufficient on their own.",
        ],
    }


@router.post("/{device_id}/mode")
async def set_mode(device_id: str, body: ModeChange, actor: CurrentUser = Depends(require_role("operator")), db: Session = Depends(get_db)):
    d = _device(db, device_id)
    if body.mode in ("auto", "manual") and d.kind == "hardware" and not d.token_hash and d.transport != "mqtt":
        raise HTTPException(status_code=409, detail="Device has no token; generate one in Device Management first")
    control.set_mode(db, d, body.mode, actor.username)
    ev = control.run_for_device(db, d, None)
    db.commit()
    await bus.publish("device_status", {"device": device_to_dict(d)})
    await bus.publish("control", {"device_id": d.id, "evaluation": ev.to_dict(), "device": device_to_dict(d)})
    return {"device": device_to_dict(d), "evaluation": ev.to_dict()}


@router.post("/{device_id}/command", status_code=201)
async def manual_command(device_id: str, body: CommandRequest, actor: CurrentUser = Depends(require_role("operator")), db: Session = Depends(get_db)):
    d = _device(db, device_id)
    if d.control_mode != "manual":
        raise HTTPException(status_code=409, detail=f"Manual commands require control mode 'manual' (current: '{d.control_mode}')")
    cmd = control.issue_command(db, d, body.actuator, body.state, reason=body.reason, origin="manual", requested_by=actor.username)
    db.commit()
    payload = command_to_dict(cmd)
    await bus.publish("command", {"command": payload, "device": device_to_dict(d)})
    if cmd.status == "rejected":
        raise HTTPException(status_code=422, detail={"message": cmd.error, "command": payload})
    return payload


@router.patch("/{device_id}/config")
async def update_config(device_id: str, body: ControlConfigUpdate, actor: CurrentUser = Depends(require_role("operator")), db: Session = Depends(get_db)):
    d = _device(db, device_id)
    cfg = dict(d.control_config or {})
    data = body.model_dump(exclude_unset=True)
    targets = data.pop("targets", None)
    for k, v in data.items():
        if v is None:
            cfg.pop(k, None)
        else:
            cfg[k] = v
    if targets is not None:
        cfg["targets"] = {k: v for k, v in targets.items() if v is not None}
    d.control_config = cfg
    log_event(db, "control", f"control configuration updated by {actor.username}", device_id=d.id, data=data | ({"targets": targets} if targets else {}))
    db.commit()
    await bus.publish("device_status", {"device": device_to_dict(d)})
    return {"device": device_to_dict(d), "config": control.effective_config(db, d), "targets": control.resolve_targets(db, d)}


@router.post("/{device_id}/evaluate")
async def evaluate_now(device_id: str, actor: CurrentUser = Depends(require_role("operator")), db: Session = Depends(get_db)):
    d = _device(db, device_id)
    ev = control.run_for_device(db, d, None, datetime.now(timezone.utc))
    db.commit()
    await bus.publish("control", {"device_id": d.id, "evaluation": ev.to_dict(), "device": device_to_dict(d)})
    return ev.to_dict()


@router.get("/{device_id}/commands")
def list_commands(device_id: str, _=Depends(read_access), db: Session = Depends(get_db), limit: int = Query(default=100, ge=1, le=1000)):
    _device(db, device_id)
    rows = db.execute(select(ActuatorCommand).where(ActuatorCommand.device_id == device_id).order_by(ActuatorCommand.created_at.desc()).limit(limit)).scalars().all()
    return [command_to_dict(c) for c in rows]


@router.get("/{device_id}/events")
def list_status_events(device_id: str, _=Depends(read_access), db: Session = Depends(get_db), limit: int = Query(default=100, ge=1, le=1000)):
    _device(db, device_id)
    rows = db.execute(select(ActuatorStatusEvent).where(ActuatorStatusEvent.device_id == device_id).order_by(ActuatorStatusEvent.observed_at.desc()).limit(limit)).scalars().all()
    return [_status_event_dict(e) for e in rows]
