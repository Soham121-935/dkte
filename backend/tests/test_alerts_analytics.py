"""Alert engine (thresholds, grace, dedup, cooldown, auto-resolve, lifecycle),
periodic device-offline detection, analytics summaries and CSV export."""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone

from app.db.models import Alert, Device
from app.services import control
from app.services.alerts import engine as alert_engine
from app.services.telemetry import ingest_telemetry, mark_offline_devices
from app.services import settings_store
from tests.conftest import create_hw_device, post_telemetry

UTC = timezone.utc


def _reading(db, device: Device, now: datetime, **values):
    payload = {"device_id": device.id, "message_id": uuid.uuid4().hex, "timestamp": now.isoformat(),
               "temperature_c": 22.0, "relative_humidity_percent": 90.0, "substrate_moisture_raw": 2000,
               "fan_state": False, "heater_state": False, "humidifier_state": False}
    payload.update(values)
    r = ingest_telemetry(db, payload, transport="test", device=device, now=now)
    db.commit()
    return r


def _evaluate(db, device, now, **values):
    outbox = []
    r = _reading(db, device, now, **values)
    alerts = alert_engine.evaluate_reading(db, device, r, now, outbox)
    alert_engine.auto_resolve(db, now, outbox, device_id=device.id)
    db.commit()
    return alerts, outbox


class TestAlertEngine:
    def test_out_of_range_respects_grace_then_opens_once(self, db):
        d = db.get(Device, "myco-esp32-01")
        t0 = datetime.now(UTC)
        alerts, _ = _evaluate(db, d, t0, temperature_c=27.0)  # first sighting: inside grace period
        assert alerts == []
        alerts, outbox = _evaluate(db, d, t0 + timedelta(seconds=200), temperature_c=27.5)
        assert len(alerts) == 1
        a = alerts[0]
        assert a.rule_key == "temperature_out_of_range" and a.severity == "critical"  # 3.5 °C above max
        assert a.status == "active" and a.source == "hardware"
        assert [e[1]["action"] for e in outbox if e[0] == "alert"] == ["opened"]
        # same condition again -> deduplicated, occurrence count grows, no second alert row
        alerts, outbox = _evaluate(db, d, t0 + timedelta(seconds=260), temperature_c=27.2)
        assert alerts[0].id == a.id and a.occurrence_count == 2
        assert db.query(Alert).filter(Alert.rule_key == "temperature_out_of_range").count() == 1
        assert not [e for e in outbox if e[0] == "alert"]

    def test_condition_clears_then_auto_resolves_and_reopens_within_cooldown(self, db):
        d = db.get(Device, "myco-esp32-01")
        t0 = datetime.now(UTC)
        _evaluate(db, d, t0, relative_humidity_percent=60.0)
        alerts, _ = _evaluate(db, d, t0 + timedelta(seconds=200), relative_humidity_percent=60.0)
        a = alerts[0]
        assert a.rule_key == "humidity_out_of_range" and a.severity == "critical"
        # back in range: not resolved immediately ...
        _evaluate(db, d, t0 + timedelta(seconds=230), relative_humidity_percent=90.0)
        assert a.status == "active"
        # ... but after auto_resolve_after_seconds without being seen
        _, outbox = _evaluate(db, d, t0 + timedelta(seconds=400), relative_humidity_percent=90.0)
        assert a.status == "resolved" and a.resolved_reason == "condition cleared"
        assert [e[1]["action"] for e in outbox if e[0] == "alert"] == ["resolved"]
        # condition returns within the cooldown -> the same alert is reopened instead of a new one
        _evaluate(db, d, t0 + timedelta(seconds=420), relative_humidity_percent=60.0)
        alerts, outbox = _evaluate(db, d, t0 + timedelta(seconds=620), relative_humidity_percent=60.0)
        assert alerts[0].id == a.id and a.status == "active"
        assert [e[1]["action"] for e in outbox if e[0] == "alert"] == ["reopened"]

    def test_thresholds_are_configurable(self, db):
        settings_store.update_section(db, "alerts", {"out_of_range_grace_seconds": 0})
        db.commit()
        d = db.get(Device, "myco-esp32-01")
        alerts, _ = _evaluate(db, d, datetime.now(UTC), temperature_c=25.0)
        assert alerts and alerts[0].rule_key == "temperature_out_of_range" and alerts[0].severity == "warning"

    def test_sensor_fault_alert(self, db):
        d = db.get(Device, "myco-esp32-01")
        t0 = datetime.now(UTC)
        keys = set()
        for i in range(4):
            alerts, _ = _evaluate(db, d, t0 + timedelta(seconds=10 * i), temperature_c=None, relative_humidity_percent=None, sensor_errors=["dht11"])
            keys |= {a.rule_key for a in alerts}
        assert "sensor_invalid" in keys

    def test_rapid_temperature_rise_detected(self, db):
        d = db.get(Device, "myco-esp32-01")
        t0 = datetime.now(UTC)
        _evaluate(db, d, t0, temperature_c=20.0)
        _evaluate(db, d, t0 + timedelta(minutes=5), temperature_c=22.0)
        alerts, _ = _evaluate(db, d, t0 + timedelta(minutes=10), temperature_c=24.0)  # +4 °C in 10 min
        assert "rapid_temperature_rise" in {a.rule_key for a in alerts}

    def test_periodic_detects_missing_telemetry_and_offline_devices(self, db):
        d = db.get(Device, "myco-esp32-01")
        d.control_mode = "auto"
        t0 = datetime.now(UTC)
        _reading(db, d, t0)
        assert d.connection_status == "online"
        later = t0 + timedelta(seconds=150)
        changed = mark_offline_devices(db, 90, later)
        assert [x.id for x in changed] == [d.id] and d.connection_status == "offline"
        outbox = []
        alerts = alert_engine.evaluate_periodic(db, later, outbox)
        db.commit()
        keys = {a.rule_key: a for a in alerts}
        assert "telemetry_missing" in keys and keys["telemetry_missing"].severity == "critical"  # hardware in auto
        assert "device_offline" in keys
        # when the device comes back the controller re-evaluates and alerts resolve over time
        _reading(db, d, later + timedelta(seconds=10))
        assert d.connection_status == "online"
        alert_engine.auto_resolve(db, later + timedelta(seconds=300), outbox)
        db.commit()
        assert all(a.status == "resolved" for a in alerts)

    def test_command_timeout_raises_one_shot_alert(self, db):
        d = Device(id="esp32-cmd", name="c", kind="hardware", transport="http", control_mode="manual", connection_status="online")
        db.add(d)
        db.commit()
        t0 = datetime.now(UTC)
        _reading(db, d, t0)
        cmd = control.issue_command(db, d, "fan", True, reason="x", origin="manual", now=t0)
        db.commit()
        control.expire_commands(db, 45, t0 + timedelta(seconds=60))
        outbox = []
        alerts = alert_engine.evaluate_periodic(db, t0 + timedelta(seconds=60), outbox)
        db.commit()
        failed = [a for a in alerts if a.rule_key == "command_failed"]
        assert failed and cmd.command_id[:8] in failed[0].message
        # one-shot alerts are not auto-resolved
        alert_engine.auto_resolve(db, t0 + timedelta(hours=1), outbox)
        assert failed[0].status == "active"


class TestAlertApi:
    def test_lifecycle_requires_operator(self, client, admin, operator, viewer, db):
        d = db.get(Device, "myco-esp32-01")
        t0 = datetime.now(UTC)
        _evaluate(db, d, t0, temperature_c=27.0)
        alerts, _ = _evaluate(db, d, t0 + timedelta(seconds=200), temperature_c=27.0)
        aid = alerts[0].id
        listed = client.get("/api/alerts", params={"status": "active"}).json()
        assert [a["id"] for a in listed] == [aid]
        assert client.post(f"/api/alerts/{aid}/acknowledge").status_code == 401
        assert client.post(f"/api/alerts/{aid}/acknowledge", headers=viewer).status_code == 403
        r = client.post(f"/api/alerts/{aid}/acknowledge", headers=operator)
        assert r.status_code == 200 and r.json()["status"] == "acknowledged" and r.json()["acknowledged_by"] == "operator1"
        r = client.post(f"/api/alerts/{aid}/resolve", json={"note": "fan fixed"}, headers=operator)
        assert r.status_code == 200 and r.json()["status"] == "resolved" and "fan fixed" in r.json()["resolved_reason"]
        summary = client.get("/api/alerts/summary").json()
        assert summary["by_status"].get("active", 0) == 0 and summary["by_status"]["resolved"] >= 1
        assert summary["thresholds"]["cooldown_seconds"] == 600
        assert client.post("/api/alerts/9999/acknowledge", headers=operator).status_code == 404

    def test_channels_report_configuration_without_secrets(self, client):
        ch = {c["name"]: c for c in client.get("/api/alerts/channels").json()}
        assert ch["in_app"]["enabled"] is True
        assert ch["webhook"]["enabled"] is False and ch["email"]["enabled"] is False
        assert "password" not in str(ch).lower()


# ----------------------------------------------------------------- analytics
def _fill(db, device: Device, start: datetime, minutes: int, step_s: int = 60, **kw):
    t = start
    while t < start + timedelta(minutes=minutes):
        _reading(db, device, t, **kw)
        t += timedelta(seconds=step_s)


class TestAnalytics:
    def test_summary_statistics_and_missing_intervals(self, client, db):
        d = db.get(Device, "myco-esp32-01")
        now = datetime.now(UTC)
        start = now - timedelta(hours=2)
        _fill(db, d, start, 50, temperature_c=22.0, relative_humidity_percent=90.0, heater_state=True)       # in range, heater on
        # 20-minute gap
        _fill(db, d, start + timedelta(minutes=70), 50, temperature_c=26.0, relative_humidity_percent=80.0)  # out of range
        s = client.get("/api/analytics/summary", params={"device_id": d.id, "from": start.isoformat(), "to": now.isoformat()}).json()
        assert s["n_readings"] == 100 and s["sources"] == ["hardware"]
        assert s["temperature_c"]["min"] == 22.0 and s["temperature_c"]["max"] == 26.0
        assert abs(s["temperature_c"]["mean"] - 24.0) < 0.01
        assert s["temperature_c"]["bins"]
        gaps = s["missing_intervals"]
        assert any(abs(g["seconds"] - 20 * 60) <= 60 for g in gaps), gaps
        assert 0.6 < s["data_completeness"] < 0.95
        tout = s["outside_range"]["temperature_c"]
        assert tout["above_seconds"] > 0 and tout["below_seconds"] == 0
        assert 0.3 < tout["outside_fraction"] < 0.7
        assert s["actuator_runtime"]["heater"]["on_seconds"] > 0
        assert 0.3 < s["actuator_runtime"]["heater"]["duty_cycle"] < 0.7
        assert s["targets"]["source"] == "default"

    def test_periodic_and_csv_exports(self, client, db):
        d = db.get(Device, "myco-esp32-01")
        now = datetime.now(UTC)
        _fill(db, d, now - timedelta(minutes=30), 30, temperature_c=23.0, fan_state=True)
        per = client.get("/api/analytics/periodic", params={"device_id": d.id, "period": "day", "range": "24h"}).json()
        assert per["items"] and per["items"][-1]["n_readings"] == 30
        assert per["items"][-1]["fan_on_minutes"] >= 28
        csv = client.get("/api/analytics/periodic.csv", params={"device_id": d.id, "period": "day", "range": "24h"})
        assert csv.status_code == 200 and csv.headers["content-type"].startswith("text/csv")
        lines = csv.text.strip().splitlines()
        assert lines[0].startswith("period") and len(lines) == 2
        raw = client.get("/api/telemetry/export.csv", params={"device_id": d.id, "range": "1h"})
        assert raw.status_code == 200
        rows = raw.text.strip().splitlines()
        assert rows[0].split(",")[:3] == ["measured_at", "device_id", "source"] or "measured_at" in rows[0]
        assert len(rows) == 31
        assert "hardware" in rows[1]

    def test_range_validation(self, client):
        r = client.get("/api/analytics/summary", params={"device_id": "myco-esp32-01", "from": "2026-02-01T00:00:00Z", "to": "2026-01-01T00:00:00Z"})
        assert r.status_code == 422
        assert client.get("/api/analytics/summary", params={"device_id": "ghost"}).status_code == 404
        assert client.get("/api/telemetry/series", params={"device_id": "myco-esp32-01", "max_points": 3}).status_code == 422

    def test_series_buckets_and_empty_range(self, client, db):
        d = db.get(Device, "myco-esp32-01")
        now = datetime.now(UTC)
        _fill(db, d, now - timedelta(minutes=120), 120, step_s=30, temperature_c=21.0)
        s = client.get("/api/telemetry/series", params={"device_id": d.id, "range": "6h", "max_points": 50}).json()
        assert s["n_readings"] == 240 and s["bucket_seconds"] >= 60
        assert len(s["points"]) <= 60
        assert all(p["temperature_c"] == 21.0 for p in s["points"] if p["temperature_c"] is not None)
        empty = client.get("/api/telemetry/series", params={"device_id": d.id, "from": "2020-01-01T00:00:00Z", "to": "2020-01-02T00:00:00Z"}).json()
        assert empty["n_readings"] == 0 and empty["points"] == []

    def test_stage_environment_is_descriptive_only(self, client, operator, db):
        profiles = client.get("/api/profiles").json()
        pid = next(p["id"] for p in profiles if "ostreatus" in p["species"])
        b = client.post("/api/batches", json={"name": "env", "species": "Pleurotus ostreatus", "profile_id": pid, "device_id": "myco-esp32-01",
                                              "inoculation_date": (datetime.now(UTC) - timedelta(days=3)).isoformat()}, headers=operator).json()
        d = db.get(Device, "myco-esp32-01")
        _fill(db, d, datetime.now(UTC) - timedelta(minutes=20), 20, temperature_c=23.0)
        env = client.get("/api/analytics/stage-environment", params={"batch_id": b["id"]}).json()
        assert env["stages"] and env["stages"][0]["stage_key"] == "inoculation"
        assert env["stages"][0]["n_readings"] == 20
        assert "causation" in env["note"].lower() or "causal" in env["note"].lower()
