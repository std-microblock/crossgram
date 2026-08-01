#include <array>
#include <cstdint>
#include <cstdlib>
#include <functional>
#include <memory>
#include <string>
#include <vector>

#include "crossgram/tgcalls_shim.h"
#include "production_adapter_test.h"

namespace {

struct Observed final {
  bool created = false;
  bool audio_creator_configured = false;
  bool direct_ice_only = false;
  bool is_outgoing = false;
  uint8_t auth_first_byte = 0;
  crossgram_tgcalls_session_config config{};
  std::string version;
  std::weak_ptr<const std::array<uint8_t, CROSSGRAM_TGCALLS_SHIM_AUTH_KEY_BYTES>> auth_key;
  std::function<void(const std::vector<uint8_t>&)> emit_signaling;
  std::vector<uint8_t> outbound;
  uint32_t stop_and_waits = 0;
  uint32_t destroyed = 0;
};

Observed* observed = nullptr;

[[noreturn]] void Fail() {
  std::abort();
}

void Check(bool condition) {
  if (!condition) Fail();
}

class NoNetworkInstance final : public tgcalls::Instance {
 public:
  ~NoNetworkInstance() override {
    ++observed->destroyed;
  }

  void setNetworkType(tgcalls::NetworkType) override {}
  void setMuteMicrophone(bool) override {}
  void setAudioOutputGainControlEnabled(bool) override {}
  void setEchoCancellationStrength(int) override {}
  bool supportsVideo() override { return false; }
  void setIncomingVideoOutput(
      std::weak_ptr<rtc::VideoSinkInterface<webrtc::VideoFrame>>) override {}
  void setAudioInputDevice(std::string) override {}
  void setAudioOutputDevice(std::string) override {}
  void setInputVolume(float) override {}
  void setOutputVolume(float) override {}
  void setAudioOutputDuckingEnabled(bool) override {}
  void setIsLowBatteryLevel(bool) override {}
  std::string getLastError() override { return {}; }
  std::string getDebugInfo() override { return {}; }
  int64_t getPreferredRelayId() override { return 0; }
  tgcalls::TrafficStats getTrafficStats() override { return {}; }
  tgcalls::PersistentState getPersistentState() override { return {}; }
  void receiveSignalingData(const std::vector<uint8_t>&) override {}
  void setVideoCapture(std::shared_ptr<tgcalls::VideoCaptureInterface>) override {}
  void sendVideoDeviceUpdated() override {}
  void setRequestedVideoAspect(float) override {}
  void stop(std::function<void(tgcalls::FinalState)> completion) override {
    completion({});
  }
  void stopAndWait() override {
    ++observed->stop_and_waits;
  }
};

std::unique_ptr<tgcalls::Instance> CreateNoNetworkInstance(const std::string& version,
                                                            tgcalls::Descriptor&& descriptor) {
  observed->created = true;
  observed->version = version;
  observed->config.initialization_timeout_ms =
      static_cast<uint32_t>(descriptor.config.initializationTimeout * 1000.0);
  observed->config.receive_timeout_ms = static_cast<uint32_t>(descriptor.config.receiveTimeout * 1000.0);
  observed->config.enable_p2p = descriptor.config.enableP2P ? 1 : 0;
  observed->config.allow_tcp = descriptor.config.allowTCP ? 1 : 0;
  observed->config.enable_aec = descriptor.config.enableAEC ? 1 : 0;
  observed->config.enable_ns = descriptor.config.enableNS ? 1 : 0;
  observed->config.enable_agc = descriptor.config.enableAGC ? 1 : 0;
  observed->config.protocol_version = descriptor.config.protocolVersion == tgcalls::ProtocolVersion::V1
                                          ? CROSSGRAM_TGCALLS_PROTOCOL_V1
                                          : CROSSGRAM_TGCALLS_PROTOCOL_V0;
  observed->direct_ice_only = descriptor.endpoints.empty() && descriptor.rtcServers.empty();
  observed->audio_creator_configured = static_cast<bool>(descriptor.createAudioDeviceModule);
  observed->is_outgoing = descriptor.encryptionKey.isOutgoing;
  observed->auth_first_byte = descriptor.encryptionKey.value->front();
  observed->auth_key = descriptor.encryptionKey.value;
  observed->emit_signaling = std::move(descriptor.signalingDataEmitted);
  return std::make_unique<NoNetworkInstance>();
}

void OnOutbound(void*, const uint8_t* data, uint32_t length) {
  observed->outbound.assign(data, data + length);
}

crossgram_tgcalls_session_config DirectConfig() {
  return {
      .initialization_timeout_ms = 4000,
      .receive_timeout_ms = 5000,
      .enable_p2p = 1,
      .allow_tcp = 1,
      .enable_aec = 1,
      .enable_ns = 1,
      .enable_agc = 1,
      .protocol_version = CROSSGRAM_TGCALLS_PROTOCOL_V1,
  };
}

crossgram_tgcalls_session_auth Auth(std::array<uint8_t, CROSSGRAM_TGCALLS_SHIM_AUTH_KEY_BYTES>* key) {
  key->fill(0xa5);
  return {key->data(), static_cast<uint32_t>(key->size()), 1};
}

void TestDirectP2pStartUsesNoNetworkCreator() {
  Observed state;
  observed = &state;
  crossgram::tgcalls_shim::SetArtifactInstanceCreatorForTest(CreateNoNetworkInstance);

  std::array<uint8_t, CROSSGRAM_TGCALLS_SHIM_AUTH_KEY_BYTES> key{};
  const auto config = DirectConfig();
  const auto auth = Auth(&key);
  const crossgram_tgcalls_session_callbacks callbacks{nullptr, OnOutbound, nullptr};
  crossgram_tgcalls_shim* session = nullptr;

  Check(crossgram_tgcalls_session_create(CROSSGRAM_TGCALLS_SHIM_ABI_VERSION, &config, &auth, nullptr, 0,
                                         &callbacks, &session) == CROSSGRAM_TGCALLS_SHIM_STATUS_OK);
  Check(crossgram_tgcalls_session_start(session) == CROSSGRAM_TGCALLS_SHIM_STATUS_OK);
  Check(state.created && state.direct_ice_only && state.audio_creator_configured);
  Check(state.version == "5.0.0");
  Check(state.config.initialization_timeout_ms == config.initialization_timeout_ms);
  Check(state.config.receive_timeout_ms == config.receive_timeout_ms);
  Check(state.config.enable_p2p == 1 && state.config.allow_tcp == 1);
  Check(state.config.enable_aec == 1 && state.config.enable_ns == 1 && state.config.enable_agc == 1);
  Check(state.config.protocol_version == CROSSGRAM_TGCALLS_PROTOCOL_V1);
  Check(state.is_outgoing && state.auth_first_byte == 0xa5 && !state.auth_key.expired());
  state.emit_signaling({1, 2, 3});
  Check(state.outbound == std::vector<uint8_t>({1, 2, 3}));

  // The injected Instance neither invokes Meta::Create nor opens sockets. The
  // production adapter Start path above is therefore exercised without AF_INET/AF_INET6 activity.
  Check(crossgram_tgcalls_session_stop(session) == CROSSGRAM_TGCALLS_SHIM_STATUS_OK);
  Check(crossgram_tgcalls_session_join(session) == CROSSGRAM_TGCALLS_SHIM_STATUS_OK);
  Check(state.stop_and_waits == 1 && state.destroyed == 1 && state.auth_key.expired());
  Check(crossgram_tgcalls_session_destroy(&session) == CROSSGRAM_TGCALLS_SHIM_STATUS_OK);
  Check(session == nullptr);
  crossgram::tgcalls_shim::ResetArtifactInstanceCreatorForTest();
}

void TestRelayStartRemainsFailClosed() {
  Observed state;
  observed = &state;
  crossgram::tgcalls_shim::SetArtifactInstanceCreatorForTest(CreateNoNetworkInstance);

  std::array<uint8_t, CROSSGRAM_TGCALLS_SHIM_AUTH_KEY_BYTES> key{};
  const auto config = DirectConfig();
  const auto auth = Auth(&key);
  const char host[] = "149.154.167.51";
  const crossgram_tgcalls_endpoint relay = {
      .id = 1,
      .ipv4 = {.data = host, .length = sizeof(host) - 1},
      .ipv6 = {nullptr, 0},
      .port = 443,
      .type = CROSSGRAM_TGCALLS_ENDPOINT_UDP_RELAY,
      .peer_tag = {0},
  };
  const crossgram_tgcalls_session_callbacks callbacks{};
  crossgram_tgcalls_shim* session = nullptr;

  Check(crossgram_tgcalls_session_create(CROSSGRAM_TGCALLS_SHIM_ABI_VERSION, &config, &auth, &relay, 1,
                                         &callbacks, &session) == CROSSGRAM_TGCALLS_SHIM_STATUS_OK);
  Check(crossgram_tgcalls_session_start(session) == CROSSGRAM_TGCALLS_SHIM_STATUS_BACKEND_UNAVAILABLE);
  Check(!state.created);
  Check(crossgram_tgcalls_session_stop(session) == CROSSGRAM_TGCALLS_SHIM_STATUS_OK);
  Check(crossgram_tgcalls_session_join(session) == CROSSGRAM_TGCALLS_SHIM_STATUS_OK);
  Check(crossgram_tgcalls_session_destroy(&session) == CROSSGRAM_TGCALLS_SHIM_STATUS_OK);
  crossgram::tgcalls_shim::ResetArtifactInstanceCreatorForTest();
}

}  // namespace

int main() {
  TestDirectP2pStartUsesNoNetworkCreator();
  TestRelayStartRemainsFailClosed();
  return 0;
}
