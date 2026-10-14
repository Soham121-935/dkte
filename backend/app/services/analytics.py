"""Historical analytics: bucketed series, distributions, runtimes, time outside
range, missing-data intervals, daily/weekly summaries, stage correlations and
CSV export.  All computations are explicit and dialect independent.
"""
from __future__ import annotations

import csv
import io
import math
import statistics
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from typing import Any, Iterable

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..db.models import CultivationBatch, SensorReading, StageEvent
from .control import resolve_targets, stage_definition

METRIC_COLUMNS = ("temperature_c", "relative_humidity_percent", "substrate_moisture_raw")
ACTUATOR_COLUMNS = ("fan_state", "heater_state", "humidifier_state")


def choose_bucket_seconds(start: datetime, end: datetime, max_points: int = 400) -> int:
    span = max((end - start).total_seconds(), 1.0)
    raw = span / max_points
    for candidate in (5, 10, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 14400, 21600, 43200, 86400):
        if raw <= candidate:
            return candidate
    return 86400


def fetch_readings(db: Session, device_id: str, start: datetime, end: datetime) -> list[SensorReading]:
    return db.execute(
        select(SensorReading)
        .where(SensorReading.device_id == device_id, SensorReading.measured_at >= start, SensorReading.measured_at <= end)
        .order_by(SensorReading.measured_at.asc())
    ).scalars().all()


def bucketize(rows: Iterable[SensorReading], bucket_seconds: int) -> list[dict[str, Any]]:
    """Aggregate readings into fixed buckets (mean/min/max per metric, on-ratio per actuator)."""
    buckets: dict[int, dict[str, Any]] = {}
    sources: dict[int, set[str]] = defaultdict(set)
    for r in rows:
        key = int(r.measured_at.timestamp() // bucket_seconds) * bucket_seconds
        b = buckets.setdefault(key, {"n": 0, **{m: [] for m in METRIC_COLUMNS}, **{a: [] for a in ACTUATOR_COLUMNS}, "invalid": 0})
        b["n"] += 1
        sources[key].add(r.source)
        q = r.quality or {}
        for m in METRIC_COLUMNS:
            v = getattr(r, m)
            if v is not None and q.get(m) in ("ok", "suspect", None):
                b[m].append(v)
            elif q.get(m) in ("invalid", "sensor_error"):
                b["invalid"] += 1
        for a in ACTUATOR_COLUMNS:
            v = getattr(r, a)
            if v is not None:
                b[a].append(1.0 if v else 0.0)
    out = []
    for key in sorted(buckets):
        b = buckets[key]
        point: dict[str, Any] = {"t": datetime.fromtimestamp(key, tz=timezone.utc).isoformat(), "n": b["n"],
                                 "source": "mixed" if len(sources[key]) > 1 else next(iter(sources[key]))}
        for m in METRIC_COLUMNS:
            vals = b[m]
            point[m] = round(sum(vals) / len(vals), 2) if vals else None
            point[f"{m}_min"] = round(min(vals), 2) if vals else None
            point[f"{m}_max"] = round(max(vals), 2) if vals else None
        for a in ACTUATOR_COLUMNS:
            vals = b[a]
            point[a.replace("_state", "_on_ratio")] = round(sum(vals) / len(vals), 3) if vals else None
        point["invalid_count"] = b["invalid"]
        out.append(point)
    return out


def _duration_weights(rows: list[SensorReading], end: datetime, cap_seconds: float = 900.0) -> list[float]:
    """Seconds each reading 'represents' (until the next reading, capped)."""
    weights = []
    for i, r in enumerate(rows):
        nxt = rows[i + 1].measured_at if i + 1 < len(rows) else end
        weights.append(max(0.0, min((nxt - r.measured_at).total_seconds(), cap_seconds)))
    return weights


def histogram(values: list[float], bins: int = 20) -> dict[str, Any]:
    if not values:
        return {"bins": [], "count": 0}
    lo, hi = min(values), max(values)
    if math.isclose(lo, hi):
        return {"bins": [{"from": lo, "to": hi, "count": len(values)}], "count": len(values), "min": lo, "max": hi,
                "mean": lo, "median": lo, "std": 0.0}
    width = (hi - lo) / bins
    counts = [0] * bins
    for v in values:
        idx = min(int((v - lo) / width), bins - 1)
        counts[idx] += 1
    return {
        "bins": [{"from": round(lo + i * width, 2), "to": round(lo + (i + 1) * width, 2), "count": c} for i, c in enumerate(counts)],
        "count": len(values), "min": round(lo, 2), "max": round(hi, 2),
        "mean": round(statistics.fmean(values), 2), "median": round(statistics.median(values), 2),
        "std": round(statistics.pstdev(values), 2),
        "p5": round(_percentile(values, 5), 2), "p95": round(_percentile(values, 95), 2),
    }


def _percentile(values: list[float], pct: float) -> float:
    s = sorted(values)
    k = (len(s) - 1) * pct / 100.0
    f = math.floor(k)
    c = math.ceil(k)
    if f == c:
        return s[int(k)]
    return s[f] + (s[c] - s[f]) * (k - f)


def summarize(db: Session, device_id: str, start: datetime, end: datetime, targets: dict[str, Any] | None = None) -> dict[str, Any]:
    rows = fetch_readings(db, device_id, start, end)
    weights = _duration_weights(rows, end)
    total_seconds = sum(weights)
    out: dict[str, Any] = {
        "device_id": device_id, "start": start.isoformat(), "end": end.isoformat(), "n_readings": len(rows),
        "covered_seconds": round(total_seconds), "sources": sorted({r.source for r in rows}),
    }
    if not rows:
        out["empty"] = True
        return out
    # distributions
    for m in METRIC_COLUMNS:
        vals = [getattr(r, m) for r in rows if getattr(r, m) is not None]
        out[m] = histogram(vals)
    # time outside configured ranges
    if targets:
        bands = {
            "temperature_c": (targets.get("temperature_min_c"), targets.get("temperature_max_c")),
            "relative_humidity_percent": (targets.get("humidity_min_percent"), targets.get("humidity_max_percent")),
        }
        outside: dict[str, Any] = {}
        for m, (lo, hi) in bands.items():
            if lo is None or hi is None:
                continue
            below = above = measured = 0.0
            for r, w in zip(rows, weights):
                v = getattr(r, m)
                if v is None:
                    continue
                measured += w
                if v < float(lo):
                    below += w
                elif v > float(hi):
                    above += w
            outside[m] = {"below_seconds": round(below), "above_seconds": round(above), "measured_seconds": round(measured),
                          "outside_fraction": round((below + above) / measured, 4) if measured else None, "min": lo, "max": hi}
        out["outside_range"] = outside
        out["targets"] = targets
    # actuator runtimes (seconds ON, weighted by reading interval)
    runtime: dict[str, Any] = {}
    for a in ACTUATOR_COLUMNS:
        on = known = 0.0
        switches = 0
        prev = None
        for r, w in zip(rows, weights):
            v = getattr(r, a)
            if v is None:
                continue
            known += w
            if v:
                on += w
            if prev is not None and v != prev:
                switches += 1
            prev = v
        runtime[a.replace("_state", "")] = {"on_seconds": round(on), "known_seconds": round(known),
                                             "duty_cycle": round(on / known, 4) if known else None, "switch_count": switches}
    out["actuator_runtime"] = runtime
    # missing data intervals
    gaps = []
    if len(rows) >= 2:
        deltas = sorted((rows[i + 1].measured_at - rows[i].measured_at).total_seconds() for i in range(len(rows) - 1))
        median = deltas[len(deltas) // 2]
        threshold = max(3 * median, 120.0)
        for i in range(len(rows) - 1):
            gap = (rows[i + 1].measured_at - rows[i].measured_at).total_seconds()
            if gap > threshold:
                gaps.append({"start": rows[i].measured_at.isoformat(), "end": rows[i + 1].measured_at.isoformat(), "seconds": round(gap)})
        out["expected_interval_seconds"] = round(median)
    if rows and (end - rows[-1].measured_at).total_seconds() > max(300.0, 3 * out.get("expected_interval_seconds", 60)):
        gaps.append({"start": rows[-1].measured_at.isoformat(), "end": end.isoformat(),
                     "seconds": round((end - rows[-1].measured_at).total_seconds()), "ongoing": True})
    out["missing_intervals"] = gaps
    out["missing_seconds"] = round(sum(g["seconds"] for g in gaps))
    span = max((end - start).total_seconds(), 1.0)
    out["data_completeness"] = round(max(0.0, 1.0 - out["missing_seconds"] / span), 4)
    invalid = sum(1 for r in rows if any((r.quality or {}).get(m) in ("invalid", "sensor_error") for m in METRIC_COLUMNS))
    out["invalid_readings"] = invalid
    return out


def daily_summaries(db: Session, device_id: str, start: datetime, end: datetime, targets: dict[str, Any] | None, period: str = "day") -> list[dict[str, Any]]:
    rows = fetch_readings(db, device_id, start, end)
    groups: dict[str, list[SensorReading]] = defaultdict(list)
    for r in rows:
        if period == "week":
            iso = r.measured_at.isocalendar()
            key = f"{iso[0]}-W{iso[1]:02d}"
        else:
            key = r.measured_at.strftime("%Y-%m-%d")
        groups[key].append(r)
    result = []
    for key in sorted(groups):
        g = groups[key]
        g_start, g_end = g[0].measured_at, g[-1].measured_at
        w = _duration_weights(g, g_end + timedelta(seconds=60))
        entry: dict[str, Any] = {"period": key, "n_readings": len(g), "sources": sorted({r.source for r in g})}
        for m in METRIC_COLUMNS:
            vals = [getattr(r, m) for r in g if getattr(r, m) is not None]
            entry[m] = {"mean": round(statistics.fmean(vals), 2), "min": round(min(vals), 2), "max": round(max(vals), 2)} if vals else None
        for a in ACTUATOR_COLUMNS:
            on = sum(wi for r, wi in zip(g, w) if getattr(r, a))
            entry[a.replace("_state", "_on_minutes")] = round(on / 60.0, 1)
        if targets:
            lo, hi = targets.get("temperature_min_c"), targets.get("temperature_max_c")
            if lo is not None and hi is not None:
                outside = sum(wi for r, wi in zip(g, w) if r.temperature_c is not None and not (float(lo) <= r.temperature_c <= float(hi)))
                entry["temperature_outside_minutes"] = round(outside / 60.0, 1)
            lo, hi = targets.get("humidity_min_percent"), targets.get("humidity_max_percent")
            if lo is not None and hi is not None:
                outside = sum(wi for r, wi in zip(g, w) if r.relative_humidity_percent is not None and not (float(lo) <= r.relative_humidity_percent <= float(hi)))
                entry["humidity_outside_minutes"] = round(outside / 60.0, 1)
        result.append(entry)
    return result


def stage_environment_table(db: Session, batch: CultivationBatch, now: datetime | None = None) -> dict[str, Any]:
    """Per-stage environmental means for a batch – descriptive only (no causal claim)."""
    now = now or datetime.now(timezone.utc)
    events = sorted(batch.stage_events, key=lambda e: e.started_at)
    rows_out = []
    stages = (batch.profile.stages if batch.profile else []) or []
    for i, ev in enumerate(events):
        end = events[i + 1].started_at if i + 1 < len(events) else (batch.ended_at or now)
        entry: dict[str, Any] = {"stage_key": ev.stage_key, "started_at": ev.started_at.isoformat(), "ended_at": end.isoformat(),
                                 "duration_days": round((end - ev.started_at).total_seconds() / 86400.0, 2), "source": ev.source}
        sdef = stage_definition(stages, ev.stage_key)
        entry["stage_name"] = sdef["name"] if sdef else ev.stage_key
        entry["typical_duration_days"] = sdef.get("typical_duration_days") if sdef else None
        if batch.device_id:
            rows = fetch_readings(db, batch.device_id, ev.started_at, end)
            entry["n_readings"] = len(rows)
            for m in METRIC_COLUMNS:
                vals = [getattr(r, m) for r in rows if getattr(r, m) is not None]
                entry[m] = {"mean": round(statistics.fmean(vals), 2), "min": round(min(vals), 2), "max": round(max(vals), 2),
                            "std": round(statistics.pstdev(vals), 2)} if vals else None
            entry["sources"] = sorted({r.source for r in rows})
        rows_out.append(entry)
    return {"batch_id": batch.id, "stages": rows_out,
            "note": "Descriptive association between recorded conditions and stage durations. Correlation does not imply causation; "
                    "with a single batch no statistical inference is possible."}


def readings_csv(rows: Iterable[SensorReading]) -> str:
    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow(["device_id", "measured_at_utc", "received_at_utc", "source", "temperature_c", "relative_humidity_percent",
                     "substrate_moisture_raw", "fan_state", "heater_state", "humidifier_state", "quality_temperature",
                     "quality_humidity", "quality_moisture", "message_id"])
    for r in rows:
        q = r.quality or {}
        writer.writerow([r.device_id, r.measured_at.isoformat(), r.received_at.isoformat() if r.received_at else "", r.source,
                         r.temperature_c, r.relative_humidity_percent, r.substrate_moisture_raw,
                         "" if r.fan_state is None else int(r.fan_state), "" if r.heater_state is None else int(r.heater_state),
                         "" if r.humidifier_state is None else int(r.humidifier_state), q.get("temperature_c", ""),
                         q.get("relative_humidity_percent", ""), q.get("substrate_moisture_raw", ""), r.message_id or ""])
    return buf.getvalue()


def summaries_csv(summaries: list[dict[str, Any]]) -> str:
    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow(["period", "n_readings", "sources", "temp_mean", "temp_min", "temp_max", "rh_mean", "rh_min", "rh_max",
                     "moisture_mean", "fan_on_minutes", "heater_on_minutes", "humidifier_on_minutes",
                     "temperature_outside_minutes", "humidity_outside_minutes"])
    for s in summaries:
        t = s.get("temperature_c") or {}
        h = s.get("relative_humidity_percent") or {}
        m = s.get("substrate_moisture_raw") or {}
        writer.writerow([s["period"], s["n_readings"], "|".join(s.get("sources", [])), t.get("mean"), t.get("min"), t.get("max"),
                         h.get("mean"), h.get("min"), h.get("max"), m.get("mean"), s.get("fan_on_minutes"), s.get("heater_on_minutes"),
                         s.get("humidifier_on_minutes"), s.get("temperature_outside_minutes"), s.get("humidity_outside_minutes")])
    return buf.getvalue()


def batch_report(db: Session, batch: CultivationBatch, now: datetime | None = None) -> dict[str, Any]:
    from .prediction import stage_estimate  # local import to avoid cycle
    from ..db.models import Alert, Prediction

    now = now or datetime.now(timezone.utc)
    start = batch.started_at or batch.inoculation_date or batch.created_at
    end = batch.ended_at or now
    report: dict[str, Any] = {
        "generated_at": now.isoformat(),
        "batch": {"id": batch.id, "code": batch.code, "name": batch.name, "species": batch.species, "strain": batch.strain,
                  "substrate_type": batch.substrate_type, "inoculation_date": batch.inoculation_date.isoformat() if batch.inoculation_date else None,
                  "status": batch.status, "current_stage_key": batch.current_stage_key, "device_id": batch.device_id,
                  "profile": batch.profile.name if batch.profile else None, "is_demo": batch.is_demo, "outcome": batch.outcome},
        "period": {"start": start.isoformat(), "end": end.isoformat()},
    }
    if batch.device_id:
        device_targets = None
        if batch.profile:
            sdef = stage_definition(batch.profile.stages, batch.current_stage_key)
            device_targets = sdef.get("targets") if sdef else None
        report["sensor_summary"] = summarize(db, batch.device_id, start, end, device_targets)
    report["stage_environment"] = stage_environment_table(db, batch, now)
    report["observations"] = [
        {"observed_at": o.observed_at.isoformat(), "kind": o.kind, "note": o.note, "stage_key": o.stage_key, "image": o.image_path}
        for o in sorted(batch.observations, key=lambda o: o.observed_at)
    ]
    report["stage_estimate"] = stage_estimate(db, batch, now=now)
    report["predictions"] = [
        {"generated_at": p.generated_at.isoformat(), "kind": p.kind, "output": p.output, "uncertainty": p.uncertainty,
         "evaluated_at": p.evaluated_at.isoformat() if p.evaluated_at else None, "error": p.error}
        for p in db.execute(select(Prediction).where(Prediction.batch_id == batch.id).order_by(Prediction.generated_at.desc()).limit(50)).scalars()
    ]
    report["alerts"] = [
        {"opened_at": a.opened_at.isoformat(), "severity": a.severity, "title": a.title, "status": a.status, "message": a.message}
        for a in db.execute(select(Alert).where(Alert.batch_id == batch.id).order_by(Alert.opened_at.desc()).limit(100)).scalars()
    ]
    return report
