# Android reaction, media, and login debugging

## Contents

1. AVD and custom server routing
2. Reaction panel probe pattern
3. Media queue failure modes
4. First-login probe
5. Protocol and Frida correlation
6. Native and Java build workflow

## 1. AVD and custom server routing

Android Emulator reaches the host through `10.0.2.2`, not host loopback. A custom MTProto main connection may use the configured host correctly while later `FileLoader` connections trust `help.getConfig.dc_options` and reconnect to an unusable `127.0.0.1` address.

When custom-server mode is active:

- Keep the configured route instead of replacing it with server-advertised loopback DC options.
- Apply the route to generic IPv4 address type `0` and media/download IPv4 type `2`.
- Clear stale IPv6 address types `1` and `3` when the custom endpoint is IPv4-only.
- Confirm logcat shows media connections to `10.0.2.2:<port>` and the server receives `upload.getFile`.

## 2. Reaction panel probe pattern

Use the real `ReactionsContainerLayout` inside `LaunchActivity` or another production Activity.

Required ordering:

1. Construct the panel.
2. Set a no-op read-only delegate.
3. Create and set `LayoutParams`.
4. Call `setMessage(...)`.
5. Attach to the Activity decor/root.
6. Start the normal enter animation.

Setting the message before layout parameters can break measurement. Drawing without a delegate can trigger a null dereference.

Validate compact holders through their actual receivers:

- `enterImageView.getImageReceiver()`
- `loopImageView.animatedEmojiDrawable.getImageReceiver()` for custom emoji
- otherwise `loopImageView.getImageReceiver()`

Open the full panel by invoking the production expansion method, such as `showCustomEmojiReactionDialog()`, rather than clicking its screen coordinates. Obtain the real `SelectAnimatedEmojiDialog.emojiGridView` from the resulting reactions window.

For each visible `ImageViewEmoji`:

- Default reaction: require its `imageReceiver.hasImageLoaded()` and the selected animation document file.
- Custom reaction: require the `AnimatedEmojiDrawable` receiver and the main custom document file.
- Other network cell: require its receiver and `cell.document` file.
- Local-only drawable: require a non-null drawable.

Record ready adapter positions in a set. Scroll only after the whole visible page is ready. Finish only when:

```text
loadedPositions.size == adapter.itemCount
expandedFiles > 0
lastVisible == adapter.itemCount - 1
```

Before a cold run, cancel background loads and delete every reaction catalog document, not only the seven compact entries. Otherwise an old blocked queue or warm cache can make results misleading.

## 3. Media queue failure modes

### Document size must match EOF

Telegram clients use `Document.size` to decide whether to request another part. If metadata advertises even one or two bytes more than the server can return, `FileLoadOperation` waits forever at EOF. A small-media operation can then occupy a queue slot and block later reaction assets.

Build resource metadata from the actual served file size and test every bundled reaction asset:

```text
document.size == servedBytes.length
```

### Raw custom reaction documents need the main document

APNG, GIF, WebP, PNG, and other raw custom reactions may have no thumbnail. If `AnimatedEmojiDrawable` only loads TGS/WebM main documents and otherwise asks for a missing thumb, no network request starts.

For raw sticker/custom-emoji MIME types:

- Load `ImageLocation.getForDocument(document)`.
- Use the main document in LiteMode/static-preview paths too.
- Add a first-frame filter for raw animated formats when appropriate.

### Placeholders are not success

An SVG thumb or static fallback can draw while the real document is still absent. Require both `hasImageLoaded()` on the production receiver and file existence after cache deletion.

## 4. First-login probe

Use a dispatcher Activity to apply server configuration before presenting `LoginActivity`. Drive `PhoneView.onNextPressed(...)` and the active code view's `onNextPressed(code)` programmatically.

Recommended markers:

```text
server_config_applied
page_opened:login
login_phone_submitted
login_code_page_ready
login_code_submitted
state activated=true
```

If code submission never occurs:

1. Confirm `auth.sendCode` reached the server.
2. Confirm the response returned and the LoginActivity changed to a code page.
3. Confirm the second E2E intent still targets the same LoginActivity instance.
4. Generate the TOTP near submission time; avoid crossing a 30-second window during a slow send-code response.
5. Distinguish a stale local activated flag from a server-recognized auth key.

## 5. Protocol and Frida correlation

Use structured logcat markers around each UI stage. Immediately query the server MTProto capture with narrow filters so background contacts/sticker traffic does not evict the relevant event.

For media loading, align:

```text
cell/holder starts loading
Android connects to media DC type 2
server receives upload.getFile
server returns the final part/EOF
FileLoader path appears
receiver reports hasImageLoaded
```

Use Frida only when an object field or native queue cannot be observed through the E2E Activity. Prefer one-shot scripts that attach, print bounded state, and exit. Never dump auth keys or message content.

## 6. Native and Java build workflow

Run source patching before E2E injection. If `patch:source` runs after `e2e:source`, inject E2E again.

For Nagram debug builds, use the persistent E2E keystore at:

```text
D:\crossgram\work\e2e-signing\release.keystore
```

Store/key password and alias are project-local test configuration; do not print them in reports.

Use a full native build after changing tgnet/C++ routing. Before building, remove any stale prebuilt `TMessagesProj/src/main/libs/x86_64/libtmessages.49.so`; Gradle `pickFirst` can otherwise package the stale prebuilt instead of the CMake output.

For Java-only E2E probe changes after the correct native library is already built, set:

```text
NAGRAM_BUILD_ARGS=skip_buildCMakeDebug
```

After installation, test both:

1. `adb install -r` to preserve an existing session.
2. `adb shell pm clear <package>` followed by programmatic login for a true first-install path.
