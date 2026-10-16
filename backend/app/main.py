"""FastAPI application factory and lifespan management."""
from __future__ import annotations

import asyncio
import logging
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from . import __version__
from .api import ai, alerts, analytics, auth, batches, control, devices, ingest, predictions, settings as settings_api, simulator as simulator_api, system, telemetry, vision, ws
from .config import get_settings
from .core.events import bus
from .core.logging_config import configure_logging, redact
from .db.migrate import run_migrations
from .db.session import session_scope
from .services.pipeline import pipeline
from .services.seed import bootstrap

log = logging.getLogger(__name__)


async def _periodic(name: str, interval: float, coro_factory) -> None:
    await asyncio.sleep(min(interval, 10.0) + 5.0)  # let transports deliver their first messages
    while True:
        try:
            await coro_factory()
        except asyncio.CancelledError:
            raise
        except Exception:  # pragma: no cover
            log.exception("background task %s failed", name)
        await asyncio.sleep(interval)


@asynccontextmanager
async def lifespan(app: FastAPI):
    settings = get_settings()
    configure_logging(settings.log_level, json_output=settings.app_env == "production")
    log.info("starting %s v%s (%s)", settings.app_name, __version__, settings.app_env)
    bus.bind_loop(asyncio.get_running_loop())

    run_migrations()
    with session_scope() as db:
        bootstrap(db)
        from .services.control import reconcile_after_restart
        n = reconcile_after_restart(db)
        if n:
            log.info("%d command(s) pending at shutdown marked unknown", n)

    tasks: list[asyncio.Task] = []
    mqtt_transport = None
    from .iot.simulator import simulator

    if settings.simulator_enabled:
        await simulator.start()
    if settings.mqtt_enabled:
        from .iot import mqtt as mqtt_module

        mqtt_transport = mqtt_module.MqttTransport()
        mqtt_module.mqtt_transport = mqtt_transport
        mqtt_transport.start(asyncio.get_running_loop())
    if settings.background_tasks_enabled:
        tasks.append(asyncio.create_task(_periodic("control", settings.control_loop_interval_seconds, pipeline.periodic_tick), name="periodic"))
        tasks.append(asyncio.create_task(_periodic("prediction", settings.prediction_interval_seconds, pipeline.prediction_tick), name="prediction"))
    app.state.started = True
    try:
        yield
    finally:
        for t in tasks:
            t.cancel()
        for t in tasks:
            try:
                await t
            except (asyncio.CancelledError, Exception):
                pass
        await simulator.stop()
        if mqtt_transport is not None:
            mqtt_transport.stop()
        log.info("shutdown complete")


def create_app() -> FastAPI:
    settings = get_settings()
    app = FastAPI(
        title="MYCO AI API",
        version=__version__,
        description="AI-powered mushroom cultivation and predictive monitoring platform – backend API.",
        lifespan=lifespan,
        docs_url="/api/docs",
        redoc_url="/api/redoc",
        openapi_url="/api/openapi.json",
    )
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origin_list,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    @app.exception_handler(Exception)
    async def _unhandled(request: Request, exc: Exception):  # pragma: no cover - safety net
        log.exception("unhandled error on %s %s", request.method, request.url.path)
        return JSONResponse(status_code=500, content={"detail": "Internal server error", "hint": redact(type(exc).__name__)})

    for router in (system.router, auth.router, devices.router, telemetry.router, ingest.router, batches.router, control.router,
                   alerts.router, predictions.router, analytics.router, ai.router, settings_api.router, simulator_api.router,
                   vision.router, ws.router):
        app.include_router(router)

    upload_dir = Path(settings.upload_dir)
    upload_dir.mkdir(parents=True, exist_ok=True)
    app.mount("/api/uploads", StaticFiles(directory=str(upload_dir)), name="uploads")

    frontend_dir = Path(settings.frontend_dir) if settings.frontend_dir else None
    frontend_index = frontend_dir / "index.html" if frontend_dir else None
    serve_frontend = bool(frontend_index and frontend_index.is_file())
    if serve_frontend:
        log.info("serving the built webpage from %s", frontend_dir)
        app.mount("/assets", StaticFiles(directory=str(frontend_dir / "assets")), name="webpage-assets")

    @app.get("/", include_in_schema=False)
    def root():
        if serve_frontend:
            return FileResponse(frontend_index, headers={"Cache-Control": "no-cache"})
        return {"app": settings.app_name, "version": __version__, "docs": "/api/docs", "health": "/api/system/health"}

    if serve_frontend:
        # Single-page app: /stats, /predictions and any other page path load index.html; real files
        # (favicon.svg …) are served as-is. API/WS paths are never swallowed – they 404 as JSON.
        @app.get("/{page_path:path}", include_in_schema=False)
        def webpage(page_path: str):
            if page_path in ("api", "ws") or page_path.startswith(("api/", "ws/")):
                return JSONResponse(status_code=404, content={"detail": "Not Found"})
            candidate = (frontend_dir / page_path).resolve()
            if page_path and candidate.is_file() and frontend_dir.resolve() in candidate.parents:
                return FileResponse(candidate)
            return FileResponse(frontend_index, headers={"Cache-Control": "no-cache"})

    return app


app = create_app()
