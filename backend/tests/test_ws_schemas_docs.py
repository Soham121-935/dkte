"""Live WebSocket feed (auth + event delivery), exported JSON schemas staying in
sync with the pydantic models, and public-read toggling."""
from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path

import pytest
from starlette.websockets import WebSocketDisconnect

from app.config import get_settings, reset_settings_cache
from tests.conftest import create_hw_device, post_telemetry

REPO = Path(__file__).resolve().parents[2]


@pytest.fixture()
def private_read(monkeypatch):
    monkeypatch.setenv("PUBLIC_READ", "false")
    reset_settings_cache()
    assert get_settings().public_read is False
    yield
    monkeypatch.setenv("PUBLIC_READ", "true")
    reset_settings_cache()


class TestWebSocket:
    def test_public_feed_sends_hello_and_telemetry_events(self, client, admin):
        device_id, token = create_hw_device(client, admin)
        with client.websocket_connect("/ws/live") as ws:
            hello = ws.receive_json()
            assert hello["type"] == "hello" and "recent" in hello["payload"]
            r = post_telemetry(client, token, device_id, temperature_c=23.3)
            assert r.status_code == 202
            seen = []
            for _ in range(8):
                msg = ws.receive_json()
                seen.append(msg["type"])
                if msg["type"] == "telemetry":
                    assert msg["payload"]["reading"]["temperature_c"] == 23.3
                    assert msg["payload"]["reading"]["source"] == "hardware"
                    assert msg["payload"]["device"]["id"] == device_id
                    break
            assert "telemetry" in seen, seen

    def test_private_feed_requires_token(self, client, admin, private_read):
        with pytest.raises(WebSocketDisconnect) as exc:
            with client.websocket_connect("/ws/live") as ws:
                ws.receive_json()
        assert exc.value.code == 4401
        with pytest.raises(WebSocketDisconnect):
            with client.websocket_connect("/ws/live?token=not-a-jwt") as ws:
                ws.receive_json()
        token = admin["Authorization"].split(" ", 1)[1]
        with client.websocket_connect(f"/ws/live?token={token}") as ws:
            assert ws.receive_json()["type"] == "hello"

    def test_private_read_locks_rest_endpoints(self, client, admin, private_read):
        assert client.get("/api/devices").status_code == 401
        assert client.get("/api/system/status").status_code == 401
        assert client.get("/api/system/health").status_code == 200  # liveness stays public
        assert client.get("/api/devices", headers=admin).status_code == 200


class TestSchemasAndDocs:
    def test_exported_json_schemas_match_models(self):
        spec = importlib.util.spec_from_file_location("export_schemas", REPO / "scripts" / "export_schemas.py")
        mod = importlib.util.module_from_spec(spec)
        sys.modules["export_schemas"] = mod
        spec.loader.exec_module(mod)
        rendered = mod.render()
        assert set(rendered) == {"telemetry.v1.schema.json", "status.v1.schema.json", "command.v1.schema.json", "command-status.v1.schema.json"}
        for name, text in rendered.items():
            path = REPO / "schemas" / name
            assert path.exists(), f"{name} missing – run scripts/export_schemas.py"
            assert path.read_text() == text, f"{name} is stale – run scripts/export_schemas.py"
            schema = json.loads(text)
            assert schema["x-mqtt-topic"].startswith("myco/{device_id}/")
            assert "schema_version" in schema["properties"] and "device_id" in schema["properties"]

    def test_schema_examples_in_readme_validate(self):
        from app.schemas.telemetry import CommandStatusV1, CommandV1, DeviceStatusV1, TelemetryV1

        text = (REPO / "schemas" / "README.md").read_text()
        blocks = [b.split("```", 1)[0] for b in text.split("```json")[1:]]
        assert len(blocks) == 4
        telemetry = json.loads(blocks[0].replace('"mycodev_...   (MQTT only; HTTP uses the X-Device-Token header)"', '"mycodev_x"'))
        telemetry.pop("device_token")
        assert TelemetryV1.model_validate(telemetry).temperature_c == 24.5
        assert DeviceStatusV1.model_validate(json.loads(blocks[1])).status == "online"
        assert CommandV1.model_validate(json.loads(blocks[2])).actuator == "heater"
        assert CommandStatusV1.model_validate(json.loads(blocks[3].replace('"…"', '"abcd1234"'))).status == "applied"

    def test_firmware_uses_same_topics_and_safety_limits(self):
        sketch = (REPO / "firmware" / "esp32" / "myco_esp32" / "myco_esp32.ino").read_text()
        for topic in ("/telemetry", "/status", "/commands", "/command-status"):
            assert f'"{topic}"' in sketch
        assert "HEATER_CUTOFF_C = 32.0f" in sketch  # matches control default heater_absolute_max_temp_c
        assert "schema_version" in sketch and "device_token" in sketch
        assert (REPO / "firmware" / "esp32" / "myco_esp32" / "config.example.h").exists()
        assert not (REPO / "firmware" / "esp32" / "myco_esp32" / "config.h").exists()

    def test_openapi_lists_every_documented_route(self, client):
        spec = client.get("/api/openapi.json").json()
        documented = (REPO / "docs" / "api.md").read_text()
        missing = []
        import re

        for path, ops in spec["paths"].items():
            for method in ops:
                # documented as `GET /api/x` or with a query template `GET /api/x?device_id=`
                if not re.search(rf"`{method.upper()} {re.escape(path)}(\?[^`]*)?`", documented):
                    missing.append(f"{method.upper()} {path}")
        assert missing == [], f"routes missing from docs/api.md: {missing}"
