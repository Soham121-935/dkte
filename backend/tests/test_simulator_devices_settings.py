"""Hardware simulator (physics + scenarios + schema compatibility), device
management, system settings and secret-handling guarantees."""
from __future__ import annotations

import asyncio
import re
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

from app.iot.simulator import SCENARIOS, ChamberModel, SimulatorService, generate_history
from app.schemas.telemetry import CommandV1, TelemetryV1
from app.services.validation import parse_telemetry, validate_telemetry
from app.services.settings_store import DEFAULTS
from tests.conftest import create_hw_device

UTC = timezone.utc
REPO = Path(__file__).resolve().parents[2]


def _run(model: ChamberModel, seconds: int, now: datetime, **relays) -> ChamberModel:
    for k, v in relays.items():
        setattr(model.state, k, v)
    for i in range(seconds):
        model.step(1.0, now + timedelta(seconds=i))
    return model


class TestChamberPhysics:
    def test_heater_warms_and_fan_pulls_towards_ambient(self):
        now = datetime(2026, 6, 1, 12, 0, tzinfo=UTC)
        m = ChamberModel(seed=1)
        m.state.temperature_c = 20.0
        before = m.state.temperature_c
        _run(m, 600, now, heater=True, fan=False)
        assert m.state.temperature_c > before + 1.0  # ≈ +1.9 °C / 10 min
        hot = ChamberModel(seed=1)
        hot.state.temperature_c = 30.0
        amb = hot.ambient(now)[0]
        _run(hot, 1800, now, fan=True)
        assert hot.state.temperature_c < 30.0 and hot.state.temperature_c > amb - 0.5  # a fan cannot cool below ambient

    def test_humidifier_raises_rh_and_low_humidity_scenario_defeats_it(self):
        now = datetime(2026, 6, 1, 12, 0, tzinfo=UTC)
        m = ChamberModel(seed=2)
        m.state.relative_humidity_percent = 70.0
        _run(m, 300, now, humidifier=True)
        assert m.state.relative_humidity_percent > 75.0
        broken = ChamberModel(seed=2)
        broken.state.relative_humidity_percent = 70.0
        broken.state.scenarios["low_humidity"] = now + timedelta(hours=1)
        _run(broken, 300, now, humidifier=True)
        assert broken.state.relative_humidity_percent < 70.5
        assert broken.sample(now, "myco-sim-01")["humidifier_state"] is True  # device still reports ON

    def test_high_temperature_scenario_and_watering(self):
        now = datetime(2026, 6, 1, 12, 0, tzinfo=UTC)
        m = ChamberModel(seed=3)
        base = m.ambient(now)[0]
        m.state.scenarios["high_temperature"] = now + timedelta(hours=1)
        assert m.ambient(now)[0] > base + 5
        moist = m.state.substrate_moisture_raw
        m.state.scenarios["watering"] = now + timedelta(minutes=1)
        m.step(1.0, now)
        assert m.state.substrate_moisture_raw > moist + 400
        assert "watering" not in m.state.scenarios  # one-shot

    def test_sensor_fault_sample_is_schema_valid_and_marked(self):
        now = datetime.now(UTC)
        m = ChamberModel(seed=4)
        m.state.scenarios["sensor_fault"] = now + timedelta(minutes=3)
        payload = m.sample(now, "myco-sim-01")
        msg = parse_telemetry(payload)
        assert msg.temperature_c is None and msg.relative_humidity_percent is None
        assert msg.sensor_errors
        v = validate_telemetry(msg, DEFAULTS["validation"], now=now)
        assert v.quality["temperature_c"] == "sensor_error"

    def test_samples_match_the_firmware_schema(self):
        now = datetime.now(UTC)
        m = ChamberModel(seed=5)
        payload = m.sample(now, "myco-sim-01")
        msg = TelemetryV1.model_validate(payload)
        assert msg.schema_version == 1 and msg.device_id == "myco-sim-01" and msg.message_id
        assert msg.timestamp is not None and msg.source == "simulation"
        assert set(payload) >= {"temperature_c", "relative_humidity_percent", "substrate_moisture_raw", "fan_state", "heater_state", "humidifier_state"}

    def test_scenario_expiry(self):
        now = datetime.now(UTC)
        m = ChamberModel(seed=6)
        m.state.scenarios["high_temperature"] = now - timedelta(seconds=1)
        m.step(1.0, now)
        assert not m.active("high_temperature")

    def test_generate_history_is_deterministic_and_valid(self):
        start = datetime(2026, 5, 1, tzinfo=UTC)
        end = start + timedelta(hours=6)
        targets = {"temperature_min_c": 20, "temperature_max_c": 24, "humidity_min_percent": 85, "humidity_max_percent": 95,
                   "fae_cycle_minutes": 30, "fae_duration_minutes": 5, "moisture_min_raw": None}
        a, ev_a = generate_history(ChamberModel(seed=42), start, end, 60, lambda t: targets, "myco-sim-01")
        b, ev_b = generate_history(ChamberModel(seed=42), start, end, 60, lambda t: targets, "myco-sim-01")
        # 361 slots minus the injected 45-minute offline episode (readings are intentionally missing there)
        assert len(a) == 361 - 45 and len(ev_a) == 4
        assert a[0]["temperature_c"] == b[0]["temperature_c"] and a[-1]["relative_humidity_percent"] == b[-1]["relative_humidity_percent"]
        assert all(r["source"] == "simulation" for r in a)
        assert all(r["measured_at"] < r2["measured_at"] for r, r2 in zip(a, a[1:]))
        glitch = [r for r in a if r["quality"]["temperature_c"] == "sensor_error"]
        assert glitch and all(r["temperature_c"] is None for r in glitch)
        offline = next(e for e in ev_a if e["kind"] == "offline")
        assert not [r for r in a if offline["start"] <= r["measured_at"] < offline["end"]]
        assert {e["kind"] for e in ev_b} == {"heater_stuck", "humidifier_failure", "offline", "sensor_glitch"}


class TestSimulatorService:
    def test_trigger_validates_scenarios(self):
        svc = SimulatorService()
        with pytest.raises(ValueError):
            svc.trigger("meteor_strike")
        st = svc.trigger("device_offline", duration_minutes=5)
        assert "device_offline" in st["scenarios"]
        assert set(SCENARIOS) >= {"high_temperature", "low_humidity", "sensor_fault", "device_offline", "actuator_failure", "recover"}
        svc.trigger("recover")
        assert svc.status()["scenarios"] == {}

    def test_commands_are_applied_or_fail_under_actuator_failure(self):
        from app.db.models import Device

        svc = SimulatorService()
        svc._running = True
        dev = Device(id=svc.device_id, name="sim", kind="simulated", transport="simulator")
        now = datetime.now(UTC)
        cmd = CommandV1(device_id=svc.device_id, actuator="fan", state=True, timestamp=now)
        assert svc.send_command(dev, cmd) == "sent"
        statuses = svc._apply_pending_commands(now + timedelta(seconds=1))
        assert statuses[0]["status"] == "applied" and statuses[0]["result_state"] is True and svc.model.state.fan is True
        svc.trigger("actuator_failure", duration_minutes=5)
        svc.send_command(dev, CommandV1(device_id=svc.device_id, actuator="heater", state=True, timestamp=now))
        statuses = svc._apply_pending_commands(now + timedelta(seconds=2))
        assert statuses[0]["status"] == "failed" and svc.model.state.heater is False
        svc.trigger("device_offline", duration_minutes=5)
        from app.iot.transport import TransportError

        with pytest.raises(TransportError):
            svc.send_command(dev, cmd)
        svc._running = False

    def test_api_reports_simulator_disabled_in_this_environment(self, client, admin):
        st = client.get("/api/simulator/status").json()
        assert st["enabled"] is False and st["available"] is False
        assert client.post("/api/simulator/scenario", json={"scenario": "high_temperature"}, headers=admin).status_code in (409, 422)
        assert client.post("/api/simulator/scenario", json={"scenario": "high_temperature"}).status_code == 401


class TestDevicesApi:
    def test_create_validate_update_and_diagnostics(self, client, admin, operator):
        assert client.post("/api/devices", json={"id": "bad id!", "name": "x"}, headers=admin).status_code == 422
        assert client.post("/api/devices", json={"id": "esp32-two", "name": "x", "transport": "zigbee"}, headers=admin).status_code == 422
        device_id, token = create_hw_device(client, admin, "esp32-two")
        assert client.post("/api/devices", json={"id": "esp32-two", "name": "dup"}, headers=admin).status_code == 409
        assert client.patch(f"/api/devices/{device_id}", json={"name": "Renamed"}, headers=operator).status_code == 403
        r = client.patch(f"/api/devices/{device_id}", json={"name": "Renamed", "hardware_notes": "DHT11 on GPIO4"}, headers=admin)
        assert r.status_code == 200 and r.json()["name"] == "Renamed"
        diag = client.get(f"/api/devices/{device_id}/diagnostics").json()
        assert diag["readings_total"] == 0 and diag["last_reading"] is None and diag["telemetry_age_seconds"] is None
        assert client.post("/api/devices/myco-sim-01/token", headers=admin).status_code == 422  # simulated devices have no token
        assert client.delete(f"/api/devices/{device_id}/token", headers=admin).status_code == 200
        assert client.get(f"/api/devices/{device_id}").json()["has_token"] is False

    def test_system_status_and_events(self, client, admin):
        st = client.get("/api/system/status").json()
        assert st["mqtt"]["enabled"] is False and st["simulator"]["enabled"] is False
        assert st["mode"] == "disconnected"
        assert any(t["name"] == "http" for t in st["transports"])
        assert client.get("/api/system/health").json()["status"] == "ok"
        create_hw_device(client, admin, "esp32-ev")
        events = client.get("/api/system/events", params={"category": "auth"}).json()
        assert any("token rotated" in e["message"] for e in events)


class TestSettings:
    def test_settings_roundtrip_and_validation(self, client, admin):
        s = client.get("/api/settings").json()
        assert set(s["sections"]) >= {"validation", "alerts", "control_defaults"}
        assert s["defaults"]["alerts"]["cooldown_seconds"] == DEFAULTS["alerts"]["cooldown_seconds"]
        assert "jwt" not in str(s).lower() or "secret" not in str(s).lower()
        r = client.patch("/api/settings/alerts", json={"value": {"cooldown_seconds": 120}}, headers=admin)
        assert r.status_code == 200 and r.json()["cooldown_seconds"] == 120
        assert client.get("/api/settings").json()["sections"]["alerts"]["cooldown_seconds"] == 120
        assert client.patch("/api/settings/alerts", json={"value": {"cooldown_seconds": -5}}, headers=admin).status_code == 422
        assert client.patch("/api/settings/alerts", json={"value": {"cooldown_seconds": "soon"}}, headers=admin).status_code == 422
        assert client.patch("/api/settings/alerts", json={"value": {"unknown_key": 1}}, headers=admin).status_code == 422
        assert client.patch("/api/settings/nope", json={"value": {}}, headers=admin).status_code == 404
        r = client.patch("/api/settings/control_defaults", json={"value": {"default_targets": {"temperature_min_c": 30, "temperature_max_c": 20}}}, headers=admin)
        assert r.status_code == 422

    def test_runtime_section_exposes_no_secrets(self, client):
        runtime = client.get("/api/settings").json()["runtime"]
        blob = str(runtime).lower()
        for forbidden in ("jwt_secret", "ai_api_key", "mqtt_password", "smtp_password", "nvapi-"):
            assert forbidden not in blob


class TestSecretHygiene:
    FRONTEND_SRC = REPO / "frontend" / "src"

    def test_no_provider_keys_or_vite_ai_vars_in_frontend(self):
        offenders = []
        for path in self.FRONTEND_SRC.rglob("*"):
            if path.suffix not in {".ts", ".tsx", ".css", ".html"}:
                continue
            text = path.read_text(encoding="utf-8", errors="ignore")
            if re.search(r"nvapi-[A-Za-z0-9_-]{8,}", text) or re.search(r"sk-[A-Za-z0-9]{20,}", text):
                offenders.append(str(path))
            if re.search(r"VITE_[A-Z_]*(KEY|SECRET|TOKEN)", text):
                offenders.append(str(path))
            if "integrate.api.nvidia.com" in text or "api.openai.com" in text:
                offenders.append(str(path))
        assert offenders == []

    def test_env_example_has_placeholders_only_and_env_is_ignored(self):
        example = (REPO / "backend" / ".env.example").read_text()
        assert "AI_API_KEY=" in example
        assert not re.search(r"AI_API_KEY=\s*nvapi-[A-Za-z0-9_-]{8,}", example)
        gitignore = (REPO / ".gitignore").read_text()
        assert re.search(r"^\s*backend/\.env\s*$", gitignore, re.M) or re.search(r"^\s*\.env\s*$", gitignore, re.M)

    def test_logging_redaction(self):
        from app.core.logging_config import redact

        assert "nvapi-" not in redact("Authorization: Bearer nvapi-abcdefghijklmnop1234")
        assert redact("key nvapi-abcdefghijklmnop1234 leaked") == "key [REDACTED] leaked"
        assert redact("api_key=secretvalue123") == "api_key=[REDACTED]"
        assert redact("X-Device-Token: mycodev_abcdefghijklmnop") == "X-Device-Token: [REDACTED]"
        assert redact("temperature 22.5, token rotated for device esp32-01") == "temperature 22.5, token rotated for device esp32-01"

    def test_openapi_has_no_secret_fields(self, client):
        spec = client.get("/api/openapi.json").text.lower()
        assert "api_key" not in spec and "jwt_secret" not in spec
