#include <atomic>
#include <chrono>
#include <cstdlib>
#include <iostream>
#include <memory>
#include <thread>

#include "session.h"

namespace {

[[noreturn]] void Fail(const char* expression, int line) {
  std::cerr << "tsan_session_callback_stop_join_test failed at line " << line << ": " << expression << '\n';
  std::exit(1);
}

#define CHECK(expression) do { if (!(expression)) Fail(#expression, __LINE__); } while (false)

using crossgram::tgcalls_shim::Session;
using crossgram::tgcalls_shim::SessionAdapter;
using crossgram::tgcalls_shim::SessionParameters;

struct CallbackState {
  std::atomic<bool> entered{false};
  std::atomic<bool> release{false};
  std::atomic<uint32_t> calls{0};
};

class CallbackAdapter final : public SessionAdapter {
 public:
  ~CallbackAdapter() override {
    if (worker_.joinable()) worker_.join();
  }

  void Configure(const SessionParameters&) noexcept override {}
  void Bind(Session* session) noexcept override { session_ = session; }

  crossgram_tgcalls_shim_status Start() override {
    worker_ = std::thread([this] {
      const uint8_t signal[] = {7};
      session_->EmitOutboundSignaling(signal, sizeof(signal));
    });
    return CROSSGRAM_TGCALLS_SHIM_STATUS_OK;
  }

  crossgram_tgcalls_shim_status ReceiveSignaling(const uint8_t*, uint32_t) override {
    return CROSSGRAM_TGCALLS_SHIM_STATUS_OK;
  }

  void Stop() override {}

  void Join() override {
    if (worker_.joinable()) worker_.join();
  }

 private:
  Session* session_ = nullptr;
  std::thread worker_;
};

void OnOutbound(void* context, const uint8_t*, uint32_t) {
  auto* state = static_cast<CallbackState*>(context);
  state->calls.fetch_add(1, std::memory_order_relaxed);
  state->entered.store(true, std::memory_order_release);
  while (!state->release.load(std::memory_order_acquire)) std::this_thread::yield();
}

void TestJoinQuiescesConcurrentCallback() {
  constexpr int kRounds = 200;
  for (int round = 0; round < kRounds; ++round) {
    CallbackState callback_state;
    SessionParameters parameters;
    parameters.auth_key.fill(9);
    auto adapter = std::make_unique<CallbackAdapter>();
    crossgram_tgcalls_session_callbacks callbacks{&callback_state, OnOutbound, nullptr};
    Session session(std::move(parameters), callbacks, std::move(adapter));

    CHECK(session.Start() == CROSSGRAM_TGCALLS_SHIM_STATUS_OK);
    while (!callback_state.entered.load(std::memory_order_acquire)) std::this_thread::yield();
    CHECK(session.Stop() == CROSSGRAM_TGCALLS_SHIM_STATUS_OK);

    std::atomic<bool> joined{false};
    crossgram_tgcalls_shim_status join_status = CROSSGRAM_TGCALLS_SHIM_STATUS_INTERNAL_ERROR;
    std::thread joiner([&] {
      join_status = session.Join();
      joined.store(true, std::memory_order_release);
    });
    std::this_thread::sleep_for(std::chrono::milliseconds(1));
    CHECK(!joined.load(std::memory_order_acquire));
    callback_state.release.store(true, std::memory_order_release);
    joiner.join();

    CHECK(join_status == CROSSGRAM_TGCALLS_SHIM_STATUS_OK);
    CHECK(session.joined());
    CHECK(callback_state.calls.load(std::memory_order_relaxed) == 1);
  }
}

}  // namespace

int main() {
  TestJoinQuiescesConcurrentCallback();
  return 0;
}
