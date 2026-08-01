#ifndef CROSSGRAM_TGCALLS_SHIM_H_
#define CROSSGRAM_TGCALLS_SHIM_H_

#include <stdint.h>

#if defined(_WIN32)
#define CROSSGRAM_TGCALLS_SHIM_API __declspec(dllexport)
#elif defined(__GNUC__)
#define CROSSGRAM_TGCALLS_SHIM_API __attribute__((visibility("default")))
#else
#define CROSSGRAM_TGCALLS_SHIM_API
#endif

#ifdef __cplusplus
extern "C" {
#endif

#define CROSSGRAM_TGCALLS_SHIM_ABI_VERSION UINT32_C(3)
#define CROSSGRAM_TGCALLS_SHIM_PCM_SAMPLE_RATE_HZ 48000u
#define CROSSGRAM_TGCALLS_SHIM_PCM_CHANNELS 1u
#define CROSSGRAM_TGCALLS_SHIM_PCM_SAMPLE_BYTES 2u
#define CROSSGRAM_TGCALLS_SHIM_PCM_FRAME_DURATION_MS 20u
#define CROSSGRAM_TGCALLS_SHIM_PCM_FRAME_SAMPLES 960u
#define CROSSGRAM_TGCALLS_SHIM_PCM_CALLBACK_DURATION_MS 10u
#define CROSSGRAM_TGCALLS_SHIM_PCM_CALLBACK_SAMPLES 480u
#define CROSSGRAM_TGCALLS_SHIM_PCM_QUEUE_CAPACITY 4u
#define CROSSGRAM_TGCALLS_SHIM_AUTH_KEY_BYTES 256u
#define CROSSGRAM_TGCALLS_SHIM_MAX_ENDPOINTS 16u
#define CROSSGRAM_TGCALLS_SHIM_MAX_SIGNAL_BYTES 32768u

/** Opaque full session handle. */
typedef struct crossgram_tgcalls_shim crossgram_tgcalls_shim;
/** Opaque fixed-capacity PCM bridge handle. */
typedef struct crossgram_tgcalls_pcm_bridge crossgram_tgcalls_pcm_bridge;

/** Stable fixed-width values for the versioned C ABI. */
typedef uint32_t crossgram_tgcalls_shim_status;
typedef uint32_t crossgram_tgcalls_endpoint_type;
typedef uint32_t crossgram_tgcalls_protocol_version;

#define CROSSGRAM_TGCALLS_SHIM_STATUS_OK UINT32_C(0)
#define CROSSGRAM_TGCALLS_SHIM_STATUS_INVALID_ARGUMENT UINT32_C(1)
#define CROSSGRAM_TGCALLS_SHIM_STATUS_STOPPED UINT32_C(2)
#define CROSSGRAM_TGCALLS_SHIM_STATUS_INPUT_FULL UINT32_C(3)
#define CROSSGRAM_TGCALLS_SHIM_STATUS_OUTPUT_EMPTY UINT32_C(4)
#define CROSSGRAM_TGCALLS_SHIM_STATUS_ABI_MISMATCH UINT32_C(5)
#define CROSSGRAM_TGCALLS_SHIM_STATUS_ALLOCATION_FAILED UINT32_C(6)
#define CROSSGRAM_TGCALLS_SHIM_STATUS_INVALID_STATE UINT32_C(7)
#define CROSSGRAM_TGCALLS_SHIM_STATUS_BACKEND_UNAVAILABLE UINT32_C(8)
#define CROSSGRAM_TGCALLS_SHIM_STATUS_INTERNAL_ERROR UINT32_C(9)

#define CROSSGRAM_TGCALLS_ENDPOINT_INET UINT32_C(0)
#define CROSSGRAM_TGCALLS_ENDPOINT_LAN UINT32_C(1)
#define CROSSGRAM_TGCALLS_ENDPOINT_UDP_RELAY UINT32_C(2)
#define CROSSGRAM_TGCALLS_ENDPOINT_TCP_RELAY UINT32_C(3)

#define CROSSGRAM_TGCALLS_PROTOCOL_V0 UINT32_C(0)
#define CROSSGRAM_TGCALLS_PROTOCOL_V1 UINT32_C(1)

/**
 * A non-owning UTF-8 view. It is copied synchronously by session creation and
 * must not contain an embedded NUL. It is used for endpoint host names only.
 */
typedef struct crossgram_tgcalls_string_view {
  const char* data;
  uint32_t length;
} crossgram_tgcalls_string_view;

/** One typed Telegram call endpoint. Both host views may be empty, but not both. */
typedef struct crossgram_tgcalls_endpoint {
  int64_t id;
  crossgram_tgcalls_string_view ipv4;
  crossgram_tgcalls_string_view ipv6;
  uint16_t port;
  crossgram_tgcalls_endpoint_type type;
  uint8_t peer_tag[16];
} crossgram_tgcalls_endpoint;

/**
 * Public, non-secret transport options. Fields are copied synchronously.
 * Boolean fields are exactly zero or one; initialization/receive timeouts are
 * milliseconds, with zero meaning the upstream default.
 */
typedef struct crossgram_tgcalls_session_config {
  uint32_t initialization_timeout_ms;
  uint32_t receive_timeout_ms;
  uint8_t enable_p2p;
  uint8_t allow_tcp;
  uint8_t enable_aec;
  uint8_t enable_ns;
  uint8_t enable_agc;
  crossgram_tgcalls_protocol_version protocol_version;
} crossgram_tgcalls_session_config;

/**
 * The key is exactly 256 bytes of Telegram call authentication material. The
 * session copies it synchronously and wipes its copy during terminal teardown.
 */
typedef struct crossgram_tgcalls_session_auth {
  const uint8_t* key;
  uint32_t key_length;
  uint8_t is_outgoing;
} crossgram_tgcalls_session_auth;

/**
 * Called by an upstream network thread when it has opaque signaling payload.
 * `data` is valid only for this call; the receiver must copy it synchronously.
 * The callback must not call any session API or block on session teardown.
 */
typedef void (*crossgram_tgcalls_outbound_signaling_callback)(
    void* context, const uint8_t* data, uint32_t length);

/**
 * Reports a terminal or API failure category. The callback is synchronous,
 * receives no sensitive data, and must neither throw nor re-enter the session.
 */
typedef void (*crossgram_tgcalls_error_callback)(
    void* context, crossgram_tgcalls_shim_status status);

typedef struct crossgram_tgcalls_session_callbacks {
  void* context;
  crossgram_tgcalls_outbound_signaling_callback outbound_signaling;
  crossgram_tgcalls_error_callback error;
} crossgram_tgcalls_session_callbacks;

/** Returns the ABI version implemented by this library. */
CROSSGRAM_TGCALLS_SHIM_API uint32_t crossgram_tgcalls_shim_abi_version(void);

/**
 * Creates a session seam and its bounded native-PCM bridge. All typed inputs
 * are copied before this call returns. `endpoints` must be non-null when
 * `endpoint_count` is non-zero. A null endpoint pointer with zero endpoints is
 * accepted only when `config->enable_p2p` is exactly one; all other null/count
 * combinations are rejected. Creation does not open a socket or start media.
 * The installed production adapter is intentionally unavailable until the
 * separately approved tgcalls artifact is linked.
 */
CROSSGRAM_TGCALLS_SHIM_API crossgram_tgcalls_shim_status crossgram_tgcalls_session_create(
    uint32_t abi_version,
    const crossgram_tgcalls_session_config* config,
    const crossgram_tgcalls_session_auth* auth,
    const crossgram_tgcalls_endpoint* endpoints,
    uint32_t endpoint_count,
    const crossgram_tgcalls_session_callbacks* callbacks,
    crossgram_tgcalls_shim** out_session);

/** Starts an already-created session. It does not claim media readiness on failure. */
CROSSGRAM_TGCALLS_SHIM_API crossgram_tgcalls_shim_status crossgram_tgcalls_session_start(
    crossgram_tgcalls_shim* session);

/** Copies one bounded opaque inbound signaling payload into the native adapter. */
CROSSGRAM_TGCALLS_SHIM_API crossgram_tgcalls_shim_status crossgram_tgcalls_session_receive_signaling(
    crossgram_tgcalls_shim* session,
    const uint8_t* data,
    uint32_t length);

/**
 * Pushes/pulls fixed-format PCM through the existing bounded bridge. Input is
 * copied before return; output is written to caller-owned storage. Every frame
 * is 20 ms, mono, 48 kHz native int16_t (960 samples / 1,920 bytes).
 */
CROSSGRAM_TGCALLS_SHIM_API crossgram_tgcalls_shim_status crossgram_tgcalls_session_push_capture_20ms(
    crossgram_tgcalls_shim* session, const int16_t* samples);
CROSSGRAM_TGCALLS_SHIM_API crossgram_tgcalls_shim_status crossgram_tgcalls_session_pop_playout_20ms(
    crossgram_tgcalls_shim* session, int16_t* samples);

/**
 * Terminal control calls are idempotent in this order: stop, join, destroy.
 * Join is the callback quiescence boundary: after it returns, the native adapter
 * has admitted no further callback and every admitted callback has returned.
 * Destroy takes the owning handle slot, clears it on success, and accepts an
 * already-null slot so it never dereferences a previously freed handle.
 */
CROSSGRAM_TGCALLS_SHIM_API crossgram_tgcalls_shim_status crossgram_tgcalls_session_stop(
    crossgram_tgcalls_shim* session);
CROSSGRAM_TGCALLS_SHIM_API crossgram_tgcalls_shim_status crossgram_tgcalls_session_join(
    crossgram_tgcalls_shim* session);
CROSSGRAM_TGCALLS_SHIM_API crossgram_tgcalls_shim_status crossgram_tgcalls_session_destroy(
    crossgram_tgcalls_shim** session);

/** Creates a standalone bounded PCM bridge for the requested ABI version. */
CROSSGRAM_TGCALLS_SHIM_API crossgram_tgcalls_shim_status crossgram_tgcalls_pcm_bridge_create(
    uint32_t abi_version,
    crossgram_tgcalls_pcm_bridge** out_bridge);
CROSSGRAM_TGCALLS_SHIM_API crossgram_tgcalls_shim_status crossgram_tgcalls_pcm_bridge_push_capture_20ms(
    crossgram_tgcalls_pcm_bridge* bridge,
    const int16_t* samples);
CROSSGRAM_TGCALLS_SHIM_API crossgram_tgcalls_shim_status crossgram_tgcalls_pcm_bridge_pop_capture_10ms(
    crossgram_tgcalls_pcm_bridge* bridge,
    int16_t* samples);
CROSSGRAM_TGCALLS_SHIM_API crossgram_tgcalls_shim_status crossgram_tgcalls_pcm_bridge_push_playout_10ms(
    crossgram_tgcalls_pcm_bridge* bridge,
    const int16_t* samples);
CROSSGRAM_TGCALLS_SHIM_API crossgram_tgcalls_shim_status crossgram_tgcalls_pcm_bridge_pop_playout_20ms(
    crossgram_tgcalls_pcm_bridge* bridge,
    int16_t* samples);
CROSSGRAM_TGCALLS_SHIM_API crossgram_tgcalls_shim_status crossgram_tgcalls_pcm_bridge_stop(
    crossgram_tgcalls_pcm_bridge* bridge);
CROSSGRAM_TGCALLS_SHIM_API crossgram_tgcalls_shim_status crossgram_tgcalls_pcm_bridge_drain(
    crossgram_tgcalls_pcm_bridge* bridge);
CROSSGRAM_TGCALLS_SHIM_API crossgram_tgcalls_shim_status crossgram_tgcalls_pcm_bridge_join(
    crossgram_tgcalls_pcm_bridge* bridge);
/** Clears the owning handle slot on success and accepts an already-null slot. */
CROSSGRAM_TGCALLS_SHIM_API crossgram_tgcalls_shim_status crossgram_tgcalls_pcm_bridge_destroy(
    crossgram_tgcalls_pcm_bridge** bridge);
CROSSGRAM_TGCALLS_SHIM_API uint64_t crossgram_tgcalls_pcm_bridge_dropped_playout_frames(
    const crossgram_tgcalls_pcm_bridge* bridge);

#ifdef __cplusplus
}  // extern "C"
#endif

#endif  // CROSSGRAM_TGCALLS_SHIM_H_
