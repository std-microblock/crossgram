#include "pcm_bridge.h"

#include <algorithm>
#include <cstring>
#include <thread>

namespace crossgram::tgcalls_shim {
namespace {

constexpr std::size_t Next(std::size_t value) noexcept {
  return (value + 1) % (PcmBridge::kQueueCapacity + 1);
}

void Silence(int16_t* samples, std::size_t count) noexcept {
  std::fill_n(samples, count, int16_t{0});
}

}  // namespace

PcmBridge::Callback::Callback(PcmBridge* bridge) noexcept
    : bridge_(bridge->TryEnterCallback() ? bridge : nullptr) {}

PcmBridge::Callback::~Callback() {
  if (bridge_ != nullptr) bridge_->LeaveCallback();
}

PcmBridge::LifecycleOperation::LifecycleOperation(PcmBridge* bridge) noexcept
    : bridge_(bridge->TryEnterLifecycleOperation() ? bridge : nullptr) {}

PcmBridge::LifecycleOperation::~LifecycleOperation() {
  if (bridge_ != nullptr) bridge_->LeaveLifecycleOperation();
}

bool PcmBridge::TryEnterCallback() noexcept {
  uint32_t state = callback_state_.load(std::memory_order_acquire);
  for (;;) {
    if ((state & kStoppingBit) != 0 || (state & kCallbackCountMask) == kCallbackCountMask) return false;
    if (callback_state_.compare_exchange_weak(
            state, state + 1, std::memory_order_acq_rel, std::memory_order_acquire)) {
      return true;
    }
  }
}

void PcmBridge::LeaveCallback() noexcept {
  callback_state_.fetch_sub(1, std::memory_order_release);
}

bool PcmBridge::TryEnterLifecycleOperation() noexcept {
  uint32_t state = lifecycle_state_.load(std::memory_order_acquire);
  for (;;) {
    if ((state & kDestroyingBit) != 0 ||
        (state & kLifecycleOperationCountMask) == kLifecycleOperationCountMask) {
      return false;
    }
    if (lifecycle_state_.compare_exchange_weak(
            state, state + 1, std::memory_order_acq_rel, std::memory_order_acquire)) {
      return true;
    }
  }
}

void PcmBridge::LeaveLifecycleOperation() noexcept {
  lifecycle_state_.fetch_sub(1, std::memory_order_release);
}

void PcmBridge::WaitForCallbacks() noexcept {
  while ((callback_state_.load(std::memory_order_acquire) & kCallbackCountMask) != 0) {
    std::this_thread::yield();
  }
}

bool PcmBridge::CaptureQueue::Push(const Frame20ms& frame) noexcept {
  const std::size_t write = write_.load(std::memory_order_relaxed);
  const std::size_t next = Next(write);
  if (next == read_.load(std::memory_order_acquire)) return false;
  frames_[write] = frame;
  write_.store(next, std::memory_order_release);
  return true;
}

bool PcmBridge::CaptureQueue::Pop(Frame20ms* frame) noexcept {
  const std::size_t read = read_.load(std::memory_order_relaxed);
  if (read == write_.load(std::memory_order_acquire)) return false;
  *frame = frames_[read];
  read_.store(Next(read), std::memory_order_release);
  return true;
}

void PcmBridge::CaptureQueue::Reset() noexcept {
  read_.store(0, std::memory_order_relaxed);
  write_.store(0, std::memory_order_relaxed);
}

PcmBridge::PlayoutQueue::PlayoutQueue() noexcept {
  Reset();
}

bool PcmBridge::PlayoutQueue::TryPush(const Frame20ms& frame) noexcept {
  std::size_t position = enqueue_.load(std::memory_order_relaxed);
  for (;;) {
    Cell& cell = cells_[position % kQueueCapacity];
    const std::size_t sequence = cell.sequence.load(std::memory_order_acquire);
    const std::intptr_t difference = static_cast<std::intptr_t>(sequence) - static_cast<std::intptr_t>(position);
    if (difference == 0) {
      if (enqueue_.compare_exchange_weak(position, position + 1, std::memory_order_relaxed)) {
        cell.frame = frame;
        cell.sequence.store(position + 1, std::memory_order_release);
        return true;
      }
      continue;
    }
    if (difference < 0) return false;
    position = enqueue_.load(std::memory_order_relaxed);
  }
}

bool PcmBridge::PlayoutQueue::PushDroppingOldest(const Frame20ms& frame) noexcept {
  bool dropped = false;
  while (!TryPush(frame)) {
    Frame20ms discarded;
    if (Pop(&discarded)) dropped = true;
  }
  return dropped;
}

bool PcmBridge::PlayoutQueue::Pop(Frame20ms* frame) noexcept {
  std::size_t position = dequeue_.load(std::memory_order_relaxed);
  for (;;) {
    Cell& cell = cells_[position % kQueueCapacity];
    const std::size_t sequence = cell.sequence.load(std::memory_order_acquire);
    const std::intptr_t difference = static_cast<std::intptr_t>(sequence) - static_cast<std::intptr_t>(position + 1);
    if (difference == 0) {
      if (dequeue_.compare_exchange_weak(position, position + 1, std::memory_order_relaxed)) {
        *frame = cell.frame;
        cell.sequence.store(position + kQueueCapacity, std::memory_order_release);
        return true;
      }
      continue;
    }
    if (difference < 0) return false;
    position = dequeue_.load(std::memory_order_relaxed);
  }
}

void PcmBridge::PlayoutQueue::Reset() noexcept {
  for (std::size_t index = 0; index < kQueueCapacity; ++index) {
    cells_[index].sequence.store(index, std::memory_order_relaxed);
  }
  enqueue_.store(0, std::memory_order_relaxed);
  dequeue_.store(0, std::memory_order_relaxed);
}

crossgram_tgcalls_shim_status PcmBridge::PushCapture20ms(const int16_t* samples) noexcept {
  if (samples == nullptr) return CROSSGRAM_TGCALLS_SHIM_STATUS_INVALID_ARGUMENT;
  Callback callback(this);
  if (!callback.entered()) return CROSSGRAM_TGCALLS_SHIM_STATUS_STOPPED;

  Frame20ms frame;
  std::memcpy(frame.samples.data(), samples, sizeof(frame.samples));
  if (!capture_.Push(frame)) return CROSSGRAM_TGCALLS_SHIM_STATUS_INPUT_FULL;
  return CROSSGRAM_TGCALLS_SHIM_STATUS_OK;
}

crossgram_tgcalls_shim_status PcmBridge::PopCapture10ms(int16_t* samples) noexcept {
  if (samples == nullptr) return CROSSGRAM_TGCALLS_SHIM_STATUS_INVALID_ARGUMENT;
  Callback callback(this);
  if (!callback.entered()) {
    Silence(samples, kSamplesPer10ms);
    return CROSSGRAM_TGCALLS_SHIM_STATUS_STOPPED;
  }

  if (!capture_second_half_ && !capture_.Pop(&capture_current_)) {
    Silence(samples, kSamplesPer10ms);
    return CROSSGRAM_TGCALLS_SHIM_STATUS_OUTPUT_EMPTY;
  }

  const std::size_t offset = capture_second_half_ ? kSamplesPer10ms : 0;
  std::memcpy(samples, capture_current_.samples.data() + offset, kSamplesPer10ms * sizeof(*samples));
  capture_second_half_ = !capture_second_half_;
  return CROSSGRAM_TGCALLS_SHIM_STATUS_OK;
}

crossgram_tgcalls_shim_status PcmBridge::PushPlayout10ms(const int16_t* samples) noexcept {
  if (samples == nullptr) return CROSSGRAM_TGCALLS_SHIM_STATUS_INVALID_ARGUMENT;
  Callback callback(this);
  if (!callback.entered()) return CROSSGRAM_TGCALLS_SHIM_STATUS_STOPPED;

  const std::size_t offset = playout_pending_first_half_ ? kSamplesPer10ms : 0;
  std::memcpy(playout_pending_.data() + offset, samples, kSamplesPer10ms * sizeof(*samples));
  if (!playout_pending_first_half_) {
    playout_pending_first_half_ = true;
    return CROSSGRAM_TGCALLS_SHIM_STATUS_OK;
  }

  playout_pending_first_half_ = false;
  Frame20ms frame;
  frame.samples = playout_pending_;
  const bool dropped = playout_.PushDroppingOldest(frame);
  if (dropped) dropped_playout_frames_.fetch_add(1, std::memory_order_relaxed);
  return CROSSGRAM_TGCALLS_SHIM_STATUS_OK;
}

crossgram_tgcalls_shim_status PcmBridge::PopPlayout20ms(int16_t* samples) noexcept {
  if (samples == nullptr) return CROSSGRAM_TGCALLS_SHIM_STATUS_INVALID_ARGUMENT;
  Callback callback(this);
  if (!callback.entered()) {
    Silence(samples, kSamplesPer20ms);
    return CROSSGRAM_TGCALLS_SHIM_STATUS_STOPPED;
  }

  Frame20ms frame;
  if (!playout_.Pop(&frame)) {
    Silence(samples, kSamplesPer20ms);
    return CROSSGRAM_TGCALLS_SHIM_STATUS_OUTPUT_EMPTY;
  }
  std::memcpy(samples, frame.samples.data(), sizeof(frame.samples));
  return CROSSGRAM_TGCALLS_SHIM_STATUS_OK;
}

bool PcmBridge::Stop() noexcept {
  LifecycleOperation operation(this);
  if (!operation.entered()) return false;

  std::lock_guard<std::mutex> lock(lifecycle_mutex_);
  callback_state_.fetch_or(kStoppingBit, std::memory_order_acq_rel);
  return true;
}

bool PcmBridge::Drain() noexcept {
  LifecycleOperation operation(this);
  if (!operation.entered()) return false;

  std::lock_guard<std::mutex> lock(lifecycle_mutex_);
  if (!stopped()) return false;
  WaitForCallbacks();
  capture_.Reset();
  playout_.Reset();
  capture_current_ = {};
  capture_second_half_ = false;
  playout_pending_.fill(0);
  playout_pending_first_half_ = false;
  drained_.store(true, std::memory_order_release);
  return true;
}

bool PcmBridge::Join() noexcept {
  LifecycleOperation operation(this);
  if (!operation.entered()) return false;

  std::lock_guard<std::mutex> lock(lifecycle_mutex_);
  if (!stopped() || !drained_.load(std::memory_order_acquire)) return false;
  WaitForCallbacks();
  joined_.store(true, std::memory_order_release);
  return true;
}

bool PcmBridge::Destroy() noexcept {
  if (!TryEnterLifecycleOperation()) return false;

  bool destroying = false;
  {
    std::lock_guard<std::mutex> lock(lifecycle_mutex_);
    const uint32_t state = lifecycle_state_.load(std::memory_order_acquire);
    if (joined_.load(std::memory_order_acquire) && (state & kDestroyingBit) == 0) {
      lifecycle_state_.fetch_or(kDestroyingBit, std::memory_order_release);
      destroying = true;
    }
  }
  LeaveLifecycleOperation();
  if (!destroying) return false;

  while ((lifecycle_state_.load(std::memory_order_acquire) & kLifecycleOperationCountMask) != 0) {
    std::this_thread::yield();
  }
  WaitForCallbacks();
  return true;
}

bool PcmBridge::stopped() const noexcept {
  return (callback_state_.load(std::memory_order_acquire) & kStoppingBit) != 0;
}

bool PcmBridge::joined() const noexcept {
  return joined_.load(std::memory_order_acquire);
}

uint64_t PcmBridge::dropped_playout_frames() const noexcept {
  return dropped_playout_frames_.load(std::memory_order_relaxed);
}

}  // namespace crossgram::tgcalls_shim
