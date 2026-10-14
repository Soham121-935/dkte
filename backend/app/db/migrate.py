"""Run Alembic migrations programmatically at startup."""
from __future__ import annotations

import logging
from pathlib import Path

from alembic import command
from alembic.config import Config

from ..config import BACKEND_DIR, get_settings
from .base import Base
from .session import get_engine

log = logging.getLogger(__name__)


def alembic_config() -> Config:
    cfg = Config(str(BACKEND_DIR / "alembic.ini"))
    cfg.set_main_option("script_location", str(BACKEND_DIR / "alembic"))
    cfg.set_main_option("sqlalchemy.url", get_settings().database_url)
    return cfg


def run_migrations() -> None:
    settings = get_settings()
    engine = get_engine()
    if not settings.db_auto_migrate:
        log.info("DB_AUTO_MIGRATE disabled; skipping migrations")
        return
    if settings.app_env == "test":
        Base.metadata.create_all(engine)
        return
    cfg = alembic_config()
    with engine.begin() as connection:
        cfg.attributes["connection"] = connection
        command.upgrade(cfg, "head")
    log.info("database migrations applied (%s)", Path(settings.database_url.replace("sqlite:///", "")).name if settings.is_sqlite else "postgresql")
