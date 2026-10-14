/*
 * MYCO AI – ESP32 chamber controller (reference firmware, schema_version 1)
 * ---------------------------------------------------------------------------
 * Hardware (see docs/hardware.md / project PDF):
 *   - ESP32 dev board
 *   - DHT11 temperature / humidity sensor           -> GPIO 4  (data, 10 kΩ pull-up)
 *   - analog soil / substrate moisture probe        -> GPIO 34 (ADC1_CH6, raw 0..4095)
 *   - 12 V DC fan via logic-level MOSFET / relay    -> GPIO 26
 *   - tungsten bulb "heater" via relay module       -> GPIO 27  (!! independent thermal cutoff / fuse required)
 *   - USB ultrasonic humidifier via driver PCB      -> GPIO 25
 *
 * Communication: MQTT (PubSubClient) using the versioned topics
 *   myco/<device_id>/telemetry       (publish, QoS 1)
 *   myco/<device_id>/status          (publish, retained; "offline" registered as last-will)
 *   myco/<device_id>/commands        (subscribe)
 *   myco/<device_id>/command-status  (publish)
 * Payloads follow /schemas/*.v1.schema.json. An HTTP fallback is sketched at the
 * bottom (POST /api/ingest/telemetry with X-Device-Token) for networks without a broker.
 *
 * LOCAL SAFETY LOGIC (runs even when the backend / Wi-Fi is gone):
 *   1. Heater is forced OFF above HEATER_CUTOFF_C or when the DHT11 read fails
 *      repeatedly (no trustworthy temperature -> no heating).
 *   2. Heater runtime is capped at HEATER_MAX_RUNTIME_MS, then a cooldown applies.
 *   3. Command watchdog: if no backend command/ping arrives for COMMAND_WATCHDOG_MS,
 *      the heater is switched off (fan/humidifier keep their state – both are
 *      harmless when stuck).
 *   4. Commands older than ttl_seconds are rejected; every command is acknowledged.
 *   5. Nothing in this file lets a chat/LLM message switch a relay – commands can
 *      only come from the backend's control service topic.
 *
 * Libraries (Arduino IDE / arduino-cli): WiFi (core), PubSubClient, ArduinoJson (v6/v7), DHT sensor library.
 * Copy config.example.h to config.h and fill in your network / token values.
 */
#include <WiFi.h>
#include <PubSubClient.h>
#include <ArduinoJson.h>
#include <DHT.h>
#include <time.h>
#include "config.h"

// ----------------------------------------------------------------------------- pins
#define PIN_DHT 4
#define PIN_MOISTURE 34
#define PIN_FAN 26
#define PIN_HEATER 27
#define PIN_HUMIDIFIER 25
#define DHT_TYPE DHT11

// If your relay board is active-LOW set these to LOW/HIGH accordingly.
#define RELAY_ON HIGH
#define RELAY_OFF LOW

// ----------------------------------------------------------------------------- safety limits
static const float HEATER_CUTOFF_C = 32.0f;                  // hard local cutoff (backend default is the same)
static const unsigned long HEATER_MAX_RUNTIME_MS = 30UL * 60UL * 1000UL;  // 30 min continuous
static const unsigned long HEATER_COOLDOWN_MS = 5UL * 60UL * 1000UL;      // 5 min after a runtime cutoff
static const unsigned long COMMAND_WATCHDOG_MS = 180UL * 1000UL;          // heater off without backend contact
static const int MAX_DHT_FAILURES = 3;
static const unsigned long TELEMETRY_INTERVAL_MS = 10UL * 1000UL;
static const unsigned long STATUS_INTERVAL_MS = 60UL * 1000UL;

// ----------------------------------------------------------------------------- state
DHT dht(PIN_DHT, DHT_TYPE);
WiFiClient espClient;
PubSubClient mqtt(espClient);

struct ActuatorState {
  bool fan = false;
  bool heater = false;
  bool humidifier = false;
} act;

unsigned long heaterOnSince = 0;      // millis() when heater was switched on, 0 = off
unsigned long heaterCooldownUntil = 0;
unsigned long lastBackendContact = 0; // millis() of last command/ping from backend
unsigned long lastTelemetry = 0;
unsigned long lastStatus = 0;
int dhtFailures = 0;
float lastTemp = NAN, lastRh = NAN;
String lastSafetyReason = "";

String topicTelemetry, topicStatus, topicCommands, topicCommandStatus;

// ----------------------------------------------------------------------------- helpers
String isoTimestamp() {
  time_t now = time(nullptr);
  if (now < 1700000000) return "";  // clock not synchronised -> send null (backend stamps arrival time)
  struct tm t;
  gmtime_r(&now, &t);
  char buf[25];
  strftime(buf, sizeof(buf), "%Y-%m-%dT%H:%M:%SZ", &t);
  return String(buf);
}

String newId() {
  char buf[33];
  uint32_t r[4] = {esp_random(), esp_random(), esp_random(), esp_random()};
  snprintf(buf, sizeof(buf), "%08x%08x%08x%08x", r[0], r[1], r[2], r[3]);
  return String(buf);
}

void applyRelay(int pin, bool on) { digitalWrite(pin, on ? RELAY_ON : RELAY_OFF); }

void setHeater(bool on, const char *why) {
  if (on && !act.heater) heaterOnSince = millis();
  if (!on) heaterOnSince = 0;
  act.heater = on;
  applyRelay(PIN_HEATER, on);
  Serial.printf("[heater] %s (%s)\n", on ? "ON" : "OFF", why);
}

void setActuator(const String &name, bool on, const char *why) {
  if (name == "fan") { act.fan = on; applyRelay(PIN_FAN, on); }
  else if (name == "humidifier") { act.humidifier = on; applyRelay(PIN_HUMIDIFIER, on); }
  else if (name == "heater") setHeater(on, why);
}

// ----------------------------------------------------------------------------- local safety
// Returns a reason string when the heater must not run right now ("" = allowed).
String heaterLockout() {
  if (isnan(lastTemp) || dhtFailures >= MAX_DHT_FAILURES) return "no_valid_temperature";
  if (lastTemp >= HEATER_CUTOFF_C) return "local_thermal_cutoff";
  if (millis() < heaterCooldownUntil) return "heater_cooldown";
  if (lastBackendContact != 0 && millis() - lastBackendContact > COMMAND_WATCHDOG_MS) return "backend_watchdog";
  return "";
}

void enforceSafety() {
  String reason = heaterLockout();
  if (act.heater) {
    if (heaterOnSince && millis() - heaterOnSince > HEATER_MAX_RUNTIME_MS) {
      heaterCooldownUntil = millis() + HEATER_COOLDOWN_MS;
      reason = "heater_max_runtime";
    }
    if (reason.length()) {
      setHeater(false, reason.c_str());
      lastSafetyReason = reason;
    }
  }
}

// ----------------------------------------------------------------------------- MQTT
void publishJson(const String &topic, JsonDocument &doc, bool retained = false) {
  String out;
  serializeJson(doc, out);
  mqtt.publish(topic.c_str(), out.c_str(), retained);
}

void publishStatus(const char *status) {
  JsonDocument doc;
  doc["schema_version"] = 1;
  doc["device_id"] = DEVICE_ID;
  doc["status"] = status;
  String ts = isoTimestamp();
  if (ts.length()) doc["timestamp"] = ts; else doc["timestamp"] = nullptr;
  doc["firmware_version"] = FIRMWARE_VERSION;
  doc["ip"] = WiFi.localIP().toString();
  doc["rssi_dbm"] = WiFi.RSSI();
  JsonObject safety = doc["local_safety"].to<JsonObject>();
  safety["heater_cutoff_c"] = HEATER_CUTOFF_C;
  safety["heater_max_runtime_s"] = HEATER_MAX_RUNTIME_MS / 1000;
  safety["command_watchdog_s"] = COMMAND_WATCHDOG_MS / 1000;
  safety["last_safety_reason"] = lastSafetyReason;
  publishJson(topicStatus, doc, true);
}

void publishCommandStatus(const String &commandId, const String &actuator, bool requested, const char *status, const char *error) {
  JsonDocument doc;
  doc["schema_version"] = 1;
  doc["device_id"] = DEVICE_ID;
  doc["device_token"] = DEVICE_TOKEN;
  doc["command_id"] = commandId;
  doc["message_id"] = newId();
  String ts = isoTimestamp();
  if (ts.length()) doc["timestamp"] = ts; else doc["timestamp"] = nullptr;
  doc["actuator"] = actuator;
  doc["requested_state"] = requested;
  bool result = actuator == "fan" ? act.fan : actuator == "heater" ? act.heater : act.humidifier;
  doc["result_state"] = result;
  doc["status"] = status;
  if (error) doc["error"] = error; else doc["error"] = nullptr;
  publishJson(topicCommandStatus, doc);
}

void onCommand(char *topic, byte *payload, unsigned int length) {
  JsonDocument doc;
  if (deserializeJson(doc, payload, length)) { Serial.println("[cmd] invalid JSON"); return; }
  if (doc["schema_version"] | 0 != 1) { Serial.println("[cmd] unsupported schema"); return; }
  String commandId = doc["command_id"] | "";
  String actuator = doc["actuator"] | "";
  bool state = doc["state"] | false;
  int ttl = doc["ttl_seconds"] | 60;
  lastBackendContact = millis();

  if (actuator != "fan" && actuator != "heater" && actuator != "humidifier") {
    publishCommandStatus(commandId, actuator, state, "rejected", "unknown_actuator");
    return;
  }
  // TTL check (only possible with a synchronised clock)
  const char *tsStr = doc["timestamp"] | "";
  time_t now = time(nullptr);
  if (now > 1700000000 && strlen(tsStr) >= 19) {
    struct tm t = {};
    strptime(tsStr, "%Y-%m-%dT%H:%M:%S", &t);
    time_t issued = mktime(&t) - _timezone;  // mktime assumes local; we run in UTC
    if (difftime(now, issued) > ttl) {
      publishCommandStatus(commandId, actuator, state, "rejected", "command_expired");
      return;
    }
  }
  if (actuator == "heater" && state) {
    String lock = heaterLockout();
    if (lock.length()) {
      publishCommandStatus(commandId, actuator, state, "rejected", lock.c_str());
      return;
    }
  }
  setActuator(actuator, state, "backend command");
  // Verify the GPIO actually took the level; a stuck driver reports "failed".
  int pin = actuator == "fan" ? PIN_FAN : actuator == "heater" ? PIN_HEATER : PIN_HUMIDIFIER;
  bool applied = digitalRead(pin) == (state ? RELAY_ON : RELAY_OFF);
  publishCommandStatus(commandId, actuator, state, applied ? "applied" : "failed", applied ? nullptr : "relay_no_response");
}

bool mqttConnect() {
  JsonDocument will;
  will["schema_version"] = 1;
  will["device_id"] = DEVICE_ID;
  will["status"] = "offline";
  will["timestamp"] = nullptr;
  String willStr;
  serializeJson(will, willStr);
  bool ok = mqtt.connect(DEVICE_ID, MQTT_USER, MQTT_PASS, topicStatus.c_str(), 1, true, willStr.c_str());
  if (ok) {
    mqtt.subscribe(topicCommands.c_str(), 1);
    publishStatus("online");
    lastBackendContact = millis();
    Serial.println("[mqtt] connected");
  }
  return ok;
}

// ----------------------------------------------------------------------------- telemetry
void readSensors(JsonDocument &doc) {
  float t = dht.readTemperature();
  float h = dht.readHumidity();
  JsonArray errors = doc["sensor_errors"].to<JsonArray>();
  if (isnan(t) || isnan(h)) {
    dhtFailures++;
    errors.add("dht11");
    doc["temperature_c"] = nullptr;
    doc["relative_humidity_percent"] = nullptr;
    if (dhtFailures >= MAX_DHT_FAILURES) { lastTemp = NAN; lastRh = NAN; }
  } else {
    dhtFailures = 0;
    lastTemp = t; lastRh = h;
    doc["temperature_c"] = t;
    doc["relative_humidity_percent"] = h;
  }
  // average a few ADC samples; raw counts only – calibration happens on the dashboard side
  long sum = 0;
  for (int i = 0; i < 8; i++) { sum += analogRead(PIN_MOISTURE); delay(2); }
  doc["substrate_moisture_raw"] = (int)(sum / 8);
}

void publishTelemetry() {
  JsonDocument doc;
  doc["schema_version"] = 1;
  doc["device_id"] = DEVICE_ID;
  doc["device_token"] = DEVICE_TOKEN;      // stripped by the backend, never stored
  doc["message_id"] = newId();
  String ts = isoTimestamp();
  if (ts.length()) doc["timestamp"] = ts; else doc["timestamp"] = nullptr;
  doc["uptime_ms"] = millis();
  readSensors(doc);
  doc["fan_state"] = act.fan;
  doc["heater_state"] = act.heater;
  doc["humidifier_state"] = act.humidifier;
  doc["firmware_version"] = FIRMWARE_VERSION;
  doc["source"] = "hardware";
  doc["rssi_dbm"] = WiFi.RSSI();
  publishJson(topicTelemetry, doc);
}

// ----------------------------------------------------------------------------- setup / loop
void setup() {
  Serial.begin(115200);
  pinMode(PIN_FAN, OUTPUT); pinMode(PIN_HEATER, OUTPUT); pinMode(PIN_HUMIDIFIER, OUTPUT);
  applyRelay(PIN_FAN, false); applyRelay(PIN_HEATER, false); applyRelay(PIN_HUMIDIFIER, false);  // safe state at boot
  analogReadResolution(12);
  dht.begin();

  String base = String(TOPIC_PREFIX) + "/" + DEVICE_ID;
  topicTelemetry = base + "/telemetry";
  topicStatus = base + "/status";
  topicCommands = base + "/commands";
  topicCommandStatus = base + "/command-status";

  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  Serial.print("[wifi] connecting");
  while (WiFi.status() != WL_CONNECTED) { delay(500); Serial.print("."); }
  Serial.printf("\n[wifi] %s\n", WiFi.localIP().toString().c_str());
  configTime(0, 0, "pool.ntp.org", "time.nist.gov");  // UTC

  mqtt.setServer(MQTT_HOST, MQTT_PORT);
  mqtt.setBufferSize(1024);
  mqtt.setCallback(onCommand);
}

void loop() {
  if (WiFi.status() != WL_CONNECTED) { WiFi.reconnect(); delay(1000); }
  if (!mqtt.connected()) {
    static unsigned long lastTry = 0;
    if (millis() - lastTry > 5000) { lastTry = millis(); mqttConnect(); }
  }
  mqtt.loop();

  // Safety first: evaluated on every loop iteration, independent of connectivity.
  if (millis() - lastTelemetry > TELEMETRY_INTERVAL_MS) {
    lastTelemetry = millis();
    float t = dht.readTemperature();
    if (!isnan(t)) { lastTemp = t; dhtFailures = 0; } else dhtFailures++;
    enforceSafety();
    if (mqtt.connected()) publishTelemetry();
  } else {
    enforceSafety();
  }
  if (mqtt.connected() && millis() - lastStatus > STATUS_INTERVAL_MS) {
    lastStatus = millis();
    publishStatus("online");
  }
  delay(20);
}

/*
 * HTTP fallback (no broker): replace the MQTT publish/subscribe with
 *   POST  http://<backend>/api/ingest/telemetry        header X-Device-Token: <token>   body = telemetry JSON
 *   GET   http://<backend>/api/ingest/commands         header X-Device-Token: <token>   -> {"commands":[CommandV1,...]}
 *   POST  http://<backend>/api/ingest/command-status   header X-Device-Token: <token>   body = command-status JSON
 * Poll /commands every 5 s and keep the same local safety rules; the backend marks
 * un-acknowledged commands as "timeout" after 45 s and raises an alert.
 */
