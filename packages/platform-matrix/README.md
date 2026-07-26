# @mtproto-relay/platform-matrix

Matrix Client-Server API adapter for CrossGram. It connects one Matrix account
to one named Cordis platform entry and exposes joined rooms to Telegram clients.

```yaml
- id: matrix
  name: '@mtproto-relay/platform-matrix'
  config:
    homeserver: https://matrix.example.com
    accessToken: replace-with-your-access-token
    # Optional; otherwise /account/whoami is used.
    userId: '@alice:example.com'
    # Optional HTTP(S) proxy for API and media requests.
    proxy: http://127.0.0.1:7890
    syncTimeoutMs: 30000
    requestTimeoutMs: 30000
```

The adapter supports account profiles, direct and group rooms, Matrix Spaces,
room history, incremental `/sync`, text/image/file/audio/video messages, replies,
media upload/download, read markers, text edits, redactions, members, power-level
permissions, and user/room avatars. Mixed Telegram messages are represented by
multiple ordered Matrix events and retained as one logical bridge message.

## Current limitations

- End-to-end encryption is not implemented. Encrypted events and attachments are
  shown as explicit placeholders instead of exposing ciphertext or silently
  dropping messages. Use an unencrypted room for full functionality.
- Matrix reactions and stickers are not exposed yet.
- Edits currently accept a single text part. Matrix forwarding is not supported.
- Matrix Spaces are shown as channel-shaped dialogs; room hierarchy is not yet
  projected as Telegram subchannels.

## Tests

```bash
yarn workspace @mtproto-relay/platform-matrix test
yarn workspace @mtproto-relay/platform-matrix test:e2e
```

The e2e suite starts a real local HTTP server and a tunneling HTTP proxy, then
exercises the adapter through the same authenticated transport used for a
homeserver.
