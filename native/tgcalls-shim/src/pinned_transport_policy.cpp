#include "pinned_transport_policy.h"

namespace crossgram::tgcalls_shim {

bool IsControlledLocalP2p(const SessionParameters& parameters) noexcept {
  if (!parameters.config.enable_p2p) return false;
  for (const auto& endpoint : parameters.endpoints) {
    if (endpoint.type != CROSSGRAM_TGCALLS_ENDPOINT_LAN) return false;
  }
  return true;
}

}  // namespace crossgram::tgcalls_shim
