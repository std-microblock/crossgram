# MTProto E2E probe patterns

## Contents

- [Minimal health probe](#minimal-health-probe)
- [Dialogs and history](#dialogs-and-history)
- [Reconnect probes](#reconnect-probes)
- [Write probe](#write-probe)
- [CLI options](#cli-options)
- [Output interpretation](#output-interpretation)

## Minimal health probe

```ts
import type { MtprotoE2eProbeContext } from '@mtproto-relay/mtproto-e2e-client'

export default async function ({ call, profile, user }: MtprotoE2eProbeContext) {
  const state = await call({ _: 'updates.getState' }, 10_000)
  return {
    endpoint: `${profile.config.host}:${profile.config.port}`,
    userId: user.id,
    state: { pts: state.pts, qts: state.qts, date: state.date, seq: state.seq },
  }
}
```

## Dialogs and history

Use `Long.ZERO` for TL `long` fields.

```ts
import { Long } from '@mtcute/node'
import type { MtprotoE2eProbeContext } from '@mtproto-relay/mtproto-e2e-client'

export async function run({ call, publish }: MtprotoE2eProbeContext) {
  const dialogs = await call({
    _: 'messages.getDialogs',
    excludePinned: false,
    offsetDate: 0,
    offsetId: 0,
    offsetPeer: { _: 'inputPeerEmpty' },
    limit: 50,
    hash: Long.ZERO,
  })
  if (dialogs._ === 'messages.dialogsNotModified') return { result: dialogs._ }
  publish({
    stage: 'dialogs',
    result: dialogs._,
    dialogs: dialogs.dialogs.length,
    messages: dialogs.messages.length,
    chats: dialogs.chats.length,
    users: dialogs.users.length,
  })

  const peer = dialogs.dialogs[0]?.peer
  if (!peer) return { result: 'empty' }
  const history = await call({
    _: 'messages.getHistory',
    peer,
    offsetId: 0,
    offsetDate: 0,
    addOffset: 0,
    limit: 20,
    maxId: 0,
    minId: 0,
    hash: Long.ZERO,
  })
  return {
    result: history._,
    messages: history._ === 'messages.messagesNotModified' ? 0 : history.messages.length,
  }
}
```

When a dialog peer requires an access hash, obtain the exact `inputPeer` from the returned dialog/peer cache or construct it from known fixture data. Do not guess access hashes in production probes.

## Reconnect probes

Use separate CLI invocations with the same profile when validating persisted credentials across processes. The later process should emit `authenticated` without `auth-required`.

For a transport reconnect inside one process, use the exposed client directly:

```ts
import type { MtprotoE2eProbeContext } from '@mtproto-relay/mtproto-e2e-client'

export async function run({ client, call }: MtprotoE2eProbeContext) {
  const before = await call({ _: 'updates.getState' })
  await client.disconnect()
  await client.connect()
  const after = await call({ _: 'updates.getState' })
  return { before: before.pts, after: after.pts }
}
```

When investigating the first RPC after reconnect, make the suspected RPC first. Do not add a health call before it if that call could initialize or warm the session and hide the race.

## Write probe

Only send after the user authorizes a write and identifies a safe conversation.

```ts
import { Long } from '@mtcute/node'
import type { MtprotoE2eProbeContext } from '@mtproto-relay/mtproto-e2e-client'

export async function run({ call }: MtprotoE2eProbeContext) {
  const marker = `crossgram-e2e-${Date.now()}`
  const result = await call({
    _: 'messages.sendMessage',
    peer: { _: 'inputPeerUser', userId: 123, accessHash: Long.ZERO },
    message: marker,
    randomId: Long.fromString(String(Date.now())),
  })
  return { marker, result: result._ }
}
```

Replace the peer with an approved, verified fixture. Record the returned message/update ID and read it back through history when validating end-to-end persistence.

## CLI options

Common options:

| Option | Meaning |
| --- | --- |
| `--profile <name>` | Persistent connection/authentication profile. |
| `--root <path>` | Profile root; defaults to `data/mtproto-e2e`. |
| `--ssh <target>` | Fetch the public key and approve QR login through the remote host. |
| `--platform <id>` | Crossgram platform account used to approve the QR token. |
| `--host <host>` / `--port <n>` | MTProto socket endpoint. |
| `--rsa-key <path>` | Local RSA JSON or PKCS#1 public PEM. |
| `--approval-origin <url>` | Direct management origin for local tests. |
| `--fresh` | Archive saved credentials and force first authorization. |
| `--auth-timeout-ms <n>` | Authentication timeout. |
| `--timeout-ms <n>` | Whole probe timeout. |
| `--call-timeout-ms <n>` | Default per-RPC timeout. |

Use `yarn mtproto:e2e doctor --profile <name>` to inspect non-secret profile metadata and whether a credential file exists. `doctor` does not print the public key or session.

## Output interpretation

The CLI emits JSON lines:

- `profile`: resolved non-secret endpoint and credential path.
- `auth-required`: a new QR token was requested; the token itself is not printed.
- `auth-approved`: Crossgram accepted the QR token for the selected platform.
- `authenticated`: mtcute completed authorization.
- `result`: a value returned or published by the probe.
- `credential-archived` / `auth-retry`: a stale or intentionally reset session was preserved and replaced.

Capture only the lines needed for the bug report. Redact unrelated user/message data before sharing evidence.
