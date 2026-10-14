# ESP32 reference firmware

`myco_esp32/myco_esp32.ino` is a complete Arduino sketch that speaks the
schema-v1 contract in `/schemas` over MQTT and implements **device-side safety
logic** that works without the backend. It targets exactly the hardware from
the project concept document:

| Function | Part | GPIO | Notes |
|---|---|---|---|
| Temperature / RH | DHT11 | 4 | ±2 °C, ±5 % RH, 0–50 °C, unreliable above ~90 % RH – readings outside the rated range are flagged `suspect` by the backend |
| Substrate moisture | analog probe (type to be confirmed) | 34 (ADC1) | raw 0–4095 counts, uncalibrated; calibrate per substrate in the dashboard |
| Fan | 12 V DC fan via MOSFET/relay | 26 | can only move towards ambient temperature, no active cooling |
| Heater | tungsten bulb via relay | 27 | **requires an independent thermal fuse / cutoff** – software limits are a second layer only |
| Humidifier | USB ultrasonic module via driver PCB | 25 | some driver boards need a pulse on the touch button instead of a level – adapt `setActuator` |

Relay polarity: set `RELAY_ON/RELAY_OFF` for active-low relay boards.

## What the firmware does

* Publishes `telemetry` every 10 s (QoS 1) and a retained `status` every 60 s;
  the broker publishes the registered last-will (`status: offline`) if the
  device drops – the dashboard then shows **DISCONNECTED** and the backend
  stops issuing automatic commands.
* Subscribes to `myco/<device_id>/commands`, applies commands from the
  backend's deterministic control service and answers every command on
  `command-status` with `applied`, `rejected` (expired TTL, local safety
  lock-out) or `failed` (GPIO read-back mismatch).
* Sends `timestamp: null` until NTP has synchronised; the backend then uses
  the arrival time and marks the reading `device_clock_unsynced`.
* Local safety, independent of connectivity:
  * heater forced off at ≥ 32 °C or when the DHT11 fails 3× in a row,
  * heater runtime capped at 30 min followed by a 5 min cooldown,
  * heater switched off when no backend contact for 180 s (watchdog),
  * safe state (all relays off) at boot.
* Never exposes a way for anything but the backend command topic to switch a
  relay. The AI assistant has no path to the device.

## Build

1. Arduino IDE 2.x (or `arduino-cli`) with the **esp32** board package.
2. Libraries: *PubSubClient* (Nick O'Leary), *ArduinoJson* (≥ 6.21 / 7.x),
   *DHT sensor library* + *Adafruit Unified Sensor*.
3. `cp myco_esp32/config.example.h myco_esp32/config.h` and fill in Wi-Fi,
   broker and the device token (create the device under *Device Management*,
   the token is shown once).
4. Select your ESP32 board, flash, open the serial monitor at 115200 baud.

## Backend side

```
# backend/.env
MQTT_ENABLED=true
MQTT_HOST=<broker>
MQTT_USERNAME=myco-backend
MQTT_PASSWORD=...
MQTT_REQUIRE_DEVICE_TOKEN=true
```

The device appears in *Device Management*; switch its control mode from
*monitor* to *auto* once you have verified relay wiring with a few *manual*
commands and watched the confirmations arrive.

## HTTP instead of MQTT

The same payloads can be sent to the HTTP ingest endpoints with the token in
the `X-Device-Token` header (see the comment block at the end of the sketch and
`docs/api.md`). Commands are then fetched by polling `GET /api/ingest/commands`.

## Not implemented on purpose

No CO₂, light or camera sensors – they are not part of the hardware set. The
firmware does not estimate growth stages; it only reports measurements.
