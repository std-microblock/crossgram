#include "crossgram/tgcalls_shim.h"

#include <stdint.h>
#include <stdlib.h>

static void Check(int condition) {
  if (!condition) abort();
}

int main(void) {
  uint8_t auth_key[CROSSGRAM_TGCALLS_SHIM_AUTH_KEY_BYTES] = {0};
  const char host[] = "127.0.0.1";
  const crossgram_tgcalls_session_config config = {
      .initialization_timeout_ms = 10000,
      .receive_timeout_ms = 10000,
      .enable_p2p = 1,
      .allow_tcp = 1,
      .enable_aec = 1,
      .enable_ns = 1,
      .enable_agc = 1,
      .protocol_version = CROSSGRAM_TGCALLS_PROTOCOL_V1,
  };
  const crossgram_tgcalls_session_auth auth = {
      .key = auth_key,
      .key_length = sizeof(auth_key),
      .is_outgoing = 1,
  };
  const crossgram_tgcalls_endpoint endpoint = {
      .id = 1,
      .ipv4 = {.data = host, .length = sizeof(host) - 1},
      .ipv6 = {0},
      .port = 443,
      .type = CROSSGRAM_TGCALLS_ENDPOINT_UDP_RELAY,
      .peer_tag = {0},
  };
  const crossgram_tgcalls_session_callbacks callbacks = {0};
  crossgram_tgcalls_shim* session = NULL;

  Check(crossgram_tgcalls_session_create(CROSSGRAM_TGCALLS_SHIM_ABI_VERSION, &config, &auth, &endpoint,
                                         1, NULL, 0, &callbacks, &session) == CROSSGRAM_TGCALLS_SHIM_STATUS_OK);
  Check(session != NULL);
  Check(crossgram_tgcalls_session_start(session) == CROSSGRAM_TGCALLS_SHIM_STATUS_BACKEND_UNAVAILABLE);
  Check(crossgram_tgcalls_session_stop(session) == CROSSGRAM_TGCALLS_SHIM_STATUS_OK);
  Check(crossgram_tgcalls_session_join(session) == CROSSGRAM_TGCALLS_SHIM_STATUS_OK);
  Check(crossgram_tgcalls_session_destroy(&session) == CROSSGRAM_TGCALLS_SHIM_STATUS_OK);
  Check(session == NULL);
  return 0;
}
