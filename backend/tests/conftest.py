"""Shared fixtures for the backend test-suite.

Every test gets a fresh SQLite database in a temporary directory.  The
environment is pinned *before* the application modules are imported so the
real ``backend/.env`` (AI key, data directory, simulator) is never used.
"""
from __future__ import annotations

import os
import tempfile
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Iterator

TMP_ROOT = Path(tempfile.mkdtemp(prefix="myco-tests-"))
os.environ.update(
    {
        "APP_ENV": "test",
        "DATABASE_URL": f"sqlite:///{(TMP_ROOT / 'test.sqlite3').as_posix()}",
        "UPLOAD_DIR": str(TMP_ROOT / "uploads"),
        "SIMULATOR_ENABLED": "false",
        "BACKGROUND_TASKS_ENABLED": "false",
        "DEMO_SEED": "false",
        "MQTT_ENABLED": "false",
        "AI_API_KEY": "",
        "AI_MODEL": "",
        "AI_RATE_LIMIT_PER_MINUTE": "20",
        "JWT_SECRET": "unit-test-secret-not-for-production",
        "ADMIN_USERNAME": "admin",
        "ADMIN_PASSWORD": "admin12345",
        "PUBLIC_READ": "true",
        "OPEN_ACCESS": "false",
        "LOG_LEVEL": "WARNING",
        "NOTIFY_WEBHOOK_URL": "",
        "SMTP_HOST": "",
        "DEVICE_OFFLINE_AFTER_SECONDS": "90",
        "HARDWARE_DEVICE_TOKEN": "",
        "CAMERA_DEVICE_ID": "myco-cam-01",
        "CAMERA_DEVICE_TOKEN": "",
        "CAMERA_TARGET_DEVICE_ID": "",
        "CAMERA_AUTO_INTERVAL_SECONDS": "1800",
        "CAMERA_MIN_INLIERS": "20",
        "CAMERA_AUTO_APPLY": "true",
        "CAMERA_AUTO_MODE": "true",
        "FRONTEND_DIR": "",  # API only in the suite; the webpage folder gets its own test
    }
)

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from app.config import get_settings, reset_settings_cache  # noqa: E402
from app.db.migrate import run_migrations  # noqa: E402
from app.db.session import dispose_engine, get_sessionmaker  # noqa: E402
from app.services.seed import bootstrap  # noqa: E402

UTC = timezone.utc


def _reset_database() -> None:
    dispose_engine()
    reset_settings_cache()
    settings = get_settings()
    assert settings.app_env == "test"
    db_path = Path(settings.database_url.replace("sqlite:///", "", 1))
    for suffix in ("", "-wal", "-shm"):
        p = Path(str(db_path) + suffix)
        if p.exists():
            p.unlink()
    run_migrations()
    from app.ai.service import reset_ai_service
    from app.services.alerts import engine as alert_engine

    alert_engine._pending_since.clear()
    reset_ai_service()
    from app.vision.service import state as camera_state

    camera_state.reset()
    with get_sessionmaker()() as db:
        bootstrap(db)
        db.commit()


@pytest.fixture()
def fresh_db() -> Iterator[None]:
    """A brand new database with admin user, reference profiles and the two default devices."""
    _reset_database()
    yield
    dispose_engine()


@pytest.fixture()
def db(fresh_db):
    session = get_sessionmaker()()
    try:
        yield session
    finally:
        session.close()


@pytest.fixture()
def client(fresh_db) -> Iterator[TestClient]:
    from app.main import create_app

    app = create_app()
    with TestClient(app) as c:
        yield c


# ----------------------------------------------------------------------- helpers
def login(client: TestClient, username: str, password: str) -> dict[str, str]:
    r = client.post("/api/auth/login", json={"username": username, "password": password})
    assert r.status_code == 200, r.text
    return {"Authorization": f"Bearer {r.json()['access_token']}"}


@pytest.fixture()
def admin(client: TestClient) -> dict[str, str]:
    return login(client, "admin", "admin12345")


def create_user(client: TestClient, admin: dict[str, str], username: str, role: str, password: str = "password123") -> dict[str, str]:
    r = client.post("/api/auth/users", json={"username": username, "password": password, "role": role}, headers=admin)
    assert r.status_code == 201, r.text
    return login(client, username, password)


@pytest.fixture()
def operator(client: TestClient, admin: dict[str, str]) -> dict[str, str]:
    return create_user(client, admin, "operator1", "operator")


@pytest.fixture()
def viewer(client: TestClient, admin: dict[str, str]) -> dict[str, str]:
    return create_user(client, admin, "viewer1", "viewer")


def create_hw_device(client: TestClient, admin: dict[str, str], device_id: str = "esp32-test-01", *, transport: str = "http",
                     control_mode: str = "monitor") -> tuple[str, str]:
    """Register a hardware device and issue a token. Returns (device_id, token)."""
    r = client.post("/api/devices", json={"id": device_id, "name": "Test ESP32", "kind": "hardware", "transport": transport,
                                           "control_mode": control_mode}, headers=admin)
    assert r.status_code == 201, r.text
    r = client.post(f"/api/devices/{device_id}/token", headers=admin)
    assert r.status_code == 200, r.text
    return device_id, r.json()["token"]


def telemetry_payload(device_id: str, *, ts: datetime | None = None, **overrides: Any) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "schema_version": 1,
        "device_id": device_id,
        "message_id": uuid.uuid4().hex,
        "timestamp": (ts or datetime.now(UTC)).isoformat(),
        "temperature_c": 22.0,
        "relative_humidity_percent": 88.0,
        "substrate_moisture_raw": 2000,
        "fan_state": False,
        "heater_state": False,
        "humidifier_state": False,
        "firmware_version": "test-1.0",
    }
    payload.update(overrides)
    return payload


def post_telemetry(client: TestClient, token: str, device_id: str, **overrides: Any):
    return client.post("/api/ingest/telemetry", json=telemetry_payload(device_id, **overrides), headers={"X-Device-Token": token})


def seconds_ago(n: float) -> datetime:
    return datetime.now(UTC) - timedelta(seconds=n)
