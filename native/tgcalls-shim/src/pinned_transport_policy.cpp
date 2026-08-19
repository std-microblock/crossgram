#include "pinned_transport_policy.h"

namespace crossgram::tgcalls_shim {

bool IsControlledLocalP2p(const SessionParameters& parameters) noexcept {
  for (const auto& endpoint : parameters.endpoints) {
    if (endpoint.type != CROSSGRAM_TGCALLS_ENDPOINT_LAN) return false;
  }
  return parameters.config.enable_p2p || !parameters.rtc_servers.empty();
}

}  // namespace crossgram::tgcalls_shim
