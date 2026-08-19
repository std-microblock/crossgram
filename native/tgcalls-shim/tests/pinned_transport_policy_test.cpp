#include <cstdlib>

#include "pinned_transport_policy.h"

namespace {

using crossgram::tgcalls_shim::Endpoint;
using crossgram::tgcalls_shim::IsControlledLocalP2p;
using crossgram::tgcalls_shim::SessionParameters;

[[noreturn]] void Fail() {
  std::abort();
}

void Check(bool condition) {
  if (!condition) Fail();
}

SessionParameters LocalParameters() {
  SessionParameters parameters;
  parameters.config.enable_p2p = 1;
  parameters.endpoints.push_back({1, "127.0.0.1", "", 9, CROSSGRAM_TGCALLS_ENDPOINT_LAN, {}});
  return parameters;
}

}  // namespace

int main() {
  SessionParameters direct;
  direct.config.enable_p2p = 1;
  Check(IsControlledLocalP2p(direct));

  auto local = LocalParameters();
  Check(IsControlledLocalP2p(local));

  local.config.enable_p2p = 0;
  Check(!IsControlledLocalP2p(local));

  SessionParameters turn;
  turn.rtc_servers.push_back({7, "turn.example.test", 3478, "user", "password", true, false});
  Check(IsControlledLocalP2p(turn));

  for (const auto type : {CROSSGRAM_TGCALLS_ENDPOINT_INET, CROSSGRAM_TGCALLS_ENDPOINT_UDP_RELAY,
                          CROSSGRAM_TGCALLS_ENDPOINT_TCP_RELAY}) {
    auto unsupported = LocalParameters();
    unsupported.endpoints.front().type = type;
    Check(!IsControlledLocalP2p(unsupported));
  }
  return 0;
}
