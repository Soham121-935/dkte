from __future__ import annotations

import re
import uuid
from datetime import datetime, timezone
from pathlib import Path

from fastapi import APIRouter, Depends, File, HTTPException, Query, UploadFile
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..config import get_settings
from ..core.deps import CurrentUser, read_access, require_role
from ..db.models import BatchObservation, CultivationBatch, CultivationProfile, Device, StageEvent
from ..db.session import get_db
from ..schemas.api import BatchCreate, BatchUpdate, ObservationCreate, ProfileCreate, ProfileUpdate, StageConfirm
from ..services import analytics, prediction
from ..services.control import stage_definition
from ..services.profiles import profile_to_dict
from ..services.telemetry import log_event
from .common import parse_range

router = APIRouter(prefix="/api", tags=["batches"])

ALLOWED_IMAGE_TYPES = {"image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp"}
MAX_IMAGE_BYTES = 8 * 1024 * 1024


# ------------------------------------------------------------------ helpers
def batch_to_dict(b: CultivationBatch, db: Session | None = None) -> dict:
    data = {
        "id": b.id, "code": b.code, "name": b.name, "species": b.species, "strain": b.strain, "substrate_type": b.substrate_type,
        "substrate_details": b.substrate_details, "inoculation_date": b.inoculation_date.isoformat() if b.inoculation_date else None,
        "spawn_details": b.spawn_details, "profile_id": b.profile_id, "profile": profile_to_dict(b.profile) if b.profile else None,
        "device_id": b.device_id, "status": b.status, "current_stage_key": b.current_stage_key,
        "target_overrides": b.target_overrides or {}, "notes": b.notes,
        "expected_harvest_start": b.expected_harvest_start.isoformat() if b.expected_harvest_start else None,
        "expected_harvest_end": b.expected_harvest_end.isoformat() if b.expected_harvest_end else None,
        "started_at": b.started_at.isoformat() if b.started_at else None, "ended_at": b.ended_at.isoformat() if b.ended_at else None,
        "outcome": b.outcome, "is_demo": b.is_demo, "created_at": b.created_at.isoformat(), "updated_at": b.updated_at.isoformat(),
    }
    if b.profile:
        sdef = stage_definition(b.profile.stages, b.current_stage_key)
        data["current_stage_name"] = sdef["name"] if sdef else b.current_stage_key
        data["effective_targets"] = effective_targets(b)
    else:
        data["current_stage_name"] = b.current_stage_key
        data["effective_targets"] = None
    return data


def effective_targets(b: CultivationBatch) -> dict | None:
    if not b.profile:
        return None
    sdef = stage_definition(b.profile.stages, b.current_stage_key)
    if not sdef:
        return None
    targets = dict(sdef.get("targets") or {})
    source = "profile_reference" if b.profile.source == "reference" else "profile_user"
    overrides = (b.target_overrides or {}).get(b.current_stage_key or "", {})
    if overrides:
        targets.update({k: v for k, v in overrides.items() if v is not None})
        source = "batch_override"
    return {**targets, "source": source, "stage_key": b.current_stage_key}


def observation_to_dict(o: BatchObservation) -> dict:
    return {"id": o.id, "batch_id": o.batch_id, "observed_at": o.observed_at.isoformat(), "kind": o.kind, "note": o.note,
            "stage_key": o.stage_key, "image_url": f"/api/uploads/{o.image_path}" if o.image_path else None,
            "recorded_by": o.recorded_by, "data": o.data, "created_at": o.created_at.isoformat()}


def stage_event_to_dict(e: StageEvent) -> dict:
    return {"id": e.id, "batch_id": e.batch_id, "stage_key": e.stage_key, "started_at": e.started_at.isoformat(), "source": e.source,
            "confirmed_by": e.confirmed_by, "note": e.note}


def _batch(db: Session, batch_id: int) -> CultivationBatch:
    b = db.get(CultivationBatch, batch_id)
    if b is None:
        raise HTTPException(status_code=404, detail="Batch not found")
    return b


def _next_code(db: Session) -> str:
    year = datetime.now(timezone.utc).year
    count = db.execute(select(func.count(CultivationBatch.id))).scalar_one()
    for i in range(count + 1, count + 1000):
        code = f"B-{year}-{i:03d}"
        if db.execute(select(CultivationBatch.id).where(CultivationBatch.code == code)).first() is None:
            return code
    return f"B-{year}-{uuid.uuid4().hex[:6]}"


def _validate_refs(db: Session, profile_id: int | None, device_id: str | None) -> None:
    if profile_id is not None and db.get(CultivationProfile, profile_id) is None:
        raise HTTPException(status_code=422, detail="profile_id does not exist")
    if device_id is not None and db.get(Device, device_id) is None:
        raise HTTPException(status_code=422, detail="device_id does not exist")


# ----------------------------------------------------------------- profiles
@router.get("/profiles")
def list_profiles(_=Depends(read_access), db: Session = Depends(get_db)):
    return [profile_to_dict(p) for p in db.execute(select(CultivationProfile).order_by(CultivationProfile.is_builtin.desc(), CultivationProfile.name)).scalars()]


@router.get("/profiles/{profile_id}")
def get_profile(profile_id: int, _=Depends(read_access), db: Session = Depends(get_db)):
    p = db.get(CultivationProfile, profile_id)
    if p is None:
        raise HTTPException(status_code=404, detail="Profile not found")
    return profile_to_dict(p)


@router.post("/profiles", status_code=201)
def create_profile(body: ProfileCreate, actor: CurrentUser = Depends(require_role("operator")), db: Session = Depends(get_db)):
    p = CultivationProfile(**body.model_dump(exclude={"stages"}), stages=[s.model_dump() for s in body.stages], is_builtin=False)
    if p.source == "reference" and not p.source_notes:
        raise HTTPException(status_code=422, detail="reference profiles must document their source in source_notes")
    db.add(p)
    log_event(db, "system", f"profile '{p.name}' created by {actor.username}")
    db.commit()
    return profile_to_dict(p)


@router.post("/profiles/{profile_id}/clone", status_code=201)
def clone_profile(profile_id: int, actor: CurrentUser = Depends(require_role("operator")), db: Session = Depends(get_db)):
    src = db.get(CultivationProfile, profile_id)
    if src is None:
        raise HTTPException(status_code=404, detail="Profile not found")
    p = CultivationProfile(name=f"{src.name} (copy)", species=src.species, strain=src.strain, cultivation_method=src.cultivation_method,
                           substrate_type=src.substrate_type, source="user",
                           source_notes=f"Cloned from '{src.name}' by {actor.username}. Values are user-editable; original source: {src.source}.",
                           stages=[dict(s) for s in src.stages], is_builtin=False)
    db.add(p)
    db.commit()
    return profile_to_dict(p)


@router.patch("/profiles/{profile_id}")
def update_profile(profile_id: int, body: ProfileUpdate, actor: CurrentUser = Depends(require_role("operator")), db: Session = Depends(get_db)):
    p = db.get(CultivationProfile, profile_id)
    if p is None:
        raise HTTPException(status_code=404, detail="Profile not found")
    if p.is_builtin and p.source == "reference":
        raise HTTPException(status_code=409, detail="Built-in reference profiles are read-only; clone it to edit")
    data = body.model_dump(exclude_none=True)
    if "stages" in data:
        data["stages"] = [s.model_dump() for s in body.stages or []]
        keys = [s["key"] for s in data["stages"]]
        if len(keys) != len(set(keys)):
            raise HTTPException(status_code=422, detail="stage keys must be unique")
    for k, v in data.items():
        setattr(p, k, v)
    db.commit()
    return profile_to_dict(p)


@router.delete("/profiles/{profile_id}", status_code=204)
def delete_profile(profile_id: int, _: CurrentUser = Depends(require_role("admin")), db: Session = Depends(get_db)):
    p = db.get(CultivationProfile, profile_id)
    if p is None:
        raise HTTPException(status_code=404, detail="Profile not found")
    if p.is_builtin:
        raise HTTPException(status_code=409, detail="Built-in profiles cannot be deleted")
    in_use = db.execute(select(func.count(CultivationBatch.id)).where(CultivationBatch.profile_id == p.id)).scalar_one()
    if in_use:
        raise HTTPException(status_code=409, detail=f"Profile is used by {in_use} batch(es)")
    db.delete(p)
    db.commit()
    return None


# ------------------------------------------------------------------ batches
@router.get("/batches")
def list_batches(_=Depends(read_access), db: Session = Depends(get_db), status: str | None = None, device_id: str | None = None):
    stmt = select(CultivationBatch).order_by(CultivationBatch.created_at.desc())
    if status:
        stmt = stmt.where(CultivationBatch.status == status)
    if device_id:
        stmt = stmt.where(CultivationBatch.device_id == device_id)
    return [batch_to_dict(b) for b in db.execute(stmt).scalars().unique()]


@router.post("/batches", status_code=201)
def create_batch(body: BatchCreate, actor: CurrentUser = Depends(require_role("operator")), db: Session = Depends(get_db)):
    _validate_refs(db, body.profile_id, body.device_id)
    profile = db.get(CultivationProfile, body.profile_id) if body.profile_id else None
    initial_key = body.initial_stage_key
    if profile:
        keys = [s["key"] for s in profile.stages]
        if initial_key is None:
            initial_key = "inoculation" if "inoculation" in keys else keys[0]
        elif initial_key not in keys:
            raise HTTPException(status_code=422, detail=f"initial_stage_key must be one of {keys}")
        for k in body.target_overrides:
            if k not in keys:
                raise HTTPException(status_code=422, detail=f"target_overrides key '{k}' is not a stage of the profile")
    if body.device_id and body.status == "active":
        other = db.execute(select(CultivationBatch).where(CultivationBatch.device_id == body.device_id, CultivationBatch.status == "active")).scalar_one_or_none()
        if other is not None:
            raise HTTPException(status_code=409, detail=f"Device already has an active batch ({other.code}). Archive or reassign it first.")
    now = datetime.now(timezone.utc)
    b = CultivationBatch(
        code=_next_code(db), name=body.name, species=body.species, strain=body.strain, substrate_type=body.substrate_type,
        substrate_details=body.substrate_details, inoculation_date=body.inoculation_date, spawn_details=body.spawn_details,
        profile_id=body.profile_id, device_id=body.device_id, status=body.status, current_stage_key=initial_key,
        target_overrides={k: v.model_dump(exclude_none=True) for k, v in body.target_overrides.items()}, notes=body.notes,
        expected_harvest_start=body.expected_harvest_start, expected_harvest_end=body.expected_harvest_end,
        started_at=body.inoculation_date or now,
    )
    db.add(b)
    db.flush()
    if initial_key:
        db.add(StageEvent(batch_id=b.id, stage_key=initial_key, started_at=body.inoculation_date or now, source="initial",
                          confirmed_by=actor.username, note="Initial stage set at batch creation."))
    log_event(db, "system", f"batch {b.code} created by {actor.username}")
    db.commit()
    db.refresh(b)
    return batch_to_dict(b)


@router.get("/batches/{batch_id}")
def get_batch(batch_id: int, _=Depends(read_access), db: Session = Depends(get_db)):
    b = _batch(db, batch_id)
    data = batch_to_dict(b)
    data["observations"] = [observation_to_dict(o) for o in sorted(b.observations, key=lambda o: o.observed_at, reverse=True)]
    data["stage_events"] = [stage_event_to_dict(e) for e in sorted(b.stage_events, key=lambda e: e.started_at)]
    return data


@router.patch("/batches/{batch_id}")
def update_batch(batch_id: int, body: BatchUpdate, actor: CurrentUser = Depends(require_role("operator")), db: Session = Depends(get_db)):
    b = _batch(db, batch_id)
    data = body.model_dump(exclude_unset=True)
    _validate_refs(db, data.get("profile_id"), data.get("device_id"))
    new_device = data.get("device_id", b.device_id)
    new_status = data.get("status", b.status)
    if new_device and new_status == "active":
        other = db.execute(select(CultivationBatch).where(CultivationBatch.device_id == new_device, CultivationBatch.status == "active",
                                                          CultivationBatch.id != b.id)).scalar_one_or_none()
        if other is not None:
            raise HTTPException(status_code=409, detail=f"Device already has an active batch ({other.code})")
    if "target_overrides" in data and body.target_overrides is not None:
        data["target_overrides"] = {k: v.model_dump(exclude_none=True) for k, v in body.target_overrides.items()}
    for k, v in data.items():
        setattr(b, k, v)
    if new_status in ("harvested", "failed", "archived") and b.ended_at is None:
        b.ended_at = datetime.now(timezone.utc)
    if new_status == "active":
        b.ended_at = None
    log_event(db, "system", f"batch {b.code} updated by {actor.username}", data={"fields": list(data.keys())})
    db.commit()
    db.refresh(b)
    return batch_to_dict(b)


@router.delete("/batches/{batch_id}", status_code=204)
def delete_batch(batch_id: int, actor: CurrentUser = Depends(require_role("admin")), db: Session = Depends(get_db)):
    b = _batch(db, batch_id)
    log_event(db, "system", f"batch {b.code} deleted by {actor.username}")
    db.delete(b)
    db.commit()
    return None


# ----------------------------------------------------------------- timeline
@router.get("/batches/{batch_id}/timeline")
def timeline(batch_id: int, _=Depends(read_access), db: Session = Depends(get_db)):
    b = _batch(db, batch_id)
    events = sorted(b.stage_events, key=lambda e: e.started_at)
    stages = (b.profile.stages if b.profile else []) or []
    estimate = prediction.stage_estimate(db, b)
    now = datetime.now(timezone.utc)
    by_key: dict[str, list[StageEvent]] = {}
    for e in events:
        by_key.setdefault(e.stage_key, []).append(e)
    items = []
    current_key = b.current_stage_key
    reached_current = False
    for i, s in enumerate(stages):
        evs = by_key.get(s["key"], [])
        started = evs[0].started_at if evs else None
        ended = None
        if evs:
            later = [e for e in events if e.started_at > evs[-1].started_at and e.stage_key != s["key"]]
            ended = later[0].started_at if later else None
        if s["key"] == current_key:
            state = "current"
            reached_current = True
        elif evs and not reached_current:
            state = "completed"
        elif evs:
            state = "completed"
        else:
            state = "upcoming"
        items.append({
            "index": i, **s, "state": state, "started_at": started.isoformat() if started else None,
            "ended_at": ended.isoformat() if ended else None,
            "actual_duration_days": round(((ended or now) - started).total_seconds() / 86400.0, 2) if started else None,
            "events": [stage_event_to_dict(e) for e in evs],
            "observations": [observation_to_dict(o) for o in b.observations if o.stage_key == s["key"] or
                             (started and o.observed_at >= started and (ended is None or o.observed_at < ended) and not o.stage_key)],
        })
    return {"batch": batch_to_dict(b), "stages": items, "events": [stage_event_to_dict(e) for e in events], "estimate": estimate}


@router.post("/batches/{batch_id}/stage", status_code=201)
def confirm_stage(batch_id: int, body: StageConfirm, actor: CurrentUser = Depends(require_role("operator")), db: Session = Depends(get_db)):
    b = _batch(db, batch_id)
    stages = (b.profile.stages if b.profile else []) or []
    keys = [s["key"] for s in stages]
    if stages and body.stage_key not in keys:
        raise HTTPException(status_code=422, detail=f"stage_key must be one of {keys}")
    started_at = body.started_at or datetime.now(timezone.utc)
    if started_at > datetime.now(timezone.utc):
        raise HTTPException(status_code=422, detail="A stage cannot start in the future")
    last = max(b.stage_events, key=lambda e: e.started_at, default=None)
    if last and started_at < last.started_at:
        raise HTTPException(status_code=422, detail=f"started_at must be after the previous stage start ({last.started_at.isoformat()})")
    if last and last.stage_key == body.stage_key:
        raise HTTPException(status_code=409, detail="Batch is already in this stage")
    ev = StageEvent(batch_id=b.id, stage_key=body.stage_key, started_at=started_at, source="manual", confirmed_by=actor.username, note=body.note)
    db.add(ev)
    b.current_stage_key = body.stage_key
    db.add(BatchObservation(batch_id=b.id, observed_at=started_at, kind="stage_confirmation", stage_key=body.stage_key,
                            note=body.note or f"Stage '{body.stage_key}' confirmed by {actor.username}.", recorded_by=actor.username))
    if body.stage_key == "harvest" and b.status == "active":
        pass  # grower decides when to close the batch via status
    db.flush()
    scored = prediction.evaluate_stage_predictions(db, b, ev)
    log_event(db, "system", f"batch {b.code} stage confirmed: {body.stage_key} by {actor.username}", data={"predictions_scored": scored})
    db.commit()
    est = prediction.stage_estimate(db, b)
    return {"event": stage_event_to_dict(ev), "batch": batch_to_dict(b), "estimate": est, "predictions_scored": scored}


# ------------------------------------------------------------- observations
@router.get("/batches/{batch_id}/observations")
def list_observations(batch_id: int, _=Depends(read_access), db: Session = Depends(get_db)):
    b = _batch(db, batch_id)
    return [observation_to_dict(o) for o in sorted(b.observations, key=lambda o: o.observed_at, reverse=True)]


@router.post("/batches/{batch_id}/observations", status_code=201)
def add_observation(batch_id: int, body: ObservationCreate, actor: CurrentUser = Depends(require_role("operator")), db: Session = Depends(get_db)):
    b = _batch(db, batch_id)
    observed_at = body.observed_at or datetime.now(timezone.utc)
    if observed_at > datetime.now(timezone.utc):
        raise HTTPException(status_code=422, detail="observed_at cannot be in the future")
    o = BatchObservation(batch_id=b.id, observed_at=observed_at, kind=body.kind, note=body.note, stage_key=body.stage_key or b.current_stage_key,
                         data=body.data, recorded_by=actor.username)
    db.add(o)
    if body.kind == "harvest" and body.data:
        outcome = dict(b.outcome or {})
        outcome.update({k: v for k, v in body.data.items() if k in ("yield_g", "quality", "flush")})
        b.outcome = outcome
    db.commit()
    return observation_to_dict(o)


@router.post("/batches/{batch_id}/observations/{observation_id}/image")
async def upload_image(batch_id: int, observation_id: int, file: UploadFile = File(...),
                       _: CurrentUser = Depends(require_role("operator")), db: Session = Depends(get_db)):
    b = _batch(db, batch_id)
    o = db.get(BatchObservation, observation_id)
    if o is None or o.batch_id != b.id:
        raise HTTPException(status_code=404, detail="Observation not found")
    ext = ALLOWED_IMAGE_TYPES.get(file.content_type or "")
    if ext is None:
        raise HTTPException(status_code=415, detail="Only JPEG, PNG or WebP images are accepted")
    data = await file.read()
    if len(data) > MAX_IMAGE_BYTES:
        raise HTTPException(status_code=413, detail="Image larger than 8 MB")
    upload_dir = Path(get_settings().upload_dir) / f"batch-{b.id}"
    upload_dir.mkdir(parents=True, exist_ok=True)
    name = re.sub(r"[^a-zA-Z0-9_\-]", "", f"obs{o.id}-{uuid.uuid4().hex[:8]}") + ext
    (upload_dir / name).write_bytes(data)
    o.image_path = f"batch-{b.id}/{name}"
    db.commit()
    return observation_to_dict(o)


@router.delete("/batches/{batch_id}/observations/{observation_id}", status_code=204)
def delete_observation(batch_id: int, observation_id: int, _: CurrentUser = Depends(require_role("operator")), db: Session = Depends(get_db)):
    b = _batch(db, batch_id)
    o = db.get(BatchObservation, observation_id)
    if o is None or o.batch_id != b.id:
        raise HTTPException(status_code=404, detail="Observation not found")
    db.delete(o)
    db.commit()
    return None


# ------------------------------------------------------- readings and report
@router.get("/batches/{batch_id}/readings")
def batch_readings(batch_id: int, _=Depends(read_access), db: Session = Depends(get_db), max_points: int = Query(default=400, ge=20, le=5000)):
    b = _batch(db, batch_id)
    if not b.device_id:
        return {"batch_id": b.id, "device_id": None, "points": [], "note": "No device linked to this batch"}
    start = b.started_at or b.inoculation_date or b.created_at
    end = b.ended_at or datetime.now(timezone.utc)
    bucket = analytics.choose_bucket_seconds(start, end, max_points)
    rows = analytics.fetch_readings(db, b.device_id, start, end)
    return {"batch_id": b.id, "device_id": b.device_id, "from": start.isoformat(), "to": end.isoformat(), "bucket_seconds": bucket,
            "n_readings": len(rows), "sources": sorted({r.source for r in rows}), "points": analytics.bucketize(rows, bucket),
            "targets": effective_targets(b)}


@router.get("/batches/{batch_id}/report")
def batch_report(batch_id: int, _=Depends(read_access), db: Session = Depends(get_db)):
    b = _batch(db, batch_id)
    return analytics.batch_report(db, b)
