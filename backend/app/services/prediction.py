"""Prediction service – transparent baseline models only.

* Environmental forecasting: ordinary least-squares linear trend over a
  recent window, with a heuristic uncertainty band derived from the residual
  standard deviation.  Forecasts are stored and later compared with actual
  readings so the UI can show *measured* forecast error (never fabricated).
* Cultivation stage estimation: calendar arithmetic on the profile's typical
  stage durations anchored at the grower-confirmed stage start, adjusted with
  explicit uncertainty labels (data availability, environmental conformity,
  observation count).  No biological growth model is claimed.
* Anomaly detection: deterministic rules over the recent history.
* Recommendations: rule-based, each with detection / reason / action /
  confidence basis / confirmation requirement.
"""
from __future__ import annotations

import logging
import math
from datetime import datetime, timedelta, timezone
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..db.models import Alert, BatchObservation, CultivationBatch, Device, Prediction, SensorReading, StageEvent
from . import settings_store
from .control import active_batch_for_device, effective_config, resolve_targets, stage_definition

log = logging.getLogger(__name__)

FORECAST_MODEL = "ols_linear_trend"
FORECAST_VERSION = "1.0"
STAGE_MODEL = "profile_calendar_estimate"
STAGE_VERSION = "1.0"

METRICS = {
    "temperature_c": {"label": "Temperature", "unit": "°C", "min": -10.0, "max": 60.0},
    "relative_humidity_percent": {"label": "Relative humidity", "unit": "%", "min": 0.0, "max": 100.0},
}


# ------------------------------------------------------------------ utilities
def _readings(db: Session, device_id: str, start: datetime, end: datetime) -> list[SensorReading]:
    return db.execute(
        select(SensorReading)
        .where(SensorReading.device_id == device_id, SensorReading.measured_at >= start, SensorReading.measured_at <= end)
        .order_by(SensorReading.measured_at.asc())
    ).scalars().all()


def _ols(points: list[tuple[float, float]]) -> tuple[float, float, float]:
    """Return (intercept, slope, residual_std) for y = a + b*x."""
    n = len(points)
    mean_x = sum(p[0] for p in points) / n
    mean_y = sum(p[1] for p in points) / n
    sxx = sum((p[0] - mean_x) ** 2 for p in points)
    if sxx == 0:
        return mean_y, 0.0, 0.0
    sxy = sum((p[0] - mean_x) * (p[1] - mean_y) for p in points)
    slope = sxy / sxx
    intercept = mean_y - slope * mean_x
    resid = [p[1] - (intercept + slope * p[0]) for p in points]
    dof = max(n - 2, 1)
    resid_std = math.sqrt(sum(r * r for r in resid) / dof)
    return intercept, slope, resid_std


# ------------------------------------------------------- environmental forecast
def environmental_forecast(
    db: Session, device_id: str, *, now: datetime | None = None, window_minutes: int = 60, horizons: tuple[int, ...] = (15, 60)
) -> dict[str, Any]:
    now = now or datetime.now(timezone.utc)
    start = now - timedelta(minutes=window_minutes)
    rows = _readings(db, device_id, start, now)
    result: dict[str, Any] = {
        "device_id": device_id,
        "generated_at": now.isoformat(),
        "model": {"name": FORECAST_MODEL, "version": FORECAST_VERSION,
                  "description": f"Ordinary least-squares linear trend fitted to the last {window_minutes} minutes of valid readings. "
                                 "The band is ±2 × residual standard deviation widened with horizon – a heuristic, not a calibrated prediction interval."},
        "window_minutes": window_minutes,
        "metrics": {},
        "source": None,
    }
    if rows:
        result["source"] = rows[-1].source
    for metric, meta in METRICS.items():
        points: list[tuple[float, float]] = []
        for r in rows:
            v = getattr(r, metric)
            q = (r.quality or {}).get(metric)
            if v is not None and q in ("ok", "suspect"):
                points.append(((r.measured_at - now).total_seconds() / 60.0, float(v)))
        entry: dict[str, Any] = {"label": meta["label"], "unit": meta["unit"], "n_points": len(points)}
        span = (points[-1][0] - points[0][0]) if len(points) >= 2 else 0.0
        if len(points) < 8 or span < 20:
            entry.update({"sufficient": False,
                          "limitation": f"Need at least 8 valid readings spanning 20 minutes (have {len(points)} spanning {span:.0f} min)."})
            result["metrics"][metric] = entry
            continue
        intercept, slope, resid_std = _ols(points)
        current = points[-1][1]
        forecasts = []
        for h in horizons:
            value = intercept + slope * h
            value = max(meta["min"], min(meta["max"], value))
            band = 2.0 * resid_std * math.sqrt(1.0 + h / max(window_minutes, 1))
            forecasts.append({
                "horizon_minutes": h,
                "target_time": (now + timedelta(minutes=h)).isoformat(),
                "value": round(value, 2),
                "lower": round(max(meta["min"], value - band), 2),
                "upper": round(min(meta["max"], value + band), 2),
            })
        trend = "stable"
        per_hour = slope * 60.0
        threshold = 0.5 if metric == "temperature_c" else 2.0
        if per_hour > threshold:
            trend = "rising"
        elif per_hour < -threshold:
            trend = "falling"
        entry.update({
            "sufficient": True,
            "current": round(current, 2),
            "slope_per_hour": round(per_hour, 3),
            "trend": trend,
            "residual_std": round(resid_std, 3),
            "forecasts": forecasts,
        })
        result["metrics"][metric] = entry
    return result


def store_forecasts(db: Session, device_id: str, forecast: dict[str, Any], now: datetime) -> list[Prediction]:
    stored: list[Prediction] = []
    for metric, entry in forecast["metrics"].items():
        if not entry.get("sufficient"):
            continue
        for f in entry["forecasts"]:
            p = Prediction(
                kind="env_forecast",
                model_name=FORECAST_MODEL,
                model_version=FORECAST_VERSION,
                device_id=device_id,
                generated_at=now,
                target_time=datetime.fromisoformat(f["target_time"]),
                horizon_minutes=f["horizon_minutes"],
                inputs={"metric": metric, "window_minutes": forecast["window_minutes"], "n_points": entry["n_points"],
                        "source": forecast.get("source")},
                output={"metric": metric, "value": f["value"], "current": entry["current"], "trend": entry["trend"]},
                uncertainty={"lower": f["lower"], "upper": f["upper"], "method": "2x residual std (heuristic)"},
            )
            db.add(p)
            stored.append(p)
    db.flush()
    return stored


def evaluate_due_forecasts(db: Session, now: datetime | None = None) -> int:
    """Compare stored forecasts with what was actually measured around the target time."""
    now = now or datetime.now(timezone.utc)
    due = db.execute(
        select(Prediction).where(Prediction.kind == "env_forecast", Prediction.evaluated_at.is_(None),
                                 Prediction.target_time <= now - timedelta(minutes=2))
        .order_by(Prediction.target_time.asc()).limit(500)
    ).scalars().all()
    count = 0
    for p in due:
        metric = (p.output or {}).get("metric")
        if not metric or p.target_time is None or p.device_id is None:
            p.evaluated_at = now
            p.error = {"status": "unevaluable"}
            continue
        window = timedelta(minutes=2)
        rows = _readings(db, p.device_id, p.target_time - window, p.target_time + window)
        values = [getattr(r, metric) for r in rows if getattr(r, metric) is not None]
        p.evaluated_at = now
        if not values:
            p.actual = None
            p.error = {"status": "no_actual_data"}
            continue
        actual = sum(values) / len(values)
        err = actual - float(p.output["value"])
        lower, upper = (p.uncertainty or {}).get("lower"), (p.uncertainty or {}).get("upper")
        p.actual = {"value": round(actual, 3), "n": len(values)}
        p.error = {
            "status": "evaluated",
            "error": round(err, 3),
            "abs_error": round(abs(err), 3),
            "within_band": bool(lower is not None and upper is not None and lower <= actual <= upper),
        }
        count += 1
    db.flush()
    return count


def forecast_accuracy(db: Session, device_id: str, *, days: int = 7) -> dict[str, Any]:
    since = datetime.now(timezone.utc) - timedelta(days=days)
    rows = db.execute(
        select(Prediction).where(Prediction.kind == "env_forecast", Prediction.device_id == device_id,
                                 Prediction.evaluated_at.isnot(None), Prediction.generated_at >= since)
    ).scalars().all()
    buckets: dict[str, dict[str, Any]] = {}
    for p in rows:
        if not p.error or p.error.get("status") != "evaluated":
            continue
        key = f"{p.output.get('metric')}@{p.horizon_minutes}"
        b = buckets.setdefault(key, {"metric": p.output.get("metric"), "horizon_minutes": p.horizon_minutes,
                                     "n": 0, "abs_errors": [], "errors": [], "in_band": 0})
        b["n"] += 1
        b["abs_errors"].append(p.error["abs_error"])
        b["errors"].append(p.error["error"])
        b["in_band"] += 1 if p.error.get("within_band") else 0
    summary = []
    for b in buckets.values():
        n = b["n"]
        summary.append({
            "metric": b["metric"],
            "horizon_minutes": b["horizon_minutes"],
            "n_evaluated": n,
            "mae": round(sum(b["abs_errors"]) / n, 3) if n else None,
            "bias": round(sum(b["errors"]) / n, 3) if n else None,
            "band_coverage": round(b["in_band"] / n, 3) if n else None,
            "sufficient": n >= 5,
        })
    summary.sort(key=lambda s: (s["metric"] or "", s["horizon_minutes"] or 0))
    return {"device_id": device_id, "days": days, "results": summary,
            "note": "Errors are computed only from forecasts whose target time has passed and for which actual readings exist."}


# ---------------------------------------------------------------- stage estimate
def _env_conformity(db: Session, device_id: str | None, targets: dict[str, Any], start: datetime, end: datetime) -> dict[str, Any] | None:
    if not device_id:
        return None
    rows = _readings(db, device_id, start, end)
    if not rows:
        return None
    t_min, t_max = targets.get("temperature_min_c"), targets.get("temperature_max_c")
    rh_min, rh_max = targets.get("humidity_min_percent"), targets.get("humidity_max_percent")
    t_in = t_n = rh_in = rh_n = 0
    for r in rows:
        if r.temperature_c is not None and t_min is not None and t_max is not None:
            t_n += 1
            t_in += 1 if t_min <= r.temperature_c <= t_max else 0
        if r.relative_humidity_percent is not None and rh_min is not None and rh_max is not None:
            rh_n += 1
            rh_in += 1 if rh_min <= r.relative_humidity_percent <= rh_max else 0
    return {
        "readings": len(rows),
        "temperature_in_range_fraction": round(t_in / t_n, 3) if t_n else None,
        "humidity_in_range_fraction": round(rh_in / rh_n, 3) if rh_n else None,
        "source": rows[-1].source,
    }


def stage_estimate(db: Session, batch: CultivationBatch, *, now: datetime | None = None) -> dict[str, Any]:
    now = now or datetime.now(timezone.utc)
    stages: list[dict[str, Any]] = (batch.profile.stages if batch.profile else []) or []
    events = sorted(batch.stage_events, key=lambda e: e.started_at)
    result: dict[str, Any] = {
        "batch_id": batch.id,
        "generated_at": now.isoformat(),
        "model": {"name": STAGE_MODEL, "version": STAGE_VERSION,
                  "description": "Calendar arithmetic on the profile's typical stage durations anchored at the grower-confirmed stage start. "
                                 "This is not a biological growth model; transitions must be confirmed by observation."},
    }
    if not stages:
        result.update({"available": False, "limitation": "Batch has no cultivation profile with stage definitions."})
        return result
    if not events:
        result.update({"available": False, "limitation": "No confirmed stage yet. Record the current stage to enable estimates."})
        return result

    current_event = events[-1]
    keys = [s["key"] for s in stages]
    if current_event.stage_key not in keys:
        result.update({"available": False, "limitation": f"Stage '{current_event.stage_key}' is not part of the profile."})
        return result
    idx = keys.index(current_event.stage_key)
    current_stage = stages[idx]
    elapsed_days = (now - current_event.started_at).total_seconds() / 86400.0
    typical = current_stage.get("typical_duration_days") or {"min": 0, "max": 0}
    tmin, tmax = float(typical.get("min") or 0), float(typical.get("max") or 0)
    next_stage = stages[idx + 1] if idx + 1 < len(stages) else None

    if tmax <= 0:
        timing = "milestone"
        timing_label = "Milestone stage – advance when the next stage is observed."
    elif elapsed_days < tmin:
        timing = "early"
        timing_label = f"Day {elapsed_days:.1f} of a typical {tmin:.0f}–{tmax:.0f} day window – transition not yet expected."
    elif elapsed_days <= tmax:
        timing = "within_window"
        timing_label = f"Day {elapsed_days:.1f} – inside the typical {tmin:.0f}–{tmax:.0f} day window; inspect for transition signs."
    else:
        timing = "beyond_window"
        timing_label = (f"Day {elapsed_days:.1f} – beyond the typical {tmin:.0f}–{tmax:.0f} day window. "
                        "Inspect for contamination, check conditions, or confirm the stage manually.")

    earliest = current_event.started_at + timedelta(days=tmin)
    latest = current_event.started_at + timedelta(days=tmax)
    if latest < now:
        latest = now + timedelta(days=max(1.0, 0.25 * max(tmax, 1.0)))
    if earliest < now:
        earliest = now

    # harvest window from remaining typical durations
    harvest_idx = keys.index("harvest") if "harvest" in keys else None
    harvest_window = None
    if harvest_idx is not None and idx <= harvest_idx:
        remaining_min = max(tmin - elapsed_days, 0.0)
        remaining_max = max(tmax - elapsed_days, 0.0)
        for s in stages[idx + 1: harvest_idx]:
            d = s.get("typical_duration_days") or {"min": 0, "max": 0}
            remaining_min += float(d.get("min") or 0)
            remaining_max += float(d.get("max") or 0)
        harvest_window = {
            "earliest": (now + timedelta(days=remaining_min)).isoformat(),
            "latest": (now + timedelta(days=remaining_max)).isoformat(),
            "basis": "Sum of typical stage durations from the profile; shifts whenever a stage is confirmed late or early.",
        }

    # cycle progress (calendar based)
    total_mid = 0.0
    done_mid = 0.0
    for i, s in enumerate(stages):
        d = s.get("typical_duration_days") or {"min": 0, "max": 0}
        mid = (float(d.get("min") or 0) + float(d.get("max") or 0)) / 2.0
        total_mid += mid
        if i < idx:
            done_mid += mid
        elif i == idx:
            done_mid += min(elapsed_days, mid)
    progress_fraction = round(done_mid / total_mid, 3) if total_mid > 0 else None

    # environmental conformity and confidence
    targets = {**(current_stage.get("targets") or {})}
    if batch.target_overrides and batch.target_overrides.get(current_stage["key"]):
        targets.update({k: v for k, v in batch.target_overrides[current_stage["key"]].items() if v is not None})
    conformity = _env_conformity(db, batch.device_id, targets, current_event.started_at, now)
    observations_in_stage = [o for o in batch.observations if o.observed_at >= current_event.started_at]

    confidence_score = 2  # 1 low, 2 medium, 3 high
    basis: list[str] = []
    if batch.profile and batch.profile.source == "reference":
        confidence_score -= 1
        basis.append("Durations come from general reference ranges, not from this strain/substrate.")
    else:
        basis.append("Durations are user-defined for this profile.")
    if conformity is None:
        confidence_score -= 1
        basis.append("No sensor data for this stage – environmental conformity unknown.")
    else:
        fr = [f for f in (conformity["temperature_in_range_fraction"], conformity["humidity_in_range_fraction"]) if f is not None]
        if fr and min(fr) < 0.7:
            confidence_score -= 1
            basis.append(f"Environment was outside target ranges {100 - int(min(fr) * 100)}% of the time; durations may stretch.")
        elif fr:
            basis.append(f"Environment inside target ranges ≥{int(min(fr) * 100)}% of the time during this stage.")
        if conformity.get("source") == "simulation":
            basis.append("Environmental data in this stage is SIMULATED.")
    if len(observations_in_stage) >= 2:
        confidence_score += 1
        basis.append(f"{len(observations_in_stage)} grower observations recorded in this stage.")
    else:
        basis.append("Fewer than 2 grower observations in this stage – record observations to improve the estimate.")
    if timing == "beyond_window":
        confidence_score -= 1
        basis.append("Stage has exceeded its typical window.")
    confidence = {1: "low", 2: "medium", 3: "high"}[max(1, min(3, confidence_score))]

    result.update({
        "available": True,
        "current_stage": {"key": current_stage["key"], "name": current_stage["name"], "index": idx, "total": len(stages),
                          "started_at": current_event.started_at.isoformat(), "source": current_event.source,
                          "confirmed_by": current_event.confirmed_by, "elapsed_days": round(elapsed_days, 2),
                          "typical_duration_days": typical, "milestone": bool(current_stage.get("milestone"))},
        "timing": timing,
        "timing_label": timing_label,
        "next_stage": {"key": next_stage["key"], "name": next_stage["name"],
                       "expected_window": {"earliest": earliest.isoformat(), "latest": latest.isoformat()},
                       "observable_signs": next_stage.get("observable_signs", []),
                       "transition_criteria": current_stage.get("transition_criteria", "")} if next_stage else None,
        "harvest_window": harvest_window,
        "cycle_progress": {"fraction": progress_fraction,
                           "label": "Calendar-based estimate from profile durations and the confirmed stage – not a biological measurement."},
        "confidence": {"level": confidence, "basis": basis},
        "environment_conformity": conformity,
        "observations_in_stage": len(observations_in_stage),
    })
    return result


def store_stage_estimate(db: Session, batch: CultivationBatch, estimate: dict[str, Any], now: datetime) -> Prediction | None:
    if not estimate.get("available"):
        return None
    last = db.execute(
        select(Prediction).where(Prediction.kind == "stage_estimate", Prediction.batch_id == batch.id)
        .order_by(Prediction.generated_at.desc()).limit(1)
    ).scalar_one_or_none()
    signature = {
        "stage": estimate["current_stage"]["key"],
        "timing": estimate["timing"],
        "next_window": (estimate.get("next_stage") or {}).get("expected_window"),
        "confidence": estimate["confidence"]["level"],
    }
    if last and (last.output or {}).get("signature") == signature and (now - last.generated_at) < timedelta(hours=6):
        return None
    p = Prediction(kind="stage_estimate", model_name=STAGE_MODEL, model_version=STAGE_VERSION, batch_id=batch.id,
                   device_id=batch.device_id, generated_at=now,
                   target_time=datetime.fromisoformat(estimate["next_stage"]["expected_window"]["latest"]) if estimate.get("next_stage") else None,
                   inputs={"stage_started_at": estimate["current_stage"]["started_at"]},
                   output={"signature": signature, "next_stage": estimate.get("next_stage"), "harvest_window": estimate.get("harvest_window"),
                           "cycle_progress": estimate.get("cycle_progress")},
                   uncertainty={"confidence": estimate["confidence"]})
    db.add(p)
    db.flush()
    return p


def evaluate_stage_predictions(db: Session, batch: CultivationBatch, new_event: StageEvent) -> int:
    """When a grower confirms a stage, score earlier estimates that predicted it."""
    preds = db.execute(
        select(Prediction).where(Prediction.kind == "stage_estimate", Prediction.batch_id == batch.id, Prediction.evaluated_at.is_(None))
    ).scalars().all()
    n = 0
    for p in preds:
        nxt = (p.output or {}).get("next_stage") or {}
        if nxt.get("key") != new_event.stage_key:
            continue
        window = nxt.get("expected_window") or {}
        try:
            earliest = datetime.fromisoformat(window["earliest"])
            latest = datetime.fromisoformat(window["latest"])
        except (KeyError, ValueError):
            continue
        actual = new_event.started_at
        p.evaluated_at = datetime.now(timezone.utc)
        p.actual = {"stage_key": new_event.stage_key, "started_at": actual.isoformat()}
        mid = earliest + (latest - earliest) / 2
        p.error = {"status": "evaluated", "within_window": earliest <= actual <= latest,
                   "days_from_window_midpoint": round((actual - mid).total_seconds() / 86400.0, 2)}
        n += 1
    db.flush()
    return n


# -------------------------------------------------------------- anomaly detection
def detect_anomalies(db: Session, device: Device, *, now: datetime | None = None, hours: int = 24) -> dict[str, Any]:
    now = now or datetime.now(timezone.utc)
    start = now - timedelta(hours=hours)
    rows = _readings(db, device.id, start, now)
    targets = resolve_targets(db, device)
    cfg = settings_store.get_section(db, "alerts")
    ccfg = effective_config(db, device)
    anomalies: list[dict[str, Any]] = []
    source = rows[-1].source if rows else None

    def _close(ep: dict[str, Any], ongoing: bool = False) -> None:
        duration = (ep["end"] - ep["start"]).total_seconds() / 60.0
        if duration < 5 and not ongoing:
            return
        anomalies.append({
            "type": "prolonged_deviation" if duration >= 60 else "out_of_range",
            "severity": "critical" if duration >= 180 else "warning",
            "metric": ep.get("metric"),
            "label": f"{ep.get('label')} {ep['direction']} range for {duration:.0f} min" + (" (ongoing)" if ongoing else ""),
            "start": ep["start"].isoformat(),
            "end": ep["end"].isoformat(),
            "duration_minutes": round(duration, 1),
            "peak": round(ep["peak"], 2),
            "ongoing": ongoing,
        })

    def run_episodes(metric: str, lo: Any, hi: Any, label: str) -> None:
        if lo is None or hi is None:
            return
        lo_f, hi_f = float(lo), float(hi)
        current: dict[str, Any] | None = None
        for r in rows:
            v = getattr(r, metric)
            if v is None:
                continue
            out = v < lo_f or v > hi_f
            if out and current is None:
                current = {"metric": metric, "label": label, "start": r.measured_at, "end": r.measured_at, "peak": v,
                           "direction": "below" if v < lo_f else "above"}
            elif out and current is not None:
                current["end"] = r.measured_at
                if (current["direction"] == "below" and v < current["peak"]) or (current["direction"] == "above" and v > current["peak"]):
                    current["peak"] = v
            elif not out and current is not None:
                _close(current)
                current = None
        if current is not None:
            _close(current, ongoing=True)

    run_episodes("temperature_c", targets.get("temperature_min_c"), targets.get("temperature_max_c"), "Temperature")
    run_episodes("relative_humidity_percent", targets.get("humidity_min_percent"), targets.get("humidity_max_percent"), "Humidity")

    # sudden changes (10-minute delta) and data gaps
    expected_interval = None
    if len(rows) >= 3:
        deltas = [(rows[i + 1].measured_at - rows[i].measured_at).total_seconds() for i in range(len(rows) - 1)]
        deltas.sort()
        expected_interval = deltas[len(deltas) // 2]
    last_by_time: list[tuple[datetime, float]] = []
    for i, r in enumerate(rows):
        if i > 0 and expected_interval:
            gap = (r.measured_at - rows[i - 1].measured_at).total_seconds()
            if gap > max(3 * expected_interval, float(cfg["stale_telemetry_seconds"])):
                anomalies.append({"type": "missing_data", "severity": "warning", "metric": None,
                                  "label": f"No telemetry for {gap / 60:.0f} min", "start": rows[i - 1].measured_at.isoformat(),
                                  "end": r.measured_at.isoformat(), "duration_minutes": round(gap / 60, 1)})
        if r.temperature_c is not None:
            last_by_time.append((r.measured_at, r.temperature_c))
            cutoff = r.measured_at - timedelta(minutes=10)
            base = None
            for t, v in reversed(last_by_time):
                if t <= cutoff:
                    base = v
                    break
            if base is not None and abs(r.temperature_c - base) >= float(cfg["rapid_temp_rise_c_per_10min"]):
                if not anomalies or anomalies[-1].get("type") != "sudden_change" or (r.measured_at - datetime.fromisoformat(anomalies[-1]["end"])).total_seconds() > 600:
                    anomalies.append({"type": "sudden_change", "severity": "warning", "metric": "temperature_c",
                                      "label": f"Temperature changed {r.temperature_c - base:+.1f}°C within 10 min",
                                      "start": cutoff.isoformat(), "end": r.measured_at.isoformat(), "duration_minutes": 10})
        if r.heater_state and r.temperature_c is not None and targets.get("temperature_max_c") is not None and r.temperature_c > float(targets["temperature_max_c"]) + 1:
            if not any(a["type"] == "unexpected_actuator_state" for a in anomalies):
                anomalies.append({"type": "unexpected_actuator_state", "severity": "warning", "metric": "heater_state",
                                  "label": f"Heater on at {r.temperature_c:.1f}°C (above target max)", "start": r.measured_at.isoformat(),
                                  "end": r.measured_at.isoformat(), "duration_minutes": 0})
    if rows and (now - rows[-1].measured_at).total_seconds() > float(cfg["stale_telemetry_seconds"]):
        anomalies.append({"type": "stale_data", "severity": "critical", "metric": None,
                          "label": f"Latest reading is {int((now - rows[-1].measured_at).total_seconds() // 60)} min old",
                          "start": rows[-1].measured_at.isoformat(), "end": now.isoformat(), "duration_minutes": None, "ongoing": True})
    if not rows:
        anomalies.append({"type": "missing_data", "severity": "critical", "metric": None, "label": f"No readings in the last {hours} h",
                          "start": start.isoformat(), "end": now.isoformat(), "duration_minutes": hours * 60, "ongoing": True})

    # repeated switching
    switching: dict[str, int] = {}
    prev_states: dict[str, bool | None] = {"fan": None, "heater": None, "humidifier": None}
    for r in rows:
        for a in ("fan", "heater", "humidifier"):
            s = getattr(r, f"{a}_state")
            if s is not None and prev_states[a] is not None and s != prev_states[a]:
                switching[a] = switching.get(a, 0) + 1
            if s is not None:
                prev_states[a] = s
    # Humidifiers legitimately cycle faster than heaters/fans under hysteresis control.
    switching_limits_per_hour = {"fan": 8.0, "heater": 6.0, "humidifier": 12.0}
    for a, n in switching.items():
        per_hour = n / max(hours, 1)
        if per_hour > switching_limits_per_hour.get(a, 6.0):
            anomalies.append({"type": "repeated_switching", "severity": "warning", "metric": f"{a}_state",
                              "label": f"{a.capitalize()} switched {n} times in {hours} h ({per_hour:.1f}/h)",
                              "start": start.isoformat(), "end": now.isoformat(), "duration_minutes": None})

    # instability windows (rolling 15-minute std of temperature)
    instability: list[dict[str, Any]] = []
    window: list[tuple[datetime, float]] = []
    for r in rows:
        if r.temperature_c is None:
            continue
        window.append((r.measured_at, r.temperature_c))
        window = [w for w in window if (r.measured_at - w[0]).total_seconds() <= 900]
        if len(window) >= 6:
            mean = sum(v for _, v in window) / len(window)
            std = math.sqrt(sum((v - mean) ** 2 for _, v in window) / len(window))
            if std >= float(cfg["fluctuation_std_c_15min"]):
                if instability and (r.measured_at - datetime.fromisoformat(instability[-1]["end"])).total_seconds() <= 900:
                    instability[-1]["end"] = r.measured_at.isoformat()
                    instability[-1]["max_std"] = max(instability[-1]["max_std"], round(std, 2))
                else:
                    instability.append({"start": window[0][0].isoformat(), "end": r.measured_at.isoformat(), "max_std": round(std, 2)})
    severity_rank = {"critical": 3, "warning": 2, "info": 1}
    anomalies.sort(key=lambda a: (-severity_rank.get(a["severity"], 0), a["start"]), reverse=False)
    return {
        "device_id": device.id,
        "generated_at": now.isoformat(),
        "hours": hours,
        "source": source,
        "n_readings": len(rows),
        "targets": targets,
        "anomalies": anomalies,
        "instability_windows": instability,
        "absolute_max_temp_c": ccfg["heater_absolute_max_temp_c"],
        "model": {"name": "rule_based_anomaly_detector", "version": "1.0"},
    }


# --------------------------------------------------------------- recommendations
def recommendations(db: Session, device: Device, *, now: datetime | None = None) -> dict[str, Any]:
    now = now or datetime.now(timezone.utc)
    targets = resolve_targets(db, device)
    reading = db.execute(
        select(SensorReading).where(SensorReading.device_id == device.id).order_by(SensorReading.measured_at.desc()).limit(1)
    ).scalar_one_or_none()
    batch = active_batch_for_device(db, device.id)
    ccfg = effective_config(db, device)
    recs: list[dict[str, Any]] = []
    source = reading.source if reading else None

    def add(key: str, title: str, detected: str, why: str, action: str, *, level: str, basis: str,
            confirmation: bool, category: str, actuator: str | None = None, suggested_state: bool | None = None) -> None:
        recs.append({"key": key, "title": title, "detected": detected, "why": why, "action": action,
                     "confidence": {"level": level, "basis": basis}, "requires_confirmation": confirmation,
                     "category": category, "actuator": actuator, "suggested_state": suggested_state})

    stale_s = float(ccfg["stale_sensor_timeout_seconds"])
    if reading is None or (now - reading.measured_at).total_seconds() > stale_s:
        age = f"{int((now - reading.measured_at).total_seconds() // 60)} min" if reading else "never"
        add("data_stale", "Restore telemetry before acting", f"Latest reading age: {age}.",
            "Without fresh data no environmental decision is reliable; automatic heating is disabled by the safety interlock.",
            "Check device power, Wi-Fi/MQTT connectivity and the DHT11 wiring; confirm the device shows 'online'.",
            level="high", basis="Derived from message timestamps, not from a model.", confirmation=False, category="connectivity")
        return {"device_id": device.id, "generated_at": now.isoformat(), "source": source, "recommendations": recs,
                "mode": device.control_mode, "targets": targets}

    t, rh = reading.temperature_c, reading.relative_humidity_percent
    t_min, t_max = float(targets["temperature_min_c"]), float(targets["temperature_max_c"])
    rh_min, rh_max = float(targets["humidity_min_percent"]), float(targets["humidity_max_percent"])
    heater_on = bool(reading.heater_state)
    fan_on = bool(reading.fan_state)
    hum_on = bool(reading.humidifier_state)
    mode = device.control_mode

    if t is not None and t < t_min:
        add("temp_low", "Raise chamber temperature", f"Temperature {t:.1f}°C is below the target minimum {t_min:.1f}°C.",
            "Low temperature slows colonisation and fruiting; a sustained deficit stretches stage durations.",
            ("Automatic control will switch the heater on (hysteresis applies)." if mode == "auto" else
             "Switch the heater on (manual command, requires confirmation) or enable automatic control.") +
            " Verify the bulb relay, fuse and that the DHT11 is not in the heater's direct radiation.",
            level="high", basis=f"Direct comparison of the latest reading with {targets['source_label']}.",
            confirmation=mode != "auto", category="temperature", actuator="heater", suggested_state=True if not heater_on else None)
    if t is not None and t > t_max:
        add("temp_high", "Lower chamber temperature", f"Temperature {t:.1f}°C exceeds the target maximum {t_max:.1f}°C.",
            "Excess heat stresses mycelium and favours contaminants; the heater must be off.",
            "Ensure the heater is off and run the fan. Note: the fan cannot cool below ambient – if ambient is warm, move the chamber or add cooling.",
            level="high", basis="Direct comparison with configured targets.", confirmation=mode != "auto",
            category="temperature", actuator="fan", suggested_state=True if not fan_on else None)
    if t is not None and heater_on and t > t_max:
        add("heater_on_above_max", "Heater running above target maximum", f"Heater reported ON at {t:.1f}°C.",
            "A heater running above the target maximum indicates a control fault, stale command or stuck relay.",
            "Switch the heater off and inspect the relay; the absolute cutoff is %.1f°C." % float(ccfg["heater_absolute_max_temp_c"]),
            level="high", basis="Actuator state reported by the device vs configured targets.", confirmation=True,
            category="safety", actuator="heater", suggested_state=False)
    if rh is not None and rh < rh_min:
        add("rh_low", "Increase humidity", f"Relative humidity {rh:.0f}% is below the target minimum {rh_min:.0f}%.",
            "Low humidity dries primordia and causes cracked or aborted fruit bodies during pinning/fruiting.",
            ("Automatic control will run the humidifier." if mode == "auto" else "Run the humidifier (requires confirmation).") +
            " Check humidifier water level and that its driver PCB is powered.",
            level="high", basis="Direct comparison with configured targets.", confirmation=mode != "auto",
            category="humidity", actuator="humidifier", suggested_state=True if not hum_on else None)
    if rh is not None and rh > rh_max:
        add("rh_high", "Increase fresh-air exchange", f"Relative humidity {rh:.0f}% is above the target maximum {rh_max:.0f}%.",
            "Saturated air with little exchange encourages bacterial blotch and long-stemmed, small-capped fruit bodies.",
            "Stop the humidifier and run the fan for a few minutes; consider a scheduled fresh-air exchange cycle for this stage.",
            level="medium", basis="Direct comparison with configured targets.", confirmation=mode != "auto",
            category="humidity", actuator="fan", suggested_state=True if not fan_on else None)
    if rh is not None and rh >= 93:
        add("dht11_saturation", "Treat humidity readings above 90 % as approximate",
            f"Humidity reading is {rh:.0f}%.", "The DHT11 is only rated to ~90 % RH; readings near saturation drift and respond slowly.",
            "Consider upgrading to a sensor rated for 95–100 % RH (e.g. SHT3x/SHT4x class) before relying on high-humidity control.",
            level="high", basis="Sensor datasheet limitation, not a model output.", confirmation=False, category="sensor")

    if batch is not None and batch.profile is not None:
        stage = stage_definition(batch.profile.stages, batch.current_stage_key)
        if stage:
            key = stage["key"]
            if key == "incubation":
                add("stage_incubation", "Keep incubation dark and stable", f"Batch {batch.code} is in {stage['name']}.",
                    "Stable warmth and darkness favour mycelial growth; frequent opening introduces contaminants.",
                    "Avoid opening the chamber; log an observation when the substrate is fully white.",
                    level="medium", basis="General cultivation practice for this stage (reference profile).", confirmation=False, category="stage")
            elif key == "pinning":
                add("stage_pinning", "Provide pinning triggers", f"Batch {batch.code} is in {stage['name']}.",
                    "Primordia need high humidity, fresh air and indirect light; CO₂ build-up delays pins.",
                    "Keep humidity in range, enable the fresh-air cycle and provide indirect light; record the first pins as an observation.",
                    level="medium", basis="General cultivation practice (reference profile).", confirmation=False, category="stage")
            elif key in ("fruiting", "harvest_ready"):
                add("stage_fruiting", "Watch cap development daily", f"Batch {batch.code} is in {stage['name']}.",
                    "Fruit bodies double in size quickly; harvest timing determines quality and spore load.",
                    "Inspect at least daily, photograph clusters, and harvest before caps flatten. Record harvest weight as the outcome.",
                    level="medium", basis="General cultivation practice (reference profile).", confirmation=False, category="stage")
        est = stage_estimate(db, batch, now=now)
        if est.get("available") and est.get("timing") == "beyond_window":
            add("stage_overdue", "Confirm or re-assess the current stage", est["timing_label"],
                "Stages that run long can indicate suboptimal conditions, contamination or a slower strain.",
                "Inspect the substrate, record an observation and either confirm the next stage or extend the profile durations.",
                level="medium", basis="Calendar comparison with profile durations (not a biological model).", confirmation=True, category="stage")
        if est.get("available") and est.get("observations_in_stage", 0) == 0:
            add("record_observation", "Record a grower observation", "No observation has been recorded in the current stage.",
                "Observations are the ground truth used to evaluate stage estimates and build a dataset for future models.",
                "Add a short note or photo describing mycelium coverage, pins or contamination.",
                level="high", basis="Record count in the database.", confirmation=False, category="data")
    elif batch is None:
        add("no_batch", "Assign an active batch to this device", "No active cultivation batch is linked to the device.",
            "Without a batch, targets fall back to generic defaults and no stage tracking is possible.",
            "Create or assign a batch with a cultivation profile.", level="high", basis="Database state.", confirmation=False, category="data")

    if mode == "monitor" and reading.source == "hardware":
        add("mode_monitor", "Monitoring only – no automatic control", "Control mode is 'monitor'.",
            "Readings outside range will raise alerts but no actuator will respond.",
            "Switch to automatic control once sensors are verified and interlocks tested.", level="high",
            basis="Current configuration.", confirmation=True, category="control")

    quality = reading.quality or {}
    if quality.get("temperature_c") == "suspect" or quality.get("relative_humidity_percent") == "suspect":
        add("suspect_quality", "Verify sensor readings", "The latest reading is flagged 'suspect'.",
            "Values outside the sensor's rated range or jumping quickly may be noise or a wiring fault.",
            "Compare with a reference thermometer/hygrometer and check the DHT11 cable and pull-up.", level="medium",
            basis="Validation flags on the stored reading.", confirmation=False, category="sensor")

    return {"device_id": device.id, "generated_at": now.isoformat(), "source": source, "recommendations": recs,
            "mode": device.control_mode, "targets": targets,
            "reading": {"measured_at": reading.measured_at.isoformat(), "temperature_c": t, "relative_humidity_percent": rh}}


# ------------------------------------------------------------------ periodic job
def run_periodic(db: Session, now: datetime | None = None) -> dict[str, int]:
    now = now or datetime.now(timezone.utc)
    stats = {"forecasts": 0, "evaluated": 0, "stage_estimates": 0}
    for device in db.execute(select(Device).where(Device.is_enabled.is_(True))).scalars().all():
        if device.connection_status != "online":
            continue
        fc = environmental_forecast(db, device.id, now=now)
        stats["forecasts"] += len(store_forecasts(db, device.id, fc, now))
    stats["evaluated"] = evaluate_due_forecasts(db, now)
    for batch in db.execute(select(CultivationBatch).where(CultivationBatch.status == "active")).scalars().all():
        est = stage_estimate(db, batch, now=now)
        if store_stage_estimate(db, batch, est, now):
            stats["stage_estimates"] += 1
    return stats


def prediction_to_dict(p: Prediction) -> dict[str, Any]:
    return {
        "id": p.id, "kind": p.kind, "model_name": p.model_name, "model_version": p.model_version,
        "device_id": p.device_id, "batch_id": p.batch_id, "generated_at": p.generated_at.isoformat(),
        "target_time": p.target_time.isoformat() if p.target_time else None, "horizon_minutes": p.horizon_minutes,
        "inputs": p.inputs, "output": p.output, "uncertainty": p.uncertainty,
        "evaluated_at": p.evaluated_at.isoformat() if p.evaluated_at else None, "actual": p.actual, "error": p.error,
    }


def recent_alert_summary(db: Session, device_id: str, hours: int = 24) -> list[dict[str, Any]]:
    since = datetime.now(timezone.utc) - timedelta(hours=hours)
    rows = db.execute(select(Alert).where(Alert.device_id == device_id, Alert.opened_at >= since).order_by(Alert.opened_at.desc())).scalars().all()
    return [{"title": a.title, "severity": a.severity, "status": a.status, "opened_at": a.opened_at.isoformat(), "message": a.message} for a in rows]
