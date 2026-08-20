---
name: debug-android-e2e
description: Reproduce and diagnose Android client bugs with AVD, programmatic Activity/View E2E probes, logcat, MTProto capture, file-cache evidence, and optional Frida inspection. Use for Android login hangs, Telegram media/reaction/sticker loading failures, queue starvation, custom server/DC routing bugs, or any request that forbids coordinate-based UI automation and requires validating the real production UI.
---

# Debug Android E2E

Use production Activities and Views as the test surface. Do not treat screenshots, coordinate taps, or a small shortcut strip as proof that the underlying feature works.

Read [references/android-reaction-debugging.md](references/android-reaction-debugging.md) when debugging reaction/media loading, custom MTProto routing, native builds, or first-login failures.

## Workflow

1. Work in an independent worktree. Acquire the repository's main-workspace lease before modifying or building a shared reference checkout.
2. Define a safe, deterministic fixture. For message UI, use an explicitly approved conversation and a read-only operation unless sending is required.
3. Patch an E2E Activity or production Activity dispatcher to invoke the real code path programmatically.
4. Add structured logcat markers for start, progress, success, and failure. Include counts and identifiers, not credentials or unrelated message text.
5. Inject patches in the correct order: run the normal source patch first, then run the E2E source injection again so the final source contains the probe.
6. Build and install the APK. Use a persistent debug keystore so `adb install -r` preserves app data when desired.
7. Reproduce from a cold state when testing initial login or media downloads.
8. Correlate Android receiver state, on-disk files, logcat, and protocol requests. Do not accept a single evidence source.
9. Run unit tests, build checks, and the programmatic AVD E2E. Remove temporary Frida scripts and restore debug configuration before review.

## Programmatic UI rules

- Never drive the test with screen coordinates.
- Instantiate or locate the real production View, attach it to a real Activity window, and invoke the production method directly or by reflection.
- Supply required layout parameters and delegates before methods that measure, lay out, or draw the View.
- Test the complete UI surface. A compact reaction row does not validate the expanded reaction panel.
- Traverse RecyclerView content programmatically. Wait until every visible cell is ready, record its adapter position, then scroll to the next range. Succeed only after every adapter position has been observed ready.
- Reject placeholder-only success. Require `ImageReceiver.hasImageLoaded()` for network-backed images and require the corresponding `FileLoader` path to exist after a cold-cache run.
- Distinguish non-network drawables from network-backed documents instead of forcing a file assertion onto static local icons.

## Reaction panel acceptance

Validate both stages:

1. Compact panel: every `ReactionHolderView` is present, each enter/loop receiver is loaded, custom documents resolve, and every expected file exists.
2. Expanded panel: invoke the real expansion method, inspect the real emoji grid, visit all adapter positions, verify each receiver, and verify each network document landed on disk.

Emit final counts such as compact holders/resources and expanded cells/items/files. Require exact equality rather than “at least one loaded.”

## First-login acceptance

- Clear app data to reproduce first install.
- Grant runtime permissions that would otherwise overlay or stall the test Activity, especially notification permission on Android 13+.
- Apply the custom server configuration before submitting the phone.
- Drive the real phone and code pages through their methods.
- Wait for explicit phone-submitted, code-submitted, and `activated=true` markers.
- If the UI looks logged in but requests return `AUTH_KEY_UNREGISTERED`, treat the local session as stale and rerun the true first-login path.

## Evidence hierarchy

Prefer this order:

1. E2E marker with exact loaded/expected counts.
2. Production receiver state and file existence.
3. Android network/logcat evidence.
4. Server MTProto capture aligned to the same request.
5. Frida object inspection as an auxiliary tool only.

Do not use Frida as the primary UI driver. Use it to inspect fields, receivers, queues, or native state when normal instrumentation cannot expose them cleanly.

## Safety and cleanup

- Do not log phone secrets, TOTP secrets, auth keys, tokens, or unrelated messages.
- Keep message/reaction inspection read-only unless the user explicitly authorizes a write.
- Restore paused debug capture and temporary server configuration.
- Delete scratch Frida scripts and generated inspection artifacts.
- Stop or release shared services and workspace leases in all outcomes.
- Wait for user review before committing when the project workflow requires it.
