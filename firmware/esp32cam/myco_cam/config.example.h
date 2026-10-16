// Copy to config.h (git-ignored) and fill in your values. Never commit config.h.
#pragma once

#define WIFI_SSID "your-wifi"
#define WIFI_PASS "your-wifi-password"

// LAN address of the computer running the MYCO AI backend – never localhost/127.0.0.1.
#define MYCO_API_URL "http://192.168.1.20:8000"

// Must match CAMERA_DEVICE_ID / CAMERA_DEVICE_TOKEN in backend/.env (or a token rotated with `POST /api/devices/{id}/token`).
#define DEVICE_ID "myco-cam-01"
#define DEVICE_TOKEN "mycocam_replace_me"

#define USE_FLASH_LED 1                 // on-board white LED (GPIO 4) lights up while taking the picture
#define CAPTURE_FRAME_SIZE FRAMESIZE_SVGA
#define CAPTURE_JPEG_QUALITY 12
