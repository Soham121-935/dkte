"""Transport adapter layer.

The control service never talks to MQTT, HTTP or the simulator directly; it
asks the registry for the transport bound to a device and calls
``send_command``.  Transports return ``"sent"`` (delivered to the device) or
``"queued"`` (waiting for the device to poll) and raise ``TransportError``
when delivery is impossible (e.g. MQTT broker unavailable).
"""
from __future__ import annotations

import logging
from typing import Protocol

from ..db.models import Device
from ..schemas.telemetry import CommandV1

log = logging.getLogger(__name__)


class TransportError(Exception):
    pass


class DeviceTransport(Protocol):
    name: str

    def send_command(self, device: Device, command: CommandV1) -> str: ...

    def status(self) -> dict: ...


class HttpPollTransport:
    """Commands are stored with status ``pending``; devices fetch them via
    ``GET /api/ingest/commands`` and acknowledge via ``POST /api/ingest/command-status``."""

    name = "http"

    def send_command(self, device: Device, command: CommandV1) -> str:
        return "queued"

    def status(self) -> dict:
        return {"name": self.name, "available": True, "detail": "devices poll for queued commands"}


class TransportRegistry:
    def __init__(self) -> None:
        self._transports: dict[str, DeviceTransport] = {"http": HttpPollTransport()}

    def register(self, transport: DeviceTransport) -> None:
        self._transports[transport.name] = transport

    def unregister(self, name: str) -> None:
        self._transports.pop(name, None)

    def get(self, name: str) -> DeviceTransport | None:
        return self._transports.get(name)

    def for_device(self, device: Device) -> DeviceTransport:
        transport = self._transports.get(device.transport)
        if transport is None:
            raise TransportError(f"transport '{device.transport}' is not available for device {device.id}")
        return transport

    def statuses(self) -> list[dict]:
        return [t.status() for t in self._transports.values()]


registry = TransportRegistry()
