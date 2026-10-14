"""In-process event bus used to fan live updates out to WebSocket clients
and to let background services react to telemetry without tight coupling.

Publishing is thread-safe: background threads (e.g. the MQTT client) call
``publish_threadsafe`` which schedules delivery on the asyncio loop.
"""
from __future__ import annotations

import asyncio
import logging
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Awaitable, Callable

log = logging.getLogger(__name__)

Handler = Callable[["Event"], Awaitable[None] | None]


@dataclass
class Event:
    type: str
    payload: dict[str, Any]
    created_at: datetime = field(default_factory=lambda: datetime.now(timezone.utc))

    def to_dict(self) -> dict[str, Any]:
        return {"type": self.type, "payload": self.payload, "ts": self.created_at.isoformat()}


class EventBus:
    def __init__(self) -> None:
        self._handlers: dict[str, list[Handler]] = defaultdict(list)
        self._queues: set[asyncio.Queue[Event]] = set()
        self._loop: asyncio.AbstractEventLoop | None = None
        self.history: list[Event] = []

    def bind_loop(self, loop: asyncio.AbstractEventLoop) -> None:
        self._loop = loop

    def subscribe(self, event_type: str, handler: Handler) -> None:
        self._handlers[event_type].append(handler)

    def unsubscribe(self, event_type: str, handler: Handler) -> None:
        if handler in self._handlers.get(event_type, []):
            self._handlers[event_type].remove(handler)

    def open_queue(self, maxsize: int = 500) -> asyncio.Queue[Event]:
        q: asyncio.Queue[Event] = asyncio.Queue(maxsize=maxsize)
        self._queues.add(q)
        return q

    def close_queue(self, q: asyncio.Queue[Event]) -> None:
        self._queues.discard(q)

    async def publish(self, event_type: str, payload: dict[str, Any]) -> Event:
        event = Event(type=event_type, payload=payload)
        self.history.append(event)
        if len(self.history) > 200:
            del self.history[: len(self.history) - 200]
        for handler in list(self._handlers.get(event_type, [])) + list(self._handlers.get("*", [])):
            try:
                result = handler(event)
                if asyncio.iscoroutine(result):
                    await result
            except Exception:  # pragma: no cover - defensive
                log.exception("event handler failed for %s", event_type)
        for q in list(self._queues):
            if q.full():
                try:
                    q.get_nowait()
                except asyncio.QueueEmpty:
                    pass
            q.put_nowait(event)
        return event

    def publish_threadsafe(self, event_type: str, payload: dict[str, Any]) -> None:
        if self._loop is None or self._loop.is_closed():
            log.debug("event loop not bound; dropping event %s", event_type)
            return
        asyncio.run_coroutine_threadsafe(self.publish(event_type, payload), self._loop)


bus = EventBus()
