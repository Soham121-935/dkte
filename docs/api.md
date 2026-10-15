# MYCO AI – REST & WebSocket API

Interactive documentation (Swagger UI) is served by the backend at
`http://localhost:8000/api/docs`, the raw spec at `/api/openapi.json`. This
page summarises the contract, access rules and the non-obvious behaviour. The
backend test `tests/test_ws_schemas_docs.py` fails if a route exists that is
not listed here.

## Conventions

* All timestamps are ISO-8601 in UTC (`2026-10-15T08:30:00+00:00`).
* Time windows: either `range=15m|1h|6h|24h|7d|30d` (default `24h`) or
  `from=<iso>&to=<iso>` (`to` optional, defaults to now; `to` must be after
  `from`, max 366 days) – both return **422** on invalid input.
* Errors use FastAPI's `{"detail": "..."}` (string) or a list of validation
  errors `{"detail": [{"loc": [...], "msg": "..."}]}`.
* `device_id` strings: 3–64 chars `[A-Za-z0-9_-]`.

## Authentication & roles

`POST /api/auth/login` with `{"username","password"}` returns
`{"access_token","token_type":"bearer","user":{id,username,role,...}}`. Send
`Authorization: Bearer <token>` on subsequent requests. Tokens expire after
`ACCESS_TOKEN_MINUTES`; the frontend keeps them in *sessionStorage* only.

| Role | Can |
|---|---|
| *(anonymous)* | read everything when `PUBLIC_READ=true` (default for the prototype); nothing otherwise |
| `viewer` | read everything, chat with the assistant |
| `operator` | + batches/profiles/observations, stage confirmation, control mode + manual commands, control config, alert ack/resolve, simulator scenarios, prediction run |
| `admin` | + users, devices & device tokens, system settings, simulator start/stop, AI diagnostics, delete batches/profiles |

Mutations always require a token even when `PUBLIC_READ=true`. There is no
endpoint that switches a relay without going through the control service's
validation (`/api/control/{device_id}/command` is the only manual path and
needs role `operator` **and** the device in `manual` mode).

Device-facing endpoints (`/api/ingest/*`) use the **per-device token** in the
`X-Device-Token` header instead of a user token.

## Routes

### System
* `GET /api/system/health` – liveness `{status, time, version}` (always public).
* `GET /api/system/status` – mode (`live` / `demo` / `disconnected` with label + detail), devices, open-alert counts, transport/MQTT/simulator/AI/notification status, `public_read`, `open_access` (true = no sign-in; anonymous callers act as a local operator).
* `GET /api/system/events?category=&device_id=&limit=` – audit log (categories: `validation`, `auth`, `control`, `connection`, `alert`, `simulator`, `system`).

### Auth / users
* `POST /api/auth/login`, `GET /api/auth/me`, `POST /api/auth/change-password` `{current_password,new_password}` (min 8 chars).
* `GET /api/auth/users`, `POST /api/auth/users` `{username,password,role}`, `PATCH /api/auth/users/{user_id}` `{role?,is_active?,password?}` – admin. Admins cannot demote or deactivate their own account.

### Devices (admin for writes)
* `GET /api/devices`, `GET /api/devices/{device_id}` – includes `connection_status` (`online|stale|offline|unknown`), `control_mode`, `actuator_state` (`requested` / `confirmed` / `status: confirmed|pending|mismatch|unknown` per actuator), `stats`.
* `POST /api/devices` `{id,name,kind:hardware|simulated,transport:mqtt|http|simulator,hardware_notes?}` → 201 with the **one-time** `token` for hardware devices (409 if id exists).
* `PATCH /api/devices/{device_id}` `{name?,hardware_notes?,is_enabled?,firmware_version?}`.
* `POST /api/devices/{device_id}/token` – rotate token (returned once); `DELETE /api/devices/{device_id}/token` – revoke (device can no longer publish). 422 for simulated devices.
* `GET /api/devices/{device_id}/diagnostics?limit=` – last readings, rejection counts, telemetry age, command statistics, transport info.

### Device ingest (HTTP transport, `X-Device-Token`)
* `POST /api/ingest/telemetry` – body = `TelemetryV1` → 202 `{accepted:true, reading_id, device_id}`; 422 when rejected by validation (reason is logged as a `validation` system event); 403 if `device_id` differs from the token's device.
* `POST /api/ingest/status` – `DeviceStatusV1` (`online|offline`).
* `GET /api/ingest/commands` – pending commands for the device (`{device_id, commands:[CommandV1]}`); they move to `sent`.
* `POST /api/ingest/command-status` – `CommandStatusV1` (`applied|rejected|failed`).
* `GET /api/ingest/commands/recent` – last 20 commands with their states (debugging).

### Telemetry
* `GET /api/telemetry/latest?device_id=` – latest reading + per-sensor values (`sensor_type,value,unit,measured_at,quality,source`) + active targets + staleness flag.
* `GET /api/telemetry/readings?device_id=&range|from/to&limit=` – raw readings (newest first).
* `GET /api/telemetry/series?device_id=&range|from/to&max_points=` – time-bucketed series `{bucket_seconds, n_readings, sources, points[{t, temperature_c, *_min/_max, relative_humidity_percent, substrate_moisture_raw, fan_on_ratio, heater_on_ratio, humidifier_on_ratio, invalid_count, source}], targets}`; `max_points` 20–5000.
* `GET /api/telemetry/export.csv?device_id=&range|from/to` – CSV download (`text/csv`), one row per reading including quality flags.

### Batches, profiles, observations
* `GET /api/profiles`, `GET /api/profiles/{profile_id}` – species profiles with stages (`key,name,typical_days_min/max,targets`) and `source: reference|user`; reference profiles are read-only – clone them.
* `POST /api/profiles`, `PATCH /api/profiles/{profile_id}`, `POST /api/profiles/{profile_id}/clone` `{name?}` – operator; `DELETE /api/profiles/{profile_id}` – admin (409 if used by a batch).
* `GET /api/batches?status=&device_id=`, `GET /api/batches/{batch_id}`.
* `POST /api/batches` `{name,species,strain?,substrate_type?,substrate_details?,inoculation_date?,spawn_details?,profile_id?,device_id?,status?,notes?,initial_stage_key?,target_overrides?}` → 201 (code `B-{year}-{nnn}`); 409 when the device already has an active batch; 422 for future inoculation dates.
* `PATCH /api/batches/{batch_id}` – same fields; `DELETE /api/batches/{batch_id}` – admin.
* `POST /api/batches/{batch_id}/stage` `{stage_key, observed_at?, note?}` – **manual stage confirmation** (records a stage event + observation; stage changes are never automatic).
* `GET /api/batches/{batch_id}/timeline` – `{batch, stages[{index,key,name,state: completed|current|upcoming, started_at, ended_at, typical_days_*, targets,...}], events, estimate}`; the estimate carries an uncertainty label and the basis for it.
* `GET /api/batches/{batch_id}/observations`, `POST /api/batches/{batch_id}/observations` `{kind: note|stage_confirmation|contamination|harvest|measurement|photo, note?, data?, observed_at?}`, `DELETE /api/batches/{batch_id}/observations/{observation_id}`, `POST /api/batches/{batch_id}/observations/{observation_id}/image` (multipart `file`, ≤ 8 MB, JPEG/PNG/WebP; served from `/api/uploads/...`).
* `GET /api/batches/{batch_id}/readings?max_points=` – series for the batch's device limited to the batch period.
* `GET /api/batches/{batch_id}/report` – summary (environment per stage, alerts, actuator runtimes, observations) for the batch.

### Environmental control (operator for writes)
* `GET /api/control/{device_id}` – `{device, mode, modes:[monitor,auto,manual], config, targets (with source), actuators{fan|heater|humidifier:{requested,confirmed,status,last_reason,requested_at}}, last_evaluation, safety, recent_commands}`.
* `POST /api/control/{device_id}/mode` `{mode: monitor|auto|manual}` – leaving `auto`/`manual` while the heater is on issues a `safety` heater-OFF command (fan/humidifier keep their state). Hardware devices without a token cannot be put into an actuating mode (409).
* `POST /api/control/{device_id}/command` `{actuator, state, reason?}` – manual command. Validated by the control service: device must be in `manual` mode (409), online with a fresh reading (422), respects min switching interval, heater absolute maximum and runtime limits (422 with the reason). Returns the command record (`status: pending|sent`).
* `PATCH /api/control/{device_id}/config` – hysteresis, min switching interval, heater runtime/cooldown/absolute max, stale-sensor timeout (ranges in `schemas/api.py`).
* `POST /api/control/{device_id}/evaluate` – run one control evaluation now and return the decision trace.
* `GET /api/control/{device_id}/commands?limit=` – command log (`pending|sent|confirmed|failed|timeout|rejected`, origin `auto|manual|safety`, reason, requested/result state).
* `GET /api/control/{device_id}/events?limit=` – actuator status events (requested vs confirmed transitions).

### Alerts
* `GET /api/alerts?status=active|acknowledged|resolved|open&device_id=&severity=&limit=`.
* `GET /api/alerts/summary` – counts by status / severity + the active thresholds.
* `GET /api/alerts/channels` – in-app / webhook / e-mail channel configuration state (no secrets).
* `POST /api/alerts/{alert_id}/acknowledge` `{note?}`, `POST /api/alerts/{alert_id}/resolve` `{note?}` – operator.

### Predictions
* `GET /api/predictions/forecast?device_id=&window_minutes=` – baseline environmental forecast (trend + persistence blend) with a widening uncertainty band and explicit data-sufficiency notes; `model` names the method.
* `GET /api/predictions/stage?batch_id=` – growth-stage estimate from **confirmed stage + profile day ranges**, with qualitative confidence and the reason (never a biological percentage derived from temperature/RH).
* `GET /api/predictions/anomalies?device_id=&hours=` – rule-based anomalies (`out_of_range, prolonged_deviation, repeated_switching, missing_data, sudden_change, unexpected_actuator_state, stale_data`) and instability windows.
* `GET /api/predictions/recommendations?device_id=` – list of `{key, detected, why, action, confidence, needs_confirmation}`.
* `GET /api/predictions/accuracy?device_id=&days=` – measured forecast error (MAE / within-band rate) from forecasts that were later compared with actual readings; empty until enough evaluated forecasts exist – never fabricated.
* `GET /api/predictions/history?device_id=&batch_id=&kind=&evaluated=&limit=` – stored prediction records (`model_name, model_version, output, uncertainty, evaluated_at, error`).
* `POST /api/predictions/run` – operator: run the prediction cycle now.

### Analytics & reports
* `GET /api/analytics/summary?device_id=&range|from/to` – distributions (bins, percentiles), time outside target range, actuator runtimes/duty cycles, missing-data intervals, data completeness, sources, targets used.
* `GET /api/analytics/periodic?device_id=&period=day|week&range|from/to` – daily/weekly summaries; `GET /api/analytics/periodic.csv` – same as CSV.
* `GET /api/analytics/stage-environment?batch_id=` – environment statistics per confirmed stage of a batch (descriptive only; the response states that no causal claim is made).

### AI assistant
* `GET /api/ai/status` – provider configured?, model, rate limit, usage counters, last error, circuit-breaker state, fallback description. Only a key *hint* (`nvapi-…`) is ever returned.
* `GET /api/ai/suggestions` – suggested questions.
* `GET /api/ai/insight?device_id=&batch_id=&refresh=` – plain-language chamber briefing shown on the home page: `{status: good|watch|attention|unknown, headline, points:[{tone, kind, text}], next_step, data_note, simulated, mode: llm|fallback, label, narrative, model, error, cached, cache_age_seconds, cache_ttl_seconds}`. `status/headline/points/next_step` are always computed deterministically from stored readings, alerts, history and the stage estimate; `narrative` is only present when the provider answered (`mode = llm`) and is labelled as AI-written. Cached per device/batch for 10 minutes (`refresh=true` bypasses the cache; provider calls are rate limited like chat). Without `device_id` the first online device is used.
* `GET /api/ai/conversations?limit=`, `POST /api/ai/conversations` `{title?, device_id?, batch_id?}`, `GET /api/ai/conversations/{conversation_id}`, `DELETE /api/ai/conversations/{conversation_id}` (operator).
* `POST /api/ai/conversations/{conversation_id}/messages` `{content}` (≤ 4000 chars) – the backend gathers context from the database (latest readings with timestamps, targets, batch/stage, alerts, forecast), calls the provider server-side and returns `{..., messages:[...]}`; the assistant reply carries `meta.source = provider|fallback` and the labels *measured / historical / predicted / user-observed / general knowledge*. When the provider is unavailable the deterministic fallback answers from stored data and says so.
* `POST /api/ai/diagnostics` – admin: live connectivity/model check against the configured provider (reports capability detection; never echoes the key).

### Settings (admin for writes)
* `GET /api/settings` – `{sections:{validation, alerts, control_defaults, display}, defaults, runtime}`; runtime shows non-secret configuration only.
* `PATCH /api/settings/{section}` `{value:{...partial...}}` – validated (unknown keys, wrong types, negative durations, inverted ranges → 422); returns the merged section.

### Simulator (demo mode)
* `GET /api/simulator/status` – enabled/running, device id, interval, active scenarios, virtual chamber state.
* `POST /api/simulator/scenario` `{scenario: high_temperature|low_humidity|sensor_fault|device_offline|actuator_failure|watering|recover, duration_minutes?}` – operator; 409 when the simulator is disabled.
* `POST /api/simulator/start`, `POST /api/simulator/stop` – admin.

## WebSocket `/ws/live`

Read-only event stream (JSON text frames `{type, payload, ts}`). Public when
`PUBLIC_READ=true`; otherwise pass the access token as `?token=` (the server
closes with code 4401 if it is missing/invalid). Message types:

| type | payload |
|---|---|
| `hello` | `{message, recent:[last 5 events]}` |
| `ping` | keep-alive every 20 s |
| `telemetry` | `{reading, device}` – stored reading incl. `source` and `quality` |
| `telemetry_rejected` | `{device_id, reason, code}` |
| `device_status` | `{device}` – online/offline transitions |
| `actuator_status` | `{device}` – requested/confirmed changes |
| `command` | `{command, device}` – issued / confirmed / failed / timeout |
| `control` | `{device_id, evaluation, device}` – control decision trace |
| `alert` | `{alert, action: opened|escalated|reopened|resolved|acknowledged}` |
| `prediction` | `{stats}` – a prediction cycle finished |
| `simulator` | `{scenario, status}` |
| `transport` | MQTT/simulator availability changes |

Nothing sent by the client is interpreted.
