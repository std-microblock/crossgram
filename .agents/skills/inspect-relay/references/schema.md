# Diagnostic schema map

## Message graph

- `mtproto_im_message`: canonical normalized message.
- `mtproto_im_message_alias`: native platform message ids mapped to the canonical message.
- `mtproto_im_media`: normalized attachments belonging to the message.
- `mtproto_tl_message_part`: Telegram-visible message parts and `tlMessageId` values.
- `mtproto_im_message_reaction`: normalized reactions.
- `mtproto_im_conversation`: conversation metadata referenced by `conversationId`.
- `mtproto_im_user`: sender metadata referenced by `senderUserId`.

## Delivery state

- `mtproto_update_delivery`: durable Telegram update outbox and publication state.
- `mtproto_update_state`: global `pts`, `qts`, `seq`, and date per platform session.
- `mtproto_channel_update_state`: channel-specific update state.
- `mtproto_route_binding`: auth key to runtime route mapping.
- `mtproto_auth_binding`: auth key to platform session mapping.

## Sessions

- `mtproto_platform_session`: platform account credentials and metadata. Treat credentials as secret.
- `mtproto_auth_session`: virtual Telegram login and TOTP secret. Treat the TOTP secret as secret.

## Runtime diagnostics

- `data/logs.db`, table `logs`: persisted Cordis log messages from `@cordisjs/plugin-logger-webui`.
- WebUI `/api`: in-memory MTProto debug entry. Its capture buffer is bounded and disappears on restart.
