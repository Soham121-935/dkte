"""Deterministic context assembly for the assistant.

Everything the language model is allowed to say about readings comes from
this module: measured values (with timestamps and source), configured
targets, actuator states and the control service's own reasons, 24-hour
history, active alerts, the stage estimate and the baseline forecast.  Each
block is tagged with its *kind* so the model (and the fallback assistant)
can separate measurements, history, predictions, observations and general
knowledge.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..db.models import Alert, BatchObservation, CultivationBatch, Device, SensorReading
from ..services import analytics, prediction
from ..services.control import active_batch_for_device, resolve_targets
from ..services.telemetry import last_reading


def _fmt_dt(dt: datetime | None) -> str:
    return dt.strftime("%Y-%m-%d %H:%M UTC") if dt else "unknown"


def build_context(db: Session, device: Device, batch: CultivationBatch | None = None, *, now: datetime | None = None) -> dict[str, Any]:
    now = now or datetime.now(timezone.utc)
    if batch is None:
        batch = active_batch_for_device(db, device.id)
    reading = last_reading(db, device.id)
    targets = resolve_targets(db, device)
    ctx: dict[str, Any] = {"generated_at": now.isoformat(), "device": {
        "id": device.id, "name": device.name, "kind": device.kind, "connection_status": device.connection_status,
        "control_mode": device.control_mode, "last_telemetry_at": device.last_telemetry_at.isoformat() if device.last_telemetry_at else None,
    }}

    # 1. current measured readings
    if reading is not None:
        age_s = (now - reading.measured_at).total_seconds()
        ctx["current_reading"] = {
            "kind": "measurement" if reading.source == "hardware" else "simulated_measurement",
            "source": reading.source,
            "measured_at": reading.measured_at.isoformat(),
            "age_seconds": int(age_s),
            "stale": age_s > 180,
            "temperature_c": reading.temperature_c,
            "relative_humidity_percent": reading.relative_humidity_percent,
            "substrate_moisture_raw": reading.substrate_moisture_raw,
            "quality": {k: v for k, v in (reading.quality or {}).items() if k in ("temperature_c", "relative_humidity_percent", "substrate_moisture_raw", "time")},
            "fan_state": reading.fan_state, "heater_state": reading.heater_state, "humidifier_state": reading.humidifier_state,
        }
    else:
        ctx["current_reading"] = None

    # 2. targets and control reasoning
    ctx["targets"] = {"kind": "configuration", **targets}
    last_eval = (device.control_state or {}).get("last_evaluation") or {}
    ctx["control"] = {
        "kind": "control_service",
        "mode": device.control_mode,
        "interlocks": last_eval.get("interlocks", []),
        "last_decisions": last_eval.get("decisions", []),
        "notes": last_eval.get("notes", []),
        "evaluated_at": last_eval.get("evaluated_at"),
        "actuators": {
            a: {"requested": e.get("requested"), "confirmed": e.get("confirmed"), "status": e.get("status"),
                "since": e.get("since"), "last_reason": e.get("last_reason"), "last_origin": e.get("last_origin")}
            for a, e in (device.actuator_state or {}).items() if isinstance(e, dict) and not a.startswith("_")
        },
    }

    # 3. history (last 24 h)
    summary = analytics.summarize(db, device.id, now - timedelta(hours=24), now, targets)
    hist: dict[str, Any] = {"kind": "history_24h", "n_readings": summary.get("n_readings", 0), "sources": summary.get("sources", [])}
    for m in ("temperature_c", "relative_humidity_percent", "substrate_moisture_raw"):
        h = summary.get(m) or {}
        if h.get("count"):
            hist[m] = {"min": h["min"], "max": h["max"], "mean": h["mean"]}
    hist["outside_range"] = summary.get("outside_range")
    hist["actuator_runtime"] = summary.get("actuator_runtime")
    hist["missing_intervals"] = summary.get("missing_intervals", [])[:5]
    hist["data_completeness"] = summary.get("data_completeness")
    first = db.execute(select(SensorReading).where(SensorReading.device_id == device.id, SensorReading.measured_at >= now - timedelta(hours=24))
                       .order_by(SensorReading.measured_at.asc()).limit(1)).scalar_one_or_none()
    if first is not None and reading is not None:
        hist["change_24h"] = {
            "from": first.measured_at.isoformat(),
            "temperature_delta_c": round(reading.temperature_c - first.temperature_c, 2) if reading.temperature_c is not None and first.temperature_c is not None else None,
            "humidity_delta_percent": round(reading.relative_humidity_percent - first.relative_humidity_percent, 1) if reading.relative_humidity_percent is not None and first.relative_humidity_percent is not None else None,
            "moisture_delta_raw": round(reading.substrate_moisture_raw - first.substrate_moisture_raw) if reading.substrate_moisture_raw is not None and first.substrate_moisture_raw is not None else None,
        }
    ctx["history"] = hist

    # 4. alerts
    alerts = db.execute(select(Alert).where(Alert.device_id == device.id, Alert.opened_at >= now - timedelta(hours=24))
                        .order_by(Alert.opened_at.desc()).limit(15)).scalars().all()
    ctx["alerts"] = {"kind": "rule_based_alerts", "items": [
        {"title": a.title, "severity": a.severity, "status": a.status, "opened_at": a.opened_at.isoformat(), "message": a.message}
        for a in alerts]}

    # 5. anomalies (rule based)
    anomalies = prediction.detect_anomalies(db, device, now=now, hours=24)
    ctx["anomalies"] = {"kind": "rule_based_anomalies", "items": anomalies["anomalies"][:10], "instability_windows": anomalies["instability_windows"][:5]}

    # 6. batch, observations, stage estimate
    if batch is not None:
        est = prediction.stage_estimate(db, batch, now=now)
        observations = db.execute(select(BatchObservation).where(BatchObservation.batch_id == batch.id)
                                  .order_by(BatchObservation.observed_at.desc()).limit(8)).scalars().all()
        ctx["batch"] = {
            "kind": "batch_record", "id": batch.id, "code": batch.code, "name": batch.name, "species": batch.species, "strain": batch.strain,
            "substrate_type": batch.substrate_type, "inoculation_date": batch.inoculation_date.isoformat() if batch.inoculation_date else None,
            "status": batch.status, "current_stage_key": batch.current_stage_key, "profile": batch.profile.name if batch.profile else None,
            "profile_source": batch.profile.source if batch.profile else None, "is_demo": batch.is_demo, "notes": batch.notes,
            "stage_sequence": [s["key"] for s in (batch.profile.stages if batch.profile else [])],
        }
        ctx["observations"] = {"kind": "user_observations", "items": [
            {"observed_at": o.observed_at.isoformat(), "kind": o.kind, "note": o.note, "stage_key": o.stage_key} for o in observations]}
        ctx["stage_estimate"] = {"kind": "model_estimate", **{k: v for k, v in est.items() if k != "model"}, "model": est.get("model", {}).get("name")}
    else:
        ctx["batch"] = None
        ctx["observations"] = {"kind": "user_observations", "items": []}
        ctx["stage_estimate"] = None

    # 7. forecast + recommendations (model outputs)
    fc = prediction.environmental_forecast(db, device.id, now=now)
    ctx["forecast"] = {"kind": "model_forecast", "model": fc["model"]["name"], "metrics": {
        m: ({"trend": e.get("trend"), "slope_per_hour": e.get("slope_per_hour"), "forecasts": e.get("forecasts")} if e.get("sufficient") else {"sufficient": False, "limitation": e.get("limitation")})
        for m, e in fc["metrics"].items()}}
    recs = prediction.recommendations(db, device, now=now)
    ctx["recommendations"] = {"kind": "rule_based_recommendations", "items": [
        {"title": r["title"], "detected": r["detected"], "action": r["action"], "confidence": r["confidence"]["level"], "requires_confirmation": r["requires_confirmation"]}
        for r in recs["recommendations"][:8]]}
    return ctx


def render_context_markdown(ctx: dict[str, Any]) -> str:
    """Compact, labelled text block for the LLM system prompt."""
    lines: list[str] = []
    dev = ctx["device"]
    lines.append(f"## DEVICE\n{dev['name']} ({dev['id']}), kind={dev['kind']}, status={dev['connection_status']}, control_mode={dev['control_mode']}")
    cr = ctx.get("current_reading")
    lines.append("## CURRENT READING (type: %s)" % ("SIMULATED measurement" if cr and cr["source"] == "simulation" else "measurement"))
    if cr:
        lines.append(
            f"measured_at={cr['measured_at']} (age {cr['age_seconds']}s{', STALE' if cr['stale'] else ''}); "
            f"temperature_c={cr['temperature_c']}; relative_humidity_percent={cr['relative_humidity_percent']}; "
            f"substrate_moisture_raw={cr['substrate_moisture_raw']} (uncalibrated raw units); quality={cr['quality']}; "
            f"fan={cr['fan_state']}; heater={cr['heater_state']}; humidifier={cr['humidifier_state']}"
        )
    else:
        lines.append("No readings stored for this device.")
    tg = ctx["targets"]
    lines.append("## CONFIGURED TARGETS (type: configuration)")
    lines.append(f"temperature {tg.get('temperature_min_c')}–{tg.get('temperature_max_c')} °C; humidity {tg.get('humidity_min_percent')}–{tg.get('humidity_max_percent')} %; "
                 f"source={tg.get('source_label')}; stage={tg.get('stage_key')}; batch={tg.get('batch_code')}")
    c = ctx["control"]
    lines.append("## CONTROL SERVICE (type: deterministic control – these are the real reasons for actuator states)")
    lines.append(f"mode={c['mode']}; interlocks={c['interlocks']}; evaluated_at={c['evaluated_at']}")
    for a, e in c["actuators"].items():
        lines.append(f"- {a}: confirmed={e['confirmed']} (status {e['status']}, since {e['since']}); requested={e['requested']}; last_reason={e['last_reason']}; origin={e['last_origin']}")
    for d in c["last_decisions"]:
        lines.append(f"- decision: {d.get('actuator')} -> {'ON' if d.get('desired') else 'OFF'} because {d.get('reason')} [{d.get('origin')}]")
    for n in c["notes"]:
        lines.append(f"- note: {n}")
    h = ctx["history"]
    lines.append("## LAST 24 HOURS (type: historical measurements; sources=%s)" % h.get("sources"))
    for m in ("temperature_c", "relative_humidity_percent", "substrate_moisture_raw"):
        if m in h:
            lines.append(f"- {m}: min {h[m]['min']}, max {h[m]['max']}, mean {h[m]['mean']}")
    if h.get("change_24h"):
        lines.append(f"- change since {h['change_24h']['from']}: ΔT={h['change_24h']['temperature_delta_c']} °C, ΔRH={h['change_24h']['humidity_delta_percent']} %, Δmoisture={h['change_24h']['moisture_delta_raw']} raw")
    if h.get("outside_range"):
        for m, o in h["outside_range"].items():
            lines.append(f"- {m}: outside range {round((o['outside_fraction'] or 0) * 100, 1)}% of measured time (below {o['below_seconds']}s, above {o['above_seconds']}s)")
    if h.get("actuator_runtime"):
        lines.append("- actuator on-time (s): " + ", ".join(f"{k}={v['on_seconds']}" for k, v in h["actuator_runtime"].items()))
    lines.append(f"- data completeness {h.get('data_completeness')}; missing intervals: {h.get('missing_intervals')}")
    lines.append("## ALERTS LAST 24 H (type: rule-based alerts)")
    lines.extend(f"- [{a['severity']}/{a['status']}] {a['opened_at']}: {a['title']} – {a['message']}" for a in ctx["alerts"]["items"]) or lines.append("- none")
    if not ctx["alerts"]["items"]:
        lines.append("- none")
    lines.append("## ANOMALIES LAST 24 H (type: rule-based detection)")
    if ctx["anomalies"]["items"]:
        lines.extend(f"- {a['label']} ({a['start']} → {a['end']})" for a in ctx["anomalies"]["items"])
    else:
        lines.append("- none detected")
    b = ctx.get("batch")
    if b:
        lines.append("## BATCH (type: user records)")
        lines.append(f"{b['code']} '{b['name']}': species={b['species']}, strain={b['strain']}, substrate={b['substrate_type']}, inoculated={b['inoculation_date']}, "
                     f"status={b['status']}, current_stage={b['current_stage_key']}, profile={b['profile']} (source {b['profile_source']}), demo={b['is_demo']}")
        lines.append(f"stage sequence: {b['stage_sequence']}")
        lines.append("## GROWER OBSERVATIONS (type: user-provided)")
        if ctx["observations"]["items"]:
            lines.extend(f"- {o['observed_at']} [{o['kind']}{'/' + o['stage_key'] if o['stage_key'] else ''}]: {o['note']}" for o in ctx["observations"]["items"])
        else:
            lines.append("- none recorded")
        est = ctx.get("stage_estimate") or {}
        lines.append("## STAGE ESTIMATE (type: MODEL ESTIMATE – calendar based, not a biological measurement)")
        if est.get("available"):
            cs = est["current_stage"]
            lines.append(f"current stage {cs['name']} since {cs['started_at']} (confirmed by {cs['confirmed_by']}), day {cs['elapsed_days']}, typical {cs['typical_duration_days']}; timing={est['timing']}: {est['timing_label']}")
            if est.get("next_stage"):
                ns = est["next_stage"]
                lines.append(f"next stage {ns['name']} expected between {ns['expected_window']['earliest']} and {ns['expected_window']['latest']}; signs: {ns['observable_signs']}")
            if est.get("harvest_window"):
                lines.append(f"harvest window estimate: {est['harvest_window']['earliest']} – {est['harvest_window']['latest']}")
            lines.append(f"confidence={est['confidence']['level']}; basis={est['confidence']['basis']}")
        else:
            lines.append(f"not available: {est.get('limitation')}")
    else:
        lines.append("## BATCH\nNo active batch assigned to this device.")
    lines.append("## FORECAST (type: MODEL FORECAST – linear trend baseline)")
    for m, e in ctx["forecast"]["metrics"].items():
        if e.get("sufficient") is False:
            lines.append(f"- {m}: insufficient data ({e.get('limitation')})")
        else:
            lines.append(f"- {m}: trend {e.get('trend')} ({e.get('slope_per_hour')}/h); " + "; ".join(
                f"+{f['horizon_minutes']}min ≈ {f['value']} [{f['lower']}–{f['upper']}]" for f in (e.get("forecasts") or [])))
    lines.append("## RULE-BASED RECOMMENDATIONS (type: deterministic rules)")
    for r in ctx["recommendations"]["items"]:
        lines.append(f"- {r['title']}: {r['detected']} → {r['action']} (confidence {r['confidence']}; confirmation required: {r['requires_confirmation']})")
    return "\n".join(lines)
