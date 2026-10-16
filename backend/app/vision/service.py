"""Camera workflow: capture requests, storing photos, recognising the card and
applying the recognised phase to the chamber's batch.

Applying a phase never touches a relay directly.  It only changes the batch's
current stage; the deterministic control service then works towards that
stage's temperature / humidity ranges (with all interlocks) exactly as if a
grower had confirmed the stage by hand.
"""
from __future__ import annotations

import logging
import threading
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..config import get_settings
from ..core.events import bus
from ..db.models import BatchObservation, CameraCapture, CultivationBatch, CultivationProfile, Device, StageEvent
from ..services import control, prediction
from ..services.telemetry import device_to_dict, log_event
from . import matcher
from .reference import ReferenceCard, all_cards, card_by_key, card_to_dict

log = logging.getLogger(__name__)

CAMERA_ONLINE_WINDOW = timedelta(seconds=45)  # the CAM polls every few seconds; silence longer than this = offline
CAPTURE_SUBDIR = "captures"


@dataclass
class CameraState:
    """In-memory state shared between the UI endpoints and the ESP32-CAM poller."""

    manual_pending: bool = False
    manual_requested_at: datetime | None = None
    manual_requested_by: str | None = None
    manual_target_device_id: str | None = None
    last_poll_at: datetime | None = None
    last_capture_at: datetime | None = None
    last_db_touch: datetime | None = None
    lock: threading.Lock = field(default_factory=threading.Lock)

    def request_manual(self, actor: str, target_device_id: str | None) -> None:
        with self.lock:
            self.manual_pending = True
            self.manual_requested_at = datetime.now(timezone.utc)
            self.manual_requested_by = actor
            self.manual_target_device_id = target_device_id

    def take_manual(self) -> tuple[bool, str | None]:
        """Called by the camera poller: returns (pending, target) and clears the flag."""
        with self.lock:
            pending, target = self.manual_pending, self.manual_target_device_id
            self.manual_pending = False
            return pending, target

    def cancel_manual(self) -> None:
        with self.lock:
            self.manual_pending = False

    def online(self, now: datetime | None = None) -> bool:
        now = now or datetime.now(timezone.utc)
        return self.last_poll_at is not None and now - self.last_poll_at <= CAMERA_ONLINE_WINDOW

    def reset(self) -> None:
        with self.lock:
            self.manual_pending = False
            self.manual_requested_at = None
            self.manual_requested_by = None
            self.manual_target_device_id = None
            self.last_poll_at = None
            self.last_capture_at = None
            self.last_db_touch = None


state = CameraState()


class VisionError(Exception):
    def __init__(self, message: str, status_code: int = 400):
        super().__init__(message)
        self.message = message
        self.status_code = status_code


# ----------------------------------------------------------------------- helpers
def target_device_id(explicit: str | None = None) -> str:
    settings = get_settings()
    return explicit or settings.camera_target_device_id or settings.hardware_device_id


def captures_dir() -> Path:
    d = Path(get_settings().upload_dir) / CAPTURE_SUBDIR
    d.mkdir(parents=True, exist_ok=True)
    return d


def capture_to_dict(c: CameraCapture) -> dict[str, Any]:
    card = card_by_key(c.card_key) if c.card_key else None
    return {
        "id": c.id,
        "camera_device_id": c.camera_device_id,
        "target_device_id": c.target_device_id,
        "captured_at": c.captured_at.isoformat() if c.captured_at else None,
        "source": c.source,
        "trigger": c.trigger,
        "image_url": f"/api/uploads/{CAPTURE_SUBDIR}/{c.image_path}",
        "width": c.width,
        "height": c.height,
        "size_bytes": c.size_bytes,
        "status": c.status,
        "method": c.method,
        "confidence": c.confidence,
        "inliers": c.inliers,
        "second_inliers": c.second_inliers,
        "qr_text": c.qr_text,
        "card": card_to_dict(card) if card else None,
        "species_key": c.species_key,
        "phase_key": c.phase_key,
        "stage_key": c.stage_key,
        "message": (c.details or {}).get("message"),
        "candidates": (c.details or {}).get("candidates", []),
        "applied": bool(c.applied),
        "applied_at": c.applied_at.isoformat() if c.applied_at else None,
        "applied_batch_id": c.applied_batch_id,
        "applied_stage_key": c.applied_stage_key,
        "applied_by": c.applied_by,
        "apply_note": c.apply_note,
    }


def touch_camera_device(db: Session, device: Device, now: datetime | None = None) -> None:
    """Record that the ESP32-CAM is alive (throttled to one DB write per ~15 s)."""
    now = now or datetime.now(timezone.utc)
    state.last_poll_at = now
    if state.last_db_touch is not None and now - state.last_db_touch < timedelta(seconds=15) and device.connection_status == "online":
        return
    state.last_db_touch = now
    was = device.connection_status
    device.last_seen_at = now
    device.connection_status = "online"
    db.flush()
    if was != "online":
        log_event(db, "connection", f"camera {device.id} online", device_id=device.id)
        bus.publish_threadsafe("device_status", {"device": device_to_dict(device)})


def profile_for_card(db: Session, card: ReferenceCard) -> CultivationProfile:
    profile = db.execute(select(CultivationProfile).where(CultivationProfile.name == card.species.profile_name)).scalar_one_or_none()
    if profile is None:
        profile = db.execute(select(CultivationProfile).where(CultivationProfile.species == card.species.latin_name)
                             .order_by(CultivationProfile.id)).scalars().first()
    if profile is None:
        raise VisionError(f"No cultivation profile for {card.species.common_name} ({card.species.latin_name}).", 409)
    return profile


def stage_targets(profile: CultivationProfile, stage_key: str) -> dict[str, Any]:
    for s in profile.stages or []:
        if s.get("key") == stage_key:
            return dict(s.get("targets") or {})
    return {}


def _next_batch_code(db: Session) -> str:
    year = datetime.now(timezone.utc).year
    count = db.execute(select(func.count(CultivationBatch.id))).scalar_one()
    for i in range(count + 1, count + 1000):
        code = f"B-{year}-{i:03d}"
        if db.execute(select(CultivationBatch.id).where(CultivationBatch.code == code)).first() is None:
            return code
    return f"B-{year}-{datetime.now(timezone.utc).strftime('%H%M%S')}"


# ----------------------------------------------------------------------- captures
def store_capture(
    db: Session,
    data: bytes,
    *,
    source: str,
    trigger: str,
    camera_device_id: str | None,
    target: str | None,
    actor: str,
    auto_apply: bool | None = None,
) -> CameraCapture:
    settings = get_settings()
    if not data:
        raise VisionError("Empty upload – no image data received.", 422)
    if len(data) > settings.camera_max_upload_bytes:
        raise VisionError(f"Image is larger than {settings.camera_max_upload_bytes // 1024} kB.", 413)

    index = matcher.get_index(settings.camera_min_inliers)
    result = index.match(data)
    if result.status == "unreadable":
        raise VisionError(result.message, 422)

    now = datetime.now(timezone.utc)
    width = height = None
    bgr, _gray = matcher.decode_image(data)
    if bgr is not None:
        height, width = bgr.shape[:2]
    filename = f"{now.strftime('%Y%m%d_%H%M%S_%f')}_{source}.jpg"
    (captures_dir() / filename).write_bytes(data)

    capture = CameraCapture(
        camera_device_id=camera_device_id,
        target_device_id=target_device_id(target),
        captured_at=now,
        source=source,
        trigger=trigger,
        image_path=filename,
        width=width,
        height=height,
        size_bytes=len(data),
        status=result.status,
        method=result.method,
        card_key=result.card.key if result.card else None,
        species_key=result.card.species.key if result.card else None,
        phase_key=result.card.phase.key if result.card else None,
        stage_key=result.card.phase.stage_key if result.card else None,
        confidence=result.confidence,
        inliers=result.inliers,
        second_inliers=result.second_inliers,
        qr_text=result.qr_text,
        details=result.to_dict(),
    )
    db.add(capture)
    db.flush()
    state.last_capture_at = now
    log_event(db, "camera", f"capture #{capture.id} ({source}/{trigger}): {result.status}"
              + (f" {result.card.key} [{result.confidence}, {result.method}]" if result.card else ""),
              device_id=camera_device_id, data={"capture_id": capture.id, "inliers": result.inliers})

    should_apply = settings.camera_auto_apply if auto_apply is None else auto_apply
    if should_apply and result.status == "matched" and result.confidence in ("high", "medium"):
        try:
            apply_capture(db, capture, actor=actor)
        except VisionError as exc:
            capture.apply_note = f"Not applied: {exc.message}"
            log.warning("camera result not applied: %s", exc.message)
    db.flush()
    return capture


def apply_capture(db: Session, capture: CameraCapture, *, actor: str, force: bool = False) -> dict[str, Any]:
    """Make the chamber follow the recognised phase.

    * finds (or creates) the active batch on the target chamber using the species' reference profile,
    * confirms the mapped stage (StageEvent source=camera) – the control service picks the ranges up,
    * switches the chamber to automatic control when CAMERA_AUTO_MODE is on.
    """
    settings = get_settings()
    if capture.status != "matched" or not capture.card_key:
        raise VisionError("This capture did not match any reference card, so there is no phase to apply.", 409)
    if capture.confidence == "low" and not force:
        raise VisionError("Low-confidence match – confirm it explicitly (force) or take a clearer photo.", 409)
    card = card_by_key(capture.card_key)
    if card is None:
        raise VisionError(f"Unknown reference card {capture.card_key}.", 409)
    device = db.get(Device, target_device_id(capture.target_device_id))
    if device is None:
        raise VisionError(f"Target chamber {target_device_id(capture.target_device_id)} is not registered.", 409)
    profile = profile_for_card(db, card)
    stage_key = card.phase.stage_key
    stage_keys = [s["key"] for s in (profile.stages or [])]
    if stage_key not in stage_keys:
        raise VisionError(f"Profile '{profile.name}' has no stage '{stage_key}'.", 409)

    now = datetime.now(timezone.utc)
    notes: list[str] = []
    batch = control.active_batch_for_device(db, device.id)
    if batch is not None and batch.profile_id != profile.id:
        batch.status = "archived"
        batch.ended_at = now
        batch.notes = ((batch.notes or "") + f"\nArchived {now.date().isoformat()}: camera recognised {card.species.common_name}, "
                       f"a different species.").strip()
        log_event(db, "camera", f"batch {batch.code} archived – camera recognised {card.species.common_name}", device_id=device.id)
        notes.append(f"archived {batch.code} ({batch.species})")
        batch = None
    if batch is None:
        batch = CultivationBatch(
            code=_next_batch_code(db), name=f"{card.species.common_name} – camera", species=card.species.latin_name,
            substrate_type=profile.substrate_type, profile_id=profile.id, device_id=device.id, status="active",
            current_stage_key=stage_key, target_overrides={}, started_at=now,
            notes="Created automatically from an ESP32-CAM phase recognition. Species/stage come from the reference "
                  "card set; ranges are the built-in reference profile's.",
        )
        db.add(batch)
        db.flush()
        db.add(StageEvent(batch_id=batch.id, stage_key=stage_key, started_at=now, source="camera", confirmed_by=actor,
                          note=f"Initial stage from camera capture #{capture.id} ({card.phase.label})."))
        notes.append(f"created {batch.code}")
        changed = True
    elif batch.current_stage_key == stage_key:
        changed = False
        notes.append(f"{batch.code} already in stage {stage_key}")
    else:
        previous = batch.current_stage_key
        batch.current_stage_key = stage_key
        ev = StageEvent(batch_id=batch.id, stage_key=stage_key, started_at=now, source="camera", confirmed_by=actor,
                        note=f"Camera capture #{capture.id} recognised '{card.phase.label}' ({capture.confidence} confidence, {capture.method}).")
        db.add(ev)
        db.flush()
        try:
            prediction.evaluate_stage_predictions(db, batch, ev)
        except Exception:  # pragma: no cover - scoring must never block the demo flow
            log.exception("stage prediction scoring failed")
        notes.append(f"{batch.code}: {previous} -> {stage_key}")
        changed = True

    db.add(BatchObservation(batch_id=batch.id, observed_at=now, kind="camera", stage_key=stage_key,
                            image_path=f"{CAPTURE_SUBDIR}/{capture.image_path}", recorded_by=actor,
                            note=f"ESP32-CAM: {card.species.common_name} – {card.phase.label} ({capture.confidence} confidence).",
                            data={"capture_id": capture.id, "card_key": card.key, "method": capture.method}))

    mode_changed = False
    if settings.camera_auto_mode and device.control_mode != "auto":
        if device.kind == "hardware" and not device.token_hash:
            notes.append("chamber kept in its current mode (no device token yet)")
        else:
            control.set_mode(db, device, "auto", actor=f"{actor} (camera)")
            mode_changed = True
            notes.append("chamber switched to automatic control")

    capture.applied = True
    capture.applied_at = now
    capture.applied_batch_id = batch.id
    capture.applied_stage_key = stage_key
    capture.applied_by = actor
    capture.apply_note = "; ".join(notes)
    log_event(db, "camera", f"capture #{capture.id} applied: {card.species.common_name} / {card.phase.label} -> {'; '.join(notes)}",
              device_id=device.id, data={"capture_id": capture.id, "batch_id": batch.id, "stage_key": stage_key})
    db.flush()
    if mode_changed or changed:
        bus.publish_threadsafe("device_status", {"device": device_to_dict(device)})
    return {
        "batch_id": batch.id,
        "batch_code": batch.code,
        "stage_key": stage_key,
        "stage_changed": changed,
        "mode_changed": mode_changed,
        "targets": stage_targets(profile, stage_key),
        "notes": notes,
    }


def latest_capture(db: Session) -> CameraCapture | None:
    return db.execute(select(CameraCapture).order_by(CameraCapture.captured_at.desc(), CameraCapture.id.desc()).limit(1)).scalar_one_or_none()


def list_captures(db: Session, limit: int = 20) -> list[CameraCapture]:
    return list(db.execute(select(CameraCapture).order_by(CameraCapture.captured_at.desc(), CameraCapture.id.desc()).limit(limit)).scalars())


def camera_status(db: Session) -> dict[str, Any]:
    settings = get_settings()
    now = datetime.now(timezone.utc)
    cam = db.get(Device, settings.camera_device_id)
    online = state.online(now)
    if cam is not None and not online and cam.connection_status == "online" and cam.last_seen_at and now - cam.last_seen_at > CAMERA_ONLINE_WINDOW:
        cam.connection_status = "offline"
        log_event(db, "connection", f"camera {cam.id} offline", device_id=cam.id, level="warning")
        db.flush()
    last = latest_capture(db)
    target = db.get(Device, target_device_id())
    batch = control.active_batch_for_device(db, target.id) if target else None
    index_info = matcher.get_index(settings.camera_min_inliers).info()
    return {
        "camera_device_id": settings.camera_device_id,
        "camera_registered": cam is not None,
        "camera_has_token": bool(cam.token_hash) if cam else False,
        "online": online,
        "last_poll_at": state.last_poll_at.isoformat() if state.last_poll_at else None,
        "last_seen_at": cam.last_seen_at.isoformat() if cam and cam.last_seen_at else None,
        "manual_pending": state.manual_pending,
        "manual_requested_at": state.manual_requested_at.isoformat() if state.manual_requested_at else None,
        "auto_interval_seconds": settings.camera_auto_interval_seconds,
        "auto_apply": settings.camera_auto_apply,
        "auto_mode": settings.camera_auto_mode,
        "target_device_id": target.id if target else target_device_id(),
        "target_control_mode": target.control_mode if target else None,
        "active_batch": {"id": batch.id, "code": batch.code, "species": batch.species, "stage_key": batch.current_stage_key,
                         "profile_name": batch.profile.name if batch.profile else None} if batch else None,
        "last_capture": capture_to_dict(last) if last else None,
        "recognition": index_info,
        "reference_cards": len(all_cards()),
    }
