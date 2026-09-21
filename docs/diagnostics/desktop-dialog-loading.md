# Desktop dialog loading investigation (2026-09-21)

## Client contract

Compared against the local AyuGramDesktop reference, revision db3b9891cb:

- Telegram/SourceFiles/apiwrap.cpp, requestMoreDialogs (934): requests folder 0,
  exclude_pinned=true, initially 20 dialogs and then 500. A messages.dialogs
  result ends loading; a messages.dialogsSlice must contain a dialog whose
  top_message matches a message with the same peer and a nonzero date.
- updateDialogsOffset (1040): derives offset_date/id/peer from those messages.
  Count alone does not cause another request when no dated top message exists.
- requestMoreDialogsIfNeeded (1020): folder-filter exception loading temporarily
  takes precedence, then normal loading resumes. Archive is only considered if
  data.folderLoaded(1) exists.
- data/data_folder.cpp, Folder::applyDialog (354): consuming a dialogFolder
  creates the archive summary and starts loading its children.
- data/data_chat_filters.cpp, loadNextExceptions (986): both success and failure
  callbacks resume requestMoreDialogsIfNeeded. Custom folders are not themselves
  evidence that ordinary pagination is permanently blocked.

## Confirmed server defects

### Saved Messages cursor identity

QQ device chats are exposed as the account self peer (Saved Messages/Favorites).
fetchDialogsPage previously passed that logical afterId straight to QQNT, which
only recognizes the physical device conversation ID. QQNT treats an unknown
anchor as offset zero. Both client pagination and the bridge's internal folder
scan could therefore revisit the first page. In the local 143-dialog fixture,
placing Saved Messages at index 99 made the first response incorrectly report
200 dialogs. Translate afterId through wireConversationId before the HTTP call;
ordinary opaque IDs and numeric cursors retain their existing behavior.

### Archive discovery

The main folder intentionally excludes archived rows, but getPinnedDialogs
always returned an empty page and no response advertised a dialogFolder.
Consequently a fresh desktop session could finish its main list without knowing
Archive exists. A subsequent update or explicitly included custom-folder peer
could incidentally introduce an archived chat, making it appear later.

The main pinned response now includes a pinned Archive summary with a matching
representative message and peer metadata. Folder 1's pinned response stays empty.
getPeerDialogs(inputDialogPeerFolder(1)) now returns a folder summary rather than
all child dialogs; an empty summary lets Desktop clear an emptied archive.
Unscoped Android feeds and ordinary dialog-page limits/order are unchanged.

## Production evidence and limits

Read-only, bounded process-local probes found 130 persisted conversations,
26 with QQ assistant mask 2, two durable archive entries, and custom filters.
These counts are not a claim about the complete upstream dialog total.
Captured first-page slices had 20 dialogs and 19–20 dated matching top messages;
the sampled last entries also had valid dates. This rules out a missing date in
those particular samples, not every possible response. Counts varied between
84, 86 and 162. Repeated zero-offset requests were visible, but their originating
client could not be reliably correlated with a stored authorization, so they
are not treated as proof of the affected desktop's exact request sequence.
No production data, credentials, or raw chat content is included here. Diagnostic
probes were removed. No production deployment or real desktop binary run was
performed for these changes.

## Validation

- 293 unit tests passed across dialog projection/folders, QQ adapter,
  platform-manager, update-manager, conversation kinds, and blocked dialogs.
- 13 HTTP/TL/SQLite E2E tests passed in saved-messages and dialog-folders suites.
- Two authenticated MTProto socket E2E tests passed: Archive discovery and the
  existing login/reconnect/contacts/history/send scenario.
- The new Saved Messages unit and HTTP/TL tests failed before the cursor fix.
- yarn build and git diff --check passed.
- Full yarn typecheck remains blocked by pre-existing inputUser comparisons in
  dialogs.ts and union-type errors in request-inbox tests; no new diagnostics
  were reported for the changed paths/expressions.

Tests were run in an isolated worktree because the main checkout contained
unrelated unfinished edits importing a missing conversation-view module.

## Root cause found after the first two fixes (2026-09-21)

The first two commits did not resolve the desktop symptom. Live inspection of
the affected client (`QQ-Cross.exe`, a patched AyuGram 6.7.8 build) showed:

- `messages.getDialogs` was re-requested from offset zero every ~10 seconds and
  never advanced to a second page.
- The client log reported
  `RPC Error: request NNNN got fail with code 0, error CLIENT_RESPONSE_PARSE_FAILED`,
  and its own MTProto trace showed
  `(could not decode type)(ERROR_SCHEME_BAD_CONS:0x19420af6)` inside the
  `reply_markup` of the platform management bot's message, in the very
  `messages.dialogsSlice` response carrying the chat list.

`0x19420af6` is `keyboardInlineButtonRow`, a constructor that exists only in
API layer 229. The server answered this layer-228 client with the newest
keyboard shape because the per-layer writer map is built as
`Object.assign(baseWriterMap, generatedFromLayerSnapshot)`: the bundled current
schema stays authoritative for every constructor, so a newest-only constructor
nested inside a field the older layer does define (here `replyInlineMarkup.rows`)
is written verbatim. The client cannot decode it, drops the entire response, and
therefore never receives the dialog list. Chats only appeared when a pushed
update introduced them, which matches the reported symptom.

Related: `Updates::stateDone` (AyuGramDesktop api_updates.cpp) calls
`requestDialogs()` whenever the update state is re-initialized, so each
unsuccessful cycle restarts pagination from the first page.

The fix adds a layer-aware response adapter (`getApiLayerResponseAdapter`) that
rewrites newest-only constructors into the target layer's wire form before
serialization, on both response and pushed-update paths. Today only the inline
keyboard family needs it: `keyboardInlineButtonRow`/`keyboardInlineButton` are
converted into legacy `keyboardButtonRow` rows with `keyboardButtonUrl`,
`keyboardButtonCallback`, `keyboardButtonCopy`, `keyboardButtonUserProfile` or
`keyboardButtonSwitchInline` buttons. A button whose action the target layer
cannot carry is dropped rather than downgraded to a working-looking but inert
button. Clients that negotiate the current layer keep the newest form.

Regression coverage:

- `packages/mtproto/src/rpc/api-layer.test.ts`: the adapter rewrites the markup,
  the layer-228 reader *throws* on the unadapted value, and parses the adapted
  value.
- `packages/mtproto/src/session/server-session.e2e.test.ts`: a real layer-228
  socket client parses both the dialog response and a pushed update containing
  the newest-only keyboard.
- `packages/test-suite/src/login.e2e.test.ts`: a layer-228 client logs in, calls
  `messages.getDialogs`, and receives a parseable dialog list whose preview has
  legacy buttons. Both transport and app-level tests were confirmed to fail with
  the adapter disabled.