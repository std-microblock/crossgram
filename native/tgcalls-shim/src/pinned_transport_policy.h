#ifndef CROSSGRAM_TGCALLS_SHIM_PINNED_TRANSPORT_POLICY_H_
#define CROSSGRAM_TGCALLS_SHIM_PINNED_TRANSPORT_POLICY_H_

#include "session.h"

namespace crossgram::tgcalls_shim {

// Only WebRTC ICE servers and optional LAN endpoints are accepted by InstanceImpl.
bool IsControlledLocalP2p(const SessionParameters& parameters) noexcept;

}  // namespace crossgram::tgcalls_shim

#endif  // CROSSGRAM_TGCALLS_SHIM_PINNED_TRANSPORT_POLICY_H_
