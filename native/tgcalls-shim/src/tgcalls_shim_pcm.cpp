#include "crossgram/tgcalls_shim.h"

#include <new>

#include "pcm_bridge.h"

struct crossgram_tgcalls_pcm_bridge {
  crossgram::tgcalls_shim::PcmBridge bridge;
};

namespace {

template <typename Function>
crossgram_tgcalls_shim_status CatchStatus(Function&& function) noexcept {
  try {
    return function();
  } catch (const std::bad_alloc&) {
    return CROSSGRAM_TGCALLS_SHIM_STATUS_ALLOCATION_FAILED;
  } catch (...) {
    return CROSSGRAM_TGCALLS_SHIM_STATUS_INTERNAL_ERROR;
  }
}

}  // namespace

extern "C" {

uint32_t crossgram_tgcalls_shim_abi_version(void) {
  return CROSSGRAM_TGCALLS_SHIM_ABI_VERSION;
}

crossgram_tgcalls_shim_status crossgram_tgcalls_pcm_bridge_create(
    uint32_t abi_version,
    crossgram_tgcalls_pcm_bridge** out_bridge) {
  return CatchStatus([&] {
    if (out_bridge == nullptr) return CROSSGRAM_TGCALLS_SHIM_STATUS_INVALID_ARGUMENT;
    *out_bridge = nullptr;
    if (abi_version != CROSSGRAM_TGCALLS_SHIM_ABI_VERSION) {
      return CROSSGRAM_TGCALLS_SHIM_STATUS_ABI_MISMATCH;
    }

    auto* bridge = new (std::nothrow) crossgram_tgcalls_pcm_bridge;
    if (bridge == nullptr) return CROSSGRAM_TGCALLS_SHIM_STATUS_ALLOCATION_FAILED;
    *out_bridge = bridge;
    return CROSSGRAM_TGCALLS_SHIM_STATUS_OK;
  });
}

crossgram_tgcalls_shim_status crossgram_tgcalls_pcm_bridge_push_capture_20ms(
    crossgram_tgcalls_pcm_bridge* bridge,
    const int16_t* samples) {
  return CatchStatus([&] {
    return bridge == nullptr ? CROSSGRAM_TGCALLS_SHIM_STATUS_INVALID_ARGUMENT
                             : bridge->bridge.PushCapture20ms(samples);
  });
}

crossgram_tgcalls_shim_status crossgram_tgcalls_pcm_bridge_pop_capture_10ms(
    crossgram_tgcalls_pcm_bridge* bridge,
    int16_t* samples) {
  return CatchStatus([&] {
    return bridge == nullptr ? CROSSGRAM_TGCALLS_SHIM_STATUS_INVALID_ARGUMENT
                             : bridge->bridge.PopCapture10ms(samples);
  });
}

crossgram_tgcalls_shim_status crossgram_tgcalls_pcm_bridge_push_playout_10ms(
    crossgram_tgcalls_pcm_bridge* bridge,
    const int16_t* samples) {
  return CatchStatus([&] {
    return bridge == nullptr ? CROSSGRAM_TGCALLS_SHIM_STATUS_INVALID_ARGUMENT
                             : bridge->bridge.PushPlayout10ms(samples);
  });
}

crossgram_tgcalls_shim_status crossgram_tgcalls_pcm_bridge_pop_playout_20ms(
    crossgram_tgcalls_pcm_bridge* bridge,
    int16_t* samples) {
  return CatchStatus([&] {
    return bridge == nullptr ? CROSSGRAM_TGCALLS_SHIM_STATUS_INVALID_ARGUMENT
                             : bridge->bridge.PopPlayout20ms(samples);
  });
}

crossgram_tgcalls_shim_status crossgram_tgcalls_pcm_bridge_stop(crossgram_tgcalls_pcm_bridge* bridge) {
  return CatchStatus([&] {
    if (bridge == nullptr) return CROSSGRAM_TGCALLS_SHIM_STATUS_INVALID_ARGUMENT;
    return bridge->bridge.Stop() ? CROSSGRAM_TGCALLS_SHIM_STATUS_OK
                                 : CROSSGRAM_TGCALLS_SHIM_STATUS_INVALID_ARGUMENT;
  });
}

crossgram_tgcalls_shim_status crossgram_tgcalls_pcm_bridge_drain(crossgram_tgcalls_pcm_bridge* bridge) {
  return CatchStatus([&] {
    if (bridge == nullptr || !bridge->bridge.Drain()) {
      return CROSSGRAM_TGCALLS_SHIM_STATUS_INVALID_ARGUMENT;
    }
    return CROSSGRAM_TGCALLS_SHIM_STATUS_OK;
  });
}

crossgram_tgcalls_shim_status crossgram_tgcalls_pcm_bridge_join(crossgram_tgcalls_pcm_bridge* bridge) {
  return CatchStatus([&] {
    if (bridge == nullptr || !bridge->bridge.Join()) {
      return CROSSGRAM_TGCALLS_SHIM_STATUS_INVALID_ARGUMENT;
    }
    return CROSSGRAM_TGCALLS_SHIM_STATUS_OK;
  });
}

crossgram_tgcalls_shim_status crossgram_tgcalls_pcm_bridge_destroy(crossgram_tgcalls_pcm_bridge** bridge) {
  return CatchStatus([&] {
    if (bridge == nullptr) return CROSSGRAM_TGCALLS_SHIM_STATUS_INVALID_ARGUMENT;
    if (*bridge == nullptr) return CROSSGRAM_TGCALLS_SHIM_STATUS_OK;
    if (!(*bridge)->bridge.Destroy()) return CROSSGRAM_TGCALLS_SHIM_STATUS_INVALID_ARGUMENT;
    delete *bridge;
    *bridge = nullptr;
    return CROSSGRAM_TGCALLS_SHIM_STATUS_OK;
  });
}

uint64_t crossgram_tgcalls_pcm_bridge_dropped_playout_frames(
    const crossgram_tgcalls_pcm_bridge* bridge) {
  try {
    return bridge == nullptr ? 0 : bridge->bridge.dropped_playout_frames();
  } catch (...) {
    return 0;
  }
}

}  // extern "C"
