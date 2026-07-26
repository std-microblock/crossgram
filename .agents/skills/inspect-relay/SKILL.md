---
name: inspect-relay
description: Inspect and collect mtproto-relay runtime diagnostics, including persisted Koishi/Cordis logs, live MTProto debug events, a message with all related SQLite rows, arbitrary database tables, and read-only SQL. Use when debugging mtproto-relay behavior, tracing a Telegram or QQNT message, checking service errors, comparing protocol traffic with stored state, or when asked to 拉日志、查消息、查数据库、看 MTProto debug、排查转发问题.
---

# Inspect Relay

Use the bundled `scripts/inspect-relay.mjs` instead of composing ad-hoc PowerShell or SQLite commands. It emits JSON and opens SQLite databases read-only.

## Locate the runtime

Run from the repository or pass `--root <path>`. The script discovers `data/cordis.db` and `data/logs.db` by walking upward. Override them with `--db` and `--logs-db`.

```sh
node .agents/skills/inspect-relay/scripts/inspect-relay.mjs doctor
```

If the active deployment is on another host, run the same command over SSH in that deployment checkout. Do not copy a live SQLite database unless SQLite's backup mechanism is used.

## Gather only relevant evidence

Start narrow, then expand:

```sh
# Recent persisted Koishi/Cordis logs
node .agents/skills/inspect-relay/scripts/inspect-relay.mjs logs --limit 200 --since 30m --level warn

# Filter logs by logger name or text
node .agents/skills/inspect-relay/scripts/inspect-relay.mjs logs --name mtproto --grep RPC

# Current MTProto capture buffer through the read-only HTTP API
node .agents/skills/inspect-relay/scripts/inspect-relay.mjs mtproto --limit 100 --name messages.sendMessage

# Correlate a result, connection, or decoded payload field
node .agents/skills/inspect-relay/scripts/inspect-relay.mjs mtproto --request-message-id 0x1234
node .agents/skills/inspect-relay/scripts/inspect-relay.mjs mtproto --connection-id conn-7 --grep RPC_ERROR
node .agents/skills/inspect-relay/scripts/inspect-relay.mjs mtproto --field payload.peer.channelId=42 --since 10m

# Internal message id and every directly related row
node .agents/skills/inspect-relay/scripts/inspect-relay.mjs message 42

# Native platform message id, optionally scoped to a conversation
node .agents/skills/inspect-relay/scripts/inspect-relay.mjs message qq-message-id --platform-id --conversation 12

# Generic table access and read-only SQL
node .agents/skills/inspect-relay/scripts/inspect-relay.mjs tables
node .agents/skills/inspect-relay/scripts/inspect-relay.mjs table mtproto_update_delivery --where published=false --limit 100
node .agents/skills/inspect-relay/scripts/inspect-relay.mjs sql "SELECT * FROM mtproto_auth_session LIMIT 20"
```

The `mtproto` command calls `/api/mtproto-debug/events` and falls back to the legacy WebUI snapshot on older deployments. Use `--webui http://127.0.0.1:3140` when the server differs, `--capture-path <path>` for a customized plugin path, or `--legacy-webui` to force the old protocol. Filters include `--since`, `--until`, `--after-id`, `--before-id`, `--id`, `--name`, `--direction`, `--phase`, `--connection-id`, `--message-id`, `--request-message-id`, `--auth-key-id`, `--session-id`, `--grep`, and repeatable `--field path=value`. Add `--compact` for JSONL-friendly compact output and `--output <file>` to save UTF-8 JSON.

## Correlate results

For message delivery issues, collect the message bundle first, then query logs and MTProto events using its `primaryPlatformMessageId`, Telegram `tlMessageId`, conversation id, or nearby timestamp. Read [references/schema.md](references/schema.md) only when table relationships are needed.

Never expose `credentials`, `totpSecret`, auth keys, access tokens, or unrelated message contents in the final response. Summarize findings and cite identifiers; retain raw output locally unless the user explicitly requests it.
