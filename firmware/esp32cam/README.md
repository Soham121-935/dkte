# ESP32-CAM phase camera firmware

`myco_cam/myco_cam.ino` runs on an **AI-Thinker ESP32-CAM** module. It is a
second, separate device: it only takes pictures. It has no actuators and no way
to switch anything – recognising the phase happens on the backend, and the
deterministic control service then drives the chamber controller
(`../esp32`) to that phase's temperature / humidity ranges.

## Flow

```
every 3 s        GET  /api/vision/pending        (X-Device-Token)
                 -> {capture_now, trigger, target_device_id, auto_interval_seconds}

capture_now      ("Take a photo now" on the Overview)  – or –
auto interval    (CAMERA_AUTO_INTERVAL_SECONDS, default 30 min, set by the backend)
                 POST /api/vision/capture?trigger=manual|auto&device_id=<target>
                 body = raw JPEG (Content-Type: image/jpeg)
                 -> {id, status, card_key, confidence, applied, message}
```

The backend reads the card's **QR code** first (always reliable on a printout),
falls back to **image-feature matching** against the reference pictures when
the QR is not visible, maps the card to a species + phase, sets that stage on
the chamber's batch (creating the batch if needed) and switches the chamber to
*Automatic*. The result, the photo and the matched card show up on the
Overview's *Chamber camera* panel within a second (WebSocket `camera_capture`).

The recogniser only knows the printed reference cards
(`docs/mushroom-reference-cards.pdf`, served at `/api/vision/reference.pdf`).
It is **not** a general mushroom classifier.

## Hardware

* AI-Thinker ESP32-CAM with OV2640, PSRAM enabled.
* 5 V supply that can deliver ≥ 500 mA (brown-outs show up as random resets
  while the flash LED is on).
* Programming: FTDI/USB-serial adapter on U0R/U0T, **GPIO 0 tied to GND**
  while uploading, then reset. Some carrier boards (ESP32-CAM-MB) do this
  for you over USB.
* On-board white flash LED on GPIO 4 (`USE_FLASH_LED`), red status LED on
  GPIO 33 (active LOW – blinks while polling, solid while uploading).
* Mount the camera 20–40 cm from where the printed card / grow bag sits, in
  decent light; the picture is 800×600 JPEG (`CAPTURE_FRAME_SIZE`,
  `CAPTURE_JPEG_QUALITY` in `config.h`).

All camera-interface GPIOs (0, 5, 18, 19, 21–23, 25–27, 32, 34–36, 39) are taken
by the sensor; that is why the chamber controller is a separate ESP32.

## Build & flash

1. Arduino IDE 2.x with the **esp32** board package. Board: *AI Thinker
   ESP32-CAM*, partition scheme *Huge APP (3 MB No OTA)*, PSRAM *enabled*.
2. Library: *ArduinoJson* (6.21+ or 7.x). Everything else (`esp_camera`,
   `WiFi`, `HTTPClient`) ships with the core.
3. `cp myco_cam/config.example.h myco_cam/config.h` and fill in Wi-Fi,
   `MYCO_API_URL` (LAN IP of the backend, never `localhost`), and
   `DEVICE_ID` / `DEVICE_TOKEN` = `CAMERA_DEVICE_ID` / `CAMERA_DEVICE_TOKEN`
   from `backend/.env`.
4. Flash, remove the GPIO 0 jumper, reset, open the serial monitor at 115200
   baud. The Overview's camera panel changes from *camera offline* to *online*
   on the first successful poll.

## Backend side

```
# backend/.env
CAMERA_DEVICE_ID=myco-cam-01
CAMERA_DEVICE_TOKEN=<same string as DEVICE_TOKEN in config.h>
CAMERA_TARGET_DEVICE_ID=            # empty = the hardware chamber (HARDWARE_DEVICE_ID)
CAMERA_AUTO_INTERVAL_SECONDS=1800   # automatic photo interval sent to the camera
CAMERA_AUTO_APPLY=true              # apply sure / fairly-sure matches to the batch stage
CAMERA_AUTO_MODE=true               # switch the chamber to Automatic when a phase is applied
CAMERA_MIN_INLIERS=20               # feature-match threshold below which a photo is "no match"
```

## No camera at hand?

The Overview panel also has *Upload a photo* – it accepts a phone photo (or a
file) and runs exactly the same recognition path, so the demo flow can be
shown without the ESP32-CAM. Uploads are labelled `source: upload` and are
never presented as camera captures.
