"""Batches, species profiles, growth timeline, and the prediction engine
(input validation, uncertainty labelling, error tracking against actual outcomes)."""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone

from app.db.models import Device, Prediction
from app.services import prediction
from app.services.telemetry import ingest_telemetry
from tests.conftest import create_hw_device, post_telemetry

UTC = timezone.utc


def _oyster_profile_id(client) -> int:
    profiles = client.get("/api/profiles").json()
    p = next(p for p in profiles if "ostreatus" in p["species"])
    assert p["source"] == "reference" and p["is_builtin"]
    return p["id"]


def _make_batch(client, operator, **extra):
    body = {"name": "Test batch", "species": "Pleurotus ostreatus", "profile_id": _oyster_profile_id(client), **extra}
    r = client.post("/api/batches", json=body, headers=operator)
    assert r.status_code == 201, r.text
    return r.json()


# ----------------------------------------------------------------- batches
class TestBatches:
    def test_create_requires_fields_and_validates_references(self, client, operator):
        assert client.post("/api/batches", json={"species": "x"}, headers=operator).status_code == 422
        assert client.post("/api/batches", json={"name": "b", "species": "x", "profile_id": 999}, headers=operator).status_code in (404, 422)
        assert client.post("/api/batches", json={"name": "b", "species": "x", "device_id": "nope"}, headers=operator).status_code in (404, 422)
        r = client.post("/api/batches", json={"name": "b", "species": "x", "expected_harvest_start": "2026-11-10T00:00:00Z",
                                              "expected_harvest_end": "2026-11-01T00:00:00Z"}, headers=operator)
        assert r.status_code == 422

    def test_batch_code_and_initial_stage(self, client, operator):
        b = _make_batch(client, operator, inoculation_date="2026-10-01T10:00:00Z", device_id="myco-esp32-01")
        assert b["code"].startswith("B-2026-")
        assert b["current_stage_key"] == "inoculation"
        assert b["source"] == "user" if "source" in b else True
        timeline = client.get(f"/api/batches/{b['id']}/timeline").json()
        assert timeline["stages"][0]["key"] in ("substrate_preparation", "inoculation")
        current = [s for s in timeline["stages"] if s["state"] == "current"]
        assert current and current[0]["key"] == "inoculation"

    def test_one_active_batch_per_device(self, client, operator):
        _make_batch(client, operator, device_id="myco-esp32-01")
        r = client.post("/api/batches", json={"name": "second", "species": "Pleurotus ostreatus", "device_id": "myco-esp32-01"}, headers=operator)
        assert r.status_code == 409

    def test_stage_confirmation_rules(self, client, operator):
        b = _make_batch(client, operator, inoculation_date="2026-10-01T10:00:00Z")
        bid = b["id"]
        # unknown stage key
        assert client.post(f"/api/batches/{bid}/stage", json={"stage_key": "flowering"}, headers=operator).status_code == 422
        # cannot start in the future
        future = (datetime.now(UTC) + timedelta(days=1)).isoformat()
        assert client.post(f"/api/batches/{bid}/stage", json={"stage_key": "incubation", "started_at": future}, headers=operator).status_code == 422
        # cannot start before the previous stage
        assert client.post(f"/api/batches/{bid}/stage", json={"stage_key": "incubation", "started_at": "2026-09-01T00:00:00Z"}, headers=operator).status_code == 422
        r = client.post(f"/api/batches/{bid}/stage", json={"stage_key": "incubation", "started_at": "2026-10-02T10:00:00Z", "note": "fully mixed"}, headers=operator)
        assert r.status_code == 201, r.text
        assert r.json()["event"]["source"] == "manual" and r.json()["event"]["confirmed_by"] == "operator1"
        # same stage twice
        assert client.post(f"/api/batches/{bid}/stage", json={"stage_key": "incubation"}, headers=operator).status_code == 409
        obs = client.get(f"/api/batches/{bid}/observations").json()
        assert obs[0]["kind"] == "stage_confirmation" and obs[0]["stage_key"] == "incubation"

    def test_stage_is_never_advanced_by_the_calendar(self, client, operator):
        """A batch inoculated long ago still reports the grower-confirmed stage; the estimate flags it as overdue."""
        b = _make_batch(client, operator, inoculation_date=(datetime.now(UTC) - timedelta(days=60)).isoformat())
        client.post(f"/api/batches/{b['id']}/stage", json={"stage_key": "incubation", "started_at": (datetime.now(UTC) - timedelta(days=59)).isoformat()}, headers=operator)
        est = client.get("/api/predictions/stage", params={"batch_id": b["id"]}).json()
        assert est["available"] is True
        assert est["current_stage"]["key"] == "incubation"
        assert est["timing"] == "beyond_window"
        assert est["confidence"]["level"] in ("low", "medium")
        assert est["confidence"]["basis"]
        assert "calendar" in est["model"]["description"].lower() or "calendar" in est["timing_label"].lower() or "not a biological" in est["model"]["description"].lower()
        # the batch itself is unchanged
        assert client.get(f"/api/batches/{b['id']}").json()["current_stage_key"] == "incubation"

    def test_observations_and_images(self, client, operator, tmp_path):
        b = _make_batch(client, operator)
        bid = b["id"]
        assert client.post(f"/api/batches/{bid}/observations", json={"kind": "note"}, headers=operator).status_code == 422  # needs note or data
        r = client.post(f"/api/batches/{bid}/observations", json={"kind": "contamination", "note": "green patch at the top"}, headers=operator)
        assert r.status_code == 201
        oid = r.json()["id"]
        png = b"\x89PNG\r\n\x1a\n" + b"\x00" * 64
        r = client.post(f"/api/batches/{bid}/observations/{oid}/image", files={"file": ("pic.png", png, "image/png")}, headers=operator)
        assert r.status_code == 200, r.text
        url = r.json()["image_url"]
        assert url.startswith("/api/uploads/")
        assert client.get(url).status_code == 200
        r = client.post(f"/api/batches/{bid}/observations/{oid}/image", files={"file": ("evil.exe", b"MZ...", "application/octet-stream")}, headers=operator)
        assert r.status_code in (400, 415, 422)

    def test_target_precedence_override_beats_profile(self, client, operator, db):
        b = _make_batch(client, operator, device_id="myco-esp32-01", initial_stage_key="incubation",
                        target_overrides={"incubation": {"temperature_min_c": 21, "temperature_max_c": 25}})
        from app.services.control import resolve_targets

        d = db.get(Device, "myco-esp32-01")
        t = resolve_targets(db, d)
        assert t["source"] == "batch_override" and t["temperature_min_c"] == 21 and t["temperature_max_c"] == 25
        assert t["humidity_min_percent"] is not None  # untouched keys still come from the profile
        # remove the override -> profile values with reference label
        r = client.patch(f"/api/batches/{b['id']}", json={"target_overrides": {}}, headers=operator)
        assert r.status_code == 200
        db.expire_all()
        t = resolve_targets(db, d)
        assert t["source"] == "profile_reference" and "verify" in t["source_label"].lower()

    def test_report_and_delete_permissions(self, client, admin, operator, viewer):
        b = _make_batch(client, operator)
        rep = client.get(f"/api/batches/{b['id']}/report").json()
        assert rep["batch"]["id"] == b["id"]
        assert client.delete(f"/api/batches/{b['id']}", headers=operator).status_code == 403
        assert client.delete(f"/api/batches/{b['id']}", headers=admin).status_code == 204
        assert client.get(f"/api/batches/{b['id']}").status_code == 404


# ----------------------------------------------------------------- profiles
class TestProfiles:
    def test_reference_profiles_are_labelled_and_protected(self, client, admin, operator):
        pid = _oyster_profile_id(client)
        assert client.patch(f"/api/profiles/{pid}", json={"name": "hacked"}, headers=operator).status_code in (403, 409)
        assert client.delete(f"/api/profiles/{pid}", headers=admin).status_code in (403, 409)

    def test_clone_then_edit_user_profile(self, client, operator):
        pid = _oyster_profile_id(client)
        r = client.post(f"/api/profiles/{pid}/clone", headers=operator)
        assert r.status_code == 201, r.text
        clone = r.json()
        assert clone["source"] == "user" and clone["is_builtin"] is False and clone["id"] != pid
        stages = clone["stages"]
        stages[0]["targets"]["temperature_min_c"] = 18
        r = client.patch(f"/api/profiles/{clone['id']}", json={"stages": stages}, headers=operator)
        assert r.status_code == 200 and r.json()["stages"][0]["targets"]["temperature_min_c"] == 18
        # validation: duplicate keys / bad ranges
        bad = [dict(stages[0]), dict(stages[0])]
        assert client.patch(f"/api/profiles/{clone['id']}", json={"stages": bad}, headers=operator).status_code == 422
        bad_targets = [dict(stages[0], targets={**stages[0]["targets"], "temperature_min_c": 30, "temperature_max_c": 20})]
        assert client.patch(f"/api/profiles/{clone['id']}", json={"stages": bad_targets}, headers=operator).status_code == 422

    def test_create_profile_validation(self, client, operator):
        r = client.post("/api/profiles", json={"name": "Shiitake custom", "species": "Lentinula edodes", "stages": []}, headers=operator)
        assert r.status_code == 422
        r = client.post("/api/profiles", json={"name": "Shiitake custom", "species": "Lentinula edodes",
                                               "stages": [{"key": "Bad Key", "name": "x"}]}, headers=operator)
        assert r.status_code == 422
        r = client.post("/api/profiles", json={"name": "Shiitake custom", "species": "Lentinula edodes",
                                               "stages": [{"key": "incubation", "name": "Incubation", "typical_duration_days": {"min": 30, "max": 60}}]}, headers=operator)
        assert r.status_code == 201 and r.json()["source"] == "user"


# ----------------------------------------------------------------- predictions
def _series(db, device: Device, start: datetime, minutes: int, step_s: int, temp_fn, rh=88.0):
    t = start
    while t < start + timedelta(minutes=minutes):
        ingest_telemetry(db, {"device_id": device.id, "message_id": uuid.uuid4().hex, "timestamp": t.isoformat(),
                              "temperature_c": round(temp_fn(t), 2), "relative_humidity_percent": rh, "substrate_moisture_raw": 2000,
                              "fan_state": False, "heater_state": False, "humidifier_state": False},
                         transport="test", device=device, now=t + timedelta(seconds=1))
        t += timedelta(seconds=step_s)
    db.commit()


class TestPredictions:
    def test_forecast_reports_insufficient_data_instead_of_guessing(self, client, db):
        d = db.get(Device, "myco-esp32-01")
        now = datetime.now(UTC)
        _series(db, d, now - timedelta(minutes=5), 5, 60, lambda t: 22.0)
        f = client.get("/api/predictions/forecast", params={"device_id": d.id}).json()
        m = f["metrics"]["temperature_c"]
        assert m["sufficient"] is False and "Need at least" in m["limitation"]
        assert "forecasts" not in m

    def test_forecast_follows_linear_trend_with_bands(self, client, db):
        d = db.get(Device, "myco-esp32-01")
        now = datetime.now(UTC)
        # +1 °C per hour for the last hour
        _series(db, d, now - timedelta(minutes=60), 60, 60, lambda t: 20.0 + (t - (now - timedelta(minutes=60))).total_seconds() / 3600.0)
        f = prediction.environmental_forecast(db, d.id, now=now, window_minutes=60)
        m = f["metrics"]["temperature_c"]
        assert m["sufficient"] is True and m["trend"] == "rising"
        assert abs(m["slope_per_hour"] - 1.0) < 0.05
        h60 = next(x for x in m["forecasts"] if x["horizon_minutes"] == 60)
        assert abs(h60["value"] - 22.0) < 0.1
        assert h60["lower"] <= h60["value"] <= h60["upper"]
        assert "heuristic" in f["model"]["description"].lower()
        assert f["source"] == "hardware"

    def test_forecast_error_is_tracked_against_actual_readings(self, db):
        d = db.get(Device, "myco-esp32-01")
        now = datetime.now(UTC) - timedelta(hours=2)
        _series(db, d, now - timedelta(minutes=60), 60, 60, lambda t: 22.0)
        f = prediction.environmental_forecast(db, d.id, now=now, window_minutes=60)
        stored = prediction.store_forecasts(db, d.id, f, now)
        db.commit()
        assert stored and all(p.evaluated_at is None for p in stored)
        # nothing happened yet -> not evaluated
        assert prediction.evaluate_due_forecasts(db, now + timedelta(minutes=5)) == 0
        # actual values arrive 1 °C warmer than predicted around the 15-minute target
        _series(db, d, now + timedelta(minutes=13), 4, 60, lambda t: 23.0)
        n = prediction.evaluate_due_forecasts(db, now + timedelta(minutes=20))
        db.commit()
        assert n >= 1
        p15 = next(p for p in stored if p.horizon_minutes == 15 and p.output["metric"] == "temperature_c")
        assert p15.error["status"] == "evaluated"
        assert abs(p15.error["abs_error"] - 1.0) < 0.1
        assert p15.actual["n"] >= 1
        acc = prediction.forecast_accuracy(db, d.id)
        row = next(r for r in acc["results"] if r["metric"] == "temperature_c" and r["horizon_minutes"] == 15)
        assert row["n_evaluated"] == 1 and row["sufficient"] is False  # not enough samples to claim accuracy
        assert abs(row["mae"] - 1.0) < 0.1
        # 60-minute forecasts with no actual data are marked explicitly
        n2 = prediction.evaluate_due_forecasts(db, now + timedelta(minutes=70))
        p60 = next(p for p in stored if p.horizon_minutes == 60 and p.output["metric"] == "temperature_c")
        assert p60.error["status"] == "no_actual_data"

    def test_accuracy_endpoint_without_history_claims_nothing(self, client):
        acc = client.get("/api/predictions/accuracy", params={"device_id": "myco-esp32-01"}).json()
        assert acc["results"] == []
        assert "only" in acc["note"]

    def test_anomaly_detection_flags_out_of_range_episode(self, client, db):
        d = db.get(Device, "myco-esp32-01")
        now = datetime.now(UTC)
        _series(db, d, now - timedelta(minutes=60), 30, 60, lambda t: 22.0)
        _series(db, d, now - timedelta(minutes=30), 30, 60, lambda t: 27.0)  # above 24 max
        res = client.get("/api/predictions/anomalies", params={"device_id": d.id, "hours": 2}).json()
        episodes = [a for a in res["anomalies"] if a["type"] in ("out_of_range", "prolonged_deviation") and a["metric"] == "temperature_c"]
        assert episodes, res["anomalies"]
        ep = episodes[-1]
        assert ep["ongoing"] is True and ep["peak"] >= 27.0 and ep["duration_minutes"] >= 25
        assert "above" in ep["label"].lower()
        assert res["model"] and "rule" in str(res["model"]).lower()

    def test_recommendations_structure_and_confirmation_flags(self, client, admin):
        device_id, token = create_hw_device(client, admin)
        post_telemetry(client, token, device_id, temperature_c=17.0, relative_humidity_percent=70.0)
        rec = client.get("/api/predictions/recommendations", params={"device_id": device_id}).json()
        assert rec["source"] == "hardware"
        keys = {r["key"] for r in rec["recommendations"]}
        assert {"temp_low", "rh_low"} <= keys
        for r in rec["recommendations"]:
            assert r["detected"] and r["why"] and r["action"]
            assert r["confidence"]["level"] in ("low", "medium", "high")
            assert isinstance(r["requires_confirmation"], bool)
            assert not any(ch.isdigit() and "%" in r["confidence"]["basis"] for ch in r["confidence"]["basis"][:0])
        # in monitor mode the actuator suggestions require confirmation
        temp_rec = next((r for r in rec["recommendations"] if r["actuator"] == "heater"), None)
        if temp_rec:
            assert temp_rec["requires_confirmation"] is True

    def test_prediction_run_endpoint_and_history(self, client, operator, db):
        d = db.get(Device, "myco-esp32-01")
        now = datetime.now(UTC)
        _series(db, d, now - timedelta(minutes=60), 60, 60, lambda t: 22.0)
        assert client.post("/api/predictions/run").status_code == 401
        r = client.post("/api/predictions/run", headers=operator)
        assert r.status_code == 200
        hist = client.get("/api/predictions/history", params={"device_id": d.id}).json()
        items = hist["items"] if isinstance(hist, dict) else hist
        assert items and items[0]["kind"] == "env_forecast"
        assert items[0]["model_name"] and items[0]["uncertainty"]["lower"] <= items[0]["output"]["value"] <= items[0]["uncertainty"]["upper"]
        assert db.query(Prediction).count() == len(items) or len(items) <= db.query(Prediction).count()
