---
name: inspect-relay
description: Inspect the live Crossgram/Cordis process by deploying short-lived TypeScript probes through the production debug-scripts runner. Use when tracing relay behavior, querying the active database, reading recent Cordis logs, inspecting services or memory state, attaching temporary event listeners, or diagnosing production-only Telegram/QQNT behavior. Also use for Crossgram service health and journald fallback when the process cannot load probes.
---

# Inspect Relay

Use `scripts/probe-relay.mjs` as the control plane. Prefer a process-local probe over ad-hoc SQL, copied databases, permanent debug APIs, or temporary changes to production packages.

## Check the runner

```sh
node .agents/skills/inspect-relay/scripts/probe-relay.mjs doctor
node .agents/skills/inspect-relay/scripts/probe-relay.mjs list
```

The default host is `root@118.89.184.208`. Override it with `--host` or `CROSSGRAM_INSPECT_HOST`.

If Crossgram is stopped or the runner is unavailable, use SSH only for the fallback surface:

```sh
ssh root@118.89.184.208 'systemctl status crossgram --no-pager'
ssh root@118.89.184.208 'journalctl -u crossgram -n 200 --no-pager'
```

## Read MTProto statistics

Use the built-in one-shot probe to read the live, read-only
`mtprotoStatistics` service. It returns the same bounded snapshot and time
series used by the WebUI, including per-RPC count, average, P90, P99, errors,
error rate, failure reasons, slow samples, and runtime data:

```sh
node .agents/skills/inspect-relay/scripts/probe-relay.mjs statistics
```

The command deploys the bundled probe through `debug-scripts`, waits for one
published result, prints that result directly as JSON, and removes the probe.
To stay safely below the debug result size limit, it includes the latest 300
second points, 180 minute points, and 48 hour points; the snapshot itself is
complete and contains all collector-retained per-RPC rows.
Use `--keep` only when diagnosing the runner itself; ordinary monitoring must
leave no active probe behind.

## Write a probe

Create a self-contained `.ts` file under the repository `work/` directory. Every probe must export `apply(ctx)` and publish bounded structured results.

```ts
export async function apply(ctx) {
  await ctx.debugScript.publish({
    script: ctx.debugScript.name,
    generation: ctx.debugScript.generation,
    value: "ok",
  });
}
```

Use Cordis-managed effects for listeners, timers, and other resources so removal or hot reload cleans them up:

```ts
export function apply(ctx) {
  ctx.on("some/event", (value) => ctx.debugScript.publish(value));
  ctx.effect(() => {
    const timer = setInterval(
      () => ctx.debugScript.publish({ alive: true }),
      1000,
    );
    return () => clearInterval(timer);
  });
}
```

## Common inspections

Query the active database through `ctx.database`; never read credentials or connect separately:

```ts
export async function apply(ctx) {
  const rows = await ctx.database
    .select("mtproto_im_message", { id: 42 })
    .execute();
  await ctx.debugScript.publish(rows);
}
```

Read recent in-process Cordis logs from the built-in bounded buffer:

```ts
export async function apply(ctx) {
  const rows = ctx.logger.buffer
    .filter((item) => item.name.includes("mtproto"))
    .slice(-200)
    .map(({ sn, ts, name, type, level, args }) => ({
      sn,
      ts,
      name,
      type,
      level,
      args,
    }));
  await ctx.debugScript.publish(rows);
}
```

Inspect services through the same `ctx` received by normal plugins. Do not serialize whole Context, Fiber, socket, request, or database objects; select the exact scalar fields needed.

## Deploy and collect

For a one-shot probe that publishes at least one result:

```sh
node .agents/skills/inspect-relay/scripts/probe-relay.mjs run work/probe.ts
```

`run` uploads atomically, waits for a result, prints JSON, and removes the probe. For longer captures:

```sh
node .agents/skills/inspect-relay/scripts/probe-relay.mjs deploy work/probe.ts --name issue/probe.ts
node .agents/skills/inspect-relay/scripts/probe-relay.mjs wait issue/probe.ts --result --timeout 30000
node .agents/skills/inspect-relay/scripts/probe-relay.mjs status issue/probe.ts
node .agents/skills/inspect-relay/scripts/probe-relay.mjs remove issue/probe.ts
```

The runtime also expires active probes automatically. Always remove probes explicitly after collecting evidence and run `cleanup` if a previous interrupted investigation left files behind.

## Safety

- Start narrow and publish only identifiers and fields relevant to the issue.
- Do not publish credentials, TOTP secrets, auth keys, access tokens, or unrelated message contents.
- Do not mutate production state unless the user explicitly asks for that mutation.
- Do not run builds, broad scans, unbounded queries, or CPU-heavy analysis on the production server.
- Keep probes self-contained. Hot reload is transactional for the entry module, but global mutations and unmanaged native handles cannot be rolled back safely.
