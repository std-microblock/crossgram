# Bot chats could not be muted (2026-09-24)

## Symptom

A chat with a bridge-owned bot (request inbox `26048`, platform admin `116`,
flash transfer `2`, botfather `111`) did not hold a mute: the chat showed
unmuted again right after the client applied one. Reported as "bot chat 还是不能
免打扰" one day after the PEER_ID_INVALID fix of 2026-09-23, which had removed
the hard failures but not the symptom.

## Root cause

`users.getFullUser` never answered with `userFull.bot_info`.

`user` marks a bot through the bit 14 slot it shares with `bot_info_version`
(`bot:flags.14?true bot_info_version:flags.14?int`), and Telegram's wire form
carries an int there. Desktop reads a non-negative value and allocates bot
state, but `userFull`'s missing `bot_info` left it permanently uninitialized:
`Data::ApplyUserUpdate` falls back to `setBotInfoVersion(-1)` whenever the
field is absent, which only rewrites the version and never marks the info as
loaded.

While a bot chat is open, Telegram Desktop reacts to every `FullInfo` update
with

```cpp
// Telegram/SourceFiles/history/history_inner_widget.cpp
void HistoryInner::refreshAboutView(bool force) {
    if (const auto info = user->botInfo.get()) {
        refresh();
        if (!info->inited) {
            session().api().requestFullPeer(user);   // → users.getFullUser
        }
    }
}
```

and `HistoryWidget::fullInfoUpdated()` calls it on every peer update - which is
what each reply produces. A bot peer therefore re-requested the whole full
user at round-trip speed for as long as its chat stayed open.

That loop is what ate the muting. `Data::ApplyUserUpdate` applies
`fullUser.notify_settings` on every reply and `PeerNotifySettings::change`
overwrites the stored value, so the reply that followed a client-side mute
(~14 ms later) restored the server's settings. Telegram Desktop serializes the
peer's settings 1 s after the change (`kNotifySettingSaveTimeout`), so the
request it finally sent carried the reverted state, and the relay stored an
unmute for a mute click.

## Evidence

- Production capture (`/api/mtproto-debug/events`, 2026-09-24 19:17-19:34 CST,
  2 s of buffer): one connection (`conn-7`, auth key `1b4cc036ec3f5280` →
  device session `e654eb6d80166989`, "21TU" Telegram Desktop 7.0.9) asked
  `users.getFullUser` for the request inbox bot 101 times in 1.2 s - 306 times
  in one 30 s window - with `mt_msgs_ack` as the only other method. The client
  negotiated API layer 228 and the answer was a well-formed, fully populated
  `users.userFull`, so the client kept parsing it and kept asking again.
- The same bot's `userFull` carried no `bot_info`, and the request inbox bot is
  the chat the user was working in when the mute failed.
- `mtproto_notification_settings` holds a full settings write with
  `muteUntil: 0` for `peer:bridge:request-inbox` (2026-09-23 20:42) and for
  `peer:bridge:qq-flash-transfer` (2026-09-23 02:47) - the shape a client
  sends when it flushes an *unmuted* peer, not the `mute_until=0` of a mute.
- The pre-fix client capture (2026-09-22 18:47 UTC, flash transfer bot) shows
  the sequence `account.getNotifySettings` → `updateNotifySettings(muteUntil=
  2147483647)` → `account.getNotifySettings` → `updateNotifySettings(muteUntil=
  0)` inside 285 ms, i.e. the client reverting its own click.

## Fix

`bridge` commit `04bbc7f` (`bridge: answer bot full users with bot info`):

- `users.getFullUser` reports `botInfo` for every peer whose TL `user` carries
  the `bot` flag, with the platform description when the bridge knows one and
  no `user_id` (these bots are not managed by a user). The about view then
  reports `inited` after the first reply, so the re-request loop never starts.
- `makeUser` states `botInfoVersion: 0` explicitly for synthesized bots. The
  slot always carries an int on the wire; making it explicit keeps the value
  the client reads from depending on how the writer handles an absent field.
- Humans are untouched: `bot_info` stays off their `userFull`, and
  `makeUser` only adds the version for bots.

## Verification

- Workstation: `packages/bridge` 53 files / 723 tests pass (18 skipped), the
  mtproto-e2e config runs `notification-settings.e2e.test.ts` 5 tests, and the
  new cases fail without the fix (`synthetic.test.ts` pins the wire form of a
  bot user, `request-inbox.test.ts` asserts the request inbox answers with
  `bot_info` and `botInfoVersion: 0`, `dialogs.test.ts` keeps `bot_info` off
  humans).
- Production, after the fast-forward (23 19:44 CST): the relay's own probe
  (`work/mtproto-e2e/bot-fulluser-botinfo.ts`) read all four bots back as
  `botInfo` + `bot: true` + `botInfoVersion: 0`, and muting the request inbox
  bot returned `muteUntil=2147483647` from both `users.getFullUser` and
  `messages.getPeerDialogs` before the probe restored it.
- Storm: the capture window that held 306 `users.getFullUser` calls in 30 s
  before the restart held 5 in 1884 events afterwards - the four probe reads
  and the one mute verification.

## Rollout

- `crossgram` fast-forwarded `e6e7122` → `04bbc7f` on `/opt/crossgram` and
  `crossgram.service` was restarted; the previous revision and `app.yml` are
  backed up in `/var/lib/crossgram/backups/20260924-bot-fulluser/`. No
  dependency change, so nothing was built or installed on the production host.
- Pre-existing and unrelated: `messages.getBotCallbackAnswer` still answers
  `500 ... inline keyboard buttonId and botAppid are required` when a client
  clicks a QQ inline keyboard (2 entries since the restart).