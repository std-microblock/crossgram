---
name: debug-mtproto-e2e
description: Run a real local mtcute MTProto client against a Crossgram server with automatic QR-token approval, persistent credentials, and TypeScript probe scripts. Use when reproducing client-visible relay bugs without Android/Desktop UI, validating MTProto RPC behavior against local or production Crossgram, comparing client and server evidence, testing reconnect/session persistence, or exercising dialogs, history, media, updates, and send flows end to end.
---

# Debug MTProto E2E

Use `@mtproto-relay/mtproto-e2e-client` through `yarn mtproto:e2e`. It connects over the real MTProto socket, authenticates by approving a QR login token through Crossgram's localhost management endpoint, and stores the reusable mtcute session under `data/mtproto-e2e/<profile>/credentials.json`.

Read [references/probes.md](references/probes.md) for probe templates and common RPC shapes.

## Workflow

1. Choose a stable profile name for the server and account. Reuse it across probes for the same identity.
2. Authenticate once. For production, use SSH-backed approval so no phone code, TOTP seed, or raw server auth key leaves the server:

   ```sh
   yarn mtproto:e2e auth --profile production --ssh root@118.89.184.208 --platform qqnt
   ```

   The command fetches only the public RSA key, connects to port `4430`, requests a Telegram QR login token, posts it through SSH to the remote WebUI bound at `127.0.0.1:3140`, and saves the client session locally. If the SSH target is only an alias or differs from the public MTProto address, also pass `--host <public-host>`.

3. Create a self-contained probe under `work/mtproto-e2e/`. Export `run(context)` or a default function. Use `context.call()` for bounded raw RPCs and `context.publish()` for intermediate evidence.
4. Run the probe:

   ```sh
   yarn mtproto:e2e run work/mtproto-e2e/issue.ts --profile production
   ```

5. Correlate the JSON-line client output with server-side evidence. Use `$inspect-relay` only when the client result is insufficient; align requests by method, time, peer/message identifiers, and connection behavior.
6. Add or update unit tests and a real MTProto E2E regression test when fixing the bug. Do not leave the probe as the only test.

## Local server authentication

For a locally running server, provide its public RSA key and direct localhost approval endpoint:

```sh
yarn mtproto:e2e auth \
  --profile local \
  --host 127.0.0.1 \
  --port 4430 \
  --rsa-key data/rsa-key.json \
  --approval-origin http://127.0.0.1:3140 \
  --platform qqnt
```

Use the platform ID registered in that server instance; synthetic test fixtures commonly use `static`.

## Probe contract

```ts
import type { MtprotoE2eProbeContext } from '@mtproto-relay/mtproto-e2e-client'

export async function run({ call, publish }: MtprotoE2eProbeContext) {
  const state = await call({ _: 'updates.getState' })
  publish({ stage: 'state', pts: state.pts, date: state.date })
  return { ok: true }
}
```

- Keep every RPC bounded. `context.call()` defaults to 30 seconds; pass a shorter timeout when appropriate.
- Return or publish selected scalar fields and exact counts, not whole client, Context, storage, or large message collections.
- Treat the production client as read-only unless the user explicitly asks for a write. For sends, use an approved conversation and a deterministic marker.
- Prefer exact assertions: result constructor, counts, IDs, ordering, file sizes, and reconnect behavior.
- Destroying the probe client is automatic, including on timeout or failure.

## Credentials and recovery

- Never print or copy `credentials.json`; it contains the reusable client authorization session.
- Never commit `data/mtproto-e2e/` or copy credentials into `work/`. The repository ignores `/data`.
- Reuse the same profile to validate fresh process connections without logging in again.
- Use `--fresh` only when intentionally testing first authorization. Existing credentials are moved under the profile's `stale/` directory instead of being deleted.
- If the server reports a revoked or unregistered auth key and automatic approval is configured, the client archives the stale credential and authenticates again automatically.
- A QR login token is short-lived but still sensitive. The SSH approval transport sends it over stdin and does not place it in command arguments or normal output.

## Acceptance evidence

Require at least:

1. An `authenticated` event and a successful real MTProto RPC.
2. Probe output containing bounded, issue-specific facts.
3. A second process using the saved profile without another `auth-required` event when testing persistence.
4. Server-side evidence only when needed to explain a discrepancy, not as a substitute for the local-client observation.

Do not claim a client-visible bug is fixed from a server-only unit test or debug-script result.
