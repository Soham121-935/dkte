"""AI provider adapter.

``OpenAICompatibleProvider`` talks to any OpenAI-style ``/chat/completions``
endpoint.  NVIDIA API Catalog keys (``nvapi-…``) use
``https://integrate.api.nvidia.com/v1`` with the same wire format.  The model
name is configuration (``AI_MODEL``) – nothing is hard-coded – and the
``list_models``/``probe`` helpers let the Settings page verify at runtime that
the configured model exists and answers a chat completion.

The secret key only ever lives in this process.  It is never logged, never
returned by an endpoint and never included in error messages.
"""
from __future__ import annotations

import asyncio
import logging
import time
from dataclasses import dataclass, field
from typing import Any, Protocol

import httpx

from ..config import get_settings

log = logging.getLogger(__name__)


class AIError(Exception):
    """Base class – message is safe to show to users (no secrets)."""

    user_message = "The AI provider request failed."


class AINotConfigured(AIError):
    user_message = "AI provider is not configured (set AI_API_KEY and AI_MODEL in the backend .env)."


class AIAuthError(AIError):
    user_message = "The AI provider rejected the API key (401/403). Check AI_API_KEY in the backend .env."


class AIRateLimited(AIError):
    user_message = "The AI provider is rate limiting requests (429). Try again shortly."


class AITimeout(AIError):
    user_message = "The AI provider did not respond in time."


class AIUnavailable(AIError):
    user_message = "The AI provider is unreachable or returned a server error."


class AIBadResponse(AIError):
    user_message = "The AI provider returned an unexpected response."


@dataclass
class AIResponse:
    content: str
    model: str
    provider: str
    prompt_tokens: int | None = None
    completion_tokens: int | None = None
    latency_ms: int | None = None
    finish_reason: str | None = None
    raw: dict[str, Any] = field(default_factory=dict)


class AIProvider(Protocol):
    name: str

    @property
    def configured(self) -> bool: ...

    async def chat(self, messages: list[dict[str, str]], *, temperature: float | None = None,
                   max_tokens: int | None = None, json_mode: bool = False) -> AIResponse: ...

    async def list_models(self) -> list[str]: ...


class DisabledProvider:
    name = "disabled"

    @property
    def configured(self) -> bool:
        return False

    async def chat(self, messages, *, temperature=None, max_tokens=None, json_mode=False):  # noqa: ANN001
        raise AINotConfigured()

    async def list_models(self) -> list[str]:
        raise AINotConfigured()


class OpenAICompatibleProvider:
    name = "openai_compatible"

    def __init__(self, api_key: str, base_url: str, model: str, timeout: float = 45.0, max_retries: int = 2) -> None:
        self._api_key = api_key
        self.base_url = base_url.rstrip("/")
        self.model = model
        self.timeout = timeout
        self.max_retries = max_retries

    @property
    def configured(self) -> bool:
        return bool(self._api_key and self.model)

    def _headers(self) -> dict[str, str]:
        return {"Authorization": f"Bearer {self._api_key}", "Content-Type": "application/json", "Accept": "application/json"}

    def describe(self) -> dict[str, Any]:
        host = self.base_url.split("//", 1)[-1].split("/", 1)[0]
        vendor = "NVIDIA API Catalog" if "nvidia.com" in host else ("OpenAI" if "openai.com" in host else "OpenAI-compatible")
        return {"provider": self.name, "vendor": vendor, "endpoint_host": host, "model": self.model or None,
                "key_present": bool(self._api_key), "key_hint": ("nvapi-…" if self._api_key.startswith("nvapi-") else "sk-…") if self._api_key else None}

    async def _request(self, method: str, path: str, json_body: dict[str, Any] | None = None) -> dict[str, Any]:
        if not self._api_key:
            raise AINotConfigured()
        url = f"{self.base_url}{path}"
        attempt = 0
        delay = 1.0
        deadline = time.monotonic() + self.timeout * 1.5 + 10.0  # hard budget across retries
        timeout = httpx.Timeout(connect=8.0, read=self.timeout, write=10.0, pool=5.0)
        while True:
            attempt += 1
            try:
                async with httpx.AsyncClient(timeout=timeout) as client:
                    resp = await client.request(method, url, headers=self._headers(), json=json_body)
            except httpx.ConnectError as exc:
                # unreachable host / DNS / TLS handshake – retry once at most
                if attempt <= 1 and time.monotonic() < deadline:
                    await asyncio.sleep(delay)
                    continue
                raise AIUnavailable(f"connection error: {type(exc).__name__}") from exc
            except httpx.TimeoutException as exc:
                if attempt <= self.max_retries and time.monotonic() < deadline:
                    await asyncio.sleep(delay)
                    delay *= 2
                    continue
                raise AITimeout(f"timeout after {attempt} attempts") from exc
            except httpx.HTTPError as exc:
                if attempt <= self.max_retries and time.monotonic() < deadline:
                    await asyncio.sleep(delay)
                    delay *= 2
                    continue
                raise AIUnavailable(f"network error: {type(exc).__name__}") from exc
            if resp.status_code in (401, 403):
                raise AIAuthError(f"auth error {resp.status_code}")
            if resp.status_code == 429:
                if attempt <= self.max_retries:
                    retry_after = resp.headers.get("retry-after")
                    try:
                        wait = float(retry_after) if retry_after else delay
                    except ValueError:
                        wait = delay
                    await asyncio.sleep(min(wait, 10.0))
                    delay *= 2
                    continue
                raise AIRateLimited("rate limited")
            if resp.status_code >= 500:
                if attempt <= self.max_retries:
                    await asyncio.sleep(delay)
                    delay *= 2
                    continue
                raise AIUnavailable(f"server error {resp.status_code}")
            if resp.status_code >= 400:
                detail = ""
                try:
                    detail = str(resp.json().get("error", {}).get("message") or resp.json().get("detail") or "")[:200]
                except Exception:
                    detail = resp.text[:200]
                raise AIBadResponse(f"HTTP {resp.status_code}: {detail}")
            try:
                return resp.json()
            except ValueError as exc:
                raise AIBadResponse("non-JSON response") from exc

    async def chat(self, messages: list[dict[str, str]], *, temperature: float | None = None,
                   max_tokens: int | None = None, json_mode: bool = False) -> AIResponse:
        if not self.configured:
            raise AINotConfigured()
        settings = get_settings()
        body: dict[str, Any] = {
            "model": self.model,
            "messages": messages,
            "temperature": settings.ai_temperature if temperature is None else temperature,
            "max_tokens": max_tokens or settings.ai_max_output_tokens,
            "stream": False,
        }
        if json_mode:
            body["response_format"] = {"type": "json_object"}
        started = time.monotonic()
        data = await self._request("POST", "/chat/completions", body)
        latency = int((time.monotonic() - started) * 1000)
        try:
            choice = data["choices"][0]
            content = choice["message"]["content"] or ""
            finish = choice.get("finish_reason")
        except (KeyError, IndexError, TypeError) as exc:
            raise AIBadResponse("missing choices/message in response") from exc
        usage = data.get("usage") or {}
        return AIResponse(content=content, model=data.get("model", self.model), provider=self.name,
                          prompt_tokens=usage.get("prompt_tokens"), completion_tokens=usage.get("completion_tokens"),
                          latency_ms=latency, finish_reason=finish, raw={"id": data.get("id")})

    async def list_models(self) -> list[str]:
        data = await self._request("GET", "/models")
        items = data.get("data") or []
        return sorted(str(m.get("id")) for m in items if isinstance(m, dict) and m.get("id"))


def build_provider() -> AIProvider:
    s = get_settings()
    if s.ai_provider == "disabled" or not s.ai_api_key:
        return DisabledProvider()
    return OpenAICompatibleProvider(api_key=s.ai_api_key, base_url=s.ai_base_url, model=s.ai_model,
                                    timeout=s.ai_timeout_seconds, max_retries=s.ai_max_retries)
