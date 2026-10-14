"""Device-facing ingest transport: token auth, validation outcomes, persistence."""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone

from tests.conftest import create_hw_device, post_telemetry, telemetry_payload

UTC = timezone.utc


def test_token_is_required_and_checked(client, admin):
    device_id, token = create_hw_device(client, admin)
    payload = telemetry_payload(device_id)
    assert client.post("/api/ingest/telemetry", json=payload).status_code == 401
    assert client.post("/api/ingest/telemetry", json=payload, headers={"X-Device-Token": "wrong"}).status_code == 401
    r = client.post("/api/ingest/telemetry", json=payload, headers={"X-Device-Token": token})
    assert r.status_code == 202, r.text
    assert r.json()["accepted"] is True


def test_token_shown_once_and_stored_hashed(client, admin, db):
    from app.db.models import Device

    device_id, token = create_hw_device(client, admin, "esp32-hash")
    d = db.get(Device, device_id)
    assert d.token_hash and token not in d.token_hash
    # the device listing never returns the token
    listing = client.get("/api/devices").json()
    assert token not in str(listing)
    assert any(x["id"] == device_id and x["has_token"] for x in listing)
    # rotating invalidates the old token
    new_token = client.post(f"/api/devices/{device_id}/token", headers=admin).json()["token"]
    assert new_token != token
    assert post_telemetry(client, token, device_id).status_code == 401
    assert post_telemetry(client, new_token, device_id).status_code == 202


def test_device_id_spoofing_is_refused(client, admin):
    device_id, token = create_hw_device(client, admin, "esp32-a")
    r = client.post("/api/ingest/telemetry", json=telemetry_payload("myco-esp32-01"), headers={"X-Device-Token": token})
    assert r.status_code == 403


def test_accepted_reading_is_persisted_and_labelled_hardware(client, admin):
    device_id, token = create_hw_device(client, admin)
    ts = datetime.now(UTC) - timedelta(seconds=3)
    r = post_telemetry(client, token, device_id, ts=ts, temperature_c=23.4, relative_humidity_percent=97.0)
    assert r.status_code == 202
    latest = client.get("/api/telemetry/latest", params={"device_id": device_id}).json()
    reading = latest["reading"]
    assert reading["temperature_c"] == 23.4
    assert reading["source"] == "hardware"
    assert reading["quality"]["temperature_c"] == "ok"
    assert reading["quality"]["relative_humidity_percent"] == "suspect"  # above DHT11 rated range
    assert reading["measured_at"].startswith(ts.isoformat()[:19])
    assert latest["connection_status"] == "online"
    assert client.get(f"/api/devices/{device_id}").json()["stats"]["messages_accepted"] == 1
    # normalised per-sensor channel view: one row per sensor type with unit, quality, source and timestamp
    rows = client.get("/api/telemetry/readings", params={"device_id": device_id, "normalized": "true", "limit": 10}).json()["items"]
    by_sensor = {c["sensor_type"]: c for c in rows}
    assert by_sensor["temperature_c"]["unit"] == "°C" and by_sensor["temperature_c"]["value"] == 23.4
    assert by_sensor["relative_humidity_percent"]["quality"] == "suspect"
    assert by_sensor["temperature_c"]["source"] == "hardware"
    assert by_sensor["temperature_c"]["measured_at"].startswith(ts.isoformat()[:19])


def test_duplicate_message_id_is_rejected_and_history_is_append_only(client, admin, db):
    from sqlalchemy import func, select
    from app.db.models import SensorReading

    device_id, token = create_hw_device(client, admin)
    mid = uuid.uuid4().hex
    assert post_telemetry(client, token, device_id, message_id=mid, temperature_c=21.0).status_code == 202
    r = post_telemetry(client, token, device_id, message_id=mid, temperature_c=99.0)
    assert r.status_code == 422
    n = db.execute(select(func.count()).select_from(SensorReading).where(SensorReading.device_id == device_id)).scalar_one()
    assert n == 1
    stored = db.execute(select(SensorReading).where(SensorReading.device_id == device_id)).scalar_one()
    assert stored.temperature_c == 21.0  # the original is untouched


def test_stale_and_future_messages_are_rejected_and_logged(client, admin):
    device_id, token = create_hw_device(client, admin)
    old = datetime.now(UTC) - timedelta(minutes=30)
    assert post_telemetry(client, token, device_id, ts=old).status_code == 422
    future = datetime.now(UTC) + timedelta(minutes=10)
    assert post_telemetry(client, token, device_id, ts=future).status_code == 422
    diag = client.get(f"/api/devices/{device_id}/diagnostics").json()
    assert diag["readings_total"] == 0
    assert diag["rejections_24h"] == 2
    reasons = " ".join(e["message"] for e in diag["events"])
    assert "stale" in reasons and "future" in reasons


def test_malformed_payload_rejected(client, admin):
    device_id, token = create_hw_device(client, admin)
    r = client.post("/api/ingest/telemetry", json={"device_id": device_id, "temperature_c": "hot"}, headers={"X-Device-Token": token})
    assert r.status_code == 422


def test_implausible_value_stored_as_null_with_quality_flag(client, admin):
    device_id, token = create_hw_device(client, admin)
    assert post_telemetry(client, token, device_id, temperature_c=120.0).status_code == 202
    reading = client.get("/api/telemetry/latest", params={"device_id": device_id}).json()["reading"]
    assert reading["temperature_c"] is None
    assert reading["quality"]["temperature_c"] == "invalid"
    assert reading["quality"]["warnings"]


def test_disabled_device_cannot_publish(client, admin):
    device_id, token = create_hw_device(client, admin)
    assert client.patch(f"/api/devices/{device_id}", json={"is_enabled": False}, headers=admin).status_code == 200
    assert post_telemetry(client, token, device_id).status_code == 401


def test_simulated_source_is_decided_by_server_not_payload(client, admin, db):
    """A hardware device claiming source=simulation (or vice versa) cannot relabel its data."""
    device_id, token = create_hw_device(client, admin)
    assert post_telemetry(client, token, device_id, source="simulation").status_code == 202
    reading = client.get("/api/telemetry/latest", params={"device_id": device_id}).json()["reading"]
    assert reading["source"] == "hardware"


def test_device_status_message_marks_offline(client, admin):
    device_id, token = create_hw_device(client, admin)
    assert post_telemetry(client, token, device_id).status_code == 202
    r = client.post("/api/ingest/status", json={"status": "offline", "timestamp": datetime.now(UTC).isoformat()},
                    headers={"X-Device-Token": token})
    assert r.status_code == 202
    assert client.get(f"/api/devices/{device_id}").json()["connection_status"] == "offline"
    status = client.get("/api/system/status").json()
    assert status["mode"] == "disconnected"


def test_system_mode_reflects_live_hardware(client, admin):
    assert client.get("/api/system/status").json()["mode"] == "disconnected"  # no simulator, nothing online
    device_id, token = create_hw_device(client, admin)
    post_telemetry(client, token, device_id)
    status = client.get("/api/system/status").json()
    assert status["mode"] == "live"
    assert "LIVE" in status["label"].upper()
