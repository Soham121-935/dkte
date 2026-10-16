# ESP32 chamber controller firmware

`myco_esp32/myco_esp32.ino` is a complete Arduino sketch for the chamber
controller. It reads the sensors, executes the commands the backend's
deterministic control service issues for the **current growth phase**, and
keeps its own safety logic running even when Wi-Fi or the backend is gone.
It talks plain HTTP to the backend on the same Wi-Fi network – no MQTT broker is
needed for the demo (the MQTT transport still exists on the backend, see
`docs/architecture.md`).

## Pin map (as wired for the demo)

| Function | Part | GPIO | Notes |
|---|---|---|---|
| Temperature / RH | DHT11 data | **4** | 10 kΩ pull-up to 3V3. ±2 °C / ±5 % RH, 0–50 °C, unreliable above ~90 % RH → the backend flags such readings `suspect` and caps every humidity target at 95 % |
| Substrate moisture | analog probe AO | **34** (ADC1_CH6) | input-only pin, max 3.3 V; raw 0–4095 counts, uncalibrated |
| Fan (12 V) | L298N / L293D channel 2 | **IN3 = 26, IN4 = 27, EN2/ENB = 25** | IN3 HIGH + IN4 LOW = run, both LOW = stop; EN2 is driven HIGH (full speed – PWM deliberately avoided, see below). The fan can only move the chamber towards ambient temperature, it is not a cooler |
| Humidifier | USB ultrasonic module via driver PCB | **18** | logic level, active HIGH by default (`HUMIDIFIER_ACTIVE_LOW` in `config.h`). Some driver boards need a pulse on their touch button instead of a level – adapt `setActuator()` |
| Heater | tungsten bulb via relay module IN | **19 (suggested)** | not fixed by the hardware; 19 is free, not a boot-strapping pin and not input-only. Alternatives: 23, 32, 33. Avoid 0 / 2 / 5 / 12 / 15 (boot strapping) and 34–39 (input only). Set `PIN_HEATER_RELAY` and `HEATER_RELAY_ACTIVE_LOW` in `config.h` |

Share GND between the ESP32, the motor driver, the relay module and the
humidifier driver. Power the motor driver's logic from 5 V and the fan from the
12 V rail – never feed 12 V into an ESP32 pin.

**The bulb is a mains / high-current load.** Use an enclosed, correctly rated
relay module, a fuse and an *independent* thermal cut-out in series with the
bulb. Everything in software (local cut-off, runtime cap, backend interlocks)
is the second layer, never the only one.

## What the firmware does

* `POST /api/ingest/status` (`online`) after boot / reconnect, then
  `POST /api/ingest/telemetry` every 5 s and `GET /api/ingest/commands` every
  3 s, all with the per-device token in the `X-Device-Token` header. Payloads
  follow `/schemas/*.v1.schema.json`.
* Applies each command (`set_actuator fan|humidifier|heater on|off`), reads the
  GPIO back and answers with `POST /api/ingest/command-status` – `applied`,
  `rejected` (expired TTL, local safety lock-out) or `failed` (read-back
  mismatch). The dashboard shows requested vs confirmed state separately.
* Sends `timestamp: null` until NTP has synchronised; the backend then uses the
  arrival time and marks the reading `device_clock_unsynced`.
* Local safety, independent of connectivity:
  * heater forced off at ≥ 32 °C or when the DHT11 fails repeatedly,
  * heater runtime capped at 30 min followed by a 5 min cool-down,
  * heater **and humidifier** switched off when no successful backend contact
    for 180 s (watchdog) – the fan keeps its state, which is harmless,
  * safe state (everything off) at boot.
* Nothing in the firmware lets a chat message or the LLM switch a relay – it
  only executes commands that the control service issued and logged.

### Why the fan is not PWM-controlled

The ESP32 Arduino core 2.x and 3.x have incompatible LEDC (PWM) APIs. To keep
the sketch compiling on both, EN2 is simply driven HIGH (full speed) while the
fan runs. If you want speed control, add `ledcAttach`/`ledcWrite` (core 3.x) or
`ledcSetup`/`ledcAttachPin` (core 2.x) on GPIO 25.

## Build & flash

1. Arduino IDE 2.x (or `arduino-cli`) with the **esp32** board package (2.x or 3.x).
2. Libraries: *ArduinoJson* (6.21+ or 7.x), *DHT sensor library* +
   *Adafruit Unified Sensor*.
3. `cp myco_esp32/config.example.h myco_esp32/config.h` and fill in:
   * Wi-Fi credentials,
   * `MYCO_API_URL` = `http://<LAN IP of the computer running the backend>:8000`
     (never `localhost`),
   * `DEVICE_ID` / `DEVICE_TOKEN` = `HARDWARE_DEVICE_ID` / `HARDWARE_DEVICE_TOKEN`
     from `backend/.env` (or a token rotated with `POST /api/devices/{id}/token`),
   * relay polarity and the heater pin if you wired it differently.
4. Select your ESP32 dev board, flash, open the serial monitor at 115200 baud.
   You should see `telemetry 202` lines; the Overview switches from
   *DISCONNECTED* to live readings within a few seconds.

## Backend side

```
# backend/.env
HARDWARE_DEVICE_ID=myco-esp32-01
HARDWARE_DEVICE_TOKEN=<same string as DEVICE_TOKEN in config.h>
SIMULATOR_ENABLED=false
```

Verify the relay wiring with a few *Manual* switches on the Overview and watch
the confirmations arrive, then set the chamber to *Automatic* (the camera does
this itself the first time it recognises a reference card).

## What the firmware does not do

It does not estimate growth phases, does not know the species and holds no
temperature/humidity targets – the backend owns those (`backend/app/vision`
recognises the phase, the profiles hold the ranges, the control service turns
them into commands). There is no CO₂ or light sensor; the camera is the
separate ESP32-CAM board in `../esp32cam`.
