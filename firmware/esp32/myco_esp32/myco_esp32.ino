/*
 * MYCO AI – ESP32 chamber controller (HTTP transport, schema_version 1)
 * ---------------------------------------------------------------------------
 * Talks to the MYCO AI backend on the same Wi-Fi network:
 *   POST <MYCO_API_URL>/api/ingest/telemetry       every TELEMETRY_INTERVAL_MS
 *   GET  <MYCO_API_URL>/api/ingest/commands        every COMMAND_POLL_MS (pending -> sent)
 *   POST <MYCO_API_URL>/api/ingest/command-status  acknowledgement for every command
 *   POST <MYCO_API_URL>/api/ingest/status          "online" after boot / reconnect
 * All requests carry the per-device token in the X-Device-Token header (the MQTT
 * transport puts the same value in a "device_token" payload field instead).
 * Payloads follow /schemas/*.v1.schema.json (the MQTT topics of the same names
 * remain documented in docs/architecture.md for brokers; this sketch is HTTP only).
 *
 * The backend owns the decision making: the ESP32-CAM result selects the
 * growth phase, the deterministic control service turns that phase's
 * temperature/humidity ranges into fan / humidifier / heater commands, and this
 * firmware executes them.  Nothing here lets a chat message or LLM switch a relay.
 *
 * PIN MAP (as wired for the demo – change the constants below if you re-wire):
 *   DHT11 data ........................ GPIO 4   (10 kΩ pull-up to 3V3)
 *   substrate moisture probe (AO) ..... GPIO 34  (ADC1_CH6, input only, max 3.3 V)
 *   12 V fan via L298N/L293D channel 2: IN3 = GPIO 26, IN4 = GPIO 27, EN2/ENB = GPIO 25
 *   USB ultrasonic humidifier driver .. GPIO 18  (logic level, active HIGH by default)
 *   tungsten bulb "heater" relay IN ... GPIO 19  (suggested; alternatives 23, 32, 33 – avoid 0/2/5/12/15 boot
 *                                                 strapping pins and 34–39 which are input-only)
 *
 *   !! The bulb is a mains/high-current load: use an enclosed, correctly rated relay
 *      module, a fuse and an INDEPENDENT thermal cut-out in series with the bulb.
 *      Software interlocks are the second layer, never the only one.
 *   !! Share GND between the ESP32, the motor driver, the relay module and the humidifier driver.
 *
 * LOCAL SAFETY LOGIC (runs even when Wi-Fi / the backend is gone):
 *   1. Heater is forced OFF above HEATER_CUTOFF_C or when the DHT11 read fails repeatedly.
 *   2. Heater runtime is capped at HEATER_MAX_RUNTIME_MS, then a cool-down applies.
 *   3. Command watchdog: without successful backend contact for COMMAND_WATCHDOG_MS the heater
 *      and the humidifier are switched off (fan keeps its state – harmless when stuck).
 *   4. Commands older than ttl_seconds are rejected; every command is acknowledged.
 *
 * Libraries (Arduino IDE / arduino-cli): ESP32 Arduino core 2.x or 3.x, ArduinoJson 6/7,
 * "DHT sensor library" + "Adafruit Unified Sensor".  Copy config.example.h to config.h.
 */
#include <WiFi.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>
#include <DHT.h>
#include <time.h>
#include "config.h"

#if ARDUINOJSON_VERSION_MAJOR >= 7
  #define MYCO_JSON_DOCUMENT(name, capacity) JsonDocument name
#else
  #define MYCO_JSON_DOCUMENT(name, capacity) DynamicJsonDocument name(capacity)
#endif

// ----------------------------------------------------------------------------- pins
static const uint8_t PIN_DHT = 4;
static const uint8_t PIN_MOISTURE = 34;
static const uint8_t PIN_FAN_IN3 = 26;
static const uint8_t PIN_FAN_IN4 = 27;
static const uint8_t PIN_FAN_EN2 = 25;
static const uint8_t PIN_HUMIDIFIER = 18;
#ifndef PIN_HEATER_RELAY
  #define PIN_HEATER_RELAY 19
#endif
static const uint8_t PIN_HEATER = PIN_HEATER_RELAY;
#define DHT_TYPE DHT11

// Relay / driver polarity – set in config.h if your boards differ.
#ifndef HEATER_RELAY_ACTIVE_LOW
  #define HEATER_RELAY_ACTIVE_LOW 0   // most 1-channel opto relay modules are active LOW -> set 1
#endif
#ifndef HUMIDIFIER_ACTIVE_LOW
  #define HUMIDIFIER_ACTIVE_LOW 0
#endif
static const uint8_t HEATER_ON = HEATER_RELAY_ACTIVE_LOW ? LOW : HIGH;
static const uint8_t HEATER_OFF = HEATER_RELAY_ACTIVE_LOW ? HIGH : LOW;
static const uint8_t HUMIDIFIER_ON = HUMIDIFIER_ACTIVE_LOW ? LOW : HIGH;
static const uint8_t HUMIDIFIER_OFF = HUMIDIFIER_ACTIVE_LOW ? HIGH : LOW;

// ----------------------------------------------------------------------------- safety limits / timing
static const float HEATER_CUTOFF_C = 32.0f;                                 // matches backend heater_absolute_max_temp_c
static const unsigned long HEATER_MAX_RUNTIME_MS = 30UL * 60UL * 1000UL;    // 30 min continuous
static const unsigned long HEATER_COOLDOWN_MS = 5UL * 60UL * 1000UL;        // 5 min after a runtime cut-off
static const unsigned long COMMAND_WATCHDOG_MS = 180UL * 1000UL;            // heater/humidifier off without backend contact
static const int MAX_DHT_FAILURES = 3;
static const unsigned long TELEMETRY_INTERVAL_MS = 5UL * 1000UL;
static const unsigned long COMMAND_POLL_MS = 3UL * 1000UL;
static const unsigned long STATUS_INTERVAL_MS = 60UL * 1000UL;
static const unsigned long WIFI_RETRY_MS = 5UL * 1000UL;
static const uint16_t HTTP_TIMEOUT_MS = 4000;

#define API_INGEST "/api/ingest"
static const char *PATH_TELEMETRY = API_INGEST "/telemetry";
static const char *PATH_STATUS = API_INGEST "/status";
static const char *PATH_COMMANDS = API_INGEST "/commands";
static const char *PATH_COMMAND_STATUS = API_INGEST "/command-status";

// ----------------------------------------------------------------------------- state
DHT dht(PIN_DHT, DHT_TYPE);

struct ActuatorState {
  bool fan = false;
  bool heater = false;
  bool humidifier = false;
} act;

float lastTemp = NAN, lastRh = NAN;
int moistureRaw = 0;
int dhtFailures = 0;
unsigned long heaterOnSince = 0;        // millis() when the heater was switched on (0 = off)
unsigned long heaterCooldownUntil = 0;
unsigned long lastBackendContact = 0;   // millis() of the last successful authenticated request
unsigned long lastTelemetry = 0, lastPoll = 0, lastStatus = 0, lastWifiAttempt = 0;
bool statusSent = false;
String lastSafetyReason;

// ----------------------------------------------------------------------------- helpers
String isoTimestamp() {
  time_t now = time(nullptr);
  if (now < 1700000000) return String();   // NTP not synced yet -> backend stamps the reading itself
  struct tm t;
  gmtime_r(&now, &t);
  char buf[32];
  strftime(buf, sizeof(buf), "%Y-%m-%dT%H:%M:%SZ", &t);
  return String(buf);
}

String newId() {
  char buf[40];
  snprintf(buf, sizeof(buf), "%s-%lu-%04x", DEVICE_ID, millis(), (unsigned)random(0xFFFF));
  return String(buf);
}

void writeFan(bool on) {
  // Channel 2 of the L298N/L293D: direction fixed (IN3 HIGH, IN4 LOW), EN2 switches the fan.
  digitalWrite(PIN_FAN_IN3, on ? HIGH : LOW);
  digitalWrite(PIN_FAN_IN4, LOW);
  digitalWrite(PIN_FAN_EN2, on ? HIGH : LOW);
  act.fan = on;
}

void writeHumidifier(bool on) {
  digitalWrite(PIN_HUMIDIFIER, on ? HUMIDIFIER_ON : HUMIDIFIER_OFF);
  act.humidifier = on;
}

void writeHeater(bool on) {
  digitalWrite(PIN_HEATER, on ? HEATER_ON : HEATER_OFF);
  if (on && !act.heater) heaterOnSince = millis();
  if (!on) heaterOnSince = 0;
  act.heater = on;
}

bool actuatorState(const String &name) {
  if (name == "fan") return act.fan;
  if (name == "heater") return act.heater;
  return act.humidifier;
}

void setActuator(const String &name, bool on) {
  if (name == "fan") writeFan(on);
  else if (name == "heater") writeHeater(on);
  else if (name == "humidifier") writeHumidifier(on);
}

bool backendStale() {
  return lastBackendContact == 0 || (millis() - lastBackendContact) > COMMAND_WATCHDOG_MS;
}

// Returns an empty string when the heater may run, otherwise the lock-out reason.
String heaterLockout() {
  if (isnan(lastTemp) || dhtFailures >= MAX_DHT_FAILURES) return "no_valid_temperature";
  if (lastTemp >= HEATER_CUTOFF_C) return "local_thermal_cutoff";
  if (heaterCooldownUntil && millis() < heaterCooldownUntil) return "heater_cooldown";
  if (backendStale()) return "backend_watchdog";
  return String();
}

void enforceSafety() {
  if (act.heater && (millis() - heaterOnSince) >= HEATER_MAX_RUNTIME_MS) {
    heaterCooldownUntil = millis() + HEATER_COOLDOWN_MS;
    writeHeater(false);
    lastSafetyReason = "heater_max_runtime";
    Serial.println("[safety] heater forced OFF: max runtime reached");
  }
  if (act.heater) {
    String reason = heaterLockout();
    if (reason.length()) {
      writeHeater(false);
      lastSafetyReason = reason;
      Serial.printf("[safety] heater forced OFF: %s\n", reason.c_str());
    }
  }
  if (act.humidifier && (backendStale() || dhtFailures >= MAX_DHT_FAILURES)) {
    writeHumidifier(false);
    lastSafetyReason = backendStale() ? "backend_watchdog" : "no_valid_humidity";
    Serial.printf("[safety] humidifier forced OFF: %s\n", lastSafetyReason.c_str());
  }
}

void readSensors() {
  float t = dht.readTemperature();
  float rh = dht.readHumidity();
  if (isnan(t) || isnan(rh)) {
    if (dhtFailures < 1000) dhtFailures++;
    if (dhtFailures >= MAX_DHT_FAILURES) { lastTemp = NAN; lastRh = NAN; }
    Serial.printf("[sensor] DHT11 read failed (%d/%d)\n", dhtFailures, MAX_DHT_FAILURES);
  } else {
    lastTemp = t;
    lastRh = rh;
    dhtFailures = 0;
  }
  long total = 0;
  for (int i = 0; i < 8; i++) { total += analogRead(PIN_MOISTURE); delay(2); }
  moistureRaw = (int)(total / 8);
}

// ----------------------------------------------------------------------------- HTTP
bool beginRequest(HTTPClient &http, const char *path) {
  String url = String(MYCO_API_URL) + path;
  if (!http.begin(url)) return false;
  http.setTimeout(HTTP_TIMEOUT_MS);
  http.setConnectTimeout(HTTP_TIMEOUT_MS);
  http.addHeader("X-Device-Token", DEVICE_TOKEN);
  return true;
}

bool postJson(const char *path, const String &body, String *reply = nullptr) {
  HTTPClient http;
  if (!beginRequest(http, path)) return false;
  http.addHeader("Content-Type", "application/json");
  int code = http.POST(body);
  String text = code > 0 ? http.getString() : String();
  http.end();
  if (reply) *reply = text;
  if (code >= 200 && code < 300) {
    lastBackendContact = millis();
    return true;
  }
  Serial.printf("[api] POST %s failed (%d) %s\n", path, code, text.c_str());
  return false;
}

void postStatus(const char *status) {
  MYCO_JSON_DOCUMENT(doc, 384);
  doc["schema_version"] = 1;
  doc["device_id"] = DEVICE_ID;
  doc["message_id"] = newId();
  String ts = isoTimestamp();
  if (ts.length()) doc["timestamp"] = ts; else doc["timestamp"] = nullptr;
  doc["status"] = status;
  doc["firmware_version"] = FIRMWARE_VERSION;
  doc["ip"] = WiFi.localIP().toString();
  doc["rssi_dbm"] = WiFi.RSSI();
  doc["uptime_ms"] = millis();
  String body;
  serializeJson(doc, body);
  statusSent = postJson(PATH_STATUS, body);
}

void postTelemetry() {
  MYCO_JSON_DOCUMENT(doc, 768);
  doc["schema_version"] = 1;
  doc["device_id"] = DEVICE_ID;
  doc["message_id"] = newId();
  String ts = isoTimestamp();
  if (ts.length()) doc["timestamp"] = ts; else doc["timestamp"] = nullptr;
  doc["uptime_ms"] = millis();
  if (isnan(lastTemp)) doc["temperature_c"] = nullptr; else doc["temperature_c"] = lastTemp;
  if (isnan(lastRh)) doc["relative_humidity_percent"] = nullptr; else doc["relative_humidity_percent"] = lastRh;
  doc["substrate_moisture_raw"] = moistureRaw;
  JsonArray errors = doc["sensor_errors"].to<JsonArray>();
  if (dhtFailures) errors.add("dht11");
  doc["fan_state"] = act.fan;
  doc["heater_state"] = act.heater;
  doc["humidifier_state"] = act.humidifier;
  doc["firmware_version"] = FIRMWARE_VERSION;
  doc["source"] = "hardware";
  doc["rssi_dbm"] = WiFi.RSSI();
  if (lastSafetyReason.length()) doc["safety_reason"] = lastSafetyReason;
  String body;
  serializeJson(doc, body);
  if (postJson(PATH_TELEMETRY, body)) {
    Serial.printf("[api] telemetry ok  T=%.1f°C RH=%.0f%% moist=%d fan=%d heat=%d hum=%d\n",
                  lastTemp, lastRh, moistureRaw, act.fan, act.heater, act.humidifier);
  }
}

time_t parseUtcTimestamp(const char *value) {
  if (!value || strlen(value) < 19) return 0;
  struct tm parsed = {};
  if (!strptime(value, "%Y-%m-%dT%H:%M:%S", &parsed)) return 0;
  return mktime(&parsed);   // TZ is UTC (see setup)
}

void acknowledgeCommand(const String &commandId, const String &actuator, bool requested, const char *status, const char *error) {
  MYCO_JSON_DOCUMENT(doc, 512);
  doc["schema_version"] = 1;
  doc["device_id"] = DEVICE_ID;
  doc["command_id"] = commandId;
  doc["message_id"] = newId();
  String ts = isoTimestamp();
  if (ts.length()) doc["timestamp"] = ts; else doc["timestamp"] = nullptr;
  doc["actuator"] = actuator;
  doc["requested_state"] = requested;
  doc["result_state"] = actuatorState(actuator);
  doc["status"] = status;
  if (error) doc["error"] = error; else doc["error"] = nullptr;
  String body;
  serializeJson(doc, body);
  postJson(PATH_COMMAND_STATUS, body);
}

void handleCommand(JsonObject command) {
  String commandId = command["command_id"] | "";
  String commandDevice = command["device_id"] | "";
  String actuator = command["actuator"] | "";
  bool requested = command["state"] | false;
  String errorStorage;
  const char *error = nullptr;

  if (!commandId.length() || commandDevice != DEVICE_ID) error = "invalid_command";
  else if (actuator != "fan" && actuator != "heater" && actuator != "humidifier") error = "unknown_actuator";
  else {
    int ttl = constrain((int)(command["ttl_seconds"] | 60), 5, 600);
    time_t issued = parseUtcTimestamp(command["timestamp"] | "");
    time_t now = time(nullptr);
    if (issued && now > 1700000000 && difftime(now, issued) > ttl) error = "command_expired";
    else if (actuator == "heater" && requested) {
      errorStorage = heaterLockout();
      if (errorStorage.length()) error = errorStorage.c_str();
    }
  }

  const char *status = "applied";
  if (error) {
    status = "rejected";
  } else {
    setActuator(actuator, requested);
    enforceSafety();
    if (actuatorState(actuator) != requested) { status = "rejected"; error = "local_safety_interlock"; }
  }
  Serial.printf("[command] %s -> %s : %s%s%s\n", actuator.c_str(), requested ? "ON" : "OFF", status,
                error ? " / " : "", error ? error : "");
  acknowledgeCommand(commandId, actuator, requested, status, error);
}

void pollCommands() {
  HTTPClient http;
  if (!beginRequest(http, PATH_COMMANDS)) return;
  int code = http.GET();
  String body = code > 0 ? http.getString() : String();
  http.end();
  if (code < 200 || code >= 300) {
    Serial.printf("[api] command poll failed (%d)\n", code);
    return;
  }
  lastBackendContact = millis();   // successful authenticated poll = backend heartbeat for the watchdog
  MYCO_JSON_DOCUMENT(doc, 4096);
  DeserializationError err = deserializeJson(doc, body);
  if (err) { Serial.printf("[api] bad command response: %s\n", err.c_str()); return; }
  JsonArray commands = doc["commands"].as<JsonArray>();
  for (JsonObject command : commands) handleCommand(command);
}

void connectWiFi() {
  if (WiFi.status() == WL_CONNECTED || (millis() - lastWifiAttempt) < WIFI_RETRY_MS) return;
  lastWifiAttempt = millis();
  statusSent = false;
  Serial.printf("[wifi] connecting to %s\n", WIFI_SSID);
  WiFi.disconnect();
  WiFi.begin(WIFI_SSID, WIFI_PASS);
}

// ----------------------------------------------------------------------------- arduino
void setup() {
  Serial.begin(115200);
  pinMode(PIN_FAN_IN3, OUTPUT);
  pinMode(PIN_FAN_IN4, OUTPUT);
  pinMode(PIN_FAN_EN2, OUTPUT);
  pinMode(PIN_HEATER, OUTPUT);
  pinMode(PIN_HUMIDIFIER, OUTPUT);
  pinMode(PIN_MOISTURE, INPUT);
  writeFan(false);
  writeHeater(false);
  writeHumidifier(false);
  analogReadResolution(12);
  dht.begin();

  setenv("TZ", "UTC0", 1);
  tzset();
  configTime(0, 0, "pool.ntp.org", "time.nist.gov");
  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(true);
  connectWiFi();
  Serial.println("MYCO AI ESP32 controller (HTTP) ready – all outputs OFF. Device: " DEVICE_ID);
}

void loop() {
  connectWiFi();
  unsigned long now = millis();
  bool online = WiFi.status() == WL_CONNECTED;

  if (online && (!statusSent || now - lastStatus >= STATUS_INTERVAL_MS)) {
    lastStatus = now;
    postStatus("online");
  }
  if (now - lastTelemetry >= TELEMETRY_INTERVAL_MS) {
    lastTelemetry = now;
    readSensors();
    enforceSafety();
    if (online) postTelemetry();
  }
  if (online && now - lastPoll >= COMMAND_POLL_MS) {
    lastPoll = now;
    pollCommands();
  }
  enforceSafety();   // keeps running when Wi-Fi / the backend is gone
  delay(20);
}
