#include "crossgram/tgcalls_shim.h"

#include <cstring>
#include <memory>
#include <new>
#include <string>
#include <utility>
#include <vector>

#include "session.h"

struct crossgram_tgcalls_shim {
  std::unique_ptr<crossgram::tgcalls_shim::Session> session;
};

namespace {

using crossgram::tgcalls_shim::Endpoint;
using crossgram::tgcalls_shim::SessionParameters;

bool IsBoolean(uint8_t value) noexcept {
  return value == 0 || value == 1;
}

bool IsEndpointType(crossgram_tgcalls_endpoint_type type) noexcept {
  return type <= CROSSGRAM_TGCALLS_ENDPOINT_TCP_RELAY;
}

bool IsProtocolVersion(crossgram_tgcalls_protocol_version version) noexcept {
  return version == CROSSGRAM_TGCALLS_PROTOCOL_V0 || version == CROSSGRAM_TGCALLS_PROTOCOL_V1;
}

bool CopyHost(crossgram_tgcalls_string_view input, std::string* output) {
  if (output == nullptr || input.length > 255 || (input.data == nullptr && input.length != 0)) return false;
  if (input.length != 0 && std::memchr(input.data, '\0', input.length) != nullptr) return false;
  output->assign(input.data, input.length);
  return true;
}

bool CopyParameters(const crossgram_tgcalls_session_config* config,
                    const crossgram_tgcalls_session_auth* auth,
                    const crossgram_tgcalls_endpoint* endpoints,
                    uint32_t endpoint_count,
                    SessionParameters* output) {
  if (output == nullptr) return false;
  const auto reject = [output] {
    output->Wipe();
    return false;
  };
  if (config == nullptr || auth == nullptr || auth->key == nullptr ||
      auth->key_length != CROSSGRAM_TGCALLS_SHIM_AUTH_KEY_BYTES || endpoint_count == 0 ||
      endpoint_count > CROSSGRAM_TGCALLS_SHIM_MAX_ENDPOINTS || endpoints == nullptr ||
      !IsBoolean(config->enable_p2p) || !IsBoolean(config->allow_tcp) || !IsBoolean(config->enable_aec) ||
      !IsBoolean(config->enable_ns) || !IsBoolean(config->enable_agc) || !IsBoolean(auth->is_outgoing) ||
      !IsProtocolVersion(config->protocol_version)) {
    return reject();
  }

  output->config = *config;
  std::memcpy(output->auth_key.data(), auth->key, output->auth_key.size());
  output->is_outgoing = auth->is_outgoing != 0;
  output->endpoints.reserve(endpoint_count);
  for (uint32_t index = 0; index < endpoint_count; ++index) {
    const auto& source = endpoints[index];
    if (source.port == 0 || !IsEndpointType(source.type) ||
        (source.ipv4.length == 0 && source.ipv6.length == 0)) {
      return reject();
    }
    Endpoint destination;
    destination.id = source.id;
    destination.port = source.port;
    destination.type = source.type;
    std::memcpy(destination.peer_tag.data(), source.peer_tag, destination.peer_tag.size());
    if (!CopyHost(source.ipv4, &destination.ipv4) || !CopyHost(source.ipv6, &destination.ipv6)) {
      return reject();
    }
    output->endpoints.push_back(std::move(destination));
  }
  return true;
}

template <typename Function>
crossgram_tgcalls_shim_status CatchStatus(Function&& function) noexcept {
  try {
    return function();
  } catch (const std::bad_alloc&) {
    return CROSSGRAM_TGCALLS_SHIM_STATUS_ALLOCATION_FAILED;
  } catch (...) {
    return CROSSGRAM_TGCALLS_SHIM_STATUS_INTERNAL_ERROR;
  }
}

}  // namespace

extern "C" {

crossgram_tgcalls_shim_status crossgram_tgcalls_session_create(
    uint32_t abi_version,
    const crossgram_tgcalls_session_config* config,
    const crossgram_tgcalls_session_auth* auth,
    const crossgram_tgcalls_endpoint* endpoints,
    uint32_t endpoint_count,
    const crossgram_tgcalls_session_callbacks* callbacks,
    crossgram_tgcalls_shim** out_session) {
  return CatchStatus([&] {
    if (out_session == nullptr || callbacks == nullptr) return CROSSGRAM_TGCALLS_SHIM_STATUS_INVALID_ARGUMENT;
    *out_session = nullptr;
    if (abi_version != CROSSGRAM_TGCALLS_SHIM_ABI_VERSION) return CROSSGRAM_TGCALLS_SHIM_STATUS_ABI_MISMATCH;

    SessionParameters parameters;
    if (!CopyParameters(config, auth, endpoints, endpoint_count, &parameters)) {
      return CROSSGRAM_TGCALLS_SHIM_STATUS_INVALID_ARGUMENT;
    }
    auto adapter = crossgram::tgcalls_shim::CreateProductionSessionAdapter(parameters);
    auto session = std::make_unique<crossgram_tgcalls_shim>();
    session->session = std::make_unique<crossgram::tgcalls_shim::Session>(
        std::move(parameters), *callbacks, std::move(adapter));
    *out_session = session.release();
    return CROSSGRAM_TGCALLS_SHIM_STATUS_OK;
  });
}

crossgram_tgcalls_shim_status crossgram_tgcalls_session_start(crossgram_tgcalls_shim* session) {
  return CatchStatus([&] {
    return session == nullptr ? CROSSGRAM_TGCALLS_SHIM_STATUS_INVALID_ARGUMENT : session->session->Start();
  });
}

crossgram_tgcalls_shim_status crossgram_tgcalls_session_receive_signaling(
    crossgram_tgcalls_shim* session, const uint8_t* data, uint32_t length) {
  return CatchStatus([&] {
    return session == nullptr ? CROSSGRAM_TGCALLS_SHIM_STATUS_INVALID_ARGUMENT
                              : session->session->ReceiveSignaling(data, length);
  });
}

crossgram_tgcalls_shim_status crossgram_tgcalls_session_push_capture_20ms(
    crossgram_tgcalls_shim* session, const int16_t* samples) {
  return CatchStatus([&] {
    return session == nullptr ? CROSSGRAM_TGCALLS_SHIM_STATUS_INVALID_ARGUMENT
                              : session->session->PushCapture20ms(samples);
  });
}

crossgram_tgcalls_shim_status crossgram_tgcalls_session_pop_playout_20ms(
    crossgram_tgcalls_shim* session, int16_t* samples) {
  return CatchStatus([&] {
    return session == nullptr ? CROSSGRAM_TGCALLS_SHIM_STATUS_INVALID_ARGUMENT
                              : session->session->PopPlayout20ms(samples);
  });
}

crossgram_tgcalls_shim_status crossgram_tgcalls_session_stop(crossgram_tgcalls_shim* session) {
  return CatchStatus([&] {
    return session == nullptr ? CROSSGRAM_TGCALLS_SHIM_STATUS_INVALID_ARGUMENT : session->session->Stop();
  });
}

crossgram_tgcalls_shim_status crossgram_tgcalls_session_join(crossgram_tgcalls_shim* session) {
  return CatchStatus([&] {
    return session == nullptr ? CROSSGRAM_TGCALLS_SHIM_STATUS_INVALID_ARGUMENT : session->session->Join();
  });
}

crossgram_tgcalls_shim_status crossgram_tgcalls_session_destroy(crossgram_tgcalls_shim** session) {
  return CatchStatus([&] {
    if (session == nullptr) return CROSSGRAM_TGCALLS_SHIM_STATUS_INVALID_ARGUMENT;
    if (*session == nullptr) return CROSSGRAM_TGCALLS_SHIM_STATUS_OK;
    if (!(*session)->session->joined()) return CROSSGRAM_TGCALLS_SHIM_STATUS_INVALID_STATE;
    delete *session;
    *session = nullptr;
    return CROSSGRAM_TGCALLS_SHIM_STATUS_OK;
  });
}

}  // extern "C"
