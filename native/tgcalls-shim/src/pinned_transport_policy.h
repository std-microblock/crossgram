#ifndef CROSSGRAM_TGCALLS_SHIM_PINNED_TRANSPORT_POLICY_H_
#define CROSSGRAM_TGCALLS_SHIM_PINNED_TRANSPORT_POLICY_H_

#include "session.h"

namespace crossgram::tgcalls_shim {

// The fixed C ABI has no STUN/TURN scheme or TURN credentials.
bool IsControlledLocalP2p(const SessionParameters& parameters) noexcept;

}  // namespace crossgram::tgcalls_shim

#endif  // CROSSGRAM_TGCALLS_SHIM_PINNED_TRANSPORT_POLICY_H_
