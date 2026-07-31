#include <atomic>
#include <cstdlib>
#include <iostream>
#include <thread>

#include "crossgram/tgcalls_shim.h"

namespace {

[[noreturn]] void Fail(const char* expression, int line) {
  std::cerr << "asan_destroy_drain_test failed at line " << line << ": " << expression << '\n';
  std::exit(1);
}

#define CHECK(expression) do { if (!(expression)) Fail(#expression, __LINE__); } while (false)

void TestDestroyWaitsForDrain() {
  constexpr int kRounds = 2000;
  for (int round = 0; round < kRounds; ++round) {
    crossgram_tgcalls_pcm_bridge* bridge = nullptr;
    CHECK(crossgram_tgcalls_pcm_bridge_create(
        CROSSGRAM_TGCALLS_SHIM_ABI_VERSION, &bridge) == CROSSGRAM_TGCALLS_SHIM_STATUS_OK);
    CHECK(crossgram_tgcalls_pcm_bridge_stop(bridge) == CROSSGRAM_TGCALLS_SHIM_STATUS_OK);
    auto* const draining_bridge = bridge;

    std::atomic<bool> start{false};
    std::thread drainer([&] {
      while (!start.load(std::memory_order_acquire)) std::this_thread::yield();
      CHECK(crossgram_tgcalls_pcm_bridge_drain(draining_bridge) == CROSSGRAM_TGCALLS_SHIM_STATUS_OK);
      CHECK(crossgram_tgcalls_pcm_bridge_join(draining_bridge) == CROSSGRAM_TGCALLS_SHIM_STATUS_OK);
    });
    std::thread destroyer([&] {
      while (!start.load(std::memory_order_acquire)) std::this_thread::yield();
      while (crossgram_tgcalls_pcm_bridge_destroy(&bridge) ==
             CROSSGRAM_TGCALLS_SHIM_STATUS_INVALID_ARGUMENT) {
        std::this_thread::yield();
      }
    });

    start.store(true, std::memory_order_release);
    drainer.join();
    destroyer.join();
  }
}

}  // namespace

int main() {
  TestDestroyWaitsForDrain();
  return 0;
}
