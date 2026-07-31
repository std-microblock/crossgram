#include <atomic>
#include <cstdlib>
#include <iostream>
#include <thread>

#include "crossgram/tgcalls_shim.h"

namespace {

[[noreturn]] void Fail(const char* expression, int line) {
  std::cerr << "tsan_concurrent_drain_test failed at line " << line << ": " << expression << '\n';
  std::exit(1);
}

#define CHECK(expression) do { if (!(expression)) Fail(#expression, __LINE__); } while (false)

void TestConcurrentDrainIsSerialized() {
  constexpr int kRounds = 1000;
  for (int round = 0; round < kRounds; ++round) {
    crossgram_tgcalls_pcm_bridge* bridge = nullptr;
    CHECK(crossgram_tgcalls_pcm_bridge_create(
        CROSSGRAM_TGCALLS_SHIM_ABI_VERSION, &bridge) == CROSSGRAM_TGCALLS_SHIM_STATUS_OK);
    CHECK(crossgram_tgcalls_pcm_bridge_stop(bridge) == CROSSGRAM_TGCALLS_SHIM_STATUS_OK);

    std::atomic<bool> start{false};
    std::thread first([&] {
      while (!start.load(std::memory_order_acquire)) std::this_thread::yield();
      CHECK(crossgram_tgcalls_pcm_bridge_drain(bridge) == CROSSGRAM_TGCALLS_SHIM_STATUS_OK);
    });
    std::thread second([&] {
      while (!start.load(std::memory_order_acquire)) std::this_thread::yield();
      CHECK(crossgram_tgcalls_pcm_bridge_drain(bridge) == CROSSGRAM_TGCALLS_SHIM_STATUS_OK);
    });

    start.store(true, std::memory_order_release);
    first.join();
    second.join();
    CHECK(crossgram_tgcalls_pcm_bridge_join(bridge) == CROSSGRAM_TGCALLS_SHIM_STATUS_OK);
    CHECK(crossgram_tgcalls_pcm_bridge_destroy(&bridge) == CROSSGRAM_TGCALLS_SHIM_STATUS_OK);
  }
}

}  // namespace

int main() {
  TestConcurrentDrainIsSerialized();
  return 0;
}
