"""WebSocket live feed: pushes every event from the in-process bus.

Read access follows the same rule as the REST API: public when
``PUBLIC_READ=true``, otherwise a valid access token must be supplied as the
``token`` query parameter (``/ws/live?token=...``). The socket is read-only –
nothing a client sends is interpreted as a command.
"""
from __future__ import annotations

import asyncio
import json
import logging

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from ..config import get_settings
from ..core.events import bus
from ..core.security import decode_access_token
from ..db.models import User
from ..db.session import get_sessionmaker

log = logging.getLogger(__name__)
router = APIRouter()


def _authorised(token: str | None) -> bool:
    if get_settings().public_read:
        return True
    if not token:
        return False
    payload = decode_access_token(token)
    if not payload or not str(payload.get("sub", "")).isdigit():
        return False
    with get_sessionmaker()() as db:
        user = db.get(User, int(payload["sub"]))
        return bool(user and user.is_active)


@router.websocket("/ws/live")
async def live(ws: WebSocket) -> None:
    if not _authorised(ws.query_params.get("token")):
        # 4401 mirrors HTTP 401; the browser client shows "feed offline" and keeps polling.
        await ws.close(code=4401, reason="Authentication required")
        return
    await ws.accept()
    queue = bus.open_queue()
    try:
        await ws.send_text(json.dumps({"type": "hello", "payload": {"message": "connected", "recent": [e.to_dict() for e in bus.history[-5:]]}}))
        while True:
            try:
                event = await asyncio.wait_for(queue.get(), timeout=20.0)
                await ws.send_text(json.dumps(event.to_dict(), default=str))
            except asyncio.TimeoutError:
                await ws.send_text(json.dumps({"type": "ping", "payload": {}}))
    except WebSocketDisconnect:
        pass
    except Exception as exc:  # pragma: no cover - client went away
        log.debug("websocket closed: %s", exc)
    finally:
        bus.close_queue(queue)
