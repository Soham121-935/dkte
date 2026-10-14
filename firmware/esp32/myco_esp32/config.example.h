// Copy to config.h (git-ignored) and fill in your values. Never commit config.h.
#pragma once

#define WIFI_SSID "your-wifi"
#define WIFI_PASS "your-wifi-password"

// Must match the device registered in MYCO AI -> Device Management.
#define DEVICE_ID "myco-esp32-01"
// Token shown once when the device is created / rotated (Device Management -> Rotate token).
#define DEVICE_TOKEN "mycodev_replace_me"
#define FIRMWARE_VERSION "esp32-myco-1.0.0"

// MQTT broker (e.g. Mosquitto on the same machine as the backend).
#define MQTT_HOST "192.168.1.10"
#define MQTT_PORT 1883
#define MQTT_USER "myco-device"
#define MQTT_PASS "broker-password"
#define TOPIC_PREFIX "myco"   // must equal MQTT_TOPIC_PREFIX in backend/.env
