# MYCO AI – IoT message contract (schema_version 1)

These JSON Schemas are **generated from the backend's pydantic models**
(`backend/app/schemas/telemetry.py`) by `scripts/export_schemas.py`; the backend
test-suite fails if they drift. The same contract is used by the ESP32 firmware
example (`firmware/esp32/`), the in-process hardware simulator and the HTTP
device transport – so anything that works for the simulator works for a real
device.

| File | MQTT topic | Direction | Purpose |
|------|-----------|-----------|---------|
| `telemetry.v1.schema.json` | `myco/{device_id}/telemetry` | device → backend | periodic sensor sample (QoS 1) |
| `status.v1.schema.json` | `myco/{device_id}/status` | device → backend | retained presence message; publish `offline` as the MQTT last-will |
| `command.v1.schema.json` | `myco/{device_id}/commands` | backend → device | actuator command from the deterministic control service |
| `command-status.v1.schema.json` | `myco/{device_id}/command-status` | device → backend | acknowledgement: `applied`, `rejected` or `failed` |

Every message carries `schema_version`, `device_id`, a unique `message_id`
(commands use `command_id`) and an ISO-8601 `timestamp` **with timezone
offset** (`2026-10-15T08:30:00Z`). Messages whose `schema_version` is unknown
are rejected. The topic prefix (`myco`) is configurable through
`MQTT_TOPIC_PREFIX`.

## Authentication

* **MQTT** – broker credentials (`MQTT_USERNAME/PASSWORD`, optional TLS) plus a
  per-device token. With `MQTT_REQUIRE_DEVICE_TOKEN=true` (default) telemetry
  and command-status payloads must include `"device_token": "<token>"`; the
  backend strips it before storing anything and drops messages whose token does
  not match the device registry (an audit event is written).
* **HTTP** – the same token is sent as the `X-Device-Token` header to
  `POST /api/ingest/telemetry`, `POST /api/ingest/status`,
  `GET /api/ingest/commands` (long-poll replacement: devices poll) and
  `POST /api/ingest/command-status`. The authenticated device may only post
  messages for its own `device_id` (403 otherwise).

Tokens are issued/rotated by an admin in *Device Management* (or
`POST /api/devices/{id}/token`) and only the hash is stored.

## Validation performed by the backend

Schema validation is only the first step. `backend/app/services/validation.py`
then applies configurable plausibility rules (System Settings → *Validation*):

* **Stale / future timestamps** – older than `max_message_age_seconds` (300 s)
  or more than `max_future_skew_seconds` (60 s) in the future → the whole
  message is rejected. Devices without a synchronised clock may send
  `"timestamp": null` (`accept_unsynced_clock`); the backend then stamps the
  arrival time and marks `quality.time = "device_clock_unsynced"`.
* **Hard limits** – a value outside `min/max` (e.g. 75 °C) is implausible: the
  field is stored as `null` with `quality = "invalid"` and ignored by control
  and analytics; the rest of the message is kept.
* **Sensor limits** – values outside the sensor's rated range (DHT11: 0–50 °C,
  20–95 % RH) are stored but flagged `quality = "suspect"`; the control
  service does not act on suspect values.
* **Rate of change** – jumps above `max_step_per_minute` are flagged
  `"suspect"` as well (warning recorded in `quality.warnings`).
* **Duplicates** – a repeated `message_id` for the same device is ignored.
* `sensor_errors: ["dht11"]` (or a field name) with `null` values marks the
  affected fields `"sensor_error"`, plain `null` is `"missing"`. The control
  service treats both as missing and falls back to its safe state after
  `stale_sensor_timeout_seconds`.
* Unknown or disabled devices, bad tokens and unknown `schema_version` values
  are rejected before any of the above.

Rejected messages are not stored as readings; they are logged as system events
(category `validation`) and visible under *Live Monitoring → Rejected messages*.

## Examples

Telemetry (device → backend):

```json
{
  "schema_version": 1,
  "device_id": "myco-esp32-01",
  "message_id": "b3f2a7c0e4d14f0b8c6a1d2e3f405061",
  "timestamp": "2026-10-15T08:30:00Z",
  "uptime_ms": 734812,
  "temperature_c": 24.5,
  "relative_humidity_percent": 88.0,
  "substrate_moisture_raw": 1850,
  "fan_state": false,
  "heater_state": false,
  "humidifier_state": true,
  "sensor_errors": [],
  "firmware_version": "esp32-myco-1.0.0",
  "rssi_dbm": -61,
  "device_token": "mycodev_...   (MQTT only; HTTP uses the X-Device-Token header)"
}
```

Status (retained; the firmware registers the `offline` variant as last-will):

```json
{ "schema_version": 1, "device_id": "myco-esp32-01", "status": "online",
  "timestamp": "2026-10-15T08:29:58Z", "firmware_version": "esp32-myco-1.0.0",
  "ip": "192.168.1.42", "rssi_dbm": -61,
  "local_safety": { "heater_cutoff_c": 32.0, "heater_max_runtime_s": 1800, "command_watchdog_s": 180 } }
```

Command (backend → device):

```json
{ "schema_version": 1, "command_id": "9c1e5c0f3a0b4f7f9d7e2a4c6b8d0e1f",
  "device_id": "myco-esp32-01", "timestamp": "2026-10-15T08:30:05Z",
  "actuator": "heater", "state": true, "origin": "auto",
  "reason": "temperature 19.4 °C below target 20.0 °C", "ttl_seconds": 60 }
```

The device **must** ignore commands older than `ttl_seconds`, must apply its own
safety limits regardless of the command (heater cut-off temperature, maximum
heater runtime) and must answer with a command-status:

```json
{ "schema_version": 1, "device_id": "myco-esp32-01",
  "command_id": "9c1e5c0f3a0b4f7f9d7e2a4c6b8d0e1f", "message_id": "…",
  "timestamp": "2026-10-15T08:30:06Z", "actuator": "heater",
  "requested_state": true, "result_state": true, "status": "applied", "error": null }
```

`status` is `rejected` when the device refused the command (expired TTL, local
safety lock-out → `error: "local_thermal_cutoff"`), `failed` when the relay did
not respond. Until a status arrives the dashboard shows the actuator as
*requested / pending*; after `command_timeout_seconds` (45 s) the command is
marked `timeout` and an alert is raised. The reported `*_state` fields in the
next telemetry message are compared with the last confirmed command – a
mismatch raises an `actuator_mismatch` alert.
