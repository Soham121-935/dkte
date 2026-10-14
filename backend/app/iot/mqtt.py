"""MQTT transport adapter (paho-mqtt v2).

Topic structure (``MQTT_TOPIC_PREFIX`` defaults to ``myco``)::

    myco/{device_id}/telemetry       device -> backend   TelemetryV1
    myco/{device_id}/status          device -> backend   DeviceStatusV1 (retained, also last-will)
    myco/{device_id}/commands        backend -> device   CommandV1
    myco/{device_id}/command-status  device -> backend   CommandStatusV1

Authentication/authorisation happens at two levels: broker credentials +
ACLs (see docs/HARDWARE_INTEGRATION.md) and – when
``MQTT_REQUIRE_DEVICE_TOKEN`` is on – a per-device token carried in the
payload (``device_token``) that is verified against the device registry and
stripped before anything is stored.
"""
from __future__ import annotations

import asyncio
import json
import logging
import threading
from datetime import datetime, timezone
from typing import Any

from ..config import get_settings
from ..core.events import bus
from ..core.security import hash_token
from ..db.models import Device
from ..db.session import session_scope
from ..schemas.telemetry import CommandV1
from .transport import TransportError, registry

log = logging.getLogger(__name__)


class MqttTransport:
    name = "mqtt"

    def __init__(self) -> None:
        self.settings = get_settings()
        self._client = None
        self._loop: asyncio.AbstractEventLoop | None = None
        self.connected = False
        self.last_error: str | None = None
        self.last_message_at: datetime | None = None
        self.messages_received = 0
        self.messages_rejected = 0
        self.commands_published = 0
        self._lock = threading.Lock()

    # ------------------------------------------------------------ lifecycle
    def start(self, loop: asyncio.AbstractEventLoop) -> None:
        self._loop = loop
        try:
            import paho.mqtt.client as mqtt
        except ImportError:  # pragma: no cover
            self.last_error = "paho-mqtt not installed"
            log.error(self.last_error)
            return
        client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id=self.settings.mqtt_client_id, clean_session=True)
        if self.settings.mqtt_username:
            client.username_pw_set(self.settings.mqtt_username, self.settings.mqtt_password or None)
        if self.settings.mqtt_tls:
            client.tls_set()
        client.on_connect = self._on_connect
        client.on_disconnect = self._on_disconnect
        client.on_message = self._on_message
        client.reconnect_delay_set(min_delay=2, max_delay=60)
        self._client = client
        registry.register(self)
        try:
            client.connect_async(self.settings.mqtt_host, self.settings.mqtt_port, keepalive=30)
            client.loop_start()
            log.info("MQTT client connecting to %s:%s", self.settings.mqtt_host, self.settings.mqtt_port)
        except Exception as exc:  # pragma: no cover - depends on environment
            self.last_error = f"{type(exc).__name__}: {exc}"
            log.error("MQTT connect failed: %s", self.last_error)

    def stop(self) -> None:
        if self._client is not None:
            try:
                self._client.loop_stop()
                self._client.disconnect()
            except Exception:  # pragma: no cover
                pass
        registry.unregister(self.name)
        self.connected = False

    # ------------------------------------------------------------ callbacks
    def _on_connect(self, client, userdata, flags, reason_code, properties=None):  # noqa: ANN001
        if getattr(reason_code, "is_failure", False) or (isinstance(reason_code, int) and reason_code != 0):
            self.connected = False
            self.last_error = f"connect refused: {reason_code}"
            log.error("MQTT %s", self.last_error)
            return
        self.connected = True
        self.last_error = None
        prefix = self.settings.mqtt_topic_prefix
        client.subscribe([(f"{prefix}/+/telemetry", 1), (f"{prefix}/+/status", 1), (f"{prefix}/+/command-status", 1)])
        log.info("MQTT connected; subscribed to %s/+/{telemetry,status,command-status}", prefix)
        bus.publish_threadsafe("transport", {"transport": "mqtt", "connected": True})

    def _on_disconnect(self, client, userdata, flags, reason_code=None, properties=None):  # noqa: ANN001
        self.connected = False
        self.last_error = f"disconnected: {reason_code}"
        log.warning("MQTT %s (auto-reconnect enabled)", self.last_error)
        bus.publish_threadsafe("transport", {"transport": "mqtt", "connected": False, "error": self.last_error})

    def _on_message(self, client, userdata, msg):  # noqa: ANN001
        from ..services.pipeline import pipeline  # late import

        with self._lock:
            self.messages_received += 1
            self.last_message_at = datetime.now(timezone.utc)
        parts = msg.topic.split("/")
        if len(parts) != 3:
            return
        _prefix, device_id, kind = parts
        try:
            payload = json.loads(msg.payload.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            self.messages_rejected += 1
            log.warning("MQTT malformed JSON on %s: %s", msg.topic, exc)
            self._log_rejection(device_id, f"malformed JSON on {kind}: {exc}")
            return
        if not isinstance(payload, dict):
            self.messages_rejected += 1
            self._log_rejection(device_id, f"payload on {kind} is not a JSON object")
            return
        if kind in ("telemetry", "command-status") and self.settings.mqtt_require_device_token:
            token = payload.pop("device_token", None)
            if not self._verify_token(device_id, token):
                self.messages_rejected += 1
                self._log_rejection(device_id, f"device token missing/invalid on {kind}")
                return
        else:
            payload.pop("device_token", None)
        if self._loop is None:
            return
        if kind == "telemetry":
            coro = pipeline.process_telemetry(payload, transport="mqtt", device_id=device_id)
        elif kind == "status":
            coro = pipeline.process_device_status(payload)
        elif kind == "command-status":
            coro = pipeline.process_command_status(payload, device_id=device_id)
        else:
            return
        asyncio.run_coroutine_threadsafe(coro, self._loop)

    def _verify_token(self, device_id: str, token: str | None) -> bool:
        if not token:
            return False
        with session_scope() as db:
            device = db.get(Device, device_id)
            return bool(device and device.token_hash and device.token_hash == hash_token(token))

    def _log_rejection(self, device_id: str, message: str) -> None:
        from ..services.telemetry import log_event

        try:
            with session_scope() as db:
                log_event(db, "validation", message, level="warning", device_id=device_id, data={"transport": "mqtt"})
        except Exception:  # pragma: no cover
            log.exception("failed to log MQTT rejection")

    # ------------------------------------------------------------ transport
    def send_command(self, device: Device, command: CommandV1) -> str:
        if self._client is None or not self.connected:
            raise TransportError(f"MQTT broker not connected ({self.last_error or 'no connection'})")
        topic = f"{self.settings.mqtt_topic_prefix}/{device.id}/commands"
        info = self._client.publish(topic, json.dumps(command.model_dump(mode="json")), qos=1)
        if info.rc != 0:
            raise TransportError(f"MQTT publish failed rc={info.rc}")
        self.commands_published += 1
        return "sent"

    def status(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "available": self.connected,
            "enabled": True,
            "detail": f"{self.settings.mqtt_host}:{self.settings.mqtt_port}" + (" (TLS)" if self.settings.mqtt_tls else ""),
            "connected": self.connected,
            "last_error": self.last_error,
            "last_message_at": self.last_message_at.isoformat() if self.last_message_at else None,
            "messages_received": self.messages_received,
            "messages_rejected": self.messages_rejected,
            "commands_published": self.commands_published,
            "topic_prefix": self.settings.mqtt_topic_prefix,
            "require_device_token": self.settings.mqtt_require_device_token,
        }


mqtt_transport: MqttTransport | None = None


def mqtt_status() -> dict[str, Any]:
    settings = get_settings()
    if not settings.mqtt_enabled:
        return {"name": "mqtt", "enabled": False, "available": False, "connected": False,
                "detail": "MQTT disabled (set MQTT_ENABLED=true and broker settings)", "topic_prefix": settings.mqtt_topic_prefix}
    if mqtt_transport is None:
        return {"name": "mqtt", "enabled": True, "available": False, "connected": False, "detail": "not started"}
    return mqtt_transport.status()
