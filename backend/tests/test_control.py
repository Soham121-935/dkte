"""Deterministic control service: hysteresis, interlocks, switching limits,
command lifecycle (requested -> sent -> confirmed / timeout) and authorization."""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone

import pytest

from app.db.models import ActuatorCommand, Device
from app.services import control
from app.services.telemetry import ingest_telemetry, record_command_status
from tests.conftest import create_hw_device, post_telemetry

UTC = timezone.utc


# ----------------------------------------------------------------- service fixtures
@pytest.fixture()
def hw(db):
    """An enabled, online HTTP-transport hardware device in AUTO mode with default targets (20–24 °C / 85–95 %)."""
    d = Device(id="esp32-ctl", name="ctl", kind="hardware", transport="http", control_mode="auto", connection_status="online")
    db.add(d)
    db.commit()
    return d


def feed(db, device: Device, now: datetime, **values):
    payload = {"device_id": device.id, "message_id": uuid.uuid4().hex, "timestamp": now.isoformat(),
               "temperature_c": 22.0, "relative_humidity_percent": 90.0, "substrate_moisture_raw": 2000,
               "fan_state": False, "heater_state": False, "humidifier_state": False}
    payload.update(values)
    reading = ingest_telemetry(db, payload, transport="test", device=device, now=now)
    db.commit()
    return reading


def confirm(db, device: Device, cmd: ActuatorCommand, now: datetime, *, result_state: bool | None = None, status="applied"):
    record_command_status(db, {"device_id": device.id, "command_id": cmd.command_id, "actuator": cmd.actuator,
                               "requested_state": cmd.requested_state,
                               "result_state": cmd.requested_state if result_state is None else result_state,
                               "status": status, "timestamp": now.isoformat()}, device=device)
    db.commit()


def commands(db, device_id: str) -> list[ActuatorCommand]:
    return list(db.query(ActuatorCommand).filter(ActuatorCommand.device_id == device_id).order_by(ActuatorCommand.id).all())


# ----------------------------------------------------------------- hysteresis
class TestHysteresis:
    def test_heater_switches_on_below_min_and_off_above_min_plus_hysteresis(self, db, hw):
        t0 = datetime.now(UTC)
        r = feed(db, hw, t0, temperature_c=19.5)
        ev = control.run_for_device(db, hw, r, t0)
        db.commit()
        on = [d for d in ev.decisions if d["actuator"] == "heater"]
        assert on and on[0]["desired"] is True and "below target minimum" in on[0]["reason"]
        cmds = commands(db, hw.id)
        assert len(cmds) == 1 and cmds[0].status == "pending" and cmds[0].origin == "auto"
        confirm(db, hw, cmds[0], t0 + timedelta(seconds=2))

        # inside the band [20, 20.5): heater stays ON, nothing new is issued
        t1 = t0 + timedelta(minutes=2)
        r = feed(db, hw, t1, temperature_c=20.2, heater_state=True)
        ev = control.run_for_device(db, hw, r, t1)
        db.commit()
        assert not [d for d in ev.decisions if d["actuator"] == "heater"]
        assert any("inside hysteresis band" in n for n in ev.notes)
        assert len(commands(db, hw.id)) == 1

        # above min + hysteresis -> OFF
        t2 = t0 + timedelta(minutes=4)
        r = feed(db, hw, t2, temperature_c=20.6, heater_state=True)
        ev = control.run_for_device(db, hw, r, t2)
        db.commit()
        off = [d for d in ev.decisions if d["actuator"] == "heater"]
        assert off and off[0]["desired"] is False
        assert len(commands(db, hw.id)) == 2

    def test_fan_cools_above_max_and_latches_until_hysteresis_cleared(self, db, hw):
        t0 = datetime.now(UTC)
        r = feed(db, hw, t0, temperature_c=24.4)
        ev = control.run_for_device(db, hw, r, t0)
        db.commit()
        fan = [d for d in ev.decisions if d["actuator"] == "fan"]
        assert fan and fan[0]["desired"] is True
        confirm(db, hw, commands(db, hw.id)[-1], t0 + timedelta(seconds=2))
        # 23.8 is below max but above max - hysteresis (23.5): keep running
        t1 = t0 + timedelta(minutes=2)
        r = feed(db, hw, t1, temperature_c=23.8, fan_state=True)
        ev = control.run_for_device(db, hw, r, t1)
        db.commit()
        assert not [d for d in ev.decisions if d["actuator"] == "fan"]
        assert hw.control_state["latches"]["fan_cooling"] is True
        # 23.4 clears the latch -> fan off
        t2 = t0 + timedelta(minutes=4)
        r = feed(db, hw, t2, temperature_c=23.4, fan_state=True)
        ev = control.run_for_device(db, hw, r, t2)
        db.commit()
        fan = [d for d in ev.decisions if d["actuator"] == "fan"]
        assert fan and fan[0]["desired"] is False

    def test_humidifier_band(self, db, hw):
        t0 = datetime.now(UTC)
        r = feed(db, hw, t0, relative_humidity_percent=84.0)
        ev = control.run_for_device(db, hw, r, t0)
        db.commit()
        assert [d for d in ev.decisions if d["actuator"] == "humidifier"][0]["desired"] is True
        confirm(db, hw, commands(db, hw.id)[-1], t0 + timedelta(seconds=2))
        t1 = t0 + timedelta(minutes=2)
        r = feed(db, hw, t1, relative_humidity_percent=87.0, humidifier_state=True)  # < 85 + 3
        ev = control.run_for_device(db, hw, r, t1)
        assert not [d for d in ev.decisions if d["actuator"] == "humidifier"]
        t2 = t0 + timedelta(minutes=4)
        r = feed(db, hw, t2, relative_humidity_percent=88.5, humidifier_state=True)
        ev = control.run_for_device(db, hw, r, t2)
        assert [d for d in ev.decisions if d["actuator"] == "humidifier"][0]["desired"] is False

    def test_venting_takes_priority_over_humidifying(self, db, hw):
        t0 = datetime.now(UTC)
        r = feed(db, hw, t0, relative_humidity_percent=97.0, humidifier_state=True)
        ev = control.run_for_device(db, hw, r, t0)
        by = {d["actuator"]: d for d in ev.decisions}
        assert by["fan"]["desired"] is True and "humidity" in by["fan"]["reason"]
        assert by["humidifier"]["desired"] is False


# ----------------------------------------------------------------- switching limits
class TestSwitchingLimits:
    def test_minimum_switching_interval_defers_auto_commands(self, db, hw):
        t0 = datetime.now(UTC)
        r = feed(db, hw, t0, temperature_c=19.0)
        control.run_for_device(db, hw, r, t0)
        db.commit()
        confirm(db, hw, commands(db, hw.id)[-1], t0 + timedelta(seconds=1))
        # 20 s later the temperature already reads 21 -> OFF wanted, but min interval (60 s) not elapsed
        t1 = t0 + timedelta(seconds=20)
        r = feed(db, hw, t1, temperature_c=21.0, heater_state=True)
        ev = control.run_for_device(db, hw, r, t1)
        db.commit()
        assert len(commands(db, hw.id)) == 1  # nothing issued, nothing rejected
        assert any("deferred" in n and "minimum switching interval" in n for n in ev.notes)
        # after the interval it goes through
        t2 = t0 + timedelta(seconds=61)
        r = feed(db, hw, t2, temperature_c=21.0, heater_state=True)
        control.run_for_device(db, hw, r, t2)
        db.commit()
        assert len(commands(db, hw.id)) == 2

    def test_manual_command_inside_interval_is_rejected_and_logged(self, db, hw):
        hw.control_mode = "manual"
        t0 = datetime.now(UTC)
        feed(db, hw, t0)
        c1 = control.issue_command(db, hw, "fan", True, reason="test", origin="manual", requested_by="tester", now=t0)
        c2 = control.issue_command(db, hw, "fan", False, reason="test", origin="manual", requested_by="tester", now=t0 + timedelta(seconds=10))
        db.commit()
        assert c1.status == "pending"
        assert c2.status == "rejected" and "minimum switching interval" in c2.error
        assert c2.validation["result"] == "rejected"

    def test_safety_commands_bypass_the_interval(self, db, hw):
        t0 = datetime.now(UTC)
        feed(db, hw, t0)
        control.issue_command(db, hw, "heater", True, reason="test", origin="auto", now=t0)
        c = control.issue_command(db, hw, "heater", False, reason="safety", origin="safety", now=t0 + timedelta(seconds=5))
        assert c.status == "pending"


# ----------------------------------------------------------------- interlocks / safe state
class TestInterlocks:
    def test_stale_sensor_forces_heater_and_humidifier_to_safe_state(self, db, hw):
        t0 = datetime.now(UTC)
        feed(db, hw, t0, temperature_c=19.0, heater_state=True, humidifier_state=True)
        hw.control_mode = "monitor"  # safe state applies in every mode
        later = t0 + timedelta(seconds=200)  # > stale_sensor_timeout 120 s
        ev = control.run_for_device(db, hw, None, later)
        db.commit()
        assert "stale_or_invalid_temperature" in ev.interlocks
        by = {d["actuator"]: d for d in ev.decisions}
        assert by["heater"]["desired"] is False and by["heater"]["origin"] == "safety"
        assert by["humidifier"]["desired"] is False and by["humidifier"]["origin"] == "safety"
        assert all(c.origin == "safety" for c in commands(db, hw.id))

    def test_invalid_temperature_reading_blocks_heating(self, db, hw):
        t0 = datetime.now(UTC)
        r = feed(db, hw, t0, temperature_c=None, sensor_errors=["dht11"])
        ev = control.run_for_device(db, hw, r, t0)
        assert "stale_or_invalid_temperature" in ev.interlocks
        assert not [d for d in ev.decisions if d["actuator"] == "heater" and d["desired"]]

    def test_manual_heater_on_needs_fresh_temperature(self, db, hw):
        hw.control_mode = "manual"
        t0 = datetime.now(UTC)
        c = control.issue_command(db, hw, "heater", True, reason="test", origin="manual", now=t0)
        assert c.status == "rejected" and "fresh valid temperature" in c.error
        feed(db, hw, t0, temperature_c=21.0)
        c = control.issue_command(db, hw, "heater", True, reason="test", origin="manual", now=t0 + timedelta(seconds=1))
        assert c.status == "pending"
        assert set(c.validation["checks"]) >= {"fresh_temperature", "absolute_max", "cooldown", "min_switch_interval"}

    def test_absolute_max_temperature_cuts_heater_and_ventilates(self, db, hw):
        t0 = datetime.now(UTC)
        r = feed(db, hw, t0, temperature_c=32.5, heater_state=True)
        ev = control.run_for_device(db, hw, r, t0)
        assert "absolute_max_temperature" in ev.interlocks
        by = {d["actuator"]: d for d in ev.decisions}
        assert by["heater"]["desired"] is False and by["heater"]["origin"] == "safety"
        assert by["fan"]["desired"] is True and by["fan"]["origin"] == "safety"
        # a manual ON is refused too (after the switching interval, so the cutoff check is the one that fires)
        hw.control_mode = "manual"
        c = control.issue_command(db, hw, "heater", True, reason="test", origin="manual", now=t0 + timedelta(seconds=61))
        assert c.status == "rejected" and "absolute cutoff" in c.error

    def test_max_heater_runtime_forces_cooldown(self, db, hw):
        t0 = datetime.now(UTC)
        feed(db, hw, t0, temperature_c=19.0, heater_state=True)
        # pretend the heater has been on for 31 minutes
        state = dict(hw.actuator_state)
        state["heater"] = {**state["heater"], "since": (t0 - timedelta(minutes=31)).isoformat()}
        hw.actuator_state = state
        db.commit()
        r = feed(db, hw, t0 + timedelta(seconds=10), temperature_c=19.0, heater_state=True)
        ev = control.run_for_device(db, hw, r, t0 + timedelta(seconds=10))
        db.commit()
        assert "heater_max_runtime" in ev.interlocks
        heater = [d for d in ev.decisions if d["actuator"] == "heater"]
        assert heater and heater[0]["desired"] is False and heater[0]["origin"] == "safety"
        assert hw.actuator_state["heater"]["cooldown_until"]
        # during cooldown the temperature is still low but the heater is held off
        r = feed(db, hw, t0 + timedelta(seconds=90), temperature_c=19.0, heater_state=False)
        ev = control.run_for_device(db, hw, r, t0 + timedelta(seconds=90))
        assert "heater_cooldown" in ev.interlocks
        assert not [d for d in ev.decisions if d["actuator"] == "heater" and d["desired"]]
        assert any("held off" in n for n in ev.notes)


# ----------------------------------------------------------------- modes / offline
class TestModes:
    def test_monitor_mode_never_actuates(self, db, hw):
        hw.control_mode = "monitor"
        t0 = datetime.now(UTC)
        r = feed(db, hw, t0, temperature_c=15.0, relative_humidity_percent=60.0)
        ev = control.run_for_device(db, hw, r, t0)
        assert ev.decisions == []
        assert commands(db, hw.id) == []
        assert any("monitoring only" in n for n in ev.notes)

    def test_manual_mode_only_applies_safety(self, db, hw):
        hw.control_mode = "manual"
        t0 = datetime.now(UTC)
        r = feed(db, hw, t0, temperature_c=15.0)
        ev = control.run_for_device(db, hw, r, t0)
        assert ev.decisions == []
        r = feed(db, hw, t0 + timedelta(seconds=5), temperature_c=33.0, heater_state=True)
        ev = control.run_for_device(db, hw, r, t0 + timedelta(seconds=5))
        assert [d for d in ev.decisions if d["actuator"] == "heater"][0]["origin"] == "safety"

    def test_offline_device_gets_no_commands(self, db, hw):
        t0 = datetime.now(UTC)
        feed(db, hw, t0, temperature_c=15.0)
        hw.connection_status = "offline"
        db.commit()
        ev = control.run_for_device(db, hw, None, t0 + timedelta(seconds=1))
        assert ev.decisions == []
        assert any("offline" in n for n in ev.notes)
        c = control.issue_command(db, hw, "fan", True, reason="x", origin="manual", now=t0)
        assert c.status == "rejected" and "offline" in c.error

    def test_unknown_actuator_rejected(self, db, hw):
        feed(db, hw, datetime.now(UTC))
        c = control.issue_command(db, hw, "laser", True, reason="x", origin="manual")
        assert c.status == "rejected"

    def test_leaving_an_actuating_mode_returns_heater_to_safe_state(self, db, hw):
        hw.control_mode = "manual"
        t0 = datetime.now(UTC)
        feed(db, hw, t0, temperature_c=19.0)
        on = control.issue_command(db, hw, "heater", True, reason="warm up", origin="manual", requested_by="op", now=t0)
        confirm(db, hw, on, t0 + timedelta(seconds=2))
        fan = control.issue_command(db, hw, "fan", True, reason="air", origin="manual", requested_by="op", now=t0)
        confirm(db, hw, fan, t0 + timedelta(seconds=2))
        control.set_mode(db, hw, "monitor", "op", now=t0 + timedelta(seconds=10))
        db.commit()
        cmds = commands(db, hw.id)
        off = [c for c in cmds if c.actuator == "heater" and c.requested_state is False]
        assert len(off) == 1 and off[0].origin == "safety" and "safe state" in off[0].reason
        assert off[0].status == "pending"  # min-interval does not block safety commands
        assert hw.actuator_state["heater"]["requested"] is False and hw.actuator_state["heater"]["status"] == "pending"
        assert not [c for c in cmds if c.actuator == "fan" and c.requested_state is False]  # fan untouched
        # monitor -> auto with heater off: nothing to do
        control.set_mode(db, hw, "auto", "op", now=t0 + timedelta(seconds=20))
        assert len(commands(db, hw.id)) == len(cmds)


# ----------------------------------------------------------------- lifecycle
class TestCommandLifecycle:
    def test_requested_vs_confirmed_state_and_timeout(self, db, hw):
        t0 = datetime.now(UTC)
        feed(db, hw, t0, temperature_c=19.0)
        control.run_for_device(db, hw, None, t0)
        db.commit()
        entry = hw.actuator_state["heater"]
        assert entry["requested"] is True and entry["confirmed"] is False and entry["status"] == "pending"
        cmd = commands(db, hw.id)[-1]
        # no confirmation within the timeout -> command times out, state becomes mismatch (last known OFF, requested ON)
        expired = control.expire_commands(db, 45, t0 + timedelta(seconds=60))
        db.commit()
        assert [c.id for c in expired] == [cmd.id]
        assert cmd.status == "timeout"
        assert hw.actuator_state["heater"]["status"] == "mismatch"

    def test_confirmation_updates_state_and_records_status_event(self, db, hw):
        from app.db.models import ActuatorStatusEvent

        t0 = datetime.now(UTC)
        feed(db, hw, t0, temperature_c=19.0)
        control.run_for_device(db, hw, None, t0)
        db.commit()
        cmd = commands(db, hw.id)[-1]
        confirm(db, hw, cmd, t0 + timedelta(seconds=3))
        assert cmd.status == "confirmed" and cmd.result_state is True
        assert hw.actuator_state["heater"]["status"] == "confirmed"
        events = db.query(ActuatorStatusEvent).filter(ActuatorStatusEvent.device_id == hw.id).all()
        assert any(e.actuator == "heater" and e.state is True and e.command_id == cmd.command_id for e in events)

    def test_device_reported_failure_marks_command_failed(self, db, hw):
        t0 = datetime.now(UTC)
        feed(db, hw, t0, temperature_c=19.0)
        control.run_for_device(db, hw, None, t0)
        db.commit()
        cmd = commands(db, hw.id)[-1]
        confirm(db, hw, cmd, t0 + timedelta(seconds=3), result_state=False, status="failed")
        assert cmd.status == "failed"
        assert hw.actuator_state["heater"]["status"] in ("mismatch", "unknown")

    def test_restart_reconciliation_marks_pending_unknown(self, db, hw):
        t0 = datetime.now(UTC)
        feed(db, hw, t0, temperature_c=19.0)
        control.run_for_device(db, hw, None, t0)
        db.commit()
        n = control.reconcile_after_restart(db, t0 + timedelta(seconds=5))
        db.commit()
        assert n == 1
        assert commands(db, hw.id)[-1].status == "unknown"
        assert hw.actuator_state["heater"]["status"] == "unknown"


# ----------------------------------------------------------------- HTTP API
class TestControlApi:
    def test_manual_command_requires_manual_mode_and_operator(self, client, admin, operator, viewer):
        device_id, token = create_hw_device(client, admin, transport="http")
        post_telemetry(client, token, device_id)
        body = {"actuator": "fan", "state": True, "reason": "test"}
        assert client.post(f"/api/control/{device_id}/command", json=body).status_code == 401
        assert client.post(f"/api/control/{device_id}/command", json=body, headers=viewer).status_code == 403
        r = client.post(f"/api/control/{device_id}/command", json=body, headers=operator)
        assert r.status_code == 409  # still in monitor mode
        assert client.post(f"/api/control/{device_id}/mode", json={"mode": "manual"}, headers=operator).status_code == 200
        r = client.post(f"/api/control/{device_id}/command", json=body, headers=operator)
        assert r.status_code == 201, r.text
        cmd = r.json()
        assert cmd["status"] == "pending" and cmd["origin"] == "manual" and cmd["requested_by"] == "operator1"
        # rejected commands come back as 422 with the stored command record
        r = client.post(f"/api/control/{device_id}/command", json={"actuator": "fan", "state": False}, headers=operator)
        assert r.status_code == 422 and "minimum switching interval" in r.json()["detail"]["message"]
        # validation of the body
        assert client.post(f"/api/control/{device_id}/command", json={"actuator": "pump", "state": True}, headers=operator).status_code == 422

    def test_device_polls_commands_and_confirms(self, client, admin, operator):
        device_id, token = create_hw_device(client, admin, transport="http")
        post_telemetry(client, token, device_id)
        client.post(f"/api/control/{device_id}/mode", json={"mode": "manual"}, headers=operator)
        cmd = client.post(f"/api/control/{device_id}/command", json={"actuator": "humidifier", "state": True}, headers=operator).json()
        polled = client.get("/api/ingest/commands", headers={"X-Device-Token": token}).json()["commands"]
        assert [c["command_id"] for c in polled] == [cmd["command_id"]]
        assert polled[0]["schema_version"] == 1 and polled[0]["actuator"] == "humidifier" and polled[0]["state"] is True
        # second poll is empty (already marked sent)
        assert client.get("/api/ingest/commands", headers={"X-Device-Token": token}).json()["commands"] == []
        overview = client.get(f"/api/control/{device_id}").json()
        assert overview["actuators"]["humidifier"]["status"] == "pending"
        r = client.post("/api/ingest/command-status", json={"command_id": cmd["command_id"], "actuator": "humidifier",
                                                            "requested_state": True, "result_state": True, "status": "applied",
                                                            "timestamp": datetime.now(UTC).isoformat()},
                        headers={"X-Device-Token": token})
        assert r.status_code == 202
        overview = client.get(f"/api/control/{device_id}").json()
        assert overview["actuators"]["humidifier"]["status"] == "confirmed"
        assert overview["actuators"]["humidifier"]["confirmed"] is True
        log = client.get(f"/api/control/{device_id}/commands").json()
        assert log[0]["status"] == "confirmed"

    def test_hardware_device_without_token_cannot_enter_auto(self, client, admin, operator):
        r = client.post("/api/devices", json={"id": "esp32-notoken", "name": "n", "kind": "hardware", "transport": "http"}, headers=admin)
        assert r.status_code == 201
        r = client.post("/api/control/esp32-notoken/mode", json={"mode": "auto"}, headers=operator)
        assert r.status_code == 409

    def test_config_update_validates_ranges_and_is_applied(self, client, admin, operator):
        device_id, token = create_hw_device(client, admin, transport="http")
        assert client.patch(f"/api/control/{device_id}/config", json={"hysteresis_temp_c": 99}, headers=operator).status_code == 422
        assert client.patch(f"/api/control/{device_id}/config", json={"heater_absolute_max_temp_c": 10}, headers=operator).status_code == 422
        r = client.patch(f"/api/control/{device_id}/config", json={"hysteresis_temp_c": 1.0, "min_switch_interval_seconds": 120,
                                                                   "targets": {"temperature_min_c": 18, "temperature_max_c": 22}}, headers=operator)
        assert r.status_code == 200, r.text
        overview = client.get(f"/api/control/{device_id}").json()
        assert overview["config"]["hysteresis_temp_c"] == 1.0
        assert overview["config"]["min_switch_interval_seconds"] == 120
        assert overview["last_evaluation"] is None or overview["last_evaluation"]["targets"]["temperature_min_c"] == 18

    def test_no_public_relay_endpoint_exists(self, client):
        """Actuators can only be reached through the validated control service."""
        paths = client.get("/api/openapi.json").json()["paths"]
        for path, ops in paths.items():
            if "relay" in path or "gpio" in path:
                pytest.fail(f"unexpected direct hardware endpoint {path}")
            if path.endswith("/command") or path.endswith("/mode"):
                for op in ops.values():
                    assert op.get("security") or "require" in str(op), path

    def test_evaluate_endpoint_returns_structured_evaluation(self, client, admin, operator):
        device_id, token = create_hw_device(client, admin, transport="http", control_mode="monitor")
        post_telemetry(client, token, device_id, temperature_c=18.0)
        r = client.post(f"/api/control/{device_id}/evaluate", headers=operator)
        assert r.status_code == 200
        ev = r.json()["evaluation"] if "evaluation" in r.json() else r.json()
        assert ev["mode"] == "monitor" and ev["inputs"]["temperature_c"] == 18.0
        assert ev["targets"]["source"] == "default"
        assert ev["decisions"] == []
