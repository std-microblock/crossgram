#include "session.h"

#include <array>
#include <cstdlib>
#include <cstddef>
#include <cstring>
#include <iostream>
#include <memory>
#include <vector>

namespace {

static_assert(CROSSGRAM_TGCALLS_SHIM_ABI_VERSION == 3);
static_assert(sizeof(crossgram_tgcalls_shim_status) == 4);
static_assert(alignof(crossgram_tgcalls_shim_status) == 4);
static_assert(sizeof(crossgram_tgcalls_endpoint_type) == 4);
static_assert(alignof(crossgram_tgcalls_endpoint_type) == 4);
static_assert(sizeof(crossgram_tgcalls_protocol_version) == 4);
static_assert(alignof(crossgram_tgcalls_protocol_version) == 4);
static_assert(CROSSGRAM_TGCALLS_SHIM_STATUS_OK == 0);
static_assert(CROSSGRAM_TGCALLS_SHIM_STATUS_INVALID_ARGUMENT == 1);
static_assert(CROSSGRAM_TGCALLS_SHIM_STATUS_STOPPED == 2);
static_assert(CROSSGRAM_TGCALLS_SHIM_STATUS_INPUT_FULL == 3);
static_assert(CROSSGRAM_TGCALLS_SHIM_STATUS_OUTPUT_EMPTY == 4);
static_assert(CROSSGRAM_TGCALLS_SHIM_STATUS_ABI_MISMATCH == 5);
static_assert(CROSSGRAM_TGCALLS_SHIM_STATUS_ALLOCATION_FAILED == 6);
static_assert(CROSSGRAM_TGCALLS_SHIM_STATUS_INVALID_STATE == 7);
static_assert(CROSSGRAM_TGCALLS_SHIM_STATUS_BACKEND_UNAVAILABLE == 8);
static_assert(CROSSGRAM_TGCALLS_SHIM_STATUS_INTERNAL_ERROR == 9);
static_assert(CROSSGRAM_TGCALLS_ENDPOINT_INET == 0);
static_assert(CROSSGRAM_TGCALLS_ENDPOINT_LAN == 1);
static_assert(CROSSGRAM_TGCALLS_ENDPOINT_UDP_RELAY == 2);
static_assert(CROSSGRAM_TGCALLS_ENDPOINT_TCP_RELAY == 3);
static_assert(CROSSGRAM_TGCALLS_PROTOCOL_V0 == 0);
static_assert(CROSSGRAM_TGCALLS_PROTOCOL_V1 == 1);
static_assert(sizeof(crossgram_tgcalls_string_view) == 16);
static_assert(alignof(crossgram_tgcalls_string_view) == 8);
static_assert(offsetof(crossgram_tgcalls_string_view, data) == 0);
static_assert(offsetof(crossgram_tgcalls_string_view, length) == 8);
static_assert(sizeof(crossgram_tgcalls_endpoint) == 64);
static_assert(alignof(crossgram_tgcalls_endpoint) == 8);
static_assert(offsetof(crossgram_tgcalls_endpoint, id) == 0);
static_assert(offsetof(crossgram_tgcalls_endpoint, ipv4) == 8);
static_assert(offsetof(crossgram_tgcalls_endpoint, ipv6) == 24);
static_assert(offsetof(crossgram_tgcalls_endpoint, port) == 40);
static_assert(offsetof(crossgram_tgcalls_endpoint, type) == 44);
static_assert(offsetof(crossgram_tgcalls_endpoint, peer_tag) == 48);
static_assert(sizeof(crossgram_tgcalls_session_config) == 20);
static_assert(alignof(crossgram_tgcalls_session_config) == 4);
static_assert(offsetof(crossgram_tgcalls_session_config, initialization_timeout_ms) == 0);
static_assert(offsetof(crossgram_tgcalls_session_config, receive_timeout_ms) == 4);
static_assert(offsetof(crossgram_tgcalls_session_config, enable_p2p) == 8);
static_assert(offsetof(crossgram_tgcalls_session_config, allow_tcp) == 9);
static_assert(offsetof(crossgram_tgcalls_session_config, enable_aec) == 10);
static_assert(offsetof(crossgram_tgcalls_session_config, enable_ns) == 11);
static_assert(offsetof(crossgram_tgcalls_session_config, enable_agc) == 12);
static_assert(offsetof(crossgram_tgcalls_session_config, protocol_version) == 16);
static_assert(sizeof(crossgram_tgcalls_session_auth) == 16);
static_assert(alignof(crossgram_tgcalls_session_auth) == 8);
static_assert(offsetof(crossgram_tgcalls_session_auth, key) == 0);
static_assert(offsetof(crossgram_tgcalls_session_auth, key_length) == 8);
static_assert(offsetof(crossgram_tgcalls_session_auth, is_outgoing) == 12);
static_assert(sizeof(crossgram_tgcalls_session_callbacks) == 24);
static_assert(alignof(crossgram_tgcalls_session_callbacks) == 8);
static_assert(offsetof(crossgram_tgcalls_session_callbacks, context) == 0);
static_assert(offsetof(crossgram_tgcalls_session_callbacks, outbound_signaling) == 8);
static_assert(offsetof(crossgram_tgcalls_session_callbacks, error) == 16);

[[noreturn]] void Fail(const char* expression, int line) {
  std::cerr << "fake_session_test failed at line " << line << ": " << expression << '\n';
  std::exit(1);
}

#define CHECK(expression) do { if (!(expression)) Fail(#expression, __LINE__); } while (false)

using crossgram::tgcalls_shim::Session;
using crossgram::tgcalls_shim::SessionAdapter;
using crossgram::tgcalls_shim::SessionParameters;

class FakeSessionAdapter final : public SessionAdapter {
 public:
  void Bind(Session* session) noexcept override { session_ = session; }

  crossgram_tgcalls_shim_status Start() override {
    ++starts;
    const uint8_t outbound[] = {1, 2, 3};
    session_->EmitOutboundSignaling(outbound, sizeof(outbound));
    return start_status;
  }

  crossgram_tgcalls_shim_status ReceiveSignaling(const uint8_t* data, uint32_t length) override {
    inbound.assign(data, data + length);
    return signaling_status;
  }

  void Stop() noexcept override { ++stops; }
  void Join() noexcept override { ++joins; }

  Session* session_ = nullptr;
  crossgram_tgcalls_shim_status start_status = CROSSGRAM_TGCALLS_SHIM_STATUS_OK;
  crossgram_tgcalls_shim_status signaling_status = CROSSGRAM_TGCALLS_SHIM_STATUS_OK;
  int starts = 0;
  int stops = 0;
  int joins = 0;
  std::vector<uint8_t> inbound;
};

struct Callbacks {
  std::vector<uint8_t> outbound;
  std::vector<crossgram_tgcalls_shim_status> errors;
};

void OnOutbound(void* context, const uint8_t* data, uint32_t length) {
  auto* callbacks = static_cast<Callbacks*>(context);
  callbacks->outbound.assign(data, data + length);
}

void OnError(void* context, crossgram_tgcalls_shim_status status) {
  static_cast<Callbacks*>(context)->errors.push_back(status);
}

SessionParameters Parameters() {
  SessionParameters result;
  result.auth_key.fill(9);
  result.is_outgoing = true;
  return result;
}

void TestFakeSessionSignalsAndPcm() {
  Callbacks observed;
  auto adapter = std::make_unique<FakeSessionAdapter>();
  auto* fake = adapter.get();
  crossgram_tgcalls_session_callbacks callbacks{&observed, OnOutbound, OnError};
  Session session(Parameters(), callbacks, std::move(adapter));

  CHECK(session.Start() == CROSSGRAM_TGCALLS_SHIM_STATUS_OK);
  CHECK(fake->starts == 1);
  CHECK(observed.outbound == std::vector<uint8_t>({1, 2, 3}));

  const std::array<uint8_t, 4> inbound = {4, 5, 6, 7};
  CHECK(session.ReceiveSignaling(inbound.data(), inbound.size()) == CROSSGRAM_TGCALLS_SHIM_STATUS_OK);
  CHECK(fake->inbound == std::vector<uint8_t>(inbound.begin(), inbound.end()));

  std::array<int16_t, CROSSGRAM_TGCALLS_SHIM_PCM_FRAME_SAMPLES> capture{};
  capture.fill(44);
  std::array<int16_t, CROSSGRAM_TGCALLS_SHIM_PCM_CALLBACK_SAMPLES> recorder{};
  CHECK(session.PushCapture20ms(capture.data()) == CROSSGRAM_TGCALLS_SHIM_STATUS_OK);
  CHECK(session.PopCapture10ms(recorder.data()) == CROSSGRAM_TGCALLS_SHIM_STATUS_OK);
  CHECK(recorder.front() == 44 && recorder.back() == 44);

  std::array<int16_t, CROSSGRAM_TGCALLS_SHIM_PCM_CALLBACK_SAMPLES> first{};
  std::array<int16_t, CROSSGRAM_TGCALLS_SHIM_PCM_CALLBACK_SAMPLES> second{};
  std::array<int16_t, CROSSGRAM_TGCALLS_SHIM_PCM_FRAME_SAMPLES> playout{};
  first.fill(55);
  second.fill(66);
  session.EmitPlayout10ms(first.data());
  session.EmitPlayout10ms(second.data());
  CHECK(session.PopPlayout20ms(playout.data()) == CROSSGRAM_TGCALLS_SHIM_STATUS_OK);
  CHECK(playout.front() == 55);
  CHECK(playout[CROSSGRAM_TGCALLS_SHIM_PCM_CALLBACK_SAMPLES] == 66);

  CHECK(session.Stop() == CROSSGRAM_TGCALLS_SHIM_STATUS_OK);
  CHECK(session.Stop() == CROSSGRAM_TGCALLS_SHIM_STATUS_OK);
  CHECK(session.Join() == CROSSGRAM_TGCALLS_SHIM_STATUS_OK);
  CHECK(session.Join() == CROSSGRAM_TGCALLS_SHIM_STATUS_OK);
  CHECK(fake->stops == 1 && fake->joins == 1);
}

void TestFakeSessionFailure() {
  Callbacks observed;
  auto adapter = std::make_unique<FakeSessionAdapter>();
  auto* fake = adapter.get();
  fake->start_status = CROSSGRAM_TGCALLS_SHIM_STATUS_BACKEND_UNAVAILABLE;
  crossgram_tgcalls_session_callbacks callbacks{&observed, OnOutbound, OnError};
  Session session(Parameters(), callbacks, std::move(adapter));

  CHECK(session.Start() == CROSSGRAM_TGCALLS_SHIM_STATUS_BACKEND_UNAVAILABLE);
  CHECK(session.parameters_wiped());
  CHECK(observed.errors == std::vector<crossgram_tgcalls_shim_status>({
      CROSSGRAM_TGCALLS_SHIM_STATUS_BACKEND_UNAVAILABLE}));
  CHECK(session.Stop() == CROSSGRAM_TGCALLS_SHIM_STATUS_OK);
  CHECK(session.Join() == CROSSGRAM_TGCALLS_SHIM_STATUS_OK);
}

}  // namespace

int main() {
  TestFakeSessionSignalsAndPcm();
  TestFakeSessionFailure();
  return 0;
}
