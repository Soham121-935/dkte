"""Alert notification channels.

In-app notifications are always delivered through the event bus.  Optional
outbound channels (webhook, SMTP e-mail) are configured exclusively through
backend environment variables – credentials never reach the frontend.
"""
from __future__ import annotations

import asyncio
import json
import logging
import smtplib
from email.message import EmailMessage
from typing import Any

import httpx

from ..config import get_settings

log = logging.getLogger(__name__)

SEVERITY_RANK = {"info": 1, "warning": 2, "critical": 3}


def channels_status() -> list[dict[str, Any]]:
    s = get_settings()
    return [
        {"name": "in_app", "enabled": True, "detail": "Notification centre + live WebSocket events"},
        {"name": "webhook", "enabled": bool(s.notify_webhook_url), "detail": "NOTIFY_WEBHOOK_URL" + (" configured" if s.notify_webhook_url else " not set")},
        {"name": "email", "enabled": bool(s.smtp_host and s.smtp_to), "detail": "SMTP_* variables" + (" configured" if s.smtp_host and s.smtp_to else " not set")},
    ]


def _send_webhook(url: str, payload: dict[str, Any]) -> None:
    try:
        with httpx.Client(timeout=5.0) as client:
            client.post(url, json=payload)
    except Exception as exc:  # pragma: no cover - network
        log.warning("webhook notification failed: %s", type(exc).__name__)


def _send_email(subject: str, body: str) -> None:
    s = get_settings()
    try:
        msg = EmailMessage()
        msg["Subject"] = subject
        msg["From"] = s.smtp_from or s.smtp_username
        msg["To"] = s.smtp_to
        msg.set_content(body)
        with smtplib.SMTP(s.smtp_host, s.smtp_port, timeout=10) as server:
            server.starttls()
            if s.smtp_username:
                server.login(s.smtp_username, s.smtp_password)
            server.send_message(msg)
    except Exception as exc:  # pragma: no cover - network
        log.warning("email notification failed: %s", type(exc).__name__)


async def dispatch_external(alert: dict[str, Any], min_severity: str = "warning") -> None:
    """Fire-and-forget delivery to external channels (never blocks the pipeline)."""
    s = get_settings()
    if SEVERITY_RANK.get(alert.get("severity", "info"), 0) < SEVERITY_RANK.get(min_severity, 2):
        return
    loop = asyncio.get_running_loop()
    if s.notify_webhook_url:
        loop.run_in_executor(None, _send_webhook, s.notify_webhook_url, {"event": "alert", "alert": alert})
    if s.smtp_host and s.smtp_to:
        subject = f"[MYCO AI] {alert.get('severity', '').upper()}: {alert.get('title')}"
        body = json.dumps(alert, indent=2, default=str)
        loop.run_in_executor(None, _send_email, subject, body)
