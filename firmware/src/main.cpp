#include "secrets.h"
#include <WiFi.h>
#include <esp_wifi.h>
#include <esp_wpa2.h>
#include <WebSocketsClient.h>
#include <string.h>
#include "USB.h"
#include "USBHIDKeyboard.h"
#include "USBHIDMouse.h"

char WS_PATH[160];

USBHIDKeyboard Keyboard;
USBHIDMouse Mouse;
WebSocketsClient webSocket;

static const uint8_t FLAG_SEQ = 0x01;
static const uint8_t OP_KEY_DOWN = 1;
static const uint8_t OP_KEY_UP = 2;
static const uint8_t OP_RELEASE_ALL = 3;
static const uint8_t OP_MOUSE = 4;

static uint8_t mouseButtonsHeld = 0;
static bool wsStarted = false;

void webSocketEvent(WStype_t type, uint8_t *payload, size_t length);

static const uint32_t WIFI_JOIN_TIMEOUT_MS = 12000;
static const int WIFI_OPEN_LIMIT = 4;

struct ApChoice {
  char ssid[33];
  uint8_t bssid[6];
  int32_t channel;
  int32_t rssi;
  wifi_auth_mode_t auth;
  int8_t profile;
};

static bool isEnterprise(wifi_auth_mode_t auth) {
  return auth == WIFI_AUTH_WPA2_ENTERPRISE;
}

static bool isPsk(wifi_auth_mode_t auth) {
  return auth == WIFI_AUTH_WPA_PSK || auth == WIFI_AUTH_WPA2_PSK ||
         auth == WIFI_AUTH_WPA_WPA2_PSK || auth == WIFI_AUTH_WPA3_PSK ||
         auth == WIFI_AUTH_WPA2_WPA3_PSK;
}

static int profileForSsid(const char *ssid) {
  for (int i = 0; i < WIFI_PROFILE_COUNT; i++) {
    if (strcmp(ssid, WIFI_PROFILES[i].ssid) == 0) {
      return i;
    }
  }
  return -1;
}

static void copySsid(char *dest, const String &ssid) {
  strncpy(dest, ssid.c_str(), 32);
  dest[32] = '\0';
}

static void sortByRssi(ApChoice *items, int count) {
  for (int i = 1; i < count; i++) {
    const ApChoice key = items[i];
    int j = i - 1;
    while (j >= 0 && items[j].rssi < key.rssi) {
      items[j + 1] = items[j];
      j--;
    }
    items[j + 1] = key;
  }
}

static void leaveWifi() {
  esp_wifi_sta_wpa2_ent_disable();
  WiFi.disconnect(false, true);
  delay(100);
}

static bool waitConnected(uint32_t timeoutMs) {
  const uint32_t start = millis();
  while (millis() - start < timeoutMs) {
    if (WiFi.status() == WL_CONNECTED) {
      return true;
    }
    delay(200);
  }
  return false;
}

static bool relayReachable() {
  WiFiClient probe;
  probe.setTimeout(5000);
  const bool ok = probe.connect(WS_HOST, WS_PORT, 5000) == 1;
  probe.stop();
  return ok;
}

static bool joinPsk(const ApChoice &ap, const char *password) {
  leaveWifi();
  WiFi.setMinSecurity(WIFI_AUTH_WPA_PSK);
  WiFi.begin(ap.ssid, password, ap.channel, ap.bssid);
  return waitConnected(WIFI_JOIN_TIMEOUT_MS);
}

static bool joinOpen(const ApChoice &ap) {
  leaveWifi();
  WiFi.setMinSecurity(WIFI_AUTH_OPEN);
  WiFi.begin(ap.ssid, nullptr, ap.channel, ap.bssid);
  return waitConnected(WIFI_JOIN_TIMEOUT_MS);
}

static bool joinEnterprise(const ApChoice &ap, const char *username, const char *password) {
  const size_t userLen = strlen(username);
  const size_t passLen = strlen(password);
  if (userLen == 0 || userLen > 127 || passLen == 0 || passLen > 64) {
    return false;
  }

  leaveWifi();
  wifi_config_t config;
  memset(&config, 0, sizeof(config));
  strncpy((char *)config.sta.ssid, ap.ssid, sizeof(config.sta.ssid) - 1);
  strncpy((char *)config.sta.password, password, sizeof(config.sta.password) - 1);
  config.sta.threshold.authmode = WIFI_AUTH_WPA2_ENTERPRISE;
  config.sta.pmf_cfg.capable = true;

  esp_wifi_set_storage(WIFI_STORAGE_RAM);
  esp_wifi_set_config(WIFI_IF_STA, &config);
  esp_wifi_sta_wpa2_ent_set_identity((uint8_t *)username, (int)userLen);
  esp_wifi_sta_wpa2_ent_set_username((uint8_t *)username, (int)userLen);
  esp_wifi_sta_wpa2_ent_set_password((uint8_t *)password, (int)passLen);
  esp_wifi_sta_wpa2_ent_set_ca_cert(NULL, 0);
  esp_wifi_sta_wpa2_ent_enable();
  WiFi.begin(ap.ssid, password);
  return waitConnected(WIFI_JOIN_TIMEOUT_MS);
}

static bool useCandidate(const ApChoice &ap) {
  bool joined = false;
  if (ap.profile >= 0) {
    const WifiProfile &profile = WIFI_PROFILES[ap.profile];
    if (isEnterprise(ap.auth)) {
      if (profile.username == nullptr) {
        return false;
      }
      joined = joinEnterprise(ap, profile.username, profile.password);
    } else if (isPsk(ap.auth)) {
      if (profile.password == nullptr || profile.password[0] == '\0') {
        return false;
      }
      joined = joinPsk(ap, profile.password);
    } else if (ap.auth == WIFI_AUTH_OPEN) {
      joined = joinOpen(ap);
    }
  } else if (ap.auth == WIFI_AUTH_OPEN) {
    joined = joinOpen(ap);
  }

  if (!joined || !relayReachable()) {
    leaveWifi();
    return false;
  }
  return true;
}

static int collectCandidates(ApChoice *known, ApChoice *openNets) {
  const int found = WiFi.scanNetworks(false, false);
  if (found <= 0) {
    WiFi.scanDelete();
    return 0;
  }

  int openCount = 0;
  for (int i = 0; i < found; i++) {
    const String ssid = WiFi.SSID(i);
    if (ssid.length() == 0 || ssid.length() > 32) {
      continue;
    }
    const int profile = profileForSsid(ssid.c_str());
    const wifi_auth_mode_t auth = WiFi.encryptionType(i);
    const int32_t rssi = WiFi.RSSI(i);
    if (profile < 0 && (auth != WIFI_AUTH_OPEN || rssi < -85)) {
      continue;
    }

    ApChoice *slot = nullptr;
    if (profile >= 0) {
      slot = &known[profile];
      if (slot->ssid[0] != '\0' && slot->rssi >= rssi) {
        continue;
      }
    } else {
      int same = -1;
      int weakest = 0;
      for (int j = 0; j < openCount; j++) {
        if (strcmp(openNets[j].ssid, ssid.c_str()) == 0) {
          same = j;
        }
        if (openNets[j].rssi < openNets[weakest].rssi) {
          weakest = j;
        }
      }
      if (same >= 0) {
        if (openNets[same].rssi >= rssi) {
          continue;
        }
        slot = &openNets[same];
      } else if (openCount < WIFI_OPEN_LIMIT) {
        slot = &openNets[openCount];
        openCount++;
      } else if (rssi > openNets[weakest].rssi) {
        slot = &openNets[weakest];
      } else {
        continue;
      }
    }

    memset(slot, 0, sizeof(*slot));
    copySsid(slot->ssid, ssid);
    memcpy(slot->bssid, WiFi.BSSID(i), 6);
    slot->channel = WiFi.channel(i);
    slot->rssi = rssi;
    slot->auth = auth;
    slot->profile = (int8_t)profile;
  }
  WiFi.scanDelete();
  return openCount;
}

static bool connectBestWifi() {
  if (wsStarted) {
    webSocket.disconnect();
  }

  WiFi.persistent(false);
  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false);
  WiFi.setAutoReconnect(false);

  ApChoice known[WIFI_PROFILE_COUNT];
  ApChoice openNets[WIFI_OPEN_LIMIT];
  memset(known, 0, sizeof(known));
  memset(openNets, 0, sizeof(openNets));
  const int openCount = collectCandidates(known, openNets);

  ApChoice ordered[WIFI_PROFILE_COUNT + WIFI_OPEN_LIMIT];
  int count = 0;
  for (int i = 0; i < WIFI_PROFILE_COUNT; i++) {
    if (known[i].ssid[0] != '\0') {
      ordered[count++] = known[i];
    }
  }
  sortByRssi(ordered, count);
  const int knownCount = count;
  for (int i = 0; i < openCount; i++) {
    ordered[count++] = openNets[i];
  }
  sortByRssi(ordered + knownCount, openCount);

  for (int i = 0; i < count; i++) {
    if (useCandidate(ordered[i])) {
      return true;
    }
  }
  leaveWifi();
  return false;
}

static void startWebSocket() {
  if (wsStarted) {
    return;
  }
  if (WS_USE_SSL) {
    webSocket.beginSSL(WS_HOST, WS_PORT, WS_PATH);
  } else {
    webSocket.begin(WS_HOST, WS_PORT, WS_PATH);
  }
  webSocket.onEvent(webSocketEvent);
  webSocket.setReconnectInterval(4000);
  wsStarted = true;
}

static bool hidUsageAllowed(uint8_t usage) {
  if (usage >= 0xE0 && usage <= 0xE7) {
    return true;
  }
  return usage > 0 && usage < 0xA5;
}

static void releaseAllInput() {
  Keyboard.releaseAll();
  Mouse.release(MOUSE_ALL);
  mouseButtonsHeld = 0;
}

/** Arduino USBHIDMouse::move is int8_t; split 16-bit deltas. */
static void mouseMoveSplit(int16_t dx, int16_t dy, int8_t wheel) {
  bool wheelSent = false;
  while (dx != 0 || dy != 0 || !wheelSent) {
    int8_t sx = 0;
    int8_t sy = 0;
    if (dx > 127) {
      sx = 127;
    } else if (dx < -127) {
      sx = -127;
    } else {
      sx = (int8_t)dx;
    }
    if (dy > 127) {
      sy = 127;
    } else if (dy < -127) {
      sy = -127;
    } else {
      sy = (int8_t)dy;
    }
    const int8_t sw = wheelSent ? 0 : wheel;
    Mouse.move(sx, sy, sw);
    dx = (int16_t)(dx - sx);
    dy = (int16_t)(dy - sy);
    wheelSent = true;
    if (sx == 0 && sy == 0) {
      break;
    }
  }
}

static void syncMouseButtons(uint8_t buttons) {
  buttons &= 0x07;
  const uint8_t pressed = (uint8_t)(buttons & ~mouseButtonsHeld);
  const uint8_t released = (uint8_t)(mouseButtonsHeld & ~buttons);
  if (pressed & MOUSE_LEFT) {
    Mouse.press(MOUSE_LEFT);
  }
  if (pressed & MOUSE_RIGHT) {
    Mouse.press(MOUSE_RIGHT);
  }
  if (pressed & MOUSE_MIDDLE) {
    Mouse.press(MOUSE_MIDDLE);
  }
  if (released & MOUSE_LEFT) {
    Mouse.release(MOUSE_LEFT);
  }
  if (released & MOUSE_RIGHT) {
    Mouse.release(MOUSE_RIGHT);
  }
  if (released & MOUSE_MIDDLE) {
    Mouse.release(MOUSE_MIDDLE);
  }
  mouseButtonsHeld = buttons;
}

/**
 * Live binary contract (little-endian):
 *   op u8, flags u8 (bit0 = seq), seq u16
 *   op 1/2: + usage u8 (total 5)
 *   op 3: releaseAll (total 4)
 *   op 4: buttons u8, dx i16, dy i16, wheel i8 (total 10)
 */
static void applyBinaryHidFrame(uint8_t *payload, size_t length) {
  if (payload == nullptr || length < 4) {
    return;
  }
  const uint8_t op = payload[0];
  const uint8_t flags = payload[1];
  if ((flags & FLAG_SEQ) == 0) {
    return;
  }

  if (op == OP_RELEASE_ALL) {
    if (length != 4) {
      return;
    }
    releaseAllInput();
    return;
  }

  if (op == OP_MOUSE) {
    if (length != 10) {
      return;
    }
    const uint8_t buttons = payload[4];
    const int16_t dx = (int16_t)(payload[5] | (payload[6] << 8));
    const int16_t dy = (int16_t)(payload[7] | (payload[8] << 8));
    const int8_t wheel = (int8_t)payload[9];
    syncMouseButtons(buttons);
    if (dx != 0 || dy != 0 || wheel != 0) {
      mouseMoveSplit(dx, dy, wheel);
    }
    return;
  }

  if (op != OP_KEY_DOWN && op != OP_KEY_UP) {
    return;
  }
  if (length != 5) {
    return;
  }
  const uint8_t usage = payload[4];
  if (!hidUsageAllowed(usage)) {
    return;
  }
  if (op == OP_KEY_DOWN) {
    Keyboard.pressRaw(usage);
  } else {
    Keyboard.releaseRaw(usage);
  }
}

void webSocketEvent(WStype_t type, uint8_t *payload, size_t length) {
  switch (type) {
    case WStype_CONNECTED:
      webSocket.sendTXT("{\"type\":\"device_ready\"}");
      break;

    case WStype_BIN:
      applyBinaryHidFrame(payload, length);
      break;

    case WStype_TEXT:
      // Dump paste from POST /api/paste only
      if (length > 0 && length < 256) {
        char buf[257];
        memcpy(buf, payload, length);
        buf[length] = '\0';
        Keyboard.print(buf);
      }
      break;

    case WStype_DISCONNECTED:
      releaseAllInput();
      break;

    case WStype_ERROR:
      releaseAllInput();
      break;

    default:
      break;
  }
}

void setup() {
  snprintf(WS_PATH, sizeof(WS_PATH), "/ws/device?token=%s", DEVICE_TOKEN);

  Keyboard.begin();
  Mouse.begin();
  USB.begin();

  if (!connectBestWifi()) {
    return;
  }
  startWebSocket();
}

void loop() {
  if (WiFi.status() != WL_CONNECTED) {
    if (!connectBestWifi()) {
      delay(3000);
      return;
    }
    startWebSocket();
  }

  webSocket.loop();
}
