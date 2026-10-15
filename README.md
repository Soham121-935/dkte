# MYCO AI – mushroom cultivation & predictive monitoring

A runnable, production-oriented web application for one small mushroom-growing
chamber built from an **ESP32, a DHT11, an analog substrate-moisture probe, a
12 V fan, a tungsten-bulb heater behind a relay and a USB ultrasonic
humidifier** (see `MYCO_AI_Project_Concept_and_Hardware_Reference.pdf`).

* **Frontend** – React 18 + TypeScript + Vite + Tailwind + Recharts + Lucide,
  dark forest-green/charcoal theme with light mode, responsive, keyboard
  accessible, explicit loading / empty / error / disconnected states.
* **Backend** – FastAPI + SQLAlchemy 2 + Alembic, SQLite by default,
  PostgreSQL by configuration; REST + WebSocket live feed; MQTT adapter and an
  HTTP device transport; deterministic control service; rule-based prediction
  engine; server-side AI assistant adapter with a deterministic fallback.
* **Demo mode** – a built-in hardware simulator produces clearly labelled
  *Simulated* data so every screen works without hardware or an AI key.

Ten sections: Overview · Live Monitoring · Cultivation Batches · Growth
Timeline · AI Predictions · Environmental Control · AI Cultivation Assistant ·
Analytics and Reports · Device Management · System Settings.

**Plain-language first.** The home page draws the chamber as a mushroom:
the *cap* shows the two readings that matter in big type with grower words
(*Just right*, *Air is a bit dry*, …) against the real target band, the
batch's stage stepper (stages change only when you confirm them) and MYCO AI's
one-line briefing with an **Ask MYCO AI what to do** button; the *stem* holds
the humidifier / fan / heater switches, which follow the chamber's confirmed
state and the control mode (Automatic · Manual · Watch only). A floating
**Ask MYCO AI** bubble opens the chat window on every page. Device ids,
message ids, rule keys, model names and controller decision traces stay behind
"technical details" blocks until you switch to the *Detailed* view (header
toggle or System Settings; remembered per browser). Fonts (Figtree, Young
Serif) are bundled – no third-party requests from the browser.

---

## Quick start (development)

Requirements: Python ≥ 3.11, Node ≥ 20 (tested with 3.11 / 22). No Docker or
broker needed for demo mode.

```bash
git clone <this repo> myco-ai && cd myco-ai
scripts/setup.sh                 # venv + pip install, npm install, backend/.env from the example
# edit backend/.env: ADMIN_PASSWORD (≥ 8 chars), optionally AI_API_KEY
scripts/dev.sh                   # backend :8000 + frontend :5173
```

or manually:

```bash
# backend
cd backend
python3 -m venv .venv && .venv/bin/pip install -r requirements-dev.txt
cp .env.example .env             # set JWT_SECRET, ADMIN_PASSWORD, (AI_API_KEY)
.venv/bin/uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload

# frontend (second terminal)
cd frontend
npm install
npm run dev                      # http://localhost:5173 (proxies /api and /ws to :8000)
```

Open http://localhost:5173. The header shows **DEMO MODE** while only the
simulator is running. Sign in with `ADMIN_USERNAME` / `ADMIN_PASSWORD` from
`backend/.env` to change control modes, create batches, trigger simulator
scenarios or edit settings (reading is public by default – `PUBLIC_READ`).

API docs: http://localhost:8000/api/docs

### Tests

```bash
scripts/test.sh                                   # everything below
cd backend && .venv/bin/python -m pytest -q       # 144 backend tests
cd frontend && npm run lint && npm test           # tsc type-check + 52 vitest tests
# optional: render every page against a running backend
cd frontend && MYCO_LIVE_BACKEND=http://127.0.0.1:8000 npx vitest run src/test/live-smoke.test.tsx
```

### Production build

```bash
cd frontend && npm run build                      # -> frontend/dist (static files)
cd backend && APP_ENV=production .venv/bin/uvicorn app.main:app --host 0.0.0.0 --port 8000 --workers 1
```

Serve `frontend/dist` from any static host / reverse proxy and forward
`/api/*` and `/ws/*` to the backend (same origin, so no CORS is needed). Example
nginx:

```nginx
server {
  listen 80;
  root /srv/myco/frontend/dist;
  location / { try_files $uri /index.html; }
  location /api/ { proxy_pass http://127.0.0.1:8000; proxy_set_header Host $host; }
  location /ws/  { proxy_pass http://127.0.0.1:8000; proxy_http_version 1.1;
                   proxy_set_header Upgrade $http_upgrade; proxy_set_header Connection "upgrade"; }
}
```

Production checklist: `APP_ENV=production`, long random `JWT_SECRET`, strong
`ADMIN_PASSWORD`, `PUBLIC_READ=false` unless the dashboard is intentionally
public, HTTPS at the proxy, `DATABASE_URL` pointing at PostgreSQL for more than
one device or long retention (`pip install psycopg[binary]`), run with one
worker (the live event bus is in-process – see `docs/architecture.md`), back up
`backend/data/` (SQLite file + uploaded images). Migrations run automatically at
startup (`DB_AUTO_MIGRATE=true`) or manually with
`cd backend && .venv/bin/alembic upgrade head`.

---

## Configuration (`backend/.env`)

All variables with defaults are documented in `backend/.env.example`. The
important ones:

| Variable | Purpose |
|---|---|
| `APP_ENV` | `development` / `test` / `production` |
| `PUBLIC_READ` | `true` = dashboards readable without login (mutations always need a token) |
| `DATABASE_URL` | `sqlite:///./data/myco.sqlite3` or `postgresql+psycopg://user:pass@host/db` |
| `JWT_SECRET`, `ACCESS_TOKEN_MINUTES` | session tokens |
| `ADMIN_USERNAME`, `ADMIN_PASSWORD` | bootstrap admin (created on first start) |
| `AI_API_KEY`, `AI_BASE_URL`, `AI_MODEL`, `AI_PROVIDER` | server-side AI provider (OpenAI-compatible chat completions; NVIDIA API Catalog by default). **Backend only.** |
| `AI_TIMEOUT_SECONDS`, `AI_MAX_RETRIES`, `AI_RATE_LIMIT_PER_MINUTE`, `AI_MAX_OUTPUT_TOKENS`, `AI_TEMPERATURE`, `AI_ENABLE_JSON_MODE` | adapter behaviour |
| `MQTT_ENABLED`, `MQTT_HOST`, `MQTT_PORT`, `MQTT_USERNAME`, `MQTT_PASSWORD`, `MQTT_TLS`, `MQTT_TOPIC_PREFIX`, `MQTT_REQUIRE_DEVICE_TOKEN` | physical device transport |
| `SIMULATOR_ENABLED`, `SIMULATOR_DEVICE_ID`, `SIMULATOR_INTERVAL_SECONDS`, `SIMULATOR_BACKFILL_HOURS`, `DEMO_SEED` | demo mode (simulated device, demo batch, 7 days of back-filled history) |
| `HARDWARE_DEVICE_ID` | id of the placeholder hardware device created at first start |
| `CONTROL_LOOP_INTERVAL_SECONDS`, `PREDICTION_INTERVAL_SECONDS`, `DEVICE_OFFLINE_AFTER_SECONDS`, `BACKGROUND_TASKS_ENABLED` | background tasks |
| `NOTIFY_WEBHOOK_URL`, `SMTP_*` | optional external alert channels |
| `CORS_ORIGINS`, `UPLOAD_DIR`, `LOG_LEVEL` | misc |

The frontend has **no** environment variables and no secrets
(`frontend/.env.example`). Operational thresholds (validation rules, alert
thresholds, control defaults, display) live in the database and are edited
under *System Settings*.

---

## What is implemented

### Data & devices
* Device registry (hardware / simulated, transport mqtt / http / simulator),
  per-device tokens (hashed, rotate/revoke), diagnostics, enable/disable.
* Versioned message contract (`schemas/*.v1.schema.json`, generated from the
  backend models): telemetry, status, command, command-status on
  `myco/{device_id}/…` topics; the same payloads over HTTP with
  `X-Device-Token`.
* Validation pipeline: schema, device auth, duplicate `message_id`, stale /
  future timestamps, plausibility and sensor-rated ranges, rate of change,
  sensor error flags → per-field `quality`; rejected messages are logged and
  visible in the UI.
* Append-only `sensor_readings` with `source` (`hardware` / `simulation`) and
  per-sensor values (type, value, unit, timestamp, quality, source) exposed by
  the API.
* Global mode (LIVE / DEMO MODE / DISCONNECTED) and per-device
  ONLINE / STALE / DISCONNECTED indicators everywhere readings are shown.

### Cultivation
* Batches (species, strain, substrate, inoculation date, spawn, device, status,
  notes, per-stage target overrides), observations with image upload, history
  of stage events.
* Species profiles (reference profiles for *Pleurotus ostreatus*, *Lentinula
  edodes*, *Hericium erinaceus*, a generic user template, plus user profiles
  via clone/edit) with per-stage targets and typical day ranges; the UI tags every
  target with its origin (batch override / user profile / reference profile /
  system default).
* Growth timeline: stage sequence from the profile, **manual stage
  confirmation**, expected windows and an estimate labelled with uncertainty
  and basis. Stages never advance from the calendar alone and no biological
  percentage is derived from temperature/humidity.

### Monitoring, analytics, alerts
* Live Monitoring with bucketed charts, gap shading, target bands, actuator
  timeline, raw readings, rejected messages, CSV export, time-range presets
  and custom ranges.
* Analytics: distributions, percentiles, time outside range, actuator duty
  cycles, missing-data intervals, data completeness, daily/weekly summaries
  (table + CSV), stage-environment table (descriptive, explicitly non-causal).
* Alerts: configurable thresholds with grace period, sensor faults, rapid
  temperature rise, fluctuation, actuator mismatch, rapid switching, telemetry
  missing, device offline, heater runtime, failed commands; dedup with
  occurrence counts, cooldown, auto-resolve, acknowledge/resolve with roles,
  notification centre + live toasts, webhook / e-mail channels via backend
  credentials.

### Control & safety
* Deterministic control service with modes **monitor / auto / manual**:
  hysteresis, minimum switching interval, maximum heater runtime + cooldown,
  absolute heater cutoff, no heating without a fresh valid temperature,
  stale-sensor safe state, offline → no commands, interlocks, safety commands
  in every mode, heater returned to safe state when leaving an actuating mode.
* Requested vs confirmed vs unknown actuator state, command log with
  validation trace (pending → sent → confirmed / failed / timeout / rejected),
  decision trace per evaluation, auth + authorisation on every control
  endpoint, no public relay endpoint, LLM has no path to actuators.

### Predictions & AI
* Baseline environmental forecast (trend/persistence blend with widening
  band), stage estimate from confirmed stage + profile day ranges with
  qualitative confidence, rule-based anomaly detection, recommendations
  (detected / why / action / confidence / needs confirmation).
* Forecasts are stored and later scored against actual readings; the
  *Accuracy* panel shows measured error only after enough evaluations exist –
  nothing is fabricated.
* AI Cultivation Assistant: server-side adapter (OpenAI-compatible endpoint,
  configurable model, timeouts, retries, rate limit, circuit breaker, usage
  accounting), context built from the database (latest readings with
  timestamps, targets, batch/stage, alerts, forecast), answers labelled
  measured / historical / predicted / user-observed / general knowledge,
  conversation history, suggested questions, markdown rendering, batch/device
  context, explicit **AI unavailable** state with a deterministic fallback that
  answers from stored data.
* Home-page briefing (`GET /api/ai/insight`): status / headline / bullet
  points / next step are always computed deterministically from stored
  readings, alerts, history and the stage estimate; when a provider is
  configured a short narrative is added and labelled *Written by MYCO AI*,
  otherwise the card says *From your data (AI offline)*. Cached 10 min per
  device.
* Floating "Ask MYCO AI" bubble on every page (chat window on desktop, bottom
  sheet on phones) with "Ask MYCO AI about this" shortcuts on alerts,
  recommendations, anomalies, equipment state and batch stage.
* Home page switches: in *Manual* mode an operator can switch the humidifier,
  fan or heater straight from the home page – the request goes through the
  same control service (interlocks, min switching interval, heater cut-off)
  and the switch only shows *Running / Off* once the chamber confirms it. In
  *Automatic* / *Watch only* mode the switches explain what to do instead of
  sending anything.

### Platform
* Users with roles viewer / operator / admin, settings UI with validation,
  system events audit log, simulator scenario panel, ESP32 firmware example
  with local safety logic, API docs, JSON schemas, tests.

---

## Feature status

| Status | Features |
|---|---|
| **Works out of the box (demo mode)** | all ten sections, simulator with scenarios (high temperature, low humidity, sensor fault, device disconnect, actuator failure, watering, recovery), 7 days of back-filled simulated history, batches/profiles/timeline, alerts, analytics, predictions, control loop against the simulated device, deterministic assistant fallback |
| **Credential-gated** | LLM answers in the assistant (`AI_API_KEY` + reachable provider – verify with *Settings → AI diagnostics*); webhook / e-mail alert channels (`NOTIFY_WEBHOOK_URL`, `SMTP_*`); MQTT broker login |
| **Hardware-gated** | LIVE mode, *Measured* readings, real relay confirmations – require the ESP32 (or `scripts/http_device.py` for a software stand-in over the HTTP transport); moisture calibration; humidifier driver behaviour |
| **Simulated** | everything produced by `myco-sim-01`: physics-style chamber model, not a real sensor. Always tagged *Simulated* / DEMO MODE |

The NVIDIA API key supplied for this project was configured in `backend/.env`
but **could not be verified** from the build environment (no outbound network
to the provider). The adapter follows the documented OpenAI-compatible NIM
API; run *System Settings → AI diagnostics* (admin) to verify key, model name
and capabilities before relying on it. Until then the assistant uses the
deterministic fallback and says so.

---

## Hardware integration

See `docs/hardware.md` (BOM, assumptions, safety) and `firmware/esp32/README.md`
(flashing, broker, topics). Short version:

1. *Device Management → Add device* (kind hardware, transport mqtt or http) →
   copy the one-time token.
2. Flash `firmware/esp32/myco_esp32` with `config.h` (Wi-Fi, broker, device id,
   token) – or run `python3 scripts/http_device.py --device-id … --token …`
   to exercise the HTTP path without hardware.
3. `MQTT_ENABLED=true` + broker settings in `backend/.env`, restart.
4. Keep the device in *monitor* while wiring, test relays in *manual*, then
   switch to *auto* with a batch assigned.

---

## Security

* Secrets only in `backend/.env` (git-ignored); `.env.example` contains
  placeholders. The AI key is never sent to the browser, never stored in
  localStorage, never logged (log redaction) and never returned by the API
  (only a 6-character hint). Tests scan the frontend for key patterns and
  provider URLs.
* JWT sessions (PBKDF2 password hashing), roles enforced server-side; the
  session token is kept in `sessionStorage` and dropped on 401.
* Devices authenticate with per-device tokens (hashed at rest); MQTT payloads
  with a wrong token are discarded and audited.
* Control endpoints require operator role and go through the control service's
  validation; the WebSocket is read-only.
* Rate limiting and a circuit breaker protect the AI provider; uploads are
  type/size checked.

---

## Known limitations

* Single DHT11 + one moisture probe: coarse accuracy (±2 °C, ±5 % RH), RH
  readings above ~90 % are unreliable, moisture is uncalibrated raw ADC. No
  CO₂, light or camera, so FAE is time-based and growth stages must be
  confirmed by the grower.
* The forecast is a statistical baseline (trend + persistence), not a trained
  model; stage estimates come from profile day ranges and confirmed stages.
  Accuracy numbers appear only once forecasts have been scored against actual
  readings.
* The in-process event bus and simulator mean the backend should run as one
  process; horizontal scaling needs an external pub/sub.
* SQLite is sufficient for one chamber; switch to PostgreSQL for several
  devices or long retention.
* The ESP32 sketch is a reference implementation and was not flashed on
  hardware here; adapt relay polarity and humidifier triggering to your boards.
* Provider capabilities (streaming, JSON mode, tool calling) are not assumed –
  the adapter uses plain chat completions and the diagnostics endpoint reports
  what the configured model supports.
* Browser e2e tests run in jsdom (fixture-backed and live-backend harness), not
  in a real browser.

## Future improvements

* Additional sensors once available (CO₂ for FAE control, light, better T/RH
  sensor such as SHT31) – the telemetry schema already allows extra fields.
* Camera-based observations and image timeline per batch.
* Learned per-chamber thermal model for the forecast; yield tracking per batch
  to correlate environment and outcome across many batches.
* Multi-chamber dashboards, PostgreSQL/Timescale deployment profile, Redis
  pub/sub for multi-worker WebSocket fan-out.
* Push notifications (Telegram/Slack) as additional alert channels.
* OTA firmware updates and device-side configuration from the dashboard.

## Repository layout

```
backend/        FastAPI app, services, AI adapter, IoT transports, Alembic, tests
frontend/       React/TypeScript SPA, vitest tests, recorded API fixtures
schemas/        JSON Schemas for the IoT contract (+ README with topics/auth)
firmware/esp32/ reference Arduino sketch with local safety logic
docs/           api.md, architecture.md, hardware.md
scripts/        setup.sh, dev.sh, test.sh, export_schemas.py, http_device.py
```
