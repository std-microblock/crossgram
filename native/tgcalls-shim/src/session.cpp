#include "session.h"

#include <algorithm>
#include <cstring>
#include <utility>

namespace crossgram::tgcalls_shim {
namespace {

class UnavailableSessionAdapter final : public SessionAdapter {
 public:
  void Bind(Session*) noexcept override {}

  crossgram_tgcalls_shim_status Start() override {
    return CROSSGRAM_TGCALLS_SHIM_STATUS_BACKEND_UNAVAILABLE;
  }

  crossgram_tgcalls_shim_status ReceiveSignaling(const uint8_t*, uint32_t) override {
    return CROSSGRAM_TGCALLS_SHIM_STATUS_BACKEND_UNAVAILABLE;
  }

  void Stop() override {}
  void Join() override {}
};

void WipeBytes(void* data, std::size_t length) noexcept {
  volatile auto* bytes = static_cast<volatile uint8_t*>(data);
  while (length-- != 0) *bytes++ = 0;
}

}  // namespace

SessionParameters::~SessionParameters() {
  Wipe();
}

void SessionParameters::Wipe() noexcept {
  WipeBytes(&config, sizeof(config));
  WipeBytes(auth_key.data(), auth_key.size());
  WipeBytes(&is_outgoing, sizeof(is_outgoing));
  for (auto& endpoint : endpoints) {
    WipeBytes(&endpoint.id, sizeof(endpoint.id));
    WipeBytes(endpoint.peer_tag.data(), endpoint.peer_tag.size());
    if (!endpoint.ipv4.empty()) WipeBytes(endpoint.ipv4.data(), endpoint.ipv4.size());
    if (!endpoint.ipv6.empty()) WipeBytes(endpoint.ipv6.data(), endpoint.ipv6.size());
    WipeBytes(&endpoint.port, sizeof(endpoint.port));
    WipeBytes(&endpoint.type, sizeof(endpoint.type));
  }
  endpoints.clear();
}

Session::Session(SessionParameters parameters,
                 crossgram_tgcalls_session_callbacks callbacks,
                 std::unique_ptr<SessionAdapter> adapter) noexcept
    : parameters_(std::move(parameters)), callbacks_(callbacks), adapter_(std::move(adapter)) {
  if (adapter_) adapter_->Bind(this);
}

Session::~Session() {
  static_cast<void>(Stop());
  static_cast<void>(Join());
  Wipe();
}

crossgram_tgcalls_shim_status Session::Start() {
  {
    std::unique_lock lock(mutex_);
    if (state_ == State::kStarted) return CROSSGRAM_TGCALLS_SHIM_STATUS_OK;
    if (state_ != State::kCreated) return CROSSGRAM_TGCALLS_SHIM_STATUS_INVALID_STATE;
    state_ = State::kStarting;
  }

  crossgram_tgcalls_shim_status status = CROSSGRAM_TGCALLS_SHIM_STATUS_BACKEND_UNAVAILABLE;
  try {
    std::lock_guard adapter_lock(adapter_mutex_);
    if (adapter_) status = adapter_->Start();
  } catch (...) {
    status = CROSSGRAM_TGCALLS_SHIM_STATUS_INTERNAL_ERROR;
  }
  if (status == CROSSGRAM_TGCALLS_SHIM_STATUS_OK) {
    std::lock_guard lock(mutex_);
    state_ = State::kStarted;
    lifecycle_changed_.notify_all();
    return status;
  }

  Report(status);
  {
    std::lock_guard lock(mutex_);
    state_ = State::kStopping;
  }
  static_cast<void>(pcm_.Stop());
  try {
    std::lock_guard adapter_lock(adapter_mutex_);
    if (adapter_) adapter_->Stop();
  } catch (...) {
    status = CROSSGRAM_TGCALLS_SHIM_STATUS_INTERNAL_ERROR;
  }
  {
    std::lock_guard lock(mutex_);
    state_ = State::kStopped;
    lifecycle_changed_.notify_all();
  }
  Wipe();
  return status;
}

crossgram_tgcalls_shim_status Session::ReceiveSignaling(const uint8_t* data, uint32_t length) {
  if (data == nullptr || length == 0 || length > CROSSGRAM_TGCALLS_SHIM_MAX_SIGNAL_BYTES) {
    return CROSSGRAM_TGCALLS_SHIM_STATUS_INVALID_ARGUMENT;
  }

  std::vector<uint8_t> copy(data, data + length);
  crossgram_tgcalls_shim_status status = CROSSGRAM_TGCALLS_SHIM_STATUS_INTERNAL_ERROR;
  try {
    std::lock_guard adapter_lock(adapter_mutex_);
    {
      std::lock_guard lock(mutex_);
      if (state_ != State::kStarted) {
        WipeBytes(copy.data(), copy.size());
        return CROSSGRAM_TGCALLS_SHIM_STATUS_INVALID_STATE;
      }
    }
    status = adapter_ == nullptr ? CROSSGRAM_TGCALLS_SHIM_STATUS_BACKEND_UNAVAILABLE
                                 : adapter_->ReceiveSignaling(copy.data(), length);
  } catch (...) {
    status = CROSSGRAM_TGCALLS_SHIM_STATUS_INTERNAL_ERROR;
  }
  WipeBytes(copy.data(), copy.size());
  if (status != CROSSGRAM_TGCALLS_SHIM_STATUS_OK) Report(status);
  return status;
}

crossgram_tgcalls_shim_status Session::PushCapture20ms(const int16_t* samples) noexcept {
  {
    std::lock_guard lock(mutex_);
    if (state_ != State::kStarted) return CROSSGRAM_TGCALLS_SHIM_STATUS_INVALID_STATE;
  }
  return pcm_.PushCapture20ms(samples);
}

crossgram_tgcalls_shim_status Session::PopPlayout20ms(int16_t* samples) noexcept {
  {
    std::lock_guard lock(mutex_);
    if (state_ != State::kStarted) {
      if (samples != nullptr) std::fill_n(samples, PcmBridge::kSamplesPer20ms, int16_t{0});
      return CROSSGRAM_TGCALLS_SHIM_STATUS_INVALID_STATE;
    }
  }
  return pcm_.PopPlayout20ms(samples);
}

crossgram_tgcalls_shim_status Session::Stop() noexcept {
  {
    std::unique_lock lock(mutex_);
    lifecycle_changed_.wait(lock, [this] {
      return state_ != State::kStarting && state_ != State::kStopping;
    });
    if (state_ == State::kStopped || state_ == State::kJoined) {
      return CROSSGRAM_TGCALLS_SHIM_STATUS_OK;
    }
    if (state_ != State::kCreated && state_ != State::kStarted) {
      return CROSSGRAM_TGCALLS_SHIM_STATUS_INVALID_STATE;
    }
    state_ = State::kStopping;
  }

  bool succeeded = pcm_.Stop();
  try {
    std::lock_guard adapter_lock(adapter_mutex_);
    if (adapter_) adapter_->Stop();
  } catch (...) {
    succeeded = false;
  }
  {
    std::lock_guard lock(mutex_);
    state_ = State::kStopped;
    lifecycle_changed_.notify_all();
  }
  return succeeded ? CROSSGRAM_TGCALLS_SHIM_STATUS_OK : CROSSGRAM_TGCALLS_SHIM_STATUS_INTERNAL_ERROR;
}

crossgram_tgcalls_shim_status Session::Join() noexcept {
  {
    std::unique_lock lock(mutex_);
    lifecycle_changed_.wait(lock, [this] {
      return state_ != State::kStarting && state_ != State::kStopping;
    });
    if (state_ == State::kJoined) return CROSSGRAM_TGCALLS_SHIM_STATUS_OK;
    if (state_ != State::kStopped) return CROSSGRAM_TGCALLS_SHIM_STATUS_INVALID_STATE;
    state_ = State::kJoining;
  }

  bool succeeded = true;
  try {
    std::lock_guard adapter_lock(adapter_mutex_);
    if (adapter_) adapter_->Join();
  } catch (...) {
    succeeded = false;
  }
  {
    std::unique_lock lock(mutex_);
    callbacks_quiesced_.wait(lock, [this] { return callbacks_in_flight_ == 0; });
  }
  if (!pcm_.Drain() || !pcm_.Join()) succeeded = false;
  {
    std::lock_guard adapter_lock(adapter_mutex_);
    if (adapter_) adapter_->Bind(nullptr);
  }
  {
    std::lock_guard lock(mutex_);
    state_ = State::kJoined;
    lifecycle_changed_.notify_all();
  }
  Wipe();
  return succeeded ? CROSSGRAM_TGCALLS_SHIM_STATUS_OK : CROSSGRAM_TGCALLS_SHIM_STATUS_INTERNAL_ERROR;
}

bool Session::joined() const noexcept {
  std::lock_guard lock(mutex_);
  return state_ == State::kJoined;
}

bool Session::parameters_wiped() const noexcept {
  std::lock_guard lock(mutex_);
  return std::all_of(parameters_.auth_key.begin(), parameters_.auth_key.end(), [](uint8_t byte) {
           return byte == 0;
         }) &&
         parameters_.endpoints.empty() && !parameters_.is_outgoing &&
         std::all_of(reinterpret_cast<const uint8_t*>(&parameters_.config),
                     reinterpret_cast<const uint8_t*>(&parameters_.config) + sizeof(parameters_.config),
                     [](uint8_t byte) { return byte == 0; });
}

void Session::EmitOutboundSignaling(const uint8_t* data, uint32_t length) noexcept {
  if (data == nullptr || length == 0 || length > CROSSGRAM_TGCALLS_SHIM_MAX_SIGNAL_BYTES) return;
  crossgram_tgcalls_outbound_signaling_callback callback = nullptr;
  void* context = nullptr;
  if (!AdmitCallback(&callback, &context)) return;
  try {
    callback(context, data, length);
  } catch (...) {
    LeaveCallback();
    Report(CROSSGRAM_TGCALLS_SHIM_STATUS_INTERNAL_ERROR);
    return;
  }
  LeaveCallback();
}

void Session::EmitPlayout10ms(const int16_t* samples) noexcept {
  static_cast<void>(pcm_.PushPlayout10ms(samples));
}

crossgram_tgcalls_shim_status Session::PopCapture10ms(int16_t* samples) noexcept {
  return pcm_.PopCapture10ms(samples);
}

bool Session::AdmitCallback(crossgram_tgcalls_outbound_signaling_callback* callback,
                            void** context) noexcept {
  std::lock_guard lock(mutex_);
  if ((state_ != State::kStarting && state_ != State::kStarted) ||
      callbacks_.outbound_signaling == nullptr) {
    return false;
  }
  ++callbacks_in_flight_;
  *callback = callbacks_.outbound_signaling;
  *context = callbacks_.context;
  return true;
}

bool Session::AdmitErrorCallback(crossgram_tgcalls_error_callback* callback,
                                 void** context) noexcept {
  std::lock_guard lock(mutex_);
  if ((state_ != State::kStarting && state_ != State::kStarted) || callbacks_.error == nullptr) {
    return false;
  }
  ++callbacks_in_flight_;
  *callback = callbacks_.error;
  *context = callbacks_.context;
  return true;
}

void Session::LeaveCallback() noexcept {
  std::lock_guard lock(mutex_);
  --callbacks_in_flight_;
  if (callbacks_in_flight_ == 0) callbacks_quiesced_.notify_all();
}

void Session::Report(crossgram_tgcalls_shim_status status) noexcept {
  if (status == CROSSGRAM_TGCALLS_SHIM_STATUS_OK) return;
  crossgram_tgcalls_error_callback callback = nullptr;
  void* context = nullptr;
  if (!AdmitErrorCallback(&callback, &context)) return;
  try {
    callback(context, status);
  } catch (...) {
  }
  LeaveCallback();
}

void Session::Wipe() noexcept {
  std::lock_guard lock(mutex_);
  parameters_.Wipe();
}

std::unique_ptr<SessionAdapter> CreateProductionSessionAdapter(const SessionParameters&) {
  return std::make_unique<UnavailableSessionAdapter>();
}

}  // namespace crossgram::tgcalls_shim
