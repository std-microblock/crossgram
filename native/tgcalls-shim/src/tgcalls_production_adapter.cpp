#include "session.h"
#include "pinned_transport_policy.h"

#include <algorithm>
#include <array>
#include <atomic>
#include <cstring>
#include <memory>
#include <mutex>
#include <utility>
#include <vector>

#include <tgcalls/FakeAudioDeviceModule.h>
#include <tgcalls/Instance.h>
#include <tgcalls/InstanceImpl.h>

#if defined(CROSSGRAM_TGCALLS_SHIM_TESTING)
#include "production_adapter_test.h"
#endif

namespace crossgram::tgcalls_shim {
namespace {

constexpr double kMillisecondsPerSecond = 1000.0;

#if defined(CROSSGRAM_TGCALLS_SHIM_TESTING)
std::atomic<ArtifactInstanceCreator> test_instance_creator{nullptr};
#endif

std::unique_ptr<tgcalls::Instance> CreateInstance(const std::string& version,
                                                   tgcalls::Descriptor&& descriptor) {
#if defined(CROSSGRAM_TGCALLS_SHIM_TESTING)
  if (auto creator = test_instance_creator.load(std::memory_order_acquire); creator != nullptr) {
    return creator(version, std::move(descriptor));
  }
#endif
  static const bool registered = tgcalls::Register<tgcalls::InstanceImpl>();
  if (!registered) return nullptr;
  return tgcalls::Meta::Create(version, std::move(descriptor));
}

void WipeBytes(void* data, std::size_t length) noexcept {
  volatile auto* bytes = static_cast<volatile uint8_t*>(data);
  while (length-- != 0) *bytes++ = 0;
}

class SessionAccess final {
 public:
  void Bind(Session* session) noexcept {
    std::unique_lock lock(mutex_);
    session_ = session;
    if (session == nullptr) {
      callbacks_quiesced_.wait(lock, [this] { return callbacks_in_flight_ == 0; });
    }
  }

  Session* Enter() noexcept {
    std::lock_guard lock(mutex_);
    if (session_ == nullptr) return nullptr;
    ++callbacks_in_flight_;
    return session_;
  }

  void Leave() noexcept {
    std::lock_guard lock(mutex_);
    --callbacks_in_flight_;
    if (callbacks_in_flight_ == 0) callbacks_quiesced_.notify_all();
  }

 private:
  std::mutex mutex_;
  std::condition_variable callbacks_quiesced_;
  Session* session_ = nullptr;
  uint32_t callbacks_in_flight_ = 0;
};

class AdapterRenderer final : public tgcalls::FakeAudioDeviceModule::Renderer {
 public:
  explicit AdapterRenderer(std::shared_ptr<SessionAccess> access) : access_(std::move(access)) {}

  bool Render(const tgcalls::AudioFrame& frame) override {
    if (frame.audio_samples == nullptr || frame.num_samples != PcmBridge::kSamplesPer10ms ||
        frame.bytes_per_sample != sizeof(int16_t) || frame.num_channels != 1 ||
        frame.samples_per_sec != CROSSGRAM_TGCALLS_SHIM_PCM_SAMPLE_RATE_HZ) {
      return false;
    }
    Session* session = access_->Enter();
    if (session == nullptr) return false;
    session->EmitPlayout10ms(frame.audio_samples);
    access_->Leave();
    return true;
  }

 private:
  const std::shared_ptr<SessionAccess> access_;
};

class AdapterRecorder final : public tgcalls::FakeAudioDeviceModule::Recorder {
 public:
  explicit AdapterRecorder(std::shared_ptr<SessionAccess> access) : access_(std::move(access)) {}

  tgcalls::AudioFrame Record() override {
    samples_.fill(0);
    if (Session* session = access_->Enter(); session != nullptr) {
      static_cast<void>(session->PopCapture10ms(samples_.data()));
      access_->Leave();
    }
    return {samples_.data(), PcmBridge::kSamplesPer10ms, sizeof(int16_t), 1,
            CROSSGRAM_TGCALLS_SHIM_PCM_SAMPLE_RATE_HZ, 0, 0};
  }

 private:
  const std::shared_ptr<SessionAccess> access_;
  std::array<int16_t, PcmBridge::kSamplesPer10ms> samples_{};
};

tgcalls::EndpointType MapEndpointType(crossgram_tgcalls_endpoint_type type) noexcept {
  switch (type) {
    case CROSSGRAM_TGCALLS_ENDPOINT_INET:
      return tgcalls::EndpointType::Inet;
    case CROSSGRAM_TGCALLS_ENDPOINT_LAN:
      return tgcalls::EndpointType::Lan;
    case CROSSGRAM_TGCALLS_ENDPOINT_UDP_RELAY:
      return tgcalls::EndpointType::UdpRelay;
    case CROSSGRAM_TGCALLS_ENDPOINT_TCP_RELAY:
      return tgcalls::EndpointType::TcpRelay;
    default:
      return tgcalls::EndpointType::Inet;
  }
}

class ProductionSessionAdapter final : public SessionAdapter {
 public:
  explicit ProductionSessionAdapter(const SessionParameters& parameters) : parameters_(parameters) {}

  ~ProductionSessionAdapter() override {
    Stop();
    Join();
  }

  void Configure(const SessionParameters&) noexcept override {}

  void Bind(Session* session) noexcept override {
    access_->Bind(session);
  }

  crossgram_tgcalls_shim_status Start() override {
    std::lock_guard lock(instance_mutex_);
    if (instance_ != nullptr || stop_requested_) return CROSSGRAM_TGCALLS_SHIM_STATUS_INVALID_STATE;
    if (!IsControlledLocalP2p(parameters_)) {
      return CROSSGRAM_TGCALLS_SHIM_STATUS_BACKEND_UNAVAILABLE;
    }

    try {
      auto descriptor = MakeDescriptor();
      instance_ = CreateInstance(descriptor.version, std::move(descriptor));
      if (instance_ == nullptr) {
        WipeAuthentication();
        return CROSSGRAM_TGCALLS_SHIM_STATUS_INTERNAL_ERROR;
      }
      return CROSSGRAM_TGCALLS_SHIM_STATUS_OK;
    } catch (...) {
      instance_.reset();
      WipeAuthentication();
      return CROSSGRAM_TGCALLS_SHIM_STATUS_INTERNAL_ERROR;
    }
  }

  crossgram_tgcalls_shim_status ReceiveSignaling(const uint8_t* data, uint32_t length) override {
    if (data == nullptr || length == 0) return CROSSGRAM_TGCALLS_SHIM_STATUS_INVALID_ARGUMENT;
    std::vector<uint8_t> signaling(data, data + length);
    try {
      std::lock_guard lock(instance_mutex_);
      if (instance_ == nullptr || stop_requested_) return CROSSGRAM_TGCALLS_SHIM_STATUS_INVALID_STATE;
      instance_->receiveSignalingData(signaling);
      WipeBytes(signaling.data(), signaling.size());
      return CROSSGRAM_TGCALLS_SHIM_STATUS_OK;
    } catch (...) {
      WipeBytes(signaling.data(), signaling.size());
      return CROSSGRAM_TGCALLS_SHIM_STATUS_INTERNAL_ERROR;
    }
  }

  void Stop() override {
    std::lock_guard lock(instance_mutex_);
    stop_requested_ = true;
  }

  void Join() override {
    tgcalls::Instance* instance = nullptr;
    {
      std::lock_guard lock(instance_mutex_);
      stop_requested_ = true;
      instance = instance_.get();
    }
    if (instance != nullptr) instance->stopAndWait();

    std::lock_guard lock(instance_mutex_);
    instance_.reset();
    WipeAuthentication();
    parameters_.Wipe();
  }

 private:
  tgcalls::Descriptor MakeDescriptor() {
    auth_key_ = std::make_shared<std::array<uint8_t, tgcalls::EncryptionKey::kSize>>(parameters_.auth_key);
    tgcalls::Descriptor descriptor{
        "", {}, {}, {}, nullptr, {}, tgcalls::NetworkType::Ethernet,
        tgcalls::EncryptionKey(auth_key_, parameters_.is_outgoing),
        {},  // mediaDevicesConfig
        {},  // videoCapture
        {},  // stateUpdated
        {},  // signalBarsUpdated
        {},  // audioLevelUpdated
        {},  // remoteBatteryLevelIsLowUpdated
        {},  // remoteMediaStateUpdated
        {},  // remotePrefferedAspectRatioUpdated
        {},  // signalingDataEmitted
        {},  // createAudioDeviceModule
        {},  // createWrappedAudioDeviceModule
        {},  // initialInputDeviceId
        {},  // initialOutputDeviceId
        {}   // directConnectionChannel
    };
    descriptor.version = parameters_.config.protocol_version == CROSSGRAM_TGCALLS_PROTOCOL_V1 ? "5.0.0" : "2.7.7";
    descriptor.config.initializationTimeout =
        static_cast<double>(parameters_.config.initialization_timeout_ms) / kMillisecondsPerSecond;
    descriptor.config.receiveTimeout =
        static_cast<double>(parameters_.config.receive_timeout_ms) / kMillisecondsPerSecond;
    descriptor.config.enableP2P = parameters_.config.enable_p2p != 0;
    descriptor.config.allowTCP = parameters_.config.allow_tcp != 0;
    descriptor.config.enableAEC = parameters_.config.enable_aec != 0;
    descriptor.config.enableNS = parameters_.config.enable_ns != 0;
    descriptor.config.enableAGC = parameters_.config.enable_agc != 0;
    descriptor.config.protocolVersion = parameters_.config.protocol_version == CROSSGRAM_TGCALLS_PROTOCOL_V1
                                            ? tgcalls::ProtocolVersion::V1
                                            : tgcalls::ProtocolVersion::V0;
    descriptor.initialNetworkType = tgcalls::NetworkType::Ethernet;

    descriptor.rtcServers.reserve(parameters_.rtc_servers.size());
    for (const auto& server : parameters_.rtc_servers) {
      tgcalls::RtcServer target;
      target.id = server.id;
      target.host = server.host;
      target.port = server.port;
      target.login = server.username;
      target.password = server.password;
      target.isTurn = server.is_turn;
      target.isTcp = server.is_tcp;
      descriptor.rtcServers.push_back(std::move(target));
    }
    descriptor.endpoints.reserve(parameters_.endpoints.size());
    for (const auto& endpoint : parameters_.endpoints) {
      tgcalls::Endpoint target;
      target.endpointId = endpoint.id;
      target.host.ipv4 = endpoint.ipv4;
      target.host.ipv6 = endpoint.ipv6;
      target.port = endpoint.port;
      target.type = MapEndpointType(endpoint.type);
      std::memcpy(target.peerTag, endpoint.peer_tag.data(), endpoint.peer_tag.size());
      descriptor.endpoints.push_back(std::move(target));
    }

    auto renderer = std::make_shared<AdapterRenderer>(access_);
    auto recorder = std::make_shared<AdapterRecorder>(access_);
    tgcalls::FakeAudioDeviceModule::Options audio_options;
    audio_options.samples_per_sec = CROSSGRAM_TGCALLS_SHIM_PCM_SAMPLE_RATE_HZ;
    audio_options.num_channels = CROSSGRAM_TGCALLS_SHIM_PCM_CHANNELS;
    descriptor.createAudioDeviceModule =
        tgcalls::FakeAudioDeviceModule::Creator(std::move(renderer), std::move(recorder), audio_options);
    descriptor.signalingDataEmitted = [access = access_](const std::vector<uint8_t>& data) {
      Session* session = access->Enter();
      if (session == nullptr) return;
      if (!data.empty() && data.size() <= CROSSGRAM_TGCALLS_SHIM_MAX_SIGNAL_BYTES) {
        session->EmitOutboundSignaling(data.data(), static_cast<uint32_t>(data.size()));
      }
      access->Leave();
    };
    descriptor.stateUpdated = [access = access_](tgcalls::State state) {
      if (state != tgcalls::State::Failed) return;
      Session* session = access->Enter();
      if (session == nullptr) return;
      session->EmitAsyncError(CROSSGRAM_TGCALLS_SHIM_STATUS_INTERNAL_ERROR);
      access->Leave();
    };
    return descriptor;
  }

  void WipeAuthentication() noexcept {
    if (auth_key_ != nullptr) {
      WipeBytes(auth_key_->data(), auth_key_->size());
      auth_key_.reset();
    }
  }

  SessionParameters parameters_;
  const std::shared_ptr<SessionAccess> access_ = std::make_shared<SessionAccess>();
  std::shared_ptr<std::array<uint8_t, tgcalls::EncryptionKey::kSize>> auth_key_;
  std::unique_ptr<tgcalls::Instance> instance_;
  std::mutex instance_mutex_;
  bool stop_requested_ = false;
};

}  // namespace

#if defined(CROSSGRAM_TGCALLS_SHIM_TESTING)
void SetArtifactInstanceCreatorForTest(ArtifactInstanceCreator creator) noexcept {
  test_instance_creator.store(creator, std::memory_order_release);
}

void ResetArtifactInstanceCreatorForTest() noexcept {
  test_instance_creator.store(nullptr, std::memory_order_release);
}
#endif

std::unique_ptr<SessionAdapter> CreateArtifactSessionAdapter(const SessionParameters& parameters) {
  return std::make_unique<ProductionSessionAdapter>(parameters);
}

}  // namespace crossgram::tgcalls_shim
