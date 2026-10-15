"""AI adapter + assistant: provider abstraction, error handling, fallback,
usage accounting, rate limiting, and the guarantee that the LLM cannot
touch hardware or leak secrets."""
from __future__ import annotations

import asyncio
from datetime import datetime, timezone

import pytest

from app.ai import service as ai_module
from app.ai.provider import AIAuthError, AIBadResponse, AIResponse, AITimeout, AIUnavailable, OpenAICompatibleProvider
from app.ai.service import AIService
from app.db.models import ActuatorCommand, AIConversation, Device
from tests.conftest import create_hw_device, post_telemetry

UTC = timezone.utc


class FakeProvider:
    name = "fake"

    def __init__(self, *, configured=True, fail_with: Exception | None = None, reply="Measured temperature is 22.0 °C (simulated)."):
        self._configured = configured
        self.fail_with = fail_with
        self.reply = reply
        self.calls: list[list[dict[str, str]]] = []

    @property
    def configured(self) -> bool:
        return self._configured

    async def chat(self, messages, *, temperature=None, max_tokens=None, json_mode=False):
        self.calls.append(messages)
        if self.fail_with:
            raise self.fail_with
        return AIResponse(content=self.reply, model="fake-model", provider="fake", prompt_tokens=120, completion_tokens=30, latency_ms=12)

    async def list_models(self):
        return ["fake-model"]


def _install(provider) -> AIService:
    svc = AIService(provider=provider)
    ai_module.ai_service = svc
    return svc


def _conversation(client, device_id="myco-esp32-01", batch_id=None) -> int:
    r = client.post("/api/ai/conversations", json={"device_id": device_id, "batch_id": batch_id})
    assert r.status_code == 201, r.text
    return r.json()["id"]


def _send(client, cid: int, text: str, headers=None):
    return client.post(f"/api/ai/conversations/{cid}/messages", json={"content": text}, headers=headers or {})


def test_not_configured_uses_deterministic_fallback_and_says_so(client):
    _install(FakeProvider(configured=False))
    status = client.get("/api/ai/status").json()
    assert status["configured"] is False
    cid = _conversation(client)
    r = _send(client, cid, "What is the current temperature?")
    assert r.status_code == 201, r.text
    reply = r.json()["messages"][-1]
    assert reply["role"] == "assistant" and reply["mode"] == "fallback"
    assert reply["error"]  # the UI shows an explicit "AI unavailable" indication
    assert "AI language model is offline" in reply["content"] and "deterministic assistant" in reply["content"]


def test_llm_reply_with_context_and_usage_accounting(client, admin):
    device_id, token = create_hw_device(client, admin)
    post_telemetry(client, token, device_id, temperature_c=22.0, relative_humidity_percent=88.0)
    provider = FakeProvider()
    svc = _install(provider)
    cid = _conversation(client, device_id)
    r = _send(client, cid, "What is the current temperature?")
    assert r.status_code == 201, r.text
    reply = r.json()["messages"][-1]
    assert reply["mode"] == "llm" and reply["model"] == "fake-model" and reply["error"] is None
    assert reply["prompt_tokens"] == 120 and reply["completion_tokens"] == 30
    # the system prompt carries real stored data with timestamps and the safety rules
    system = provider.calls[0][0]
    assert system["role"] == "system"
    assert "22.0" in system["content"] and device_id in system["content"]
    assert "never" in system["content"].lower() and "actuator" in system["content"].lower()
    status = r.json()["ai"]
    assert status["usage"] == {"requests": 1, "failures": 0, "prompt_tokens": 120, "completion_tokens": 30}
    assert svc.last_success_at is not None
    # the conversation keeps history in order
    conv = client.get(f"/api/ai/conversations/{cid}").json()
    assert [m["role"] for m in conv["messages"]] == ["user", "assistant"]
    assert conv["messages"][-1]["context_snapshot"]["current_reading"]["temperature_c"] == 22.0


def test_simulated_context_is_flagged_in_answer(client, db):
    """When the underlying data is simulated the answer must say so even if the model forgot."""
    sim = db.get(Device, "myco-sim-01")
    from tests.test_control import feed

    sim.connection_status = "online"
    feed(db, sim, datetime.now(UTC), temperature_c=21.0)
    _install(FakeProvider(reply="The temperature is 21.0 °C."))
    cid = _conversation(client, "myco-sim-01")
    reply = _send(client, cid, "temperature?").json()["messages"][-1]
    assert "simulated" in reply["content"].lower()


@pytest.mark.parametrize("exc, phrase", [
    (AIUnavailable("connection error"), "unreachable"),
    (AITimeout("timeout"), "respond"),
    (AIBadResponse("HTTP 400"), "unexpected"),
])
def test_provider_errors_fall_back_gracefully(client, exc, phrase):
    svc = _install(FakeProvider(fail_with=exc))
    cid = _conversation(client)
    r = _send(client, cid, "Any advice?")
    assert r.status_code == 201
    reply = r.json()["messages"][-1]
    assert reply["mode"] == "fallback"
    assert phrase in reply["error"].lower()
    assert svc.failures == 1 and svc.requests == 1
    status = client.get("/api/ai/status").json()
    assert status["last_error"] == reply["error"]


def test_circuit_breaker_opens_after_repeated_failures(client):
    provider = FakeProvider(fail_with=AIUnavailable("down"))
    svc = _install(provider)
    cid = _conversation(client)
    _send(client, cid, "one")
    _send(client, cid, "two")
    assert svc.status()["circuit_open"] is True
    calls_before = len(provider.calls)
    reply = _send(client, cid, "three").json()["messages"][-1]
    assert len(provider.calls) == calls_before  # provider is not hammered while the circuit is open
    assert reply["mode"] == "fallback" and "retrying in" in reply["error"]


def test_auth_error_opens_circuit_immediately(client):
    svc = _install(FakeProvider(fail_with=AIAuthError("401")))
    cid = _conversation(client)
    reply = _send(client, cid, "hello").json()["messages"][-1]
    assert reply["mode"] == "fallback"
    assert "key" in reply["error"].lower() or "auth" in reply["error"].lower()
    assert svc.status()["circuit_open"] is True


def test_rate_limit_is_enforced_per_user(client, monkeypatch):
    provider = FakeProvider()
    svc = _install(provider)
    svc.limiter = ai_module.RateLimiter(2)
    cid = _conversation(client)
    modes = [_send(client, cid, f"q{i}").json()["messages"][-1]["mode"] for i in range(3)]
    assert modes == ["llm", "llm", "fallback"]
    assert len(provider.calls) == 2


def test_message_validation(client):
    _install(FakeProvider())
    cid = _conversation(client)
    assert _send(client, cid, "").status_code == 422
    assert _send(client, cid, "x" * 4001).status_code == 422
    assert client.post("/api/ai/conversations/9999/messages", json={"content": "hi"}).status_code == 404


def test_llm_cannot_switch_actuators(client, admin, operator, db):
    """Even a model that 'decides' to switch the heater produces no command."""
    device_id, token = create_hw_device(client, admin)
    post_telemetry(client, token, device_id, temperature_c=15.0)
    client.post(f"/api/control/{device_id}/mode", json={"mode": "manual"}, headers=operator)
    _install(FakeProvider(reply='{"action": "set_actuator", "actuator": "heater", "state": true} Turning the heater on now.'))
    cid = _conversation(client, device_id)
    r = _send(client, cid, "Turn the heater on", headers=operator)
    assert r.status_code == 201
    assert db.query(ActuatorCommand).filter(ActuatorCommand.device_id == device_id).count() == 0
    overview = client.get(f"/api/control/{device_id}").json()
    assert overview["actuators"]["heater"].get("requested") in (None, False)


def test_status_and_responses_never_contain_the_api_key(client, monkeypatch):
    secret = "nvapi-UNIT-TEST-SECRET-VALUE-0000"
    provider = OpenAICompatibleProvider(api_key=secret, base_url="https://integrate.api.nvidia.com/v1", model="meta/llama-3.3-70b-instruct")
    svc = _install(provider)

    async def fail(*a, **k):
        raise AIUnavailable("connection error: ConnectError")

    monkeypatch.setattr(provider, "chat", fail)
    status = client.get("/api/ai/status")
    assert secret not in status.text
    assert status.json()["key_hint"] == "nvapi-…" and status.json()["key_present"] is True
    assert status.json()["vendor"] == "NVIDIA API Catalog"
    cid = _conversation(client)
    r = _send(client, cid, "hello")
    assert secret not in r.text
    conv = client.get(f"/api/ai/conversations/{cid}")
    assert secret not in conv.text
    assert secret not in str(svc.status())


def test_openai_compatible_provider_parses_chat_completion(monkeypatch):
    provider = OpenAICompatibleProvider(api_key="k", base_url="https://example.invalid/v1", model="m")

    async def fake_request(method, path, json_body=None):
        assert path == "/chat/completions" and json_body["model"] == "m"
        assert json_body["messages"][0]["role"] == "system"
        return {"choices": [{"message": {"content": "hi"}, "finish_reason": "stop"}], "usage": {"prompt_tokens": 5, "completion_tokens": 1}, "model": "m"}

    monkeypatch.setattr(provider, "_request", fake_request)
    resp = asyncio.run(provider.chat([{"role": "system", "content": "s"}, {"role": "user", "content": "u"}]))
    assert resp.content == "hi" and resp.prompt_tokens == 5 and resp.completion_tokens == 1

    async def bad_request(method, path, json_body=None):
        return {"unexpected": True}

    monkeypatch.setattr(provider, "_request", bad_request)
    with pytest.raises(AIBadResponse):
        asyncio.run(provider.chat([{"role": "user", "content": "u"}]))


def test_openai_compatible_provider_maps_http_errors(monkeypatch):
    import httpx

    provider = OpenAICompatibleProvider(api_key="k", base_url="https://example.invalid/v1", model="m", timeout=1, max_retries=0)
    real = httpx.AsyncClient

    def make_client(status: int, body: dict | None = None):
        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(status, json=body or {"error": {"message": "nope"}})

        transport = httpx.MockTransport(handler)

        class Client(real):
            def __init__(self, *a, **k):
                k["transport"] = transport
                super().__init__(*a, **k)

        return Client

    for status, exc in ((401, AIAuthError), (429, type(None)), (503, AIUnavailable), (400, AIBadResponse)):
        monkeypatch.setattr(httpx, "AsyncClient", make_client(status))
        try:
            asyncio.run(provider._request("POST", "/chat/completions", {}))
        except Exception as e:  # noqa: BLE001
            if exc is type(None):
                assert e.__class__.__name__ == "AIRateLimited"
            else:
                assert isinstance(e, exc), (status, e)
        else:
            pytest.fail(f"status {status} should raise")


def test_diagnostics_requires_admin_and_reports_provider(client, admin):
    _install(FakeProvider())
    assert client.post("/api/ai/diagnostics").status_code == 401
    r = client.post("/api/ai/diagnostics", headers=admin)
    assert r.status_code == 200
    body = r.json()
    assert "configured" in body or "ok" in body or "status" in body


def test_conversation_management(client, operator, viewer):
    _install(FakeProvider())
    cid = _conversation(client)
    assert client.get("/api/ai/conversations").json()[0]["id"] == cid
    assert client.get("/api/ai/suggestions").json()["questions"]
    assert client.delete(f"/api/ai/conversations/{cid}", headers=viewer).status_code == 403
    assert client.delete(f"/api/ai/conversations/{cid}", headers=operator).status_code == 204
    assert client.get(f"/api/ai/conversations/{cid}").status_code == 404
    db_conv = AIConversation  # noqa: F841  (model import exercised)


# --------------------------------------------------------------------------- insight / briefing
from app.ai.insight import build_briefing  # noqa: E402


def _ctx(**overrides):
    base = {
        "generated_at": "2026-10-15T06:00:00+00:00",
        "device": {"id": "d", "name": "Chamber", "kind": "hardware", "connection_status": "online", "control_mode": "auto"},
        "current_reading": {"kind": "measurement", "source": "hardware", "measured_at": "2026-10-15T05:59:30+00:00", "age_seconds": 30,
                            "stale": False, "temperature_c": 22.0, "relative_humidity_percent": 90.0, "substrate_moisture_raw": 2000,
                            "quality": {}, "fan_state": False, "heater_state": False, "humidifier_state": True},
        "targets": {"temperature_min_c": 20, "temperature_max_c": 24, "humidity_min_percent": 85, "humidity_max_percent": 95},
        "history": {"n_readings": 100, "temperature_c": {"min": 21.0, "max": 23.0, "mean": 22.0},
                    "relative_humidity_percent": {"min": 86, "max": 92, "mean": 89}, "outside_range": {}, "data_completeness": 0.99},
        "alerts": {"items": []}, "batch": None, "stage_estimate": None, "recommendations": {"items": []},
    }
    base.update(overrides)
    return base


def test_briefing_is_good_when_everything_is_in_range():
    b = build_briefing(_ctx())
    assert b["status"] == "good" and b["headline"] == "Everything looks good"
    texts = " ".join(p["text"] for p in b["points"])
    assert "Temperature is 22 °C – inside the target range (20–24 °C)" in texts
    assert "No open alerts" in texts
    assert b["simulated"] is False and "measured by your chamber" in b["data_note"]
    assert "Nothing to do right now" in b["next_step"]


def test_briefing_flags_low_temperature_offline_and_alerts_in_plain_words():
    ctx = _ctx()
    ctx["current_reading"].update({"temperature_c": 17.0, "heater_state": True, "source": "simulation"})
    ctx["alerts"] = {"items": [{"title": "Temperature out of range", "severity": "warning", "status": "active"},
                               {"title": "Old one", "severity": "critical", "status": "resolved"}]}
    b = build_briefing(ctx)
    assert b["status"] == "attention"
    texts = [p["text"] for p in b["points"]]
    assert any("well below the target range" in t and "The heater is on." in t for t in texts)
    assert any(t.startswith("1 open alert: Temperature out of range") for t in texts)
    assert b["simulated"] is True and "simulated" in b["data_note"]
    # no jargon leaks into the grower-facing text
    joined = " ".join(texts).lower()
    for word in ("hysteresis", "adc", "mqtt", "rule_key", "interlock"):
        assert word not in joined

    ctx["device"]["connection_status"] = "offline"
    ctx["current_reading"]["age_seconds"] = 3600
    b2 = build_briefing(ctx)
    assert any("appears to be disconnected" in p["text"] for p in b2["points"])
    assert "connection" in b2["next_step"].lower() or "power" in b2["next_step"].lower()


def test_briefing_without_readings_is_unknown_and_uses_stage_estimate_when_available():
    assert build_briefing(_ctx(current_reading=None))["status"] == "unknown"
    ctx = _ctx(batch={"code": "B-1", "species": "Pleurotus ostreatus"},
               stage_estimate={"available": True, "timing": "within_window", "current_stage": {"name": "Pinning", "elapsed_days": 4.6},
                               "next_stage": {"name": "Fruiting", "observable_signs": ["Caps expanding beyond 1 cm."]}})
    b = build_briefing(ctx)
    assert any("day 5 of the Pinning stage" in p["text"] and p["kind"] == "estimate" for p in b["points"])
    assert b["next_step"].startswith("Inspect the batch for signs of fruiting: caps expanding")


def test_insight_endpoint_falls_back_without_provider_and_caches(client, admin):
    _install(FakeProvider(configured=False))
    device_id, token = create_hw_device(client, admin)
    post_telemetry(client, token, device_id, temperature_c=27.5, relative_humidity_percent=88.0)
    r = client.get("/api/ai/insight", params={"device_id": device_id})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["mode"] == "fallback" and body["narrative"] is None and body["model"] is None
    assert "AI assistant offline" in body["label"] and body["error"]
    assert body["status"] in ("watch", "attention")
    assert any("Temperature is 27.5 °C" in p["text"] and "above the target range" in p["text"] for p in body["points"])
    assert body["cached"] is False
    assert client.get("/api/ai/insight", params={"device_id": device_id}).json()["cached"] is True
    assert client.get("/api/ai/insight", params={"device_id": device_id, "refresh": "true"}).json()["cached"] is False
    assert client.get("/api/ai/insight", params={"device_id": "nope"}).status_code == 404
    assert client.get("/api/ai/insight", params={"device_id": device_id, "batch_id": 99999}).status_code == 404


def test_insight_uses_llm_narrative_when_configured_and_falls_back_on_error(client, admin):
    device_id, token = create_hw_device(client, admin, device_id="esp32-insight-02")
    post_telemetry(client, token, device_id, temperature_c=22.0, relative_humidity_percent=90.0)
    provider = FakeProvider(reply="Your chamber is doing well: temperature and humidity are inside their targets. Nothing to do right now.")
    svc = _install(provider)
    body = client.get("/api/ai/insight", params={"device_id": device_id}).json()
    assert body["mode"] == "llm" and body["model"] == "fake-model" and body["narrative"].startswith("Your chamber is doing well")
    assert "Written by MYCO AI" in body["label"]
    assert body["points"] and body["status"] == "good"
    sent = provider.calls[-1]
    assert sent[0]["role"] == "system" and "# CONTEXT" in sent[0]["content"] and "22.0" in sent[0]["content"]
    assert "plain language" in sent[1]["content"].lower() and "Computed status: Everything looks good" in sent[1]["content"]
    assert svc.total_completion_tokens == 30 and svc.requests == 1

    svc = _install(FakeProvider(fail_with=AITimeout("slow")))
    body = client.get("/api/ai/insight", params={"device_id": device_id}).json()
    assert body["mode"] == "fallback" and body["narrative"] is None
    assert body["error"] == AITimeout.user_message
    assert body["points"] and svc.failures == 1
