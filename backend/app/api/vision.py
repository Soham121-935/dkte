"""Camera / phase-recognition API.

Operator-facing (JWT or OPEN_ACCESS):
  GET  /api/vision/status                 camera online?, pending request, last capture, recogniser info
  POST /api/vision/capture-request        the "take a photo now" button – flags the ESP32-CAM
  POST /api/vision/upload                 browser fallback: multipart photo instead of the ESP32-CAM
  GET  /api/vision/captures               recent captures with their results
  POST /api/vision/captures/{id}/apply    apply a (low-confidence) result explicitly
  GET  /api/vision/reference              the card set (species x phases with the profile ranges)
  GET  /api/vision/reference/{key}.jpg    reference image

Device-facing (X-Device-Token of the camera device):
  GET  /api/vision/pending                ESP32-CAM poll: manual request? auto interval?
  POST /api/vision/capture                raw image/jpeg body from the ESP32-CAM
"""
from __future__ import annotations

import asyncio
from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter, Depends, File, HTTPException, Query, Request, UploadFile
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..config import get_settings
from ..core.deps import CurrentUser, get_device_from_token, read_access, require_role
from ..core.events import bus
from ..db.models import CultivationProfile, Device
from ..db.session import get_db
from ..services.profiles import profile_to_dict
from ..vision import matcher, service
from ..vision.reference import PHASES_BY_SPECIES, SPECIES, all_cards, card_by_key, card_to_dict

router = APIRouter(prefix="/api/vision", tags=["camera"])

JPEG_MAGIC = b"\xff\xd8"
PNG_MAGIC = b"\x89PNG"


def _camera_device(device: Device = Depends(get_device_from_token)) -> Device:
    if device.id != get_settings().camera_device_id:
        raise HTTPException(status_code=403, detail="This token does not belong to the camera device")
    return device


def _looks_like_image(data: bytes) -> bool:
    return data.startswith(JPEG_MAGIC) or data.startswith(PNG_MAGIC)


class CaptureRequest(BaseModel):
    device_id: str | None = None  # chamber the result should be applied to (defaults to the hardware chamber)
    note: str | None = None


class ApplyRequest(BaseModel):
    force: bool = False
    device_id: str | None = None


async def _publish_capture(capture_dict: dict[str, Any]) -> None:
    await bus.publish("camera_capture", {"capture": capture_dict})


# ------------------------------------------------------------------ operator side
@router.get("/status")
def status(_=Depends(read_access), db: Session = Depends(get_db)):
    data = service.camera_status(db)
    db.commit()
    return data


@router.post("/capture-request", status_code=202)
def capture_request(body: CaptureRequest | None = None, actor: CurrentUser = Depends(require_role("operator")), db: Session = Depends(get_db)):
    body = body or CaptureRequest()
    target = service.target_device_id(body.device_id)
    if db.get(Device, target) is None:
        raise HTTPException(status_code=404, detail=f"Chamber {target} is not registered")
    service.state.request_manual(actor.username, target)
    online = service.state.online()
    service.log_event(db, "camera", f"manual photo requested by {actor.username} for {target}" + ("" if online else " (camera offline)"),
                      device_id=get_settings().camera_device_id)
    db.commit()
    return {
        "requested": True,
        "camera_online": online,
        "target_device_id": target,
        "message": "The camera will take the photo on its next poll (a few seconds)." if online
        else "Request stored, but the ESP32-CAM has not polled recently – check its power / Wi-Fi, or upload a photo instead.",
    }


@router.delete("/capture-request", status_code=200)
def cancel_capture_request(actor: CurrentUser = Depends(require_role("operator"))):
    service.state.cancel_manual()
    return {"requested": False}


@router.post("/upload", status_code=201)
async def upload(
    file: UploadFile = File(...),
    device_id: str | None = Query(default=None, description="Chamber to apply the result to"),
    apply: bool = Query(default=True, description="Apply a high/medium confidence result to the chamber's batch"),
    actor: CurrentUser = Depends(require_role("operator")),
    db: Session = Depends(get_db),
):
    data = await file.read()
    if not _looks_like_image(data):
        raise HTTPException(status_code=415, detail="Upload a JPEG or PNG photo")
    try:
        capture = await asyncio.to_thread(
            service.store_capture, db, data, source="upload", trigger="upload", camera_device_id=None,
            target=device_id, actor=actor.username, auto_apply=apply,
        )
    except service.VisionError as exc:
        db.rollback()
        raise HTTPException(status_code=exc.status_code, detail=exc.message)
    db.commit()
    db.refresh(capture)
    out = service.capture_to_dict(capture)
    await _publish_capture(out)
    return out


@router.get("/captures")
def captures(limit: int = Query(default=20, ge=1, le=200), _=Depends(read_access), db: Session = Depends(get_db)):
    return [service.capture_to_dict(c) for c in service.list_captures(db, limit)]


@router.get("/captures/{capture_id}")
def capture_detail(capture_id: int, _=Depends(read_access), db: Session = Depends(get_db)):
    c = db.get(service.CameraCapture, capture_id)
    if c is None:
        raise HTTPException(status_code=404, detail="Capture not found")
    return service.capture_to_dict(c)


@router.post("/captures/{capture_id}/apply")
async def apply_capture(capture_id: int, body: ApplyRequest | None = None, actor: CurrentUser = Depends(require_role("operator")), db: Session = Depends(get_db)):
    body = body or ApplyRequest()
    c = db.get(service.CameraCapture, capture_id)
    if c is None:
        raise HTTPException(status_code=404, detail="Capture not found")
    if body.device_id:
        if db.get(Device, body.device_id) is None:
            raise HTTPException(status_code=404, detail=f"Chamber {body.device_id} is not registered")
        c.target_device_id = body.device_id
    try:
        result = service.apply_capture(db, c, actor=actor.username, force=body.force)
    except service.VisionError as exc:
        db.rollback()
        raise HTTPException(status_code=exc.status_code, detail=exc.message)
    db.commit()
    db.refresh(c)
    out = service.capture_to_dict(c)
    await _publish_capture(out)
    return {"capture": out, "result": result}


@router.get("/reference")
def reference(_=Depends(read_access), db: Session = Depends(get_db)):
    """The printable card set with the ranges each phase applies (from the built-in reference profiles)."""
    present = matcher.reference_dir_status()
    profiles = {p.name: p for p in db.execute(select(CultivationProfile)).scalars()}
    species_out = []
    for sp in SPECIES:
        profile = profiles.get(sp.profile_name)
        pdict = profile_to_dict(profile) if profile else None
        phases = []
        for ph in PHASES_BY_SPECIES[sp.key]:
            card = card_by_key(f"{sp.key}_{ph.key}")
            targets = service.stage_targets(profile, ph.stage_key) if profile else {}
            stage = next((s for s in (profile.stages if profile else []) if s.get("key") == ph.stage_key), None)
            phases.append({
                **card_to_dict(card, available=present.get(card.key, False)),
                "stage_name": stage.get("name") if stage else ph.stage_key,
                "targets": targets,
                "typical_duration_days": stage.get("typical_duration_days") if stage else None,
            })
        species_out.append({
            "key": sp.key, "code": sp.code, "common_name": sp.common_name, "latin_name": sp.latin_name,
            "profile_id": profile.id if profile else None, "profile_name": sp.profile_name,
            "profile_source": pdict["source"] if pdict else None, "source_notes": pdict["source_notes"] if pdict else None,
            "phases": phases,
        })
    return {
        "species": species_out,
        "cards": len(all_cards()),
        "images_available": sum(1 for v in present.values() if v),
        "pdf_url": "/api/vision/reference.pdf",
        "qr_format": "MYCO:<species code>:<phase key>",
        "recognition": matcher.get_index(get_settings().camera_min_inliers).info(),
        "note": "The recogniser only knows these printed cards. It is not a general mushroom classifier.",
    }


@router.get("/reference.pdf", include_in_schema=True)
def reference_pdf():
    from pathlib import Path

    pdf = Path(__file__).resolve().parents[3] / "docs" / "mushroom-reference-cards.pdf"
    if not pdf.exists():
        raise HTTPException(status_code=404, detail="docs/mushroom-reference-cards.pdf has not been built (python scripts/build_reference_pdf.py)")
    return FileResponse(str(pdf), media_type="application/pdf", filename="myco-reference-cards.pdf")


@router.get("/reference/{key}.jpg")
def reference_image(key: str):
    card = card_by_key(key)
    if card is None or not card.path.exists():
        raise HTTPException(status_code=404, detail="Reference image not found")
    return FileResponse(str(card.path), media_type="image/jpeg")


# ------------------------------------------------------------------ camera side
@router.get("/pending")
def pending(device: Device = Depends(_camera_device), db: Session = Depends(get_db)):
    """Polled by the ESP32-CAM every few seconds."""
    settings = get_settings()
    now = datetime.now(timezone.utc)
    service.touch_camera_device(db, device, now)
    manual, target = service.state.take_manual()
    db.commit()
    return {
        "capture_now": manual,
        "trigger": "manual" if manual else None,
        "target_device_id": target or service.target_device_id(),
        "auto_interval_seconds": settings.camera_auto_interval_seconds,
        "poll_interval_seconds": 3,
        "server_time": now.isoformat(),
    }


@router.post("/capture", status_code=201)
async def capture(request: Request, device: Device = Depends(_camera_device), db: Session = Depends(get_db)):
    """Raw JPEG body from the ESP32-CAM. Query: trigger=auto|manual, device_id=<chamber>."""
    data = await request.body()
    if not _looks_like_image(data):
        raise HTTPException(status_code=415, detail="Body must be a JPEG (Content-Type: image/jpeg)")
    trigger = request.query_params.get("trigger", "auto")
    if trigger not in ("auto", "manual"):
        trigger = "auto"
    target = request.query_params.get("device_id") or None
    service.touch_camera_device(db, device)
    try:
        cap = await asyncio.to_thread(
            service.store_capture, db, data, source="esp32cam", trigger=trigger, camera_device_id=device.id,
            target=target, actor="esp32cam",
        )
    except service.VisionError as exc:
        db.rollback()
        return JSONResponse(status_code=exc.status_code, content={"detail": exc.message})
    db.commit()
    db.refresh(cap)
    out = service.capture_to_dict(cap)
    await _publish_capture(out)
    return {"id": cap.id, "status": cap.status, "card_key": cap.card_key, "confidence": cap.confidence,
            "applied": cap.applied, "message": out["message"]}
