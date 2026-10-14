#!/usr/bin/env python3
"""Minimal "virtual ESP32" speaking the HTTP transport – handy for verifying the
device path end-to-end without hardware (standard library only).

    python3 scripts/http_device.py --backend http://localhost:8000 \
        --device-id myco-esp32-01 --token mycodev_... [--interval 10] [--once]

It posts schema-v1 telemetry, polls queued commands, applies them to its
in-memory relay state (with the same local heater cutoff the real firmware
uses) and acknowledges them on /api/ingest/command-status. Readings are
clearly labelled source="hardware" because this stands in for a real device –
use the built-in simulator (DEMO MODE) if you want labelled simulated data.
"""
from __future__ import annotations

import argparse
import json
import math
import random
import sys
import time
import urllib.error
import urllib.request
import uuid
from datetime import datetime, timezone

HEATER_CUTOFF_C = 32.0


def request(method: str, url: str, token: str, body: dict | None = None) -> tuple[int, dict | list | None]:
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method, headers={"X-Device-Token": token, "Content-Type": "application/json", "Accept": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            text = resp.read().decode()
            return resp.status, (json.loads(text) if text else None)
    except urllib.error.HTTPError as exc:
        text = exc.read().decode(errors="replace")
        try:
            return exc.code, json.loads(text)
        except json.JSONDecodeError:
            return exc.code, {"detail": text}
    except urllib.error.URLError as exc:
        return 0, {"detail": f"backend unreachable: {exc.reason}"}


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--backend", default="http://localhost:8000")
    ap.add_argument("--device-id", required=True)
    ap.add_argument("--token", required=True, help="device token from Device Management")
    ap.add_argument("--interval", type=float, default=10.0)
    ap.add_argument("--temperature", type=float, default=22.0, help="starting temperature")
    ap.add_argument("--humidity", type=float, default=88.0)
    ap.add_argument("--once", action="store_true", help="send one telemetry message and exit")
    args = ap.parse_args()

    base = args.backend.rstrip("/")
    relays = {"fan": False, "heater": False, "humidifier": False}
    temp, rh, moisture = args.temperature, args.humidity, 1850.0
    t0 = time.time()
    print(f"virtual device {args.device_id} -> {base} (Ctrl+C to stop)")

    status, body = request("POST", f"{base}/api/ingest/status", args.token, {"schema_version": 1, "device_id": args.device_id, "status": "online",
                                                                           "timestamp": datetime.now(timezone.utc).isoformat(), "firmware_version": "http-device-script"})
    print(f"status -> {status} {body}")
    if status in (401, 403):
        return 2

    while True:
        # crude dynamics so charts move: heater warms, fan pulls towards 20 °C, humidifier adds RH
        temp += (0.08 if relays["heater"] else 0.0) - (0.04 if relays["fan"] else 0.0) + (20.0 - temp) * 0.01 + random.uniform(-0.05, 0.05)
        rh += (0.6 if relays["humidifier"] else -0.15) - (0.4 if relays["fan"] else 0.0) + random.uniform(-0.2, 0.2)
        rh = max(30.0, min(95.0, rh))
        moisture = max(600.0, moisture - 0.3 + random.uniform(-2, 2))
        if relays["heater"] and temp >= HEATER_CUTOFF_C:
            relays["heater"] = False
            print("local safety: heater cutoff")

        payload = {
            "schema_version": 1, "device_id": args.device_id, "message_id": uuid.uuid4().hex,
            "timestamp": datetime.now(timezone.utc).isoformat(), "uptime_ms": int((time.time() - t0) * 1000),
            "temperature_c": round(temp, 1), "relative_humidity_percent": round(rh, 1), "substrate_moisture_raw": int(moisture),
            "fan_state": relays["fan"], "heater_state": relays["heater"], "humidifier_state": relays["humidifier"],
            "sensor_errors": [], "firmware_version": "http-device-script", "source": "hardware",
        }
        status, body = request("POST", f"{base}/api/ingest/telemetry", args.token, payload)
        print(f"{datetime.now().strftime('%H:%M:%S')} telemetry {payload['temperature_c']}°C {payload['relative_humidity_percent']}% -> {status} {body if status != 202 else ''}")
        if status == 0:
            time.sleep(args.interval)
            continue

        status, body = request("GET", f"{base}/api/ingest/commands", args.token)
        for cmd in (body or {}).get("commands", []) if isinstance(body, dict) else []:
            actuator, state = cmd["actuator"], bool(cmd["state"])
            result, error = "applied", None
            if actuator == "heater" and state and temp >= HEATER_CUTOFF_C:
                result, error = "rejected", "local_thermal_cutoff"
            else:
                relays[actuator] = state
            ack = {"schema_version": 1, "device_id": args.device_id, "command_id": cmd["command_id"], "message_id": uuid.uuid4().hex,
                   "timestamp": datetime.now(timezone.utc).isoformat(), "actuator": actuator, "requested_state": state,
                   "result_state": relays[actuator], "status": result, "error": error}
            s, _ = request("POST", f"{base}/api/ingest/command-status", args.token, ack)
            print(f"  command {cmd['command_id'][:8]} {actuator}->{'ON' if state else 'OFF'} ({cmd.get('origin')}: {cmd.get('reason')}) => {result} [{s}]")
        if args.once:
            return 0
        time.sleep(max(1.0, args.interval + math.sin(time.time()) * 0))


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        print("\nstopped")
