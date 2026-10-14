"""Application configuration.

All settings are read from environment variables (and an optional ``.env``
file next to the backend package).  Secrets such as ``AI_API_KEY`` are only
ever read here and are never serialised back to clients or logs.
"""
from __future__ import annotations

from functools import lru_cache
from pathlib import Path
from typing import Literal

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

BACKEND_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = BACKEND_DIR / "data"


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=str(BACKEND_DIR / ".env"),
        env_file_encoding="utf-8",
        extra="ignore",
        case_sensitive=False,
    )

    # ------------------------------------------------------------------ app
    app_name: str = "MYCO AI"
    app_env: Literal["development", "test", "production"] = "development"
    log_level: str = "INFO"
    host: str = "0.0.0.0"
    port: int = 8000
    cors_origins: str = "http://localhost:5173,http://127.0.0.1:5173"
    public_read: bool = True  # allow unauthenticated read-only dashboard access

    # ------------------------------------------------------------- database
    database_url: str = f"sqlite:///{(DATA_DIR / 'myco.sqlite3').as_posix()}"
    db_auto_migrate: bool = True
    upload_dir: str = str(DATA_DIR / "uploads")

    # ----------------------------------------------------------------- auth
    jwt_secret: str = "change-me-development-only"
    jwt_algorithm: str = "HS256"
    access_token_minutes: int = 12 * 60
    admin_username: str = "admin"
    admin_password: str = "admin12345"
    admin_bootstrap: bool = True

    # ------------------------------------------------------------------- AI
    ai_api_key: str = ""
    ai_provider: Literal["openai_compatible", "disabled"] = "openai_compatible"
    ai_base_url: str = "https://integrate.api.nvidia.com/v1"
    ai_model: str = ""
    ai_timeout_seconds: float = 45.0
    ai_max_retries: int = 2
    ai_max_output_tokens: int = 900
    ai_temperature: float = 0.2
    ai_rate_limit_per_minute: int = 20
    ai_enable_json_mode: bool = False  # only enable after verifying model support

    # ------------------------------------------------------------------ IoT
    mqtt_enabled: bool = False
    mqtt_host: str = "localhost"
    mqtt_port: int = 1883
    mqtt_username: str = ""
    mqtt_password: str = ""
    mqtt_tls: bool = False
    mqtt_client_id: str = "myco-backend"
    mqtt_topic_prefix: str = "myco"
    mqtt_require_device_token: bool = True

    # ------------------------------------------------------------ simulator
    simulator_enabled: bool = True
    simulator_device_id: str = "myco-sim-01"
    simulator_interval_seconds: float = 5.0
    simulator_backfill_hours: int = 24 * 7
    simulator_backfill_step_seconds: int = 60
    demo_seed: bool = True
    hardware_device_id: str = "myco-esp32-01"

    # ---------------------------------------------------- background tasks
    background_tasks_enabled: bool = True
    control_loop_interval_seconds: float = 5.0
    prediction_interval_seconds: float = 300.0
    device_offline_after_seconds: int = 90

    # ------------------------------------------------------- notifications
    notify_webhook_url: str = ""
    smtp_host: str = ""
    smtp_port: int = 587
    smtp_username: str = ""
    smtp_password: str = ""
    smtp_from: str = ""
    smtp_to: str = ""

    @field_validator("cors_origins")
    @classmethod
    def _strip(cls, v: str) -> str:
        return v.strip()

    @property
    def cors_origin_list(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]

    @property
    def ai_configured(self) -> bool:
        return bool(self.ai_api_key) and self.ai_provider != "disabled" and bool(self.ai_model)

    @property
    def is_sqlite(self) -> bool:
        return self.database_url.startswith("sqlite")

    @field_validator("database_url")
    @classmethod
    def _resolve_sqlite_path(cls, v: str) -> str:
        """Relative SQLite paths are resolved against the backend directory."""
        if v.startswith("sqlite:///") and not v.startswith("sqlite:////") and ":memory:" not in v:
            rel = v[len("sqlite:///"):]
            if rel.startswith("./") or not rel.startswith("/"):
                return "sqlite:///" + (BACKEND_DIR / rel).resolve().as_posix()
        return v

    @field_validator("upload_dir")
    @classmethod
    def _resolve_upload_dir(cls, v: str) -> str:
        p = Path(v)
        return str(p if p.is_absolute() else (BACKEND_DIR / p).resolve())


@lru_cache
def get_settings() -> Settings:
    return Settings()


def reset_settings_cache() -> None:
    get_settings.cache_clear()
