"""Telemetry schema + plausibility validation (pure functions, no I/O)."""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone

import pytest

from app.schemas.telemetry import CommandV1, DeviceStatusV1, TelemetryV1
from app.services.settings_store import DEFAULTS
from app.services.validation import MessageRejected, is_stale, parse_telemetry, validate_telemetry

UTC = timezone.utc
RULES = DEFAULTS["validation"]


def _msg(**kw):
    base = {"device_id": "dev-01", "message_id": uuid.uuid4().hex, "timestamp": datetime.now(UTC).isoformat(),
            "temperature_c": 22.5, "relative_humidity_percent": 88.0, "substrate_moisture_raw": 1900,
            "fan_state": False, "heater_state": False, "humidifier_state": True}
    base.update(kw)
    return base


class TestSchema:
    def test_non_object_payload_is_malformed(self):
        with pytest.raises(MessageRejected) as exc:
            parse_telemetry("22.5,88")
        assert exc.value.code == "malformed"

    @pytest.mark.parametrize("bad", [
        {"device_id": "x"},                       # too short
        {"device_id": "has space"},               # pattern
        {"temperature_c": "warm"},                # type
        {"timestamp": "2026-01-01T10:00:00"},     # naive timestamp
        {"schema_version": 2},                    # unsupported schema
        {"fan_state": "yes please"},
    ])
    def test_schema_errors_are_rejected_with_details(self, bad):
        with pytest.raises(MessageRejected) as exc:
            parse_telemetry(_msg(**bad))
        assert exc.value.code == "schema"
        assert exc.value.details["errors"]

    def test_missing_device_id_rejected(self):
        payload = _msg()
        payload.pop("device_id")
        with pytest.raises(MessageRejected):
            parse_telemetry(payload)

    def test_message_id_is_generated_when_absent(self):
        payload = _msg()
        payload.pop("message_id")
        m = parse_telemetry(payload)
        assert len(m.message_id) >= 4

    def test_timestamp_normalised_to_utc(self):
        m = parse_telemetry(_msg(timestamp="2026-05-01T12:00:00+02:00"))
        assert m.timestamp == datetime(2026, 5, 1, 10, 0, tzinfo=UTC)

    def test_command_and_status_schemas_round_trip(self):
        cmd = CommandV1(device_id="dev-01", actuator="fan", state=True)
        dumped = cmd.model_dump(mode="json")
        assert dumped["schema_version"] == 1 and dumped["command_id"] and dumped["timestamp"]
        st = DeviceStatusV1(device_id="dev-01", status="offline")
        assert st.status == "offline"
        with pytest.raises(Exception):
            CommandV1(device_id="dev-01", actuator="laser", state=True)


class TestPlausibility:
    def test_clean_reading_is_ok(self):
        v = validate_telemetry(parse_telemetry(_msg()), RULES)
        assert v.values["temperature_c"] == 22.5
        assert v.quality["temperature_c"] == "ok"
        assert v.quality["relative_humidity_percent"] == "ok"
        assert v.quality["time"] == "ok"
        assert v.warnings == []
        assert v.has_valid_temperature

    def test_stale_message_rejected(self):
        old = datetime.now(UTC) - timedelta(seconds=RULES["max_message_age_seconds"] + 60)
        with pytest.raises(MessageRejected) as exc:
            validate_telemetry(parse_telemetry(_msg(timestamp=old.isoformat())), RULES)
        assert exc.value.code == "stale"
        assert exc.value.details["age_seconds"] > RULES["max_message_age_seconds"]

    def test_future_timestamp_rejected(self):
        future = datetime.now(UTC) + timedelta(seconds=RULES["max_future_skew_seconds"] + 30)
        with pytest.raises(MessageRejected) as exc:
            validate_telemetry(parse_telemetry(_msg(timestamp=future.isoformat())), RULES)
        assert exc.value.code == "future_timestamp"

    def test_small_clock_skew_tolerated(self):
        slightly_future = datetime.now(UTC) + timedelta(seconds=5)
        v = validate_telemetry(parse_telemetry(_msg(timestamp=slightly_future.isoformat())), RULES)
        assert v.quality["time"] == "ok"

    def test_unsynced_clock_uses_server_time_and_flags_it(self):
        now = datetime(2026, 3, 1, 8, 0, tzinfo=UTC)
        v = validate_telemetry(parse_telemetry(_msg(timestamp=None)), RULES, now=now)
        assert v.measured_at == now
        assert v.quality["time"] == "device_clock_unsynced"
        assert any("clock" in w for w in v.warnings)

    def test_unsynced_clock_can_be_rejected_by_rule(self):
        rules = {**RULES, "accept_unsynced_clock": False}
        with pytest.raises(MessageRejected) as exc:
            validate_telemetry(parse_telemetry(_msg(timestamp=None)), rules)
        assert exc.value.code == "timestamp"

    def test_implausible_value_is_dropped_not_stored(self):
        v = validate_telemetry(parse_telemetry(_msg(temperature_c=85.0)), RULES)
        assert v.values["temperature_c"] is None
        assert v.quality["temperature_c"] == "invalid"
        assert not v.has_valid_temperature
        # other fields unaffected
        assert v.values["relative_humidity_percent"] == 88.0

    def test_value_outside_dht11_rated_range_is_suspect_but_kept(self):
        v = validate_telemetry(parse_telemetry(_msg(relative_humidity_percent=97.0)), RULES)
        assert v.values["relative_humidity_percent"] == 97.0
        assert v.quality["relative_humidity_percent"] == "suspect"
        assert any("sensor rated range" in w for w in v.warnings)

    def test_reported_sensor_error_marks_fields(self):
        v = validate_telemetry(parse_telemetry(_msg(temperature_c=None, relative_humidity_percent=None, sensor_errors=["dht11"])), RULES)
        assert v.quality["temperature_c"] == "sensor_error"
        assert v.quality["relative_humidity_percent"] == "sensor_error"
        assert v.quality["substrate_moisture_raw"] == "ok"

    def test_missing_field_is_missing_not_error(self):
        v = validate_telemetry(parse_telemetry(_msg(substrate_moisture_raw=None)), RULES)
        assert v.quality["substrate_moisture_raw"] == "missing"

    def test_rate_of_change_rule_flags_jumps(self):
        now = datetime.now(UTC)
        previous = {"measured_at": now - timedelta(seconds=30), "temperature_c": 20.0,
                    "relative_humidity_percent": 85.0, "substrate_moisture_raw": 2000}
        v = validate_telemetry(parse_telemetry(_msg(temperature_c=29.0, timestamp=now.isoformat())), RULES, previous=previous, now=now)
        assert v.quality["temperature_c"] == "suspect"
        assert any("changed by" in w for w in v.warnings)
        # a slow drift over a long gap is fine
        previous["measured_at"] = now - timedelta(minutes=30)
        v2 = validate_telemetry(parse_telemetry(_msg(temperature_c=29.0, timestamp=now.isoformat())), RULES, previous=previous, now=now)
        assert v2.quality["temperature_c"] == "ok"

    def test_actuator_states_quality(self):
        v = validate_telemetry(parse_telemetry(_msg(fan_state=None)), RULES)
        assert v.quality["fan_state"] == "unknown"
        assert v.quality["heater_state"] == "ok"


def test_is_stale():
    now = datetime.now(UTC)
    assert is_stale(None, 120, now)
    assert is_stale(now - timedelta(seconds=121), 120, now)
    assert not is_stale(now - timedelta(seconds=60), 120, now)
