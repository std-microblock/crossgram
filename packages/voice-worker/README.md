# Crossgram voice worker foundation

This standalone Rust crate is intentionally not part of the JavaScript workspace. It provides local-worker foundations and an optional native-session backend seam:

- versioned, length-prefixed local IPC with strict frame and opaque-signal bounds; private DH exponents are generated only inside the worker and never have an IPC field;
- a single-call state machine with deterministic teardown and committed recipient flow (`PrepareRecipient(ga_hash)` followed by `CompleteRecipient(ga, expected_fingerprint)`);
- Telegram's fixed 2048-bit safe-prime DH group, fixed-width 256-byte big-endian public values, public-value margin checks, call key confirmation, shared-key derivation, and signed little-endian TL fingerprints;
- Telegram call AES key/IV KDF material derivation (it does not encrypt media);
- an in-memory fake media backend for protocol tests and worker integration;
- a `tgcalls-backend` feature that defines fixed-width `repr(C)` session layouts plus a synchronous opaque-session factory; a safe native-symbol adapter must copy all construction inputs before returning, and the owner is `Send` but intentionally not `Sync`;
- an unavailable native adapter as the production fallback, so enabling the feature alone cannot make media active or replace `UnavailableMediaBackend`.

The worker accepts framed binary requests on standard input and writes framed binary public responses on standard output. `--unix <path>` serves the same protocol on a Unix-domain socket, with exactly one request/response exchange per connection. The socket parent is forced to mode `0700`; startup refuses an existing socket path; the socket is forced to mode `0600` regardless of the process umask; Linux `SO_PEERCRED` requires the connecting process to have the worker's UID; and each connection has five-second read/write timeouts. It neither persists nor logs call endpoints, signaling, secret material, audio, or keys. Production continues to use `UnavailableMediaBackend`; the optional seam does not link or select tgcalls by itself.

## Wire format

Every message is a `u32` big-endian payload length followed by a payload beginning with the one-byte protocol version (`3`) and one-byte message tag. Lengths are checked before allocation; integer fields are big-endian unless marked little-endian.

### Requests

| Tag | Request payload after version and tag |
| --- | --- |
| `0x01` | `call_id: u64` — prepare caller |
| `0x02` | `call_id: u64`, `ga_hash: [u8; 32]` — prepare recipient |
| `0x03` | `call_id: u64`, `gb: [u8; 256]` — complete caller |
| `0x04` | `call_id: u64`, `ga: [u8; 256]`, `expected_fingerprint: i64` little-endian — complete recipient |
| `0x05` | `call_id: u64`, caller-supplied `request_id: u64`, `signal_length: u16`, `signal: [u8; signal_length]` — forward signal; signal length is at most 32,768 bytes |
| `0x06` | `call_id: u64` — hang up |
| `0x07` | `call_id: u64`, caller-supplied `request_id: u64` — attach the single PCM endpoint after media is active |
| `0x08` | `call_id: u64`, `capability: [u8; 32]`, one 1,920-byte PCM frame — send fixed-format PCM to the worker |
| `0x09` | `call_id: u64`, `capability: [u8; 32]` — receive one fixed-format PCM frame, if available |
| `0x0a` | `call_id: u64`, `capability: [u8; 32]` — permanently close the PCM endpoint and call |

### Responses

| Tag | Response payload after version and tag |
| --- | --- |
| `0x81` | `ga_hash: [u8; 32]` — caller prepared |
| `0x82` | `gb: [u8; 256]` — recipient prepared |
| `0x83` | `ga: [u8; 256]`, `fingerprint: i64` little-endian — caller completed |
| `0x84` | `fingerprint: i64` little-endian — recipient completed |
| `0x85` | `request_id: u64` — signal forwarded; correlates the caller-supplied signal request ID |
| `0x86` | no fields — hung up |
| `0x87` | `request_id: u64`, `capability: [u8; 32]` — the one-use PCM endpoint attachment |
| `0x88` | no fields — fixed-format PCM frame accepted |
| `0x89` | one 1,920-byte PCM frame — fixed-format PCM received from the worker |
| `0x8a` | no fields — no worker PCM frame is currently available |
| `0x8b` | no fields — PCM endpoint and call closed |
| `0xff` | `error_code: u8` — public error (`1` invalid request, `2` busy, `3` invalid state, `4` crypto, `5` media unavailable) |

PCM is 20 ms of mono 48 kHz signed-16-bit little-endian audio. An attach replay with the exact call/request pair returns the same capability without opening another backend endpoint; a different attach request is rejected. The capability is held only by the local bridge endpoint, never logged, and is zeroized on local closure, hangup, timeout, worker failure, or client shutdown. PCM is accepted only after the backend has started the call and opened both PCM directions; the production placeholder never does either.

An active call retains at most 16 signal request identities (SHA-256 digest plus public response) for replay. An exact retry returns the original public response without forwarding again; a reused request ID with a different signal, or a new signal after the cache is full, fails closed. The cache is dropped with the active call on timeout, hangup, or terminal media failure; signal bytes are never retained beyond handling, and cache entries retain only digests and public responses. See `src/ipc.rs` for the authoritative limits.

## Third-party licenses

Direct dependencies are exact-pinned in `Cargo.toml`:

| Crate | Version | License |
| --- | --- | --- |
| `crypto-bigint` | 0.7.5 | Apache-2.0 OR MIT |
| `nix` | 0.30.1 | MIT |
| `sha1` | 0.10.6 | MIT OR Apache-2.0 |
| `sha2` | 0.10.9 | MIT OR Apache-2.0 |
| `zeroize` | 1.8.2 | Apache-2.0 OR MIT |

`crypto-bigint` is exact-pinned and built with only its `zeroize` feature. The DH implementation uses its fixed-width pure-Rust `U2048` Montgomery arithmetic; this crate has no `num-bigint`, OpenSSL, or GMP dependency. Transitive dependency license information is recorded by Cargo in `Cargo.lock` and should be reviewed before distribution.

## Verification

```sh
cargo fmt --check --manifest-path packages/voice-worker/Cargo.toml
cargo test --locked --manifest-path packages/voice-worker/Cargo.toml
cargo clippy --locked --manifest-path packages/voice-worker/Cargo.toml --all-targets -- -D warnings
cargo test --locked --manifest-path packages/voice-worker/Cargo.toml --features tgcalls-backend
cargo clippy --locked --manifest-path packages/voice-worker/Cargo.toml --all-targets --features tgcalls-backend -- -D warnings
```
