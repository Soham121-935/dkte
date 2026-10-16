// Copy to config.h (git-ignored) and fill in your values. Never commit config.h.
#pragma once

#define WIFI_SSID "your-wifi"
#define WIFI_PASS "your-wifi-password"

// LAN address of the computer running the MYCO AI backend – never localhost/127.0.0.1.
// Find it with `ipconfig` (Windows) / `ip a` (Linux, macOS: ifconfig). Example: http://192.168.1.20:8000
#define MYCO_API_URL "http://192.168.1.20:8000"

// Must match the hardware device registered in MYCO AI (HARDWARE_DEVICE_ID in backend/.env).
#define DEVICE_ID "myco-esp32-01"
// Either the value of HARDWARE_DEVICE_TOKEN in backend/.env, or the token shown once when you
// rotate it with POST /api/devices/<id>/token (admin token).
#define DEVICE_TOKEN "mycodev_replace_me"
#define FIRMWARE_VERSION "esp32-myco-http-2.0.0"

// Relay / driver polarity. Most opto-isolated 1-channel relay modules switch ON when the IN pin is LOW.
#define HEATER_RELAY_ACTIVE_LOW 0
#define HUMIDIFIER_ACTIVE_LOW 0
// Heater relay signal pin (default 19). Alternatives: 23, 32, 33.
#define PIN_HEATER_RELAY 19
