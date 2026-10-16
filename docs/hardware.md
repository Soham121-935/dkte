# Hardware reference & integration

Source of truth: *MYCO AI – Project Concept and Hardware Reference* (PDF in the
repository root) plus the parts added for the demonstration build: an
**L298N/L293D-style motor driver** for the fan and an **ESP32-CAM** module.
Only this hardware is assumed to exist; the software does **not** expect CO₂
or light sensors or a better T/RH probe.

## Bill of materials and what the software assumes

| Component | Role | Assumptions made in software |
|---|---|---|
| ESP32 dev board | chamber controller, Wi-Fi, HTTP client (MQTT optional) | NTP time; `timestamp: null` accepted when the clock is not synced |
| DHT11 | temperature & relative humidity | 0–50 °C ±2 °C, 20–90 % RH ±5 %; **unreliable at sustained >90 % RH**. Readings above 95 % RH or outside 0–50 °C are stored but flagged `suspect` and never drive control. Humidity targets are capped at 95 % and the UI says the sensor is near its limit |
| Analog moisture probe (type to be confirmed) | substrate moisture | raw ADC counts 0–4095, **uncalibrated**; shown as "raw", only an optional minimum threshold alert is supported |
| 12 V DC fan via motor driver (channel 2) | fresh-air exchange / cooling towards ambient | on/off at full speed; cannot cool below ambient – the control service only expects the fan to *reduce* temperature when ambient is lower and otherwise relies on timed FAE cycles |
| Tungsten bulb via relay | heating | treated as a hazard: hysteresis + minimum switching interval, maximum continuous runtime (30 min) + cooldown, absolute cutoff (32 °C), no heating without a fresh valid temperature reading, device-side watchdog; **an independent thermal fuse / cutoff is required in hardware** |
| USB ultrasonic humidifier via driver PCB | humidification | on/off only; some driver boards need a button pulse – adapt the firmware's `setActuator`; "humidifier on but RH not rising" is detected as an anomaly |
| ESP32-CAM (AI-Thinker, OV2640) | photographs the grow bag / printed reference card | separate device with its own token; recognises **only the printed reference cards** (QR code first, image features second); its result selects the growth phase, nothing else |

## Chamber controller pin map

| Function | GPIO | Notes |
|---|---|---|
| DHT11 data | 4 | 10 kΩ pull-up to 3V3 |
| Moisture probe AO | 34 | ADC1, input-only, max 3.3 V |
| Fan – motor driver IN3 / IN4 / EN2 | 26 / 27 / 25 | IN3 HIGH + IN4 LOW = run; EN2 HIGH (full speed) |
| Humidifier driver | 18 | logic level, active HIGH by default |
| Heater relay IN | **19 (suggested)** | not dictated by the hardware – free GPIO, not a strapping pin, output-capable. Alternatives 23 / 32 / 33. Do not use 0, 2, 5, 12, 15 (boot strapping) or 34–39 (input-only). Configurable in `firmware/esp32/myco_esp32/config.h` |

Common GND between ESP32, motor driver, relay module and humidifier driver;
12 V only on the motor driver's motor supply, 5 V for its logic.

## How the pieces decide what to do

1. The **species profiles** (`backend/app/services/seed.py`, editable under
   *Profiles*) hold, for each of the three species, the phases and their
   real-world temperature / humidity ranges and fresh-air schedule:

   | Species | Phase | Temp °C | RH % | FAE |
   |---|---|---|---|---|
   | Oyster | colonising | 20–24 | 60–80 | passive |
   | | pinning | 15–20 | 90–95 | 5 min / 30 min |
   | | fruiting | 16–21 | 85–95 | 5 / 20 |
   | | harvest ready | 16–21 | 85–95 | 5 / 20 |
   | Shiitake | colonising | 20–24 | 60–75 | passive |
   | | browning | 20–24 | 60–75 | 5 / 60 |
   | | pinning | 12–18 | 85–95 | 5 / 30 |
   | | fruiting | 14–20 | 80–90 | 5 / 20 |
   | | harvest ready | 14–20 | 80–90 | 5 / 30 |
   | Lion's mane | colonising | 20–24 | 60–75 | passive |
   | | pinning | 18–22 | 90–95 | 5 / 30 |
   | | fruiting | 18–22 | 85–95 | 5 / 20 |
   | | harvest ready | 18–22 | 85–95 | 5 / 20 |

   (RH is capped at 95 % because of the DHT11; the fan cannot cool below
   ambient, so the low ends of the temperature ranges depend on the room.)
2. The **ESP32-CAM** photographs the printed reference card (automatically
   every `CAMERA_AUTO_INTERVAL_SECONDS`, or when *Take a photo now* is pressed
   on the Overview). The backend matches it to a species + phase, sets that
   stage on the chamber's batch and switches the chamber to *Automatic*. A
   grower can still confirm or change the stage by hand.
3. The **control service** turns the current phase's ranges into fan /
   humidifier / heater commands with hysteresis, minimum switching intervals
   and the heater interlocks; the **ESP32** executes and confirms them and keeps
   its own local cut-offs. The AI assistant never touches any of this.

## Integration steps

1. **Tokens** – put the chamber token in `HARDWARE_DEVICE_TOKEN` and the camera
   token in `CAMERA_DEVICE_TOKEN` in `backend/.env` (any long random strings),
   and the same strings in the two firmware `config.h` files.
2. **Firmware** – flash `firmware/esp32/myco_esp32` on the controller and
   `firmware/esp32cam/myco_cam` on the camera (`MYCO_API_URL` = the LAN IP of
   the computer running the backend, never `localhost`).
3. **Verify data** – the Overview switches from **DISCONNECTED** to live
   readings tagged *Measured*; the camera panel shows *online*. If nothing
   appears, `GET /api/system/events?category=validation` lists the reason
   (token, clock skew, schema).
4. **Verify relays safely** – keep the chamber in *Watch only* while wiring.
   Switch to *Manual*, flip the fan from the Overview and confirm the dashboard
   shows *requested → confirmed*. Only then test the heater (with the thermal
   cutoff installed) and the humidifier.
5. **Automatic control** – print `docs/mushroom-reference-cards.pdf`, hold a
   card in front of the camera and press *Take a photo now*. The matched phase
   is applied and the chamber goes to *Automatic*; the decision trace in the
   control panel explains every command.

## Safety notes

* The backend is not a safety system: Wi-Fi or the server can fail. The
  firmware keeps its own heater cutoff/runtime limits and shuts the heater and
  humidifier off when the backend goes silent; the physical thermal fuse is the
  last line of defence.
* Heater commands are rejected when the latest temperature reading is older
  than `stale_sensor_timeout_seconds` (120 s) or missing, when the temperature
  is at/above `heater_absolute_max_temp_c`, during the post-runtime cooldown
  and when the device is offline.
* When a device goes offline the dashboard shows **DISCONNECTED**, automatic
  commands stop and an alert is raised; the last known actuator state is shown
  as *unknown* until the device reports again.

## Sensor limitations that shape the product

* Two-point measurements (one T/RH probe, one moisture probe) describe a single
  location in the chamber – gradients are invisible.
* There is no CO₂ or light measurement, so fresh-air-exchange decisions are
  time-based (`fae_cycle_minutes` / `fae_duration_minutes` per stage).
* The camera recognises the **printed cards**, not real mushrooms. On a live
  grow the stage is still confirmed by the grower; the system never claims a
  biological percentage from temperature/humidity.
