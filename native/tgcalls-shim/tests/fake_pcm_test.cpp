#include "pcm_bridge.h"

#include <algorithm>
#include <array>
#include <atomic>
#include <cstdlib>
#include <cstring>
#include <iostream>
#include <thread>

namespace {

using crossgram::tgcalls_shim::PcmBridge;

[[noreturn]] void Fail(const char* expression, int line) {
  std::cerr << "fake_pcm_test failed at line " << line << ": " << expression << '\n';
  std::exit(1);
}

#define CHECK(expression) do { if (!(expression)) Fail(#expression, __LINE__); } while (false)

using Frame10 = std::array<int16_t, PcmBridge::kSamplesPer10ms>;
using Frame20 = std::array<int16_t, PcmBridge::kSamplesPer20ms>;

Frame10 Frame10With(int16_t value) {
  Frame10 frame{};
  frame.fill(value);
  return frame;
}

Frame20 Frame20With(int16_t first, int16_t second) {
  Frame20 frame{};
  frame.fill(first);
  std::fill(frame.begin() + PcmBridge::kSamplesPer10ms, frame.end(), second);
  return frame;
}

void CheckAll(const Frame10& frame, int16_t value) {
  for (const int16_t sample : frame) CHECK(sample == value);
}

void CheckAll(const Frame20& frame, int16_t value) {
  for (const int16_t sample : frame) CHECK(sample == value);
}

void TestCaptureSplitOrder() {
  PcmBridge bridge;
  const Frame20 input = Frame20With(101, 202);
  Frame10 output{};

  CHECK(bridge.PushCapture20ms(input.data()) == CROSSGRAM_TGCALLS_SHIM_STATUS_OK);
  CHECK(bridge.PopCapture10ms(output.data()) == CROSSGRAM_TGCALLS_SHIM_STATUS_OK);
  CheckAll(output, 101);
  CHECK(bridge.PopCapture10ms(output.data()) == CROSSGRAM_TGCALLS_SHIM_STATUS_OK);
  CheckAll(output, 202);
}

void TestPlayoutAggregationOrder() {
  PcmBridge bridge;
  const Frame10 first = Frame10With(303);
  const Frame10 second = Frame10With(404);
  Frame20 output{};

  CHECK(bridge.PushPlayout10ms(first.data()) == CROSSGRAM_TGCALLS_SHIM_STATUS_OK);
  CHECK(bridge.PopPlayout20ms(output.data()) == CROSSGRAM_TGCALLS_SHIM_STATUS_OUTPUT_EMPTY);
  CheckAll(output, 0);
  CHECK(bridge.PushPlayout10ms(second.data()) == CROSSGRAM_TGCALLS_SHIM_STATUS_OK);
  CHECK(bridge.PopPlayout20ms(output.data()) == CROSSGRAM_TGCALLS_SHIM_STATUS_OK);
  for (std::size_t index = 0; index < PcmBridge::kSamplesPer10ms; ++index) CHECK(output[index] == 303);
  for (std::size_t index = PcmBridge::kSamplesPer10ms; index < output.size(); ++index) CHECK(output[index] == 404);
}

void TestUnderflowAndOverflow() {
  PcmBridge bridge;
  Frame10 capture{};
  Frame20 playout{};

  CHECK(bridge.PopCapture10ms(capture.data()) == CROSSGRAM_TGCALLS_SHIM_STATUS_OUTPUT_EMPTY);
  CheckAll(capture, 0);
  CHECK(bridge.PopPlayout20ms(playout.data()) == CROSSGRAM_TGCALLS_SHIM_STATUS_OUTPUT_EMPTY);
  CheckAll(playout, 0);

  for (int16_t value = 1; value <= static_cast<int16_t>(PcmBridge::kQueueCapacity); ++value) {
    const Frame20 input = Frame20With(value, value);
    CHECK(bridge.PushCapture20ms(input.data()) == CROSSGRAM_TGCALLS_SHIM_STATUS_OK);
  }
  const Frame20 full = Frame20With(9, 9);
  CHECK(bridge.PushCapture20ms(full.data()) == CROSSGRAM_TGCALLS_SHIM_STATUS_INPUT_FULL);

  for (int16_t value = 1; value <= 5; ++value) {
    const Frame10 input = Frame10With(value);
    CHECK(bridge.PushPlayout10ms(input.data()) == CROSSGRAM_TGCALLS_SHIM_STATUS_OK);
    CHECK(bridge.PushPlayout10ms(input.data()) == CROSSGRAM_TGCALLS_SHIM_STATUS_OK);
  }
  CHECK(bridge.dropped_playout_frames() == 1);
  for (int16_t value = 2; value <= 5; ++value) {
    CHECK(bridge.PopPlayout20ms(playout.data()) == CROSSGRAM_TGCALLS_SHIM_STATUS_OK);
    CheckAll(playout, value);
  }
}

void TestWraparound() {
  PcmBridge bridge;
  Frame20 output{};
  for (int16_t value = 1; value <= 32; ++value) {
    const Frame10 input = Frame10With(value);
    CHECK(bridge.PushPlayout10ms(input.data()) == CROSSGRAM_TGCALLS_SHIM_STATUS_OK);
    CHECK(bridge.PushPlayout10ms(input.data()) == CROSSGRAM_TGCALLS_SHIM_STATUS_OK);
    CHECK(bridge.PopPlayout20ms(output.data()) == CROSSGRAM_TGCALLS_SHIM_STATUS_OK);
    CheckAll(output, value);
  }
  CHECK(bridge.dropped_playout_frames() == 0);
}

void TestStopAndTeardown() {
  Frame20 output{};
  {
    PcmBridge bridge;
    const Frame20 capture = Frame20With(5, 6);
    const Frame10 playout = Frame10With(7);
    CHECK(bridge.PushCapture20ms(capture.data()) == CROSSGRAM_TGCALLS_SHIM_STATUS_OK);
    CHECK(bridge.PushPlayout10ms(playout.data()) == CROSSGRAM_TGCALLS_SHIM_STATUS_OK);
    CHECK(bridge.Stop());
    CHECK(bridge.stopped());
    CHECK(bridge.PushCapture20ms(capture.data()) == CROSSGRAM_TGCALLS_SHIM_STATUS_STOPPED);
    CHECK(bridge.PushPlayout10ms(playout.data()) == CROSSGRAM_TGCALLS_SHIM_STATUS_STOPPED);
    CHECK(bridge.PopPlayout20ms(output.data()) == CROSSGRAM_TGCALLS_SHIM_STATUS_STOPPED);
    CheckAll(output, 0);
  }
}

void TestSpscCapture() {
  constexpr int kFrames = 10'000;
  PcmBridge bridge;
  std::atomic<bool> producer_done{false};
  std::atomic<bool> failed{false};

  std::thread producer([&] {
    for (int value = 1; value <= kFrames; ++value) {
      const Frame20 input = Frame20With(static_cast<int16_t>(value), static_cast<int16_t>(value));
      while (bridge.PushCapture20ms(input.data()) == CROSSGRAM_TGCALLS_SHIM_STATUS_INPUT_FULL) std::this_thread::yield();
    }
    producer_done.store(true, std::memory_order_release);
  });

  std::thread consumer([&] {
    for (int value = 1; value <= kFrames; ++value) {
      Frame10 first{};
      Frame10 second{};
      while (bridge.PopCapture10ms(first.data()) == CROSSGRAM_TGCALLS_SHIM_STATUS_OUTPUT_EMPTY) std::this_thread::yield();
      while (bridge.PopCapture10ms(second.data()) == CROSSGRAM_TGCALLS_SHIM_STATUS_OUTPUT_EMPTY) std::this_thread::yield();
      if (first[0] != value || second[0] != value) failed.store(true, std::memory_order_release);
    }
  });

  producer.join();
  consumer.join();
  CHECK(producer_done.load(std::memory_order_acquire));
  CHECK(!failed.load(std::memory_order_acquire));
}

void TestSpscPlayout() {
  constexpr int kFrames = 10'000;
  PcmBridge bridge;
  std::atomic<bool> producer_done{false};
  std::atomic<bool> failed{false};

  std::thread producer([&] {
    for (int value = 1; value <= kFrames; ++value) {
      const Frame10 input = Frame10With(static_cast<int16_t>(value));
      if (bridge.PushPlayout10ms(input.data()) != CROSSGRAM_TGCALLS_SHIM_STATUS_OK
        || bridge.PushPlayout10ms(input.data()) != CROSSGRAM_TGCALLS_SHIM_STATUS_OK) {
        failed.store(true, std::memory_order_release);
      }
    }
    producer_done.store(true, std::memory_order_release);
  });

  std::thread consumer([&] {
    int16_t previous = 0;
    while (!producer_done.load(std::memory_order_acquire)) {
      Frame20 output{};
      if (bridge.PopPlayout20ms(output.data()) != CROSSGRAM_TGCALLS_SHIM_STATUS_OK) continue;
      if (output.front() <= previous || output.back() != output.front()) failed.store(true, std::memory_order_release);
      previous = output.front();
    }
    for (;;) {
      Frame20 output{};
      if (bridge.PopPlayout20ms(output.data()) == CROSSGRAM_TGCALLS_SHIM_STATUS_OUTPUT_EMPTY) break;
      if (output.front() <= previous || output.back() != output.front()) failed.store(true, std::memory_order_release);
      previous = output.front();
    }
  });

  producer.join();
  consumer.join();
  CHECK(!failed.load(std::memory_order_acquire));
}

void TestCAbiTeardownStress() {
  constexpr int kRounds = 500;
  for (int round = 0; round < kRounds; ++round) {
    crossgram_tgcalls_pcm_bridge* bridge = nullptr;
    CHECK(crossgram_tgcalls_pcm_bridge_create(
        CROSSGRAM_TGCALLS_SHIM_ABI_VERSION, &bridge) == CROSSGRAM_TGCALLS_SHIM_STATUS_OK);

    std::atomic<bool> start{false};
    std::thread producer([&] {
      Frame20 input = Frame20With(1, 1);
      while (!start.load(std::memory_order_acquire)) std::this_thread::yield();
      for (;;) {
        const auto status = crossgram_tgcalls_pcm_bridge_push_capture_20ms(bridge, input.data());
        if (status == CROSSGRAM_TGCALLS_SHIM_STATUS_STOPPED) return;
        CHECK(status == CROSSGRAM_TGCALLS_SHIM_STATUS_OK || status == CROSSGRAM_TGCALLS_SHIM_STATUS_INPUT_FULL);
      }
    });
    std::thread consumer([&] {
      Frame10 output{};
      while (!start.load(std::memory_order_acquire)) std::this_thread::yield();
      for (;;) {
        const auto status = crossgram_tgcalls_pcm_bridge_pop_capture_10ms(bridge, output.data());
        if (status == CROSSGRAM_TGCALLS_SHIM_STATUS_STOPPED) return;
        CHECK(status == CROSSGRAM_TGCALLS_SHIM_STATUS_OK || status == CROSSGRAM_TGCALLS_SHIM_STATUS_OUTPUT_EMPTY);
      }
    });

    start.store(true, std::memory_order_release);
    for (int yield = 0; yield < 8; ++yield) std::this_thread::yield();
    CHECK(crossgram_tgcalls_pcm_bridge_stop(bridge) == CROSSGRAM_TGCALLS_SHIM_STATUS_OK);
    CHECK(crossgram_tgcalls_pcm_bridge_drain(bridge) == CROSSGRAM_TGCALLS_SHIM_STATUS_OK);
    CHECK(crossgram_tgcalls_pcm_bridge_join(bridge) == CROSSGRAM_TGCALLS_SHIM_STATUS_OK);
    producer.join();
    consumer.join();
    CHECK(crossgram_tgcalls_pcm_bridge_destroy(&bridge) == CROSSGRAM_TGCALLS_SHIM_STATUS_OK);
  }
}

}  // namespace

int main() {
  TestCaptureSplitOrder();
  TestPlayoutAggregationOrder();
  TestUnderflowAndOverflow();
  TestWraparound();
  TestStopAndTeardown();
  TestSpscCapture();
  TestSpscPlayout();
  TestCAbiTeardownStress();
  return 0;
}
