"""Rule-based alert engine with de-duplication, cooldown and auto-resolution.

Every rule produces a ``dedup_key`` (``rule_key:device_id[:extra]``).  While a
condition persists the existing alert is updated (``last_seen_at`` and
``occurrence_count``) instead of creating duplicates.  When the condition has
not been observed for ``auto_resolve_after_seconds`` the alert is resolved.
If the same condition re-appears within ``cooldown_seconds`` the previous
alert is re-opened silently (no new notification).
"""
from __future__ import annotations

import logging
import statistics
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..db.models import ActuatorCommand, ActuatorStatusEvent, Alert, Device, SensorReading
from . import settings_store
from .control import effective_config, resolve_targets
from .telemetry import log_event

log = logging.getLogger(__name__)

Outbox = list[tuple[str, dict[str, Any]]]


@dataclass
class Finding:
    rule_key: str
    severity: str
    title: str
    message: str
    device_id: str | None = None
    batch_id: int | None = None
    extra_key: str = ""
    data: dict[str, Any] | None = None

    @property
    def dedup_key(self) -> str:
        parts = [self.rule_key, self.device_id or "-"]
        if self.extra_key:
            parts.append(self.extra_key)
        return ":".join(parts)


def alert_to_dict(a: Alert) -> dict[str, Any]:
    return {
        "id": a.id,
        "rule_key": a.rule_key,
        "dedup_key": a.dedup_key,
        "severity": a.severity,
        "title": a.title,
        "message": a.message,
        "device_id": a.device_id,
        "batch_id": a.batch_id,
        "source": a.source,
        "status": a.status,
        "opened_at": a.opened_at.isoformat(),
        "last_seen_at": a.last_seen_at.isoformat(),
        "acknowledged_at": a.acknowledged_at.isoformat() if a.acknowledged_at else None,
        "acknowledged_by": a.acknowledged_by,
        "resolved_at": a.resolved_at.isoformat() if a.resolved_at else None,
        "resolved_reason": a.resolved_reason,
        "occurrence_count": a.occurrence_count,
        "data": a.data or {},
    }


class AlertEngine:
    def __init__(self) -> None:
        # dedup_key -> first time the condition was observed (for grace periods)
        self._pending_since: dict[str, datetime] = {}

    # ------------------------------------------------------------------ core
    def raise_finding(self, db: Session, finding: Finding, source: str, now: datetime, outbox: Outbox) -> Alert:
        cfg = settings_store.get_section(db, "alerts")
        existing = db.execute(
            select(Alert).where(Alert.dedup_key == finding.dedup_key).order_by(Alert.opened_at.desc()).limit(1)
        ).scalar_one_or_none()
        if existing is not None and existing.status in ("active", "acknowledged"):
            existing.last_seen_at = now
            existing.occurrence_count += 1
            existing.message = finding.message
            if finding.data:
                existing.data = finding.data
            if _rank(finding.severity) > _rank(existing.severity):
                existing.severity = finding.severity
                existing.status = "active"  # escalation re-activates acknowledged alerts
                outbox.append(("alert", {"alert": alert_to_dict(existing), "action": "escalated"}))
            db.flush()
            return existing
        if existing is not None and existing.status == "resolved" and existing.resolved_at is not None:
            if (now - existing.resolved_at).total_seconds() < float(cfg["cooldown_seconds"]):
                existing.status = "active"
                existing.resolved_at = None
                existing.resolved_reason = None
                existing.last_seen_at = now
                existing.occurrence_count += 1
                existing.message = finding.message
                existing.severity = finding.severity
                if finding.data:
                    existing.data = finding.data
                db.flush()
                outbox.append(("alert", {"alert": alert_to_dict(existing), "action": "reopened"}))
                return existing
        alert = Alert(
            rule_key=finding.rule_key,
            dedup_key=finding.dedup_key,
            severity=finding.severity,
            title=finding.title,
            message=finding.message,
            device_id=finding.device_id,
            batch_id=finding.batch_id,
            source=source,
            status="active",
            opened_at=now,
            last_seen_at=now,
            data=finding.data,
        )
        db.add(alert)
        db.flush()
        log_event(db, "alert", f"alert opened: {finding.title}", level="warning" if finding.severity != "critical" else "error",
                  device_id=finding.device_id, data={"alert_id": alert.id, "rule_key": finding.rule_key})
        outbox.append(("alert", {"alert": alert_to_dict(alert), "action": "opened", "notify": True}))
        return alert

    def auto_resolve(self, db: Session, now: datetime, outbox: Outbox, *, device_id: str | None = None) -> list[Alert]:
        cfg = settings_store.get_section(db, "alerts")
        horizon = now - timedelta(seconds=float(cfg["auto_resolve_after_seconds"]))
        stmt = select(Alert).where(Alert.status.in_(("active", "acknowledged")), Alert.last_seen_at < horizon)
        if device_id:
            stmt = stmt.where(Alert.device_id == device_id)
        resolved = []
        for alert in db.execute(stmt).scalars().all():
            if alert.rule_key in ("command_failed",):
                continue  # one-shot alerts are resolved manually
            alert.status = "resolved"
            alert.resolved_at = now
            alert.resolved_reason = "condition cleared"
            resolved.append(alert)
            outbox.append(("alert", {"alert": alert_to_dict(alert), "action": "resolved"}))
        db.flush()
        return resolved

    # -------------------------------------------------------------- per reading
    def evaluate_reading(self, db: Session, device: Device, reading: SensorReading, now: datetime, outbox: Outbox) -> list[Alert]:
        cfg = settings_store.get_section(db, "alerts")
        ccfg = effective_config(db, device)
        targets = resolve_targets(db, device)
        source = "simulation" if reading.source == "simulation" else "hardware"
        batch_id = targets.get("batch_id")
        findings: list[Finding] = []
        quality = reading.quality or {}

        temp = reading.temperature_c
        rh = reading.relative_humidity_percent
        grace = float(cfg["out_of_range_grace_seconds"])

        def graced(key: str, condition: bool) -> bool:
            if not condition:
                self._pending_since.pop(key, None)
                return False
            first = self._pending_since.setdefault(key, now)
            return (now - first).total_seconds() >= grace

        if temp is not None:
            t_min, t_max = float(targets["temperature_min_c"]), float(targets["temperature_max_c"])
            out = temp < t_min or temp > t_max
            key = f"temperature_out_of_range:{device.id}"
            if graced(key, out):
                dev = (t_min - temp) if temp < t_min else (temp - t_max)
                sev = "critical" if (temp >= float(ccfg["heater_absolute_max_temp_c"]) or dev >= 3.0) else "warning"
                findings.append(Finding("temperature_out_of_range", sev, "Temperature outside target range",
                                        f"{temp:.1f}°C is {'below' if temp < t_min else 'above'} the configured range {t_min:.1f}–{t_max:.1f}°C ({targets['source_label']}).",
                                        device.id, batch_id, data={"value": temp, "min": t_min, "max": t_max}))
        if rh is not None:
            rh_min, rh_max = float(targets["humidity_min_percent"]), float(targets["humidity_max_percent"])
            out = rh < rh_min or rh > rh_max
            key = f"humidity_out_of_range:{device.id}"
            if graced(key, out):
                dev = (rh_min - rh) if rh < rh_min else (rh - rh_max)
                findings.append(Finding("humidity_out_of_range", "critical" if dev >= 15 else "warning",
                                        "Humidity outside target range",
                                        f"{rh:.0f}% RH is {'below' if rh < rh_min else 'above'} the configured range {rh_min:.0f}–{rh_max:.0f}% ({targets['source_label']}).",
                                        device.id, batch_id, data={"value": rh, "min": rh_min, "max": rh_max}))
        moisture_min = targets.get("moisture_min_raw")
        if moisture_min is not None and reading.substrate_moisture_raw is not None and reading.substrate_moisture_raw < float(moisture_min):
            findings.append(Finding("moisture_low", "warning", "Growing-medium moisture below configured minimum",
                                    f"Raw moisture reading {reading.substrate_moisture_raw:.0f} is below the configured minimum {float(moisture_min):.0f} (uncalibrated raw units).",
                                    device.id, batch_id))

        for field_name, label in (("temperature_c", "Temperature"), ("relative_humidity_percent", "Humidity"), ("substrate_moisture_raw", "Moisture")):
            q = quality.get(field_name)
            if q in ("invalid", "sensor_error", "missing"):
                recent = db.execute(
                    select(SensorReading.quality).where(SensorReading.device_id == device.id)
                    .order_by(SensorReading.measured_at.desc()).limit(3)
                ).scalars().all()
                if len(recent) >= 3 and all((r or {}).get(field_name) in ("invalid", "sensor_error", "missing") for r in recent):
                    findings.append(Finding("sensor_invalid", "warning", f"{label} sensor data invalid or missing",
                                            f"The last 3 readings reported {label.lower()} as '{q}'. Check sensor wiring and placement.",
                                            device.id, batch_id, extra_key=field_name))

        # rapid temperature rise over 10 minutes
        if temp is not None:
            window_start = reading.measured_at - timedelta(minutes=10)
            older = db.execute(
                select(SensorReading.temperature_c).where(
                    SensorReading.device_id == device.id, SensorReading.measured_at <= window_start,
                    SensorReading.temperature_c.isnot(None)
                ).order_by(SensorReading.measured_at.desc()).limit(1)
            ).scalar_one_or_none()
            if older is not None and temp - older >= float(cfg["rapid_temp_rise_c_per_10min"]):
                findings.append(Finding("rapid_temperature_rise", "critical", "Unexpected rapid temperature increase",
                                        f"Temperature rose {temp - older:.1f}°C within 10 minutes (from {older:.1f}°C to {temp:.1f}°C). Check the heater and relay.",
                                        device.id, batch_id, data={"delta": temp - older}))
            recent_temps = db.execute(
                select(SensorReading.temperature_c).where(
                    SensorReading.device_id == device.id,
                    SensorReading.measured_at >= reading.measured_at - timedelta(minutes=15),
                    SensorReading.temperature_c.isnot(None),
                )
            ).scalars().all()
            if len(recent_temps) >= 6 and statistics.pstdev(recent_temps) >= float(cfg["fluctuation_std_c_15min"]):
                findings.append(Finding("temperature_fluctuation", "warning", "Abnormal temperature fluctuation",
                                        f"Temperature standard deviation over the last 15 minutes is {statistics.pstdev(recent_temps):.2f}°C.",
                                        device.id, batch_id))

        # unexpected actuator states
        if reading.heater_state and temp is not None and temp > float(targets["temperature_max_c"]) + 1.0:
            findings.append(Finding("unexpected_actuator_state", "warning", "Heater running above target maximum",
                                    f"Heater is reported ON while temperature is {temp:.1f}°C (target max {float(targets['temperature_max_c']):.1f}°C).",
                                    device.id, batch_id, extra_key="heater"))
        for actuator, entry in (device.actuator_state or {}).items():
            if isinstance(entry, dict) and entry.get("status") == "mismatch":
                findings.append(Finding("actuator_mismatch", "warning", f"{actuator.capitalize()} state does not match command",
                                        f"Requested {'ON' if entry.get('requested') else 'OFF'} but the device reports {'ON' if entry.get('confirmed') else 'OFF'}.",
                                        device.id, batch_id, extra_key=actuator))

        # rapid switching
        since = now - timedelta(minutes=15)
        for actuator in ("fan", "heater", "humidifier"):
            count = len(db.execute(
                select(ActuatorStatusEvent.id).where(ActuatorStatusEvent.device_id == device.id,
                                                     ActuatorStatusEvent.actuator == actuator,
                                                     ActuatorStatusEvent.observed_at >= since)
            ).scalars().all())
            if count >= int(cfg["rapid_switching_count_15min"]):
                findings.append(Finding("rapid_switching", "warning", f"{actuator.capitalize()} switching too frequently",
                                        f"{count} state changes in 15 minutes. Check hysteresis settings and sensor noise.",
                                        device.id, batch_id, extra_key=actuator))

        alerts = [self.raise_finding(db, f, source, now, outbox) for f in findings]
        return alerts

    # ----------------------------------------------------------------- periodic
    def evaluate_periodic(self, db: Session, now: datetime, outbox: Outbox) -> list[Alert]:
        cfg = settings_store.get_section(db, "alerts")
        alerts: list[Alert] = []
        for device in db.execute(select(Device).where(Device.is_enabled.is_(True))).scalars().all():
            source = "simulation" if device.kind == "simulated" else "hardware"
            last = device.last_telemetry_at
            stale_s = float(cfg["stale_telemetry_seconds"])
            if device.connection_status == "online" or last is not None:
                if last is None or (now - last).total_seconds() > stale_s:
                    severity = "critical" if (device.control_mode == "auto" and device.kind == "hardware") else "warning"
                    age = f"{int((now - last).total_seconds())}s ago" if last else "never"
                    alerts.append(self.raise_finding(db, Finding(
                        "telemetry_missing", severity, "Telemetry missing",
                        f"No telemetry from {device.id} (last {age}; limit {int(stale_s)}s). Automatic heating is disabled while data is stale.",
                        device.id), source, now, outbox))
            if device.connection_status == "offline" and last is not None:
                alerts.append(self.raise_finding(db, Finding(
                    "device_offline", "warning", "Device disconnected",
                    f"{device.name} ({device.id}) is offline. Device-side safety logic must keep the heater safe.",
                    device.id), source, now, outbox))
            heater = (device.actuator_state or {}).get("heater", {})
            if heater.get("confirmed") and heater.get("since") and device.connection_status == "online":
                try:
                    since = datetime.fromisoformat(heater["since"])
                    if since.tzinfo is None:
                        since = since.replace(tzinfo=timezone.utc)
                    runtime = (now - since).total_seconds()
                except ValueError:
                    runtime = 0
                if runtime > float(cfg["heater_max_runtime_seconds"]):
                    alerts.append(self.raise_finding(db, Finding(
                        "heater_runtime_exceeded", "critical", "Excessive heater runtime",
                        f"Heater has been on continuously for {int(runtime // 60)} minutes (limit {int(float(cfg['heater_max_runtime_seconds']) // 60)} min).",
                        device.id, data={"runtime_seconds": runtime}), source, now, outbox))
            failed = db.execute(
                select(ActuatorCommand).where(ActuatorCommand.device_id == device.id,
                                              ActuatorCommand.status.in_(("failed", "timeout")),
                                              ActuatorCommand.created_at >= now - timedelta(minutes=10))
            ).scalars().all()
            for cmd in failed:
                alerts.append(self.raise_finding(db, Finding(
                    "command_failed", "warning", f"{cmd.actuator.capitalize()} command not confirmed",
                    f"Command {cmd.command_id[:8]} ({cmd.actuator} -> {'ON' if cmd.requested_state else 'OFF'}) {cmd.status}: {cmd.error or 'no confirmation'}.",
                    device.id, extra_key=cmd.command_id, data={"command_id": cmd.command_id}), source, now, outbox))
        self.auto_resolve(db, now, outbox)
        return alerts

    # -------------------------------------------------------------- lifecycle
    def acknowledge(self, db: Session, alert: Alert, actor: str, now: datetime | None = None) -> Alert:
        now = now or datetime.now(timezone.utc)
        if alert.status == "active":
            alert.status = "acknowledged"
            alert.acknowledged_at = now
            alert.acknowledged_by = actor
        db.flush()
        return alert

    def resolve(self, db: Session, alert: Alert, actor: str, reason: str = "resolved by user", now: datetime | None = None) -> Alert:
        now = now or datetime.now(timezone.utc)
        if alert.status != "resolved":
            alert.status = "resolved"
            alert.resolved_at = now
            alert.resolved_reason = f"{reason} ({actor})"
        db.flush()
        return alert


def _rank(sev: str) -> int:
    return {"info": 1, "warning": 2, "critical": 3}.get(sev, 0)


engine = AlertEngine()
