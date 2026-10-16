/*
 * MYCO AI – ESP32-CAM phase camera (AI-Thinker module)
 * ---------------------------------------------------------------------------
 * The camera is a *second* device.  It only takes pictures; it has no actuators
 * and no say over any relay.  Flow:
 *
 *   every POLL_INTERVAL_MS:   GET  <MYCO_API_URL>/api/vision/pending   (X-Device-Token)
 *                             -> { capture_now, trigger, target_device_id, auto_interval_seconds }
 *   when capture_now is true  ("Take a photo now" button on the Overview page)
 *   or the auto interval elapsed:
 *                             POST <MYCO_API_URL>/api/vision/capture?trigger=manual|auto&device_id=<target>
 *                             body = raw JPEG, Content-Type: image/jpeg
 *                             -> { id, status, card_key, confidence, applied, message }
 *
 * The backend recognises the printed reference card (QR code first, then image
 * features), maps it to a growth phase and the control service applies that
 * phase's temperature / humidity ranges to the chamber controller.
 *
 * Wiring (AI-Thinker ESP32-CAM): 5 V + GND from a supply that can deliver 500 mA+,
 * programming over an FTDI/USB-serial adapter (U0R/U0T) with GPIO0 tied to GND
 * during upload.  GPIO 4 drives the on-board flash LED (USE_FLASH_LED).
 *
 * Arduino IDE: board "AI Thinker ESP32-CAM", partition scheme "Huge APP",
 * PSRAM enabled.  Libraries: ESP32 core only (esp_camera, WiFi, HTTPClient),
 * ArduinoJson 6/7.  Copy config.example.h to config.h.
 */
#include <WiFi.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>
#include "esp_camera.h"
#include "config.h"

#if ARDUINOJSON_VERSION_MAJOR >= 7
  #define MYCO_JSON_DOCUMENT(name, capacity) JsonDocument name
#else
  #define MYCO_JSON_DOCUMENT(name, capacity) DynamicJsonDocument name(capacity)
#endif

// ----------------------------------------------------------------------------- AI-Thinker pin map
#define PWDN_GPIO_NUM 32
#define RESET_GPIO_NUM -1
#define XCLK_GPIO_NUM 0
#define SIOD_GPIO_NUM 26
#define SIOC_GPIO_NUM 27
#define Y9_GPIO_NUM 35
#define Y8_GPIO_NUM 34
#define Y7_GPIO_NUM 39
#define Y6_GPIO_NUM 36
#define Y5_GPIO_NUM 21
#define Y4_GPIO_NUM 19
#define Y3_GPIO_NUM 18
#define Y2_GPIO_NUM 5
#define VSYNC_GPIO_NUM 25
#define HREF_GPIO_NUM 23
#define PCLK_GPIO_NUM 22
#define FLASH_LED_GPIO 4
#define STATUS_LED_GPIO 33   // red LED on the back, active LOW

#ifndef USE_FLASH_LED
  #define USE_FLASH_LED 1
#endif
#ifndef CAPTURE_FRAME_SIZE
  #define CAPTURE_FRAME_SIZE FRAMESIZE_SVGA   // 800x600 – plenty for QR + feature matching, ~40-60 kB JPEG
#endif
#ifndef CAPTURE_JPEG_QUALITY
  #define CAPTURE_JPEG_QUALITY 12            // 0 (best) .. 63
#endif

static const unsigned long POLL_INTERVAL_MS = 3000;
static const unsigned long WIFI_RETRY_MS = 5000;
static const uint16_t HTTP_TIMEOUT_MS = 8000;
static const unsigned long DEFAULT_AUTO_INTERVAL_MS = 30UL * 60UL * 1000UL;

unsigned long lastPoll = 0, lastAutoCapture = 0, lastWifiAttempt = 0;
unsigned long autoIntervalMs = DEFAULT_AUTO_INTERVAL_MS;
unsigned long pollIntervalMs = POLL_INTERVAL_MS;
bool cameraReady = false;
String targetDevice;

// ----------------------------------------------------------------------------- camera
bool initCamera() {
  camera_config_t config = {};
  config.ledc_channel = LEDC_CHANNEL_0;
  config.ledc_timer = LEDC_TIMER_0;
  config.pin_d0 = Y2_GPIO_NUM;
  config.pin_d1 = Y3_GPIO_NUM;
  config.pin_d2 = Y4_GPIO_NUM;
  config.pin_d3 = Y5_GPIO_NUM;
  config.pin_d4 = Y6_GPIO_NUM;
  config.pin_d5 = Y7_GPIO_NUM;
  config.pin_d6 = Y8_GPIO_NUM;
  config.pin_d7 = Y9_GPIO_NUM;
  config.pin_xclk = XCLK_GPIO_NUM;
  config.pin_pclk = PCLK_GPIO_NUM;
  config.pin_vsync = VSYNC_GPIO_NUM;
  config.pin_href = HREF_GPIO_NUM;
  config.pin_sccb_sda = SIOD_GPIO_NUM;
  config.pin_sccb_scl = SIOC_GPIO_NUM;
  config.pin_pwdn = PWDN_GPIO_NUM;
  config.pin_reset = RESET_GPIO_NUM;
  config.xclk_freq_hz = 20000000;
  config.pixel_format = PIXFORMAT_JPEG;
  config.grab_mode = CAMERA_GRAB_LATEST;   // always deliver a fresh frame, not a stale buffered one
  if (psramFound()) {
    config.frame_size = CAPTURE_FRAME_SIZE;
    config.jpeg_quality = CAPTURE_JPEG_QUALITY;
    config.fb_count = 2;
    config.fb_location = CAMERA_FB_IN_PSRAM;
  } else {
    config.frame_size = FRAMESIZE_VGA;
    config.jpeg_quality = 15;
    config.fb_count = 1;
    config.fb_location = CAMERA_FB_IN_DRAM;
  }
  esp_err_t err = esp_camera_init(&config);
  if (err != ESP_OK) {
    Serial.printf("[cam] init failed 0x%x\n", err);
    return false;
  }
  sensor_t *s = esp_camera_sensor_get();
  if (s) {
    s->set_brightness(s, 0);
    s->set_saturation(s, 0);
    s->set_whitebal(s, 1);
    s->set_awb_gain(s, 1);
    s->set_exposure_ctrl(s, 1);
    s->set_gain_ctrl(s, 1);
    s->set_lenc(s, 1);        // lens correction
    s->set_hmirror(s, 0);
    s->set_vflip(s, 0);
  }
  return true;
}

camera_fb_t *takePicture() {
#if USE_FLASH_LED
  digitalWrite(FLASH_LED_GPIO, HIGH);
  delay(150);
#endif
  // Let auto-exposure settle: throw away two frames, keep the third.
  for (int i = 0; i < 2; i++) {
    camera_fb_t *warm = esp_camera_fb_get();
    if (warm) esp_camera_fb_return(warm);
    delay(80);
  }
  camera_fb_t *fb = esp_camera_fb_get();
#if USE_FLASH_LED
  digitalWrite(FLASH_LED_GPIO, LOW);
#endif
  if (!fb) Serial.println("[cam] capture failed");
  return fb;
}

// ----------------------------------------------------------------------------- HTTP
bool beginRequest(HTTPClient &http, const String &path) {
  if (!http.begin(String(MYCO_API_URL) + path)) return false;
  http.setTimeout(HTTP_TIMEOUT_MS);
  http.setConnectTimeout(HTTP_TIMEOUT_MS);
  http.addHeader("X-Device-Token", DEVICE_TOKEN);
  return true;
}

void uploadCapture(const char *trigger) {
  if (!cameraReady) { Serial.println("[cam] camera not initialised"); return; }
  camera_fb_t *fb = takePicture();
  if (!fb) return;
  digitalWrite(STATUS_LED_GPIO, LOW);   // on while uploading
  HTTPClient http;
  String path = String("/api/vision/capture?trigger=") + trigger;
  if (targetDevice.length()) path += "&device_id=" + targetDevice;
  if (beginRequest(http, path)) {
    http.addHeader("Content-Type", "image/jpeg");
    int code = http.POST(fb->buf, fb->len);
    String reply = code > 0 ? http.getString() : String();
    http.end();
    if (code >= 200 && code < 300) {
      MYCO_JSON_DOCUMENT(doc, 1024);
      if (!deserializeJson(doc, reply)) {
        Serial.printf("[cam] %s capture #%d (%u bytes): %s %s %s applied=%d – %s\n", trigger, (int)(doc["id"] | 0),
                      (unsigned)fb->len, (const char *)(doc["status"] | "?"), (const char *)(doc["card_key"] | "-"),
                      (const char *)(doc["confidence"] | "-"), (int)(doc["applied"] | false), (const char *)(doc["message"] | ""));
      } else {
        Serial.printf("[cam] capture uploaded (%d)\n", code);
      }
    } else {
      Serial.printf("[cam] upload failed (%d) %s\n", code, reply.c_str());
    }
  }
  esp_camera_fb_return(fb);
  digitalWrite(STATUS_LED_GPIO, HIGH);
}

void pollServer() {
  HTTPClient http;
  if (!beginRequest(http, "/api/vision/pending")) return;
  int code = http.GET();
  String body = code > 0 ? http.getString() : String();
  http.end();
  if (code < 200 || code >= 300) {
    Serial.printf("[api] poll failed (%d) %s\n", code, body.c_str());
    return;
  }
  MYCO_JSON_DOCUMENT(doc, 768);
  if (deserializeJson(doc, body)) { Serial.println("[api] bad poll response"); return; }
  unsigned long autoSeconds = doc["auto_interval_seconds"] | 0UL;
  if (autoSeconds >= 30) autoIntervalMs = autoSeconds * 1000UL;
  unsigned long pollSeconds = doc["poll_interval_seconds"] | 0UL;
  if (pollSeconds >= 1 && pollSeconds <= 60) pollIntervalMs = pollSeconds * 1000UL;
  const char *target = doc["target_device_id"] | "";
  targetDevice = target;
  if (doc["capture_now"] | false) {
    Serial.println("[api] manual capture requested");
    uploadCapture("manual");
    lastAutoCapture = millis();
  }
}

void connectWiFi() {
  if (WiFi.status() == WL_CONNECTED || millis() - lastWifiAttempt < WIFI_RETRY_MS) return;
  lastWifiAttempt = millis();
  Serial.printf("[wifi] connecting to %s\n", WIFI_SSID);
  WiFi.disconnect();
  WiFi.begin(WIFI_SSID, WIFI_PASS);
}

// ----------------------------------------------------------------------------- arduino
void setup() {
  Serial.begin(115200);
  pinMode(STATUS_LED_GPIO, OUTPUT);
  digitalWrite(STATUS_LED_GPIO, HIGH);
#if USE_FLASH_LED
  pinMode(FLASH_LED_GPIO, OUTPUT);
  digitalWrite(FLASH_LED_GPIO, LOW);
#endif
  cameraReady = initCamera();
  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false);
  WiFi.setAutoReconnect(true);
  connectWiFi();
  lastAutoCapture = millis();
  Serial.println("MYCO AI ESP32-CAM ready. Device: " DEVICE_ID);
}

void loop() {
  connectWiFi();
  if (WiFi.status() != WL_CONNECTED) { delay(100); return; }
  unsigned long now = millis();
  if (now - lastPoll >= pollIntervalMs) {
    lastPoll = now;
    pollServer();
  }
  if (now - lastAutoCapture >= autoIntervalMs) {
    lastAutoCapture = now;
    Serial.println("[cam] automatic capture");
    uploadCapture("auto");
  }
  delay(50);
}
