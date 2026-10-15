from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from ..config import get_settings
from ..core.deps import CurrentUser, read_access, require_role
from ..db.session import get_db
from ..schemas.api import SettingsUpdate
from ..services import settings_store
from ..services.telemetry import log_event

router = APIRouter(prefix="/api/settings", tags=["settings"])


@router.get("")
def get_all(_=Depends(read_access), db: Session = Depends(get_db)):
    s = get_settings()
    return {
        "sections": settings_store.get_all(db),
        "defaults": settings_store.DEFAULTS,
        "runtime": {  # non-secret runtime configuration for display
            "app_env": s.app_env, "database": "sqlite" if s.is_sqlite else "postgresql", "public_read": s.public_read, "open_access": s.open_access,
            "simulator_enabled": s.simulator_enabled, "mqtt_enabled": s.mqtt_enabled, "ai_configured": s.ai_configured,
            "ai_model": s.ai_model or None, "device_offline_after_seconds": s.device_offline_after_seconds,
            "prediction_interval_seconds": s.prediction_interval_seconds,
        },
    }


@router.patch("/{section}")
def update_section(section: str, body: SettingsUpdate, actor: CurrentUser = Depends(require_role("admin")), db: Session = Depends(get_db)):
    try:
        merged = settings_store.update_section(db, section, body.value)
    except KeyError:
        raise HTTPException(status_code=404, detail=f"Unknown settings section '{section}'")
    except settings_store.SettingsValidationError as exc:
        db.rollback()
        raise HTTPException(status_code=422, detail=str(exc))
    if section == "validation":
        for field in ("temperature_c", "relative_humidity_percent", "substrate_moisture_raw"):
            rule = merged.get(field, {})
            if float(rule.get("min", 0)) >= float(rule.get("max", 1)):
                db.rollback()
                raise HTTPException(status_code=422, detail=f"{field}: min must be lower than max")
    if section == "control_defaults":
        t = merged["default_targets"]
        if float(t["temperature_min_c"]) >= float(t["temperature_max_c"]) or float(t["humidity_min_percent"]) >= float(t["humidity_max_percent"]):
            db.rollback()
            raise HTTPException(status_code=422, detail="default targets: min must be lower than max")
        if float(merged["heater_absolute_max_temp_c"]) <= float(t["temperature_max_c"]):
            db.rollback()
            raise HTTPException(status_code=422, detail="heater_absolute_max_temp_c must be above the default temperature maximum")
    log_event(db, "system", f"settings section '{section}' updated by {actor.username}", data={"keys": list(body.value.keys())})
    db.commit()
    return merged
