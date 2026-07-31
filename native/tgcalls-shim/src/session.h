#ifndef CROSSGRAM_TGCALLS_SHIM_SESSION_H_
#define CROSSGRAM_TGCALLS_SHIM_SESSION_H_

#include <array>
#include <cstdint>
#include <condition_variable>
#include <memory>
#include <mutex>
#include <string>
#include <vector>

#include "crossgram/tgcalls_shim.h"
#include "pcm_bridge.h"

namespace crossgram::tgcalls_shim {

struct Endpoint final {
  int64_t id = 0;
  std::string ipv4;
  std::string ipv6;
  uint16_t port = 0;
  crossgram_tgcalls_endpoint_type type = CROSSGRAM_TGCALLS_ENDPOINT_INET;
  std::array<uint8_t, 16> peer_tag{};
};

struct SessionParameters final {
  crossgram_tgcalls_session_config config{};
  std::array<uint8_t, CROSSGRAM_TGCALLS_SHIM_AUTH_KEY_BYTES> auth_key{};
  bool is_outgoing = false;
  std::vector<Endpoint> endpoints;

  ~SessionParameters();
  void Wipe() noexcept;
};

class Session;

class SessionAdapter {
 public:
  virtual ~SessionAdapter() = default;
  virtual void Bind(Session* session) noexcept = 0;
  virtual crossgram_tgcalls_shim_status Start() = 0;
  virtual crossgram_tgcalls_shim_status ReceiveSignaling(const uint8_t* data, uint32_t length) = 0;
  virtual void Stop() = 0;
  virtual void Join() = 0;
};

/**
 * Adapter construction is deliberately separated from the C ABI. The installed
 * build has no transport adapter until the approved tgcalls linkage is present.
 * Unit tests inject an in-memory adapter through this C++ seam.
 */
class Session final {
 public:
  Session(SessionParameters parameters,
          crossgram_tgcalls_session_callbacks callbacks,
          std::unique_ptr<SessionAdapter> adapter) noexcept;
  ~Session();
  Session(const Session&) = delete;
  Session& operator=(const Session&) = delete;

  crossgram_tgcalls_shim_status Start();
  crossgram_tgcalls_shim_status ReceiveSignaling(const uint8_t* data, uint32_t length);
  crossgram_tgcalls_shim_status PushCapture20ms(const int16_t* samples) noexcept;
  crossgram_tgcalls_shim_status PopPlayout20ms(int16_t* samples) noexcept;
  crossgram_tgcalls_shim_status Stop() noexcept;
  crossgram_tgcalls_shim_status Join() noexcept;
  bool joined() const noexcept;
  bool parameters_wiped() const noexcept;

  void EmitOutboundSignaling(const uint8_t* data, uint32_t length) noexcept;
  void EmitPlayout10ms(const int16_t* samples) noexcept;
  crossgram_tgcalls_shim_status PopCapture10ms(int16_t* samples) noexcept;

 private:
  enum class State { kCreated, kStarting, kStarted, kStopping, kStopped, kJoining, kJoined };

  bool AdmitCallback(crossgram_tgcalls_outbound_signaling_callback* callback,
                     void** context) noexcept;
  bool AdmitErrorCallback(crossgram_tgcalls_error_callback* callback, void** context) noexcept;
  void LeaveCallback() noexcept;
  void Report(crossgram_tgcalls_shim_status status) noexcept;
  void Wipe() noexcept;

  SessionParameters parameters_;
  crossgram_tgcalls_session_callbacks callbacks_{};
  std::unique_ptr<SessionAdapter> adapter_;
  PcmBridge pcm_;
  std::mutex adapter_mutex_;
  mutable std::mutex mutex_;
  std::condition_variable lifecycle_changed_;
  std::condition_variable callbacks_quiesced_;
  State state_ = State::kCreated;
  uint32_t callbacks_in_flight_ = 0;
};

std::unique_ptr<SessionAdapter> CreateProductionSessionAdapter(const SessionParameters& parameters);

}  // namespace crossgram::tgcalls_shim

#endif  // CROSSGRAM_TGCALLS_SHIM_SESSION_H_
