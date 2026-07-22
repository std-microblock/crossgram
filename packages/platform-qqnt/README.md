# @mtproto-relay/platform-qqnt

`IMPlatform` adapter for the local server injected by `qqnt-bridge` into QQNT.

```yaml
- id: qqnt
  name: '@mtproto-relay/platform-qqnt'
  config:
    endpoint: http://127.0.0.1:18767/v1
    # token: optional-shared-secret
```

The transport uses JSON for metadata, SSE for ordered incoming events, a
chunked request body for uploads, and a ranged chunked response for downloads.
The adapter reads `IMMediaSource.stream()` directly and never constructs a
complete media `Buffer`.

QQNT's native API accepts local paths rather than byte streams. The injected QQ
process therefore writes the incoming request incrementally to a private
staging file, invokes the native API, and removes the staging file after QQ
confirms or rejects the message. Memory use remains bounded.

## Tests

```sh
pnpm --filter @mtproto-relay/platform-qqnt test
```

Live E2E tests are opt-in:

```sh
QQNT_BRIDGE_E2E=1 pnpm --filter @mtproto-relay/platform-qqnt test:e2e
```

They hard-code the requested safety allowlist: direct messages only target
`MicroBlock (1715311957)`, while group messages only target `1058754719` or
`1084013940`. Set `QQNT_BRIDGE_E2E_FILE` to additionally test a streamed file
upload and ranged download.
