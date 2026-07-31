#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>

#include "crossgram/tgcalls_shim.h"

static void Check(int condition, int line) {
  if (!condition) {
    fprintf(stderr, "c_abi_pcm_test failed at line %d\n", line);
    exit(1);
  }
}

#define CHECK(expression) Check((expression), __LINE__)

int main(void) {
  crossgram_tgcalls_pcm_bridge* bridge = NULL;
  int16_t capture[CROSSGRAM_TGCALLS_SHIM_PCM_FRAME_SAMPLES];
  int16_t callback[CROSSGRAM_TGCALLS_SHIM_PCM_CALLBACK_SAMPLES];

  CHECK(crossgram_tgcalls_shim_abi_version() == CROSSGRAM_TGCALLS_SHIM_ABI_VERSION);
  CHECK(crossgram_tgcalls_pcm_bridge_create(
            CROSSGRAM_TGCALLS_SHIM_ABI_VERSION + 1, &bridge) ==
        CROSSGRAM_TGCALLS_SHIM_STATUS_ABI_MISMATCH);
  CHECK(bridge == NULL);
  CHECK(crossgram_tgcalls_pcm_bridge_create(
            CROSSGRAM_TGCALLS_SHIM_ABI_VERSION, &bridge) ==
        CROSSGRAM_TGCALLS_SHIM_STATUS_OK);

  for (uint32_t index = 0; index < CROSSGRAM_TGCALLS_SHIM_PCM_FRAME_SAMPLES; ++index) {
    capture[index] = index < CROSSGRAM_TGCALLS_SHIM_PCM_CALLBACK_SAMPLES ? 258 : -258;
  }
  CHECK(crossgram_tgcalls_pcm_bridge_push_capture_20ms(bridge, capture) ==
        CROSSGRAM_TGCALLS_SHIM_STATUS_OK);
  CHECK(crossgram_tgcalls_pcm_bridge_pop_capture_10ms(bridge, callback) ==
        CROSSGRAM_TGCALLS_SHIM_STATUS_OK);
  CHECK(callback[0] == 258 && callback[CROSSGRAM_TGCALLS_SHIM_PCM_CALLBACK_SAMPLES - 1] == 258);
  CHECK(crossgram_tgcalls_pcm_bridge_pop_capture_10ms(bridge, callback) ==
        CROSSGRAM_TGCALLS_SHIM_STATUS_OK);
  CHECK(callback[0] == -258 && callback[CROSSGRAM_TGCALLS_SHIM_PCM_CALLBACK_SAMPLES - 1] == -258);

  CHECK(crossgram_tgcalls_pcm_bridge_destroy(&bridge) ==
        CROSSGRAM_TGCALLS_SHIM_STATUS_INVALID_ARGUMENT);
  CHECK(crossgram_tgcalls_pcm_bridge_stop(bridge) == CROSSGRAM_TGCALLS_SHIM_STATUS_OK);
  CHECK(crossgram_tgcalls_pcm_bridge_stop(bridge) == CROSSGRAM_TGCALLS_SHIM_STATUS_OK);
  CHECK(crossgram_tgcalls_pcm_bridge_join(bridge) ==
        CROSSGRAM_TGCALLS_SHIM_STATUS_INVALID_ARGUMENT);
  CHECK(crossgram_tgcalls_pcm_bridge_destroy(&bridge) ==
        CROSSGRAM_TGCALLS_SHIM_STATUS_INVALID_ARGUMENT);
  CHECK(crossgram_tgcalls_pcm_bridge_drain(bridge) == CROSSGRAM_TGCALLS_SHIM_STATUS_OK);
  CHECK(crossgram_tgcalls_pcm_bridge_destroy(&bridge) ==
        CROSSGRAM_TGCALLS_SHIM_STATUS_INVALID_ARGUMENT);
  CHECK(crossgram_tgcalls_pcm_bridge_drain(bridge) == CROSSGRAM_TGCALLS_SHIM_STATUS_OK);
  CHECK(crossgram_tgcalls_pcm_bridge_join(bridge) == CROSSGRAM_TGCALLS_SHIM_STATUS_OK);
  CHECK(crossgram_tgcalls_pcm_bridge_join(bridge) == CROSSGRAM_TGCALLS_SHIM_STATUS_OK);
  CHECK(crossgram_tgcalls_pcm_bridge_destroy(&bridge) == CROSSGRAM_TGCALLS_SHIM_STATUS_OK);
  CHECK(bridge == NULL);
  CHECK(crossgram_tgcalls_pcm_bridge_destroy(&bridge) == CROSSGRAM_TGCALLS_SHIM_STATUS_OK);
  return 0;
}
