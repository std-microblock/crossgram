#ifndef CROSSGRAM_TGCALLS_SHIM_PCM_BRIDGE_H_
#define CROSSGRAM_TGCALLS_SHIM_PCM_BRIDGE_H_

#include <array>
#include <atomic>
#include <cstddef>
#include <cstdint>
#include <mutex>

#include "crossgram/tgcalls_shim.h"

namespace crossgram::tgcalls_shim {

class PcmBridge final {
 public:
  static constexpr std::size_t kSamplesPer10ms = CROSSGRAM_TGCALLS_SHIM_PCM_CALLBACK_SAMPLES;
  static constexpr std::size_t kSamplesPer20ms = CROSSGRAM_TGCALLS_SHIM_PCM_FRAME_SAMPLES;
  static constexpr std::size_t kQueueCapacity = CROSSGRAM_TGCALLS_SHIM_PCM_QUEUE_CAPACITY;

  PcmBridge() = default;
  PcmBridge(const PcmBridge&) = delete;
  PcmBridge& operator=(const PcmBridge&) = delete;

  // Called by the external PCM producer with one 20 ms capture frame.
  crossgram_tgcalls_shim_status PushCapture20ms(const int16_t* samples) noexcept;
  // Called by the upstream recorder callback to receive one 10 ms capture slice.
  crossgram_tgcalls_shim_status PopCapture10ms(int16_t* samples) noexcept;

  // Called by the upstream renderer callback with one 10 ms playout slice.
  crossgram_tgcalls_shim_status PushPlayout10ms(const int16_t* samples) noexcept;
  // Called by the external PCM consumer to receive one 20 ms playout frame.
  crossgram_tgcalls_shim_status PopPlayout20ms(int16_t* samples) noexcept;

  [[nodiscard]] bool Stop() noexcept;
  [[nodiscard]] bool Drain() noexcept;
  [[nodiscard]] bool Join() noexcept;
  [[nodiscard]] bool Destroy() noexcept;
  [[nodiscard]] bool stopped() const noexcept;
  [[nodiscard]] bool joined() const noexcept;
  [[nodiscard]] uint64_t dropped_playout_frames() const noexcept;

 private:
  struct Frame20ms {
    std::array<int16_t, kSamplesPer20ms> samples{};
  };

  class Callback final {
   public:
    explicit Callback(PcmBridge* bridge) noexcept;
    ~Callback();

    [[nodiscard]] bool entered() const noexcept { return bridge_ != nullptr; }

   private:
    PcmBridge* bridge_;
  };

  class LifecycleOperation final {
   public:
    explicit LifecycleOperation(PcmBridge* bridge) noexcept;
    ~LifecycleOperation();

    [[nodiscard]] bool entered() const noexcept { return bridge_ != nullptr; }

   private:
    PcmBridge* bridge_;
  };

  class CaptureQueue final {
   public:
    bool Push(const Frame20ms& frame) noexcept;
    bool Pop(Frame20ms* frame) noexcept;
    void Reset() noexcept;

   private:
    std::array<Frame20ms, kQueueCapacity + 1> frames_{};
    std::atomic<std::size_t> read_{0};
    std::atomic<std::size_t> write_{0};
  };

  class PlayoutQueue final {
   public:
    PlayoutQueue() noexcept;

    bool PushDroppingOldest(const Frame20ms& frame) noexcept;
    bool Pop(Frame20ms* frame) noexcept;
    void Reset() noexcept;

   private:
    struct Cell {
      std::atomic<std::size_t> sequence{0};
      Frame20ms frame{};
    };

    bool TryPush(const Frame20ms& frame) noexcept;
    std::array<Cell, kQueueCapacity> cells_{};
    std::atomic<std::size_t> enqueue_{0};
    std::atomic<std::size_t> dequeue_{0};
  };

  [[nodiscard]] bool TryEnterCallback() noexcept;
  void LeaveCallback() noexcept;
  [[nodiscard]] bool TryEnterLifecycleOperation() noexcept;
  void LeaveLifecycleOperation() noexcept;
  void WaitForCallbacks() noexcept;

  static constexpr uint32_t kStoppingBit = uint32_t{1} << 31;
  static constexpr uint32_t kCallbackCountMask = ~kStoppingBit;
  static constexpr uint32_t kDestroyingBit = uint32_t{1} << 31;
  static constexpr uint32_t kLifecycleOperationCountMask = ~kDestroyingBit;
  std::atomic<uint32_t> callback_state_{0};
  std::atomic<uint32_t> lifecycle_state_{0};
  std::mutex lifecycle_mutex_;
  std::atomic<bool> drained_{false};
  std::atomic<bool> joined_{false};
  CaptureQueue capture_;
  PlayoutQueue playout_;
  Frame20ms capture_current_{};
  bool capture_second_half_{false};
  std::array<int16_t, kSamplesPer20ms> playout_pending_{};
  bool playout_pending_first_half_{false};
  std::atomic<uint64_t> dropped_playout_frames_{0};
};

}  // namespace crossgram::tgcalls_shim

#endif  // CROSSGRAM_TGCALLS_SHIM_PCM_BRIDGE_H_
