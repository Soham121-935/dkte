"""Bootstrap data: admin user, device registry, built-in profiles and – when
``DEMO_SEED`` is enabled – a clearly labelled demo batch with simulated
history so every screen has data before hardware exists.
"""
from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone
from typing import Any

from sqlalchemy import func, insert, select
from sqlalchemy.orm import Session

from ..config import get_settings
from ..core.security import hash_password, hash_token
from ..db.models import (
    ActuatorStatusEvent,
    Alert,
    BatchObservation,
    CultivationBatch,
    CultivationProfile,
    Device,
    SensorReading,
    StageEvent,
    User,
)
from ..iot.simulator import ChamberModel, generate_history
from .profiles import seed_profiles
from .telemetry import log_event

log = logging.getLogger(__name__)


def ensure_admin(db: Session) -> None:
    settings = get_settings()
    if not settings.admin_bootstrap:
        return
    exists = db.execute(select(User).where(User.username == settings.admin_username)).scalar_one_or_none()
    if exists is None:
        db.add(User(username=settings.admin_username, password_hash=hash_password(settings.admin_password), role="admin"))
        log.info("bootstrap admin user '%s' created (change the password!)", settings.admin_username)


def ensure_devices(db: Session) -> tuple[Device, Device]:
    settings = get_settings()
    sim = db.get(Device, settings.simulator_device_id)
    if sim is None:
        sim = Device(id=settings.simulator_device_id, name="Simulated chamber", kind="simulated", transport="simulator",
                     firmware_version="sim-1.0.0", control_mode="auto", connection_status="unknown",
                     hardware_notes="In-process simulator. All readings from this device are SIMULATED.")
        db.add(sim)
    hw = db.get(Device, settings.hardware_device_id)
    if hw is None:
        hw = Device(id=settings.hardware_device_id, name="ESP32 grow chamber", kind="hardware", transport="http",
                    control_mode="monitor", connection_status="unknown",
                    hardware_notes="ESP32 + DHT11 (GPIO 4) + substrate moisture probe (GPIO 34); 12 V fan via L298N/L293D "
                                   "(IN3 26, IN4 27, EN2 25), USB humidifier driver (GPIO 18), bulb relay (GPIO 19). "
                                   "Talks HTTP to this backend (firmware/esp32/myco_esp32).")
        db.add(hw)
    db.flush()
    ensure_camera_device(db)
    apply_fixed_tokens(db)
    return sim, hw


def ensure_camera_device(db: Session) -> Device:
    """The ESP32-CAM is registered as its own (monitor-only) device so its uploads are authenticated."""
    settings = get_settings()
    cam = db.get(Device, settings.camera_device_id)
    if cam is None:
        cam = Device(id=settings.camera_device_id, name="ESP32-CAM phase camera", kind="hardware", transport="http",
                     control_mode="monitor", connection_status="unknown",
                     hardware_notes="AI-Thinker ESP32-CAM. Photographs the chamber / printed reference card and uploads "
                                    "JPEGs to /api/vision/capture. Has no actuators (firmware/esp32cam/myco_cam).")
        db.add(cam)
        db.flush()
    return cam


def apply_fixed_tokens(db: Session) -> None:
    """Store the hashes of tokens configured in .env so firmware can be flashed with known tokens.

    Only the hash is persisted; rotating a token from Device Management still works and simply
    stops matching the .env value until the firmware is updated.
    """
    settings = get_settings()
    for device_id, token in ((settings.hardware_device_id, settings.hardware_device_token),
                             (settings.camera_device_id, settings.camera_device_token)):
        if not token:
            continue
        dev = db.get(Device, device_id)
        if dev is None:
            continue
        digest = hash_token(token)
        if dev.token_hash != digest:
            dev.token_hash = digest
            log.info("device %s token set from environment", device_id)
    db.flush()


def _targets_from_profile(profile: CultivationProfile, stage_key: str) -> dict[str, Any]:
    for s in profile.stages:
        if s["key"] == stage_key:
            return dict(s["targets"])
    raise KeyError(stage_key)


def seed_demo(db: Session) -> bool:
    """Create the demo batch and simulated history once. Returns True when seeded."""
    settings = get_settings()
    marker = db.execute(select(CultivationBatch).where(CultivationBatch.is_demo.is_(True))).scalar_one_or_none()
    if marker is not None:
        return False
    sim, _hw = ensure_devices(db)
    profile = db.execute(select(CultivationProfile).where(CultivationProfile.species == "Pleurotus ostreatus")).scalar_one_or_none()
    if profile is None:
        seed_profiles(db)
        profile = db.execute(select(CultivationProfile).where(CultivationProfile.species == "Pleurotus ostreatus")).scalar_one()

    now = datetime.now(timezone.utc)
    inoculated = now - timedelta(days=12)
    pinning_started = now - timedelta(days=2, hours=6)
    batch = CultivationBatch(
        code="DEMO-OYS-001", name="Demo oyster batch (simulated)", species=profile.species, strain="Grey oyster (unspecified)",
        substrate_type="Pasteurised wheat straw", substrate_details="2 kg hydrated straw, 10 % grain spawn rate, 5 L bucket with 12 mm side holes",
        inoculation_date=inoculated, spawn_details="Rye grain spawn, 200 g", profile_id=profile.id, device_id=sim.id, status="active",
        current_stage_key="pinning", notes="Demo batch created automatically. All sensor data linked to this batch is SIMULATED.",
        started_at=inoculated, is_demo=True,
    )
    db.add(batch)
    db.flush()
    db.add_all([
        StageEvent(batch_id=batch.id, stage_key="inoculation", started_at=inoculated, source="initial", confirmed_by="demo-seed",
                   note="Inoculated with grain spawn."),
        StageEvent(batch_id=batch.id, stage_key="incubation", started_at=inoculated + timedelta(hours=2), source="manual",
                   confirmed_by="demo-seed", note="Bucket sealed and placed in the chamber."),
        StageEvent(batch_id=batch.id, stage_key="pinning", started_at=pinning_started, source="manual", confirmed_by="demo-seed",
                   note="Substrate fully colonised; fruiting conditions started (lower temperature, FAE cycle, high humidity)."),
    ])
    db.add_all([
        BatchObservation(batch_id=batch.id, observed_at=inoculated + timedelta(days=4), kind="note",
                         note="Mycelium visible around spawn grains, roughly 30 % of visible surface.", recorded_by="demo-seed"),
        BatchObservation(batch_id=batch.id, observed_at=inoculated + timedelta(days=8), kind="note",
                         note="About 80 % colonised; no contamination visible.", recorded_by="demo-seed"),
        BatchObservation(batch_id=batch.id, observed_at=pinning_started, kind="stage_confirmation", stage_key="pinning",
                         note="Fully white block; opened side holes and switched to pinning targets.", recorded_by="demo-seed"),
        BatchObservation(batch_id=batch.id, observed_at=now - timedelta(hours=10), kind="note",
                         note="First tiny pin clusters forming at two of the side holes.", recorded_by="demo-seed"),
    ])

    # ------------------------------------------------------------- history
    hours = settings.simulator_backfill_hours
    step = settings.simulator_backfill_step_seconds
    start = now - timedelta(hours=hours)
    existing = db.execute(select(func.count(SensorReading.id)).where(SensorReading.device_id == sim.id)).scalar_one()
    if existing == 0 and hours > 0:
        from ..iot.simulator import simulator  # shared model so live data continues from the history

        model: ChamberModel = simulator.model
        incubation_targets = _targets_from_profile(profile, "incubation")
        pinning_targets = _targets_from_profile(profile, "pinning")

        def targets_at(t: datetime) -> dict[str, Any]:
            return pinning_targets if t >= pinning_started else incubation_targets

        readings, episodes = generate_history(model, start, now - timedelta(seconds=step), step, targets_at, sim.id)
        if readings:
            db.execute(insert(SensorReading), readings)
            # actuator transitions for the status-event log
            prev = {"fan": None, "heater": None, "humidifier": None}
            events = []
            for r in readings:
                for a in prev:
                    v = r[f"{a}_state"]
                    if prev[a] is not None and v != prev[a]:
                        events.append({"device_id": sim.id, "actuator": a, "state": v, "observed_at": r["measured_at"],
                                       "source": "simulation", "command_id": None})
                    prev[a] = v
            if events:
                db.execute(insert(ActuatorStatusEvent), events)
            last = readings[-1]
            sim.last_telemetry_at = last["measured_at"]
            sim.last_seen_at = last["measured_at"]
            sim.actuator_state = {
                a: {"confirmed": last[f"{a}_state"], "confirmed_at": last["measured_at"].isoformat(), "status": "confirmed",
                    "since": last["measured_at"].isoformat()} for a in ("fan", "heater", "humidifier")
            }
        for ep in episodes:
            title, message, sev, rule = {
                "heater_stuck": ("Unexpected rapid temperature increase", "Simulated episode: heater remained on for 40 minutes; temperature rose above the target maximum.", "critical", "rapid_temperature_rise"),
                "humidifier_failure": ("Humidity outside target range", "Simulated episode: humidifier reservoir empty for 3 hours; humidity fell below the target minimum.", "warning", "humidity_out_of_range"),
                "offline": ("Device disconnected", "Simulated episode: no telemetry for 45 minutes.", "warning", "device_offline"),
                "sensor_glitch": ("Temperature sensor data invalid or missing", "Simulated episode: DHT11 read failures for 6 minutes.", "warning", "sensor_invalid"),
            }[ep["kind"]]
            db.add(Alert(rule_key=rule, dedup_key=f"{rule}:{sim.id}:demo-{ep['kind']}", severity=sev, title=title, message=message,
                         device_id=sim.id, batch_id=batch.id, source="simulation", status="resolved", opened_at=ep["start"],
                         last_seen_at=ep["end"], resolved_at=ep["end"] + timedelta(minutes=5), resolved_reason="condition cleared",
                         occurrence_count=max(1, int((ep["end"] - ep["start"]).total_seconds() // 60)),
                         data={"demo_episode": ep["kind"]}))
        log_event(db, "simulator", f"demo history generated: {len(readings)} simulated readings over {hours} h", device_id=sim.id)
    log_event(db, "system", "demo batch DEMO-OYS-001 created (simulated data)")
    db.flush()
    return True


def bootstrap(db: Session) -> None:
    ensure_admin(db)
    seed_profiles(db)
    ensure_devices(db)
    if get_settings().demo_seed:
        seed_demo(db)
