# Hardware reference & integration

Source of truth: *MYCO AI – Project Concept and Hardware Reference* (PDF in the
repository root). Only the hardware listed there is assumed to exist; the
software does **not** expect CO₂, light or camera sensors.

## Bill of materials and what the software assumes

| Component | Role | Assumptions made in software |
|---|---|---|
| ESP32 dev board | controller, Wi-Fi, MQTT/HTTP client | NTP time; `timestamp: null` accepted when the clock is not synced |
| DHT11 | temperature & relative humidity | 0–50 °C ±2 °C, 20–90 % RH ±5 %; **unreliable at sustained >90 % RH**. Readings above 95 % RH or outside 0–50 °C are stored but flagged `suspect` and never drive control. Humidity targets of 90–95 % therefore come with a "sensor near its limit" caveat in the UI |
| Analog moisture probe (type to be confirmed) | substrate moisture | raw ADC counts 0–4095, **uncalibrated**; shown as "raw", only an optional minimum threshold alert is supported; calibration per substrate type must be done by the grower |
| 12 V DC fan | fresh-air exchange / cooling towards ambient | cannot cool below ambient – the control service only expects the fan to *reduce* temperature when ambient is lower and otherwise relies on FAE cycles |
| Tungsten bulb via relay | heating | treated as a hazard: hysteresis + minimum switching interval, maximum continuous runtime (30 min) + cooldown, absolute cutoff (32 °C), no heating without a fresh valid temperature reading, device-side watchdog; **an independent thermal fuse / cutoff is required in hardware** |
| USB ultrasonic humidifier via driver PCB | humidification | on/off only; some driver boards need a button pulse – adapt the firmware's `setActuator`; "humidifier on but RH not rising" is detected as an anomaly (`actuator_failure` scenario in the simulator) |

Items still to confirm (also listed in the PDF): moisture sensor type and
voltage, fan current/PWM capability, humidifier driver behaviour, relay and
bulb rating, target species.

## Integration steps

1. **Register the device** – *Device Management → Add device* (kind
   `hardware`, transport `mqtt` or `http`). Copy the token shown once.
2. **Firmware** – flash `firmware/esp32/myco_esp32` with your `config.h`
   (Wi-Fi, broker, device id + token). Watch the serial log for `[mqtt]
   connected`.
3. **Broker** – any MQTT 3.1.1 broker (Mosquitto works). Create a user for the
   backend and one for devices. Set `MQTT_ENABLED=true` and the `MQTT_*`
   variables in `backend/.env`, restart the backend. *System status* shows
   `mqtt: connected`.
4. **Verify data** – the device switches to **ONLINE** in the header; *Live
   Monitoring* shows readings tagged *Measured*. Check *Rejected messages* on
   that page if nothing appears (clock skew and token errors are the usual
   causes).
5. **Verify relays safely** – keep control mode `monitor` while wiring. Switch
   to `manual`, send a fan command from *Environmental Control* and confirm the
   dashboard shows *requested → confirmed*. Only then test the heater (with the
   thermal cutoff installed) and the humidifier.
6. **Automatic control** – create a batch with a species profile (targets per
   stage) and assign the device, then set mode `auto`. The decision trace on
   *Environmental Control* explains every command.

## Safety notes

* The backend is not a safety system: Wi-Fi, the broker or the server can
  fail. The firmware keeps its own heater cutoff/runtime limits and shuts the
  heater off when the backend goes silent; the physical thermal fuse is the
  last line of defence.
* Heater commands are rejected when the latest temperature reading is older
  than `stale_sensor_timeout_seconds` (120 s) or missing, when the temperature
  is at/above `heater_absolute_max_temp_c`, during the post-runtime cooldown
  and when the device is offline.
* When a device goes offline the dashboard shows **DISCONNECTED**, automatic
  commands stop, and an alert is raised; the last known actuator state is
  displayed as *unknown* until the device reports again.

## Sensor limitations that shape the product

* Two-point measurements (one T/RH probe, one moisture probe) describe a single
  location in the chamber – gradients are invisible.
* There is no CO₂ or light measurement, so fresh-air-exchange decisions are
  time-based (`fae_cycle_minutes` / `fae_duration_minutes` per stage) and the
  assistant says so when asked about CO₂.
* No camera: growth stages are **confirmed by the grower**; the system only
  estimates "expected window" ranges from the species profile and never
  claims a biological percentage from temperature/humidity.
