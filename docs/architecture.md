# Architecture

```
 ┌──────────────┐   MQTT (myco/<id>/…)   ┌──────────────────────────────────────────────┐
 │  ESP32       │◄──────────────────────►│  backend (FastAPI, Python 3.11)               │
 │  DHT11,      │   or HTTP ingest       │                                              │
 │  moisture,   │   (X-Device-Token)     │  iot/        transport registry, MQTT adapter, │
 │  fan/heater/ │                        │              in-process hardware simulator    │
 │  humidifier  │                        │  services/   validation → telemetry ingest →  │
 └──────────────┘                        │              control (deterministic) → alerts │
                                         │              prediction, analytics, settings  │
 ┌──────────────┐  REST /api + WS /ws    │  ai/         provider adapter + context       │
 │  browser SPA │◄──────────────────────►│              builder + deterministic fallback │
 │  React/Vite  │                        │  db/         SQLAlchemy models, Alembic        │
 └──────────────┘                        └───────────────┬──────────────────────────────┘
                                                         │ SQLite (dev) / PostgreSQL
                                                         ▼
                                                 data/myco.sqlite3
```

## Data flow for one telemetry message

1. **Transport** – MQTT subscriber (`iot/mqtt.py`), HTTP ingest router
   (`api/ingest.py`) or the simulator loop (`iot/simulator.py`) hands a raw
   dict to `services/pipeline.process_telemetry`.
2. **Authentication** – device token (hash compared) / known & enabled device.
3. **Schema** – `schemas/telemetry.TelemetryV1` (versioned, exported to
   `/schemas`).
4. **Validation** – `services/validation.validate_telemetry`: stale/future
   timestamps, duplicate `message_id`, plausibility and sensor-range limits,
   rate of change, sensor error flags. Rejections become `system_events`
   (category `validation`) and a `telemetry_rejected` WebSocket event.
5. **Persist** – append-only `sensor_readings` row (`source`, `quality` JSON,
   raw payload), device `last_telemetry_at` / `connection_status` update,
   actuator state reconciliation (reported `*_state` vs last confirmed command
   → `mismatch` detection).
6. **Control** – `services/control.run_for_device`: evaluates the reading
   against the effective targets (batch override → profile stage → defaults)
   with hysteresis, min switching interval, heater runtime/cooldown, absolute
   maximum, stale-sensor safe state and interlocks; issues commands via the
   transport registry (`auto` mode) or only safety commands (`manual`/
   `monitor`). Every command is persisted (`actuator_commands`) with its
   validation trace and dispatched; confirmations arrive on
   `command-status`.
7. **Alerts** – `services/alerts.AlertEngine.evaluate_reading` (thresholds
   with grace period, sensor faults, rapid rise, fluctuation, actuator
   mismatch, rapid switching) + `evaluate_periodic` (telemetry missing, device
   offline, heater runtime, failed commands). Dedup by rule key + device,
   cooldown, auto-resolve, optional webhook / e-mail notification.
8. **Broadcast** – every step publishes typed events on the in-process bus
   (`core/events.py`) which the `/ws/live` WebSocket streams to the SPA.

Background tasks (`main._periodic`): control loop for devices without fresh
events, command expiry (→ `timeout`), offline detection
(`DEVICE_OFFLINE_AFTER_SECONDS`), periodic alert evaluation, prediction cycle
(`PREDICTION_INTERVAL_SECONDS`) that stores forecasts and later scores them
against actual readings (`predictions.evaluated_at / error`).

## Modules

| Path | Responsibility |
|---|---|
| `backend/app/config.py` | `pydantic-settings` configuration from `.env` (see `.env.example`) |
| `backend/app/db/models.py` | 15 tables: users, devices, sensor_readings, system_events, cultivation_profiles, cultivation_batches, batch_observations, stage_events, predictions, alerts, actuator_commands, actuator_status_events, ai_conversations, ai_messages, app_settings |
| `backend/alembic/` | migrations (`0001_initial_schema`), run automatically at startup (`DB_AUTO_MIGRATE`) |
| `backend/app/services/control.py` | deterministic control service – the **only** code path that creates actuator commands |
| `backend/app/services/prediction.py` | baseline forecasting (trend + persistence blend, widening band), stage estimation from confirmed stages + profile day ranges, rule-based anomaly detection, recommendations, forecast scoring |
| `backend/app/services/analytics.py` | bucketing, distributions, out-of-range time, duty cycles, missing intervals, periodic summaries, CSV |
| `backend/app/ai/` | `provider.py` (OpenAI-compatible chat completions with timeouts/retries/circuit breaker), `context.py` (DB-derived context with timestamps and source labels), `fallback.py` (deterministic answers), `service.py` (rate limiting, usage accounting, conversation persistence) |
| `backend/app/iot/simulator.py` | physics-ish chamber model (ambient diurnal cycle, heater/fan/humidifier effects, substrate drying), scenario injection, history back-fill for demo mode |
| `frontend/src/api` | typed client (`client.ts`), endpoint map, response types derived from live payloads |
| `frontend/src/providers` | theme, auth (JWT in sessionStorage), live WebSocket feed, device selection, toasts |
| `frontend/src/pages` | the ten sections + batch detail |

## Modes

`GET /api/system/status` derives the global mode:

* **LIVE** – at least one hardware device is online.
* **DEMO MODE** – only the simulator is producing data; every reading from it is
  stored with `source = "simulation"` and rendered with a *Simulated* tag.
* **DISCONNECTED** – no device has delivered data recently.

The SPA shows the mode in the header and as a banner; per-device
`connection_status` (online / stale / offline) is shown next to the device
selector and on every page that displays readings.

## Security model

* Roles `viewer < operator < admin` (JWT, PBKDF2 password hashes). Reads are
  public only when `PUBLIC_READ=true` (prototype convenience); all mutations
  need a token. The WebSocket follows the same rule.
* Actuators can only be switched through `services/control.issue_command`,
  which validates against device state, sensor freshness and limits. The REST
  surface exposes it solely via `POST /api/control/{id}/command` (operator,
  device must be in *manual* mode). The AI assistant has no tool that reaches
  the control service.
* Device credentials: per-device tokens, hashed at rest, rotated/revoked by
  admins; MQTT broker credentials in the backend only.
* AI provider key: `AI_API_KEY` in `backend/.env`, used only by
  `ai/provider.py`; never serialised into responses (status exposes a 6-char
  hint), logs are redacted (`core/logging_config.py`), the frontend bundle is
  scanned by tests for key patterns and provider URLs.

## Scaling notes

* SQLite is fine for a single chamber (one reading / 5–10 s). For several
  devices or long retention switch `DATABASE_URL` to PostgreSQL – the models
  avoid SQLite-only features and `sensor_readings` is indexed on
  `(device_id, measured_at)`. Time-series extensions (TimescaleDB hypertable
  on `sensor_readings`) are a drop-in later.
* The event bus is in-process; running several backend workers requires an
  external broker (Redis pub/sub) for WebSocket fan-out – not needed for the
  prototype, so not built.
