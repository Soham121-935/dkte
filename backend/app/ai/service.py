"""AI service: rate limiting, prompt construction, provider calls, usage
accounting and graceful fallback.
"""
from __future__ import annotations

import logging
import time
from collections import deque
from datetime import datetime, timezone
from typing import Any

from sqlalchemy.orm import Session

from ..config import get_settings
from ..db.models import AIConversation, AIMessage, CultivationBatch, Device
from . import fallback
from .context import build_context, render_context_markdown
from .provider import AIAuthError, AIError, AINotConfigured, AIProvider, OpenAICompatibleProvider, build_provider

log = logging.getLogger(__name__)

SYSTEM_PROMPT = """You are the MYCO AI cultivation assistant for a small ESP32-based mushroom growing chamber.

STRICT RULES
1. Only state sensor values, timestamps, actuator states, alerts and batch facts that appear in the CONTEXT below. Never invent, round-trip or extrapolate readings. If a value is missing, say that it is missing.
2. Always include the measurement timestamp (UTC) when you quote a reading, and say whether the data is SIMULATED when the source is simulation.
3. Clearly separate five kinds of information using these labels in your answer when relevant: **Measured now**, **History**, **Model estimate/forecast**, **Grower observation**, **General cultivation knowledge**.
4. Model estimates (stage timing, forecasts) are baselines with explicit uncertainty – repeat their confidence/limitation; never present them as facts or give precise percentages that are not in the context.
5. The deterministic control service decides actuator states. Explain its reasons from the context; never claim an actuator switched unless a confirmed state says so. You cannot control hardware; if the user asks to switch something, tell them to use the Environmental Control page where the command is validated.
6. Growing-medium moisture is an uncalibrated raw ADC value – do not convert it to a percentage.
7. The DHT11 sensor is rated for 0–50 °C and ~20–90 % RH; mention this when readings approach those limits.
8. Be concise, use Markdown with short sections or bullet lists, and end with one practical next step when appropriate.
"""


class RateLimiter:
    def __init__(self, per_minute: int) -> None:
        self.per_minute = per_minute
        self._events: dict[str, deque[float]] = {}

    def allow(self, key: str) -> bool:
        now = time.monotonic()
        q = self._events.setdefault(key, deque())
        while q and now - q[0] > 60.0:
            q.popleft()
        if len(q) >= self.per_minute:
            return False
        q.append(now)
        return True


class AIService:
    def __init__(self, provider: AIProvider | None = None) -> None:
        self.provider: AIProvider = provider or build_provider()
        self.limiter = RateLimiter(get_settings().ai_rate_limit_per_minute)
        self.last_error: str | None = None
        self.last_success_at: datetime | None = None
        self.total_prompt_tokens = 0
        self.total_completion_tokens = 0
        self.requests = 0
        self.failures = 0
        self._consecutive_failures = 0
        self._circuit_open_until: float = 0.0

    # ----------------------------------------------------------------- status
    def status(self) -> dict[str, Any]:
        settings = get_settings()
        info: dict[str, Any] = {
            "configured": self.provider.configured,
            "provider": self.provider.name,
            "model": settings.ai_model or None,
            "json_mode_enabled": settings.ai_enable_json_mode,
            "rate_limit_per_minute": settings.ai_rate_limit_per_minute,
            "last_error": self.last_error,
            "last_success_at": self.last_success_at.isoformat() if self.last_success_at else None,
            "usage": {"requests": self.requests, "failures": self.failures,
                      "prompt_tokens": self.total_prompt_tokens, "completion_tokens": self.total_completion_tokens},
            "fallback": "deterministic assistant answers from stored data when the provider is unavailable",
            "circuit_open": time.monotonic() < self._circuit_open_until,
            "circuit_retry_in_seconds": max(0, int(self._circuit_open_until - time.monotonic())),
        }
        if isinstance(self.provider, OpenAICompatibleProvider):
            info.update(self.provider.describe())
        if not self.provider.configured:
            missing = []
            if not settings.ai_api_key:
                missing.append("AI_API_KEY")
            if not settings.ai_model:
                missing.append("AI_MODEL")
            info["detail"] = "Not configured: set " + ", ".join(missing) + " in backend/.env" if missing else "disabled"
        return info

    async def diagnostics(self) -> dict[str, Any]:
        """Verify connectivity, model availability and a minimal chat completion. Never returns the key."""
        result: dict[str, Any] = {"checked_at": datetime.now(timezone.utc).isoformat(), **self.status()}
        if not self.provider.configured:
            result["ok"] = False
            result["steps"] = [{"step": "configuration", "ok": False, "detail": result.get("detail")}]
            return result
        steps = []
        try:
            models = await self.provider.list_models()
            configured = get_settings().ai_model
            steps.append({"step": "list_models", "ok": True, "detail": f"{len(models)} models visible",
                          "model_found": configured in models, "sample": [m for m in models if any(k in m for k in ("llama", "nemotron", "mistral", "gpt", "qwen"))][:12]})
        except AIError as exc:
            self.last_error = exc.user_message
            steps.append({"step": "list_models", "ok": False, "detail": exc.user_message})
        try:
            resp = await self.provider.chat([{"role": "user", "content": "Reply with the single word OK."}], max_tokens=5, temperature=0.0)
            steps.append({"step": "chat_completion", "ok": True, "detail": f"model={resp.model} latency={resp.latency_ms}ms reply={resp.content.strip()[:20]!r}"})
            self.last_success_at = datetime.now(timezone.utc)
            self.last_error = None
        except AIError as exc:
            self.failures += 1
            self.last_error = exc.user_message
            steps.append({"step": "chat_completion", "ok": False, "detail": exc.user_message})
        if get_settings().ai_enable_json_mode:
            try:
                resp = await self.provider.chat([{"role": "user", "content": 'Return {"ok": true} as JSON.'}], max_tokens=20, temperature=0.0, json_mode=True)
                steps.append({"step": "json_mode", "ok": '"ok"' in resp.content, "detail": resp.content.strip()[:60]})
            except AIError as exc:
                steps.append({"step": "json_mode", "ok": False, "detail": exc.user_message})
        result["steps"] = steps
        result["ok"] = all(s["ok"] for s in steps)
        return result

    # ------------------------------------------------------------------ chat
    async def chat(
        self,
        db: Session,
        conversation: AIConversation,
        user_text: str,
        *,
        device: Device,
        batch: CultivationBatch | None,
        user_key: str = "anonymous",
    ) -> AIMessage:
        text = user_text.strip()
        if not text:
            raise ValueError("message is empty")
        if len(text) > 4000:
            raise ValueError("message is too long (max 4000 characters)")
        ctx = build_context(db, device, batch)
        user_msg = AIMessage(conversation_id=conversation.id, role="user", content=text)
        db.add(user_msg)
        db.flush()
        snapshot = {"generated_at": ctx["generated_at"], "current_reading": ctx.get("current_reading"),
                    "targets": {k: ctx["targets"].get(k) for k in ("temperature_min_c", "temperature_max_c", "humidity_min_percent", "humidity_max_percent", "source_label")},
                    "batch": {"code": ctx["batch"]["code"], "stage": ctx["batch"]["current_stage_key"]} if ctx.get("batch") else None}
        history = [m for m in conversation.messages if m.id != user_msg.id][-12:]
        messages = [{"role": "system", "content": SYSTEM_PROMPT + "\n\n# CONTEXT (generated " + ctx["generated_at"] + ")\n" + render_context_markdown(ctx)}]
        for m in history:
            if m.role in ("user", "assistant") and m.content:
                messages.append({"role": m.role, "content": m.content})
        messages.append({"role": "user", "content": text})

        reply: AIMessage
        if not self.provider.configured:
            reply = AIMessage(conversation_id=conversation.id, role="assistant", content=fallback.answer(text, ctx), mode="fallback",
                              provider="deterministic", context_snapshot=snapshot, error=AINotConfigured.user_message)
        elif not self.limiter.allow(user_key):
            reply = AIMessage(conversation_id=conversation.id, role="assistant", content=fallback.answer(text, ctx), mode="fallback",
                              provider="deterministic", context_snapshot=snapshot,
                              error="Local rate limit reached for the AI provider; deterministic answer shown instead.")
        elif time.monotonic() < self._circuit_open_until:
            wait = int(self._circuit_open_until - time.monotonic())
            reply = AIMessage(conversation_id=conversation.id, role="assistant", content=fallback.answer(text, ctx), mode="fallback",
                              provider="deterministic", context_snapshot=snapshot,
                              error=f"AI provider unreachable ({self.last_error}); retrying in {wait}s. Deterministic answer shown instead.")
        else:
            self.requests += 1
            try:
                resp = await self.provider.chat(messages)
                self.last_success_at = datetime.now(timezone.utc)
                self.last_error = None
                self._consecutive_failures = 0
                self.total_prompt_tokens += resp.prompt_tokens or 0
                self.total_completion_tokens += resp.completion_tokens or 0
                content = resp.content.strip() or "_(empty response from model)_"
                if ctx.get("current_reading") and ctx["current_reading"]["source"] == "simulation" and "simulat" not in content.lower():
                    content += "\n\n_Note: the readings in this answer come from the **simulated** device, not from hardware._"
                reply = AIMessage(conversation_id=conversation.id, role="assistant", content=content, mode="llm", provider=resp.provider,
                                  model=resp.model, prompt_tokens=resp.prompt_tokens, completion_tokens=resp.completion_tokens,
                                  latency_ms=resp.latency_ms, context_snapshot=snapshot)
            except AIError as exc:
                self.failures += 1
                self._consecutive_failures += 1
                self.last_error = exc.user_message
                if self._consecutive_failures >= 2 or isinstance(exc, (AIAuthError, AINotConfigured)):
                    self._circuit_open_until = time.monotonic() + (300.0 if isinstance(exc, AIAuthError) else 60.0)
                log.warning("AI provider error: %s (%s)", exc.user_message, type(exc).__name__)
                reply = AIMessage(conversation_id=conversation.id, role="assistant", content=fallback.answer(text, ctx), mode="fallback",
                                  provider="deterministic", context_snapshot=snapshot, error=exc.user_message)
        db.add(reply)
        if conversation.title == "New conversation":
            conversation.title = text[:60] + ("…" if len(text) > 60 else "")
        conversation.updated_at = datetime.now(timezone.utc)
        db.flush()
        return reply


ai_service = AIService()


def reset_ai_service() -> None:
    global ai_service
    ai_service = AIService()
