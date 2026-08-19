#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "crossgram/tgcalls_shim.h"

_Static_assert(CROSSGRAM_TGCALLS_SHIM_ABI_VERSION == 4, "ABI version is ABI");
_Static_assert(sizeof(crossgram_tgcalls_shim_status) == 4, "status must be uint32_t");
_Static_assert(_Alignof(crossgram_tgcalls_shim_status) == 4, "status alignment is ABI");
_Static_assert(sizeof(crossgram_tgcalls_endpoint_type) == 4, "endpoint type must be uint32_t");
_Static_assert(_Alignof(crossgram_tgcalls_endpoint_type) == 4, "endpoint type alignment is ABI");
_Static_assert(sizeof(crossgram_tgcalls_protocol_version) == 4, "protocol version must be uint32_t");
_Static_assert(_Alignof(crossgram_tgcalls_protocol_version) == 4, "protocol version alignment is ABI");
_Static_assert(CROSSGRAM_TGCALLS_SHIM_STATUS_OK == 0, "status values are ABI");
_Static_assert(CROSSGRAM_TGCALLS_SHIM_STATUS_INVALID_ARGUMENT == 1, "status values are ABI");
_Static_assert(CROSSGRAM_TGCALLS_SHIM_STATUS_STOPPED == 2, "status values are ABI");
_Static_assert(CROSSGRAM_TGCALLS_SHIM_STATUS_INPUT_FULL == 3, "status values are ABI");
_Static_assert(CROSSGRAM_TGCALLS_SHIM_STATUS_OUTPUT_EMPTY == 4, "status values are ABI");
_Static_assert(CROSSGRAM_TGCALLS_SHIM_STATUS_ABI_MISMATCH == 5, "status values are ABI");
_Static_assert(CROSSGRAM_TGCALLS_SHIM_STATUS_ALLOCATION_FAILED == 6, "status values are ABI");
_Static_assert(CROSSGRAM_TGCALLS_SHIM_STATUS_INVALID_STATE == 7, "status values are ABI");
_Static_assert(CROSSGRAM_TGCALLS_SHIM_STATUS_BACKEND_UNAVAILABLE == 8, "status values are ABI");
_Static_assert(CROSSGRAM_TGCALLS_SHIM_STATUS_INTERNAL_ERROR == 9, "status values are ABI");
_Static_assert(CROSSGRAM_TGCALLS_ENDPOINT_INET == 0, "endpoint values are ABI");
_Static_assert(CROSSGRAM_TGCALLS_ENDPOINT_LAN == 1, "endpoint values are ABI");
_Static_assert(CROSSGRAM_TGCALLS_ENDPOINT_UDP_RELAY == 2, "endpoint values are ABI");
_Static_assert(CROSSGRAM_TGCALLS_ENDPOINT_TCP_RELAY == 3, "endpoint values are ABI");
_Static_assert(CROSSGRAM_TGCALLS_PROTOCOL_V0 == 0, "protocol values are ABI");
_Static_assert(CROSSGRAM_TGCALLS_PROTOCOL_V1 == 1, "protocol values are ABI");
_Static_assert(sizeof(crossgram_tgcalls_string_view) == 16, "string view ABI layout");
_Static_assert(_Alignof(crossgram_tgcalls_string_view) == 8, "string view ABI alignment");
_Static_assert(offsetof(crossgram_tgcalls_string_view, data) == 0, "string view data offset");
_Static_assert(offsetof(crossgram_tgcalls_string_view, length) == 8, "string view length offset");
_Static_assert(sizeof(crossgram_tgcalls_endpoint) == 64, "endpoint ABI layout");
_Static_assert(_Alignof(crossgram_tgcalls_endpoint) == 8, "endpoint ABI alignment");
_Static_assert(offsetof(crossgram_tgcalls_endpoint, id) == 0, "endpoint id offset");
_Static_assert(offsetof(crossgram_tgcalls_endpoint, ipv4) == 8, "endpoint ipv4 offset");
_Static_assert(offsetof(crossgram_tgcalls_endpoint, ipv6) == 24, "endpoint ipv6 offset");
_Static_assert(offsetof(crossgram_tgcalls_endpoint, port) == 40, "endpoint port offset");
_Static_assert(offsetof(crossgram_tgcalls_endpoint, type) == 44, "endpoint type offset");
_Static_assert(offsetof(crossgram_tgcalls_endpoint, peer_tag) == 48, "endpoint peer tag offset");
_Static_assert(sizeof(crossgram_tgcalls_rtc_server) == 72, "RTC server ABI layout");
_Static_assert(_Alignof(crossgram_tgcalls_rtc_server) == 8, "RTC server ABI alignment");
_Static_assert(offsetof(crossgram_tgcalls_rtc_server, id) == 0, "RTC server id offset");
_Static_assert(offsetof(crossgram_tgcalls_rtc_server, host) == 8, "RTC server host offset");
_Static_assert(offsetof(crossgram_tgcalls_rtc_server, port) == 24, "RTC server port offset");
_Static_assert(offsetof(crossgram_tgcalls_rtc_server, username) == 32, "RTC server username offset");
_Static_assert(offsetof(crossgram_tgcalls_rtc_server, password) == 48, "RTC server password offset");
_Static_assert(offsetof(crossgram_tgcalls_rtc_server, is_turn) == 64, "RTC server TURN offset");
_Static_assert(offsetof(crossgram_tgcalls_rtc_server, is_tcp) == 65, "RTC server TCP offset");
_Static_assert(sizeof(crossgram_tgcalls_session_config) == 20, "config ABI layout");
_Static_assert(_Alignof(crossgram_tgcalls_session_config) == 4, "config ABI alignment");
_Static_assert(offsetof(crossgram_tgcalls_session_config, initialization_timeout_ms) == 0, "config initialization timeout offset");
_Static_assert(offsetof(crossgram_tgcalls_session_config, receive_timeout_ms) == 4, "config receive timeout offset");
_Static_assert(offsetof(crossgram_tgcalls_session_config, enable_p2p) == 8, "config p2p offset");
_Static_assert(offsetof(crossgram_tgcalls_session_config, allow_tcp) == 9, "config tcp offset");
_Static_assert(offsetof(crossgram_tgcalls_session_config, enable_aec) == 10, "config aec offset");
_Static_assert(offsetof(crossgram_tgcalls_session_config, enable_ns) == 11, "config ns offset");
_Static_assert(offsetof(crossgram_tgcalls_session_config, enable_agc) == 12, "config agc offset");
_Static_assert(offsetof(crossgram_tgcalls_session_config, protocol_version) == 16, "config protocol offset");
_Static_assert(sizeof(crossgram_tgcalls_session_auth) == 16, "auth ABI layout");
_Static_assert(_Alignof(crossgram_tgcalls_session_auth) == 8, "auth ABI alignment");
_Static_assert(offsetof(crossgram_tgcalls_session_auth, key) == 0, "auth key offset");
_Static_assert(offsetof(crossgram_tgcalls_session_auth, key_length) == 8, "auth key length offset");
_Static_assert(offsetof(crossgram_tgcalls_session_auth, is_outgoing) == 12, "auth outgoing offset");
_Static_assert(sizeof(crossgram_tgcalls_session_callbacks) == 24, "callbacks ABI layout");
_Static_assert(_Alignof(crossgram_tgcalls_session_callbacks) == 8, "callbacks ABI alignment");
_Static_assert(offsetof(crossgram_tgcalls_session_callbacks, context) == 0, "callbacks context offset");
_Static_assert(offsetof(crossgram_tgcalls_session_callbacks, outbound_signaling) == 8, "callbacks output offset");
_Static_assert(offsetof(crossgram_tgcalls_session_callbacks, error) == 16, "callbacks error offset");

static void Check(int condition, int line) {
  if (!condition) {
    fprintf(stderr, "c_abi_session_test failed at line %d\n", line);
    exit(1);
  }
}

#define CHECK(expression) Check((expression), __LINE__)

static void OnError(void* context, crossgram_tgcalls_shim_status status) {
  *(crossgram_tgcalls_shim_status*)context = status;
}

int main(void) {
  crossgram_tgcalls_shim* session = NULL;
  uint8_t auth[CROSSGRAM_TGCALLS_SHIM_AUTH_KEY_BYTES];
  memset(auth, 7, sizeof(auth));
  const char ipv4[] = "149.154.167.51";
  crossgram_tgcalls_endpoint endpoint = {0};
  endpoint.id = 17;
  endpoint.ipv4.data = ipv4;
  endpoint.ipv4.length = sizeof(ipv4) - 1;
  endpoint.port = 443;
  endpoint.type = CROSSGRAM_TGCALLS_ENDPOINT_UDP_RELAY;

  crossgram_tgcalls_session_config config = {0};
  config.enable_p2p = 1;
  config.protocol_version = CROSSGRAM_TGCALLS_PROTOCOL_V1;
  crossgram_tgcalls_session_auth credentials = {auth, sizeof(auth), 1};
  crossgram_tgcalls_shim_status callback_status = CROSSGRAM_TGCALLS_SHIM_STATUS_OK;
  crossgram_tgcalls_session_callbacks callbacks = {&callback_status, NULL, OnError};

  CHECK(crossgram_tgcalls_session_create(
            CROSSGRAM_TGCALLS_SHIM_ABI_VERSION + 1, &config, &credentials, &endpoint, 1,
            NULL, 0, &callbacks, &session) == CROSSGRAM_TGCALLS_SHIM_STATUS_ABI_MISMATCH);
  CHECK(session == NULL);
  CHECK(crossgram_tgcalls_session_create(
            CROSSGRAM_TGCALLS_SHIM_ABI_VERSION, &config, &credentials, NULL, 0,
            NULL, 0, &callbacks, &session) == CROSSGRAM_TGCALLS_SHIM_STATUS_OK);
  CHECK(session != NULL);
  CHECK(crossgram_tgcalls_session_stop(session) == CROSSGRAM_TGCALLS_SHIM_STATUS_OK);
  CHECK(crossgram_tgcalls_session_join(session) == CROSSGRAM_TGCALLS_SHIM_STATUS_OK);
  CHECK(crossgram_tgcalls_session_destroy(&session) == CROSSGRAM_TGCALLS_SHIM_STATUS_OK);
  CHECK(session == NULL);
  CHECK(crossgram_tgcalls_session_create(
            CROSSGRAM_TGCALLS_SHIM_ABI_VERSION, &config, &credentials, &endpoint, 0,
            NULL, 0, &callbacks, &session) == CROSSGRAM_TGCALLS_SHIM_STATUS_INVALID_ARGUMENT);
  config.enable_p2p = 0;
  CHECK(crossgram_tgcalls_session_create(
            CROSSGRAM_TGCALLS_SHIM_ABI_VERSION, &config, &credentials, NULL, 0,
            NULL, 0, &callbacks, &session) == CROSSGRAM_TGCALLS_SHIM_STATUS_INVALID_ARGUMENT);
  config.enable_p2p = 1;
  CHECK(crossgram_tgcalls_session_create(
            CROSSGRAM_TGCALLS_SHIM_ABI_VERSION, &config, &credentials, NULL, 1,
            NULL, 0, &callbacks, &session) == CROSSGRAM_TGCALLS_SHIM_STATUS_INVALID_ARGUMENT);
  CHECK(crossgram_tgcalls_session_create(
            CROSSGRAM_TGCALLS_SHIM_ABI_VERSION, &config, &credentials, &endpoint, 1,
            NULL, 0, &callbacks, &session) == CROSSGRAM_TGCALLS_SHIM_STATUS_OK);
  CHECK(session != NULL);
  CHECK(crossgram_tgcalls_session_receive_signaling(session, auth, 1) ==
        CROSSGRAM_TGCALLS_SHIM_STATUS_INVALID_STATE);
  CHECK(crossgram_tgcalls_session_start(session) ==
        CROSSGRAM_TGCALLS_SHIM_STATUS_BACKEND_UNAVAILABLE);
  CHECK(callback_status == CROSSGRAM_TGCALLS_SHIM_STATUS_BACKEND_UNAVAILABLE);
  CHECK(crossgram_tgcalls_session_stop(session) == CROSSGRAM_TGCALLS_SHIM_STATUS_OK);
  CHECK(crossgram_tgcalls_session_stop(session) == CROSSGRAM_TGCALLS_SHIM_STATUS_OK);
  CHECK(crossgram_tgcalls_session_join(session) == CROSSGRAM_TGCALLS_SHIM_STATUS_OK);
  CHECK(crossgram_tgcalls_session_join(session) == CROSSGRAM_TGCALLS_SHIM_STATUS_OK);
  CHECK(crossgram_tgcalls_session_destroy(&session) == CROSSGRAM_TGCALLS_SHIM_STATUS_OK);
  CHECK(session == NULL);
  CHECK(crossgram_tgcalls_session_destroy(&session) == CROSSGRAM_TGCALLS_SHIM_STATUS_OK);
  return 0;
}
