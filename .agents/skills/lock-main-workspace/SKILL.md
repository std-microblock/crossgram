---
name: lock-main-workspace
description: Acquire and release a shared FIFO lease for a Git repository's main workspace across multiple agents, branches, and worktrees. Use when an agent must exclusively enter or operate on the main workspace for tests, builds, branch switching, shared services, or any workflow that currently relies on manually waiting for other agents.
---

# Lock Main Workspace

Use the bundled zero-dependency Node.js script to coordinate exclusive access to the repository's main workspace. The lease and FIFO wait tickets live under Git's common directory, so every worktree shares the same lock while no state is committed.

## Choose an agent ID

Choose one stable, unique ID for the current agent/task and reuse it for both acquire and release. Prefer the Codex task name or thread ID plus a short descriptive suffix. Do not use only a branch name when multiple agents may work on that branch.

```text
relay-e2e-019f9b06
```

## Acquire the lease

Before entering or operating on the main workspace, block until the agent reaches the head of the FIFO queue:

```sh
node .agents/skills/lock-main-workspace/scripts/workspace-lock.mjs acquire --agent "relay-e2e-019f9b06" --label "run relay e2e"
```

The `acquire` process exits after printing `ACQUIRED`, but the lease remains held for that agent. After acquisition, perform any required commands or edits in the reported main workspace. Do not treat the end of the acquire process as a release.

Useful acquire options:

- `--wait-timeout <duration>` limits the wait, such as `30m` or `2h`; the default is unlimited.
- `--poll <duration>` changes the polling interval; the default is `1s`.
- `--quiet` suppresses position updates.
- `--lock-dir <path>` overrides automatic Git common-directory discovery. Use the same absolute path for every participant when coordinating unrelated clones.

An interrupted waiter removes its own ticket. Tickets left by crashed waiting processes are pruned automatically. An acquired lease is deliberately not tied to a shell PID and never expires automatically.

## Release in all outcomes

Release with the exact same agent ID immediately after the protected work finishes, whether it succeeds or fails:

```sh
node .agents/skills/lock-main-workspace/scripts/workspace-lock.mjs release --agent "relay-e2e-019f9b06"
```

Treat release like a `finally` block. Do not leave the lease held while doing unrelated work or waiting for user input.

## Inspect the lock

Inspect the holder and FIFO waiters without changing them:

```sh
node .agents/skills/lock-main-workspace/scripts/workspace-lock.mjs status
```

Add `--json` for machine-readable output. Status also reports the resolved main workspace path.

If the recorded holder is known to be permanently abandoned, another agent may explicitly break it:

```sh
node .agents/skills/lock-main-workspace/scripts/workspace-lock.mjs release --agent "recovery-agent" --force
```

Use `--force` only after checking `status` and confirming that the holder cannot release its lease. Never force-release merely because a protected task is slow.

Run `node .agents/skills/lock-main-workspace/scripts/workspace-lock.mjs help` for the complete CLI synopsis.
