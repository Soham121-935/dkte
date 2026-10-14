#!/usr/bin/env python3
"""Export the versioned IoT message schemas (pydantic -> JSON Schema) into /schemas.

Run from the repository root with the backend virtualenv:

    backend/.venv/bin/python scripts/export_schemas.py

The backend test-suite (`tests/test_schemas_docs.py`) fails when the files in
/schemas are out of date, so firmware authors can trust them.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

from app.schemas.telemetry import CommandStatusV1, CommandV1, DeviceStatusV1, TelemetryV1  # noqa: E402

TOPIC = "myco/{device_id}"
EXPORTS = {
    "telemetry.v1.schema.json": (TelemetryV1, f"{TOPIC}/telemetry", "device -> backend", "Periodic sensor sample. Also accepted on POST /api/ingest/telemetry."),
    "status.v1.schema.json": (DeviceStatusV1, f"{TOPIC}/status", "device -> backend", "Retained presence message; publish 'offline' as the MQTT last-will."),
    "command.v1.schema.json": (CommandV1, f"{TOPIC}/commands", "backend -> device", "Actuator command issued by the deterministic control service (never by the LLM)."),
    "command-status.v1.schema.json": (CommandStatusV1, f"{TOPIC}/command-status", "device -> backend", "Acknowledgement for a command: applied, rejected or failed."),
}


def build(model, topic: str, direction: str, description: str) -> dict:
    schema = model.model_json_schema()
    schema["$schema"] = "https://json-schema.org/draft/2020-12/schema"
    schema["$id"] = f"https://myco-ai.local/schemas/{model.__name__.lower()}.json"
    schema["title"] = model.__name__
    schema["description"] = f"{description} MQTT topic: {topic} ({direction}). schema_version = 1."
    schema["x-mqtt-topic"] = topic
    schema["x-direction"] = direction
    return schema


def render() -> dict[str, str]:
    return {name: json.dumps(build(model, *rest), indent=2, sort_keys=True) + "\n" for name, (model, *rest) in EXPORTS.items()}


def main(check: bool = False) -> int:
    out_dir = ROOT / "schemas"
    out_dir.mkdir(exist_ok=True)
    stale = []
    for name, text in render().items():
        path = out_dir / name
        if check:
            if not path.exists() or path.read_text() != text:
                stale.append(name)
        else:
            path.write_text(text)
            print(f"wrote {path.relative_to(ROOT)}")
    if check and stale:
        print("schemas out of date: " + ", ".join(stale))
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(check="--check" in sys.argv))
