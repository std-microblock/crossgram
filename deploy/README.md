# Linux deployment

Crossgram runs as the unprivileged `crossgram` user. Its checkout lives in
`/opt/crossgram`, while the database, MTProto auth keys, RSA key, and media
cache live under `/var/lib/crossgram/data`. The WebUI binds only to localhost;
the MTProto listener uses port 4430 by default.

The rendered runtime configuration lives at `/opt/crossgram/.runtime/app.yml`
so Cordis can resolve workspace plugins from the checkout. Git updates do not
touch this untracked, root-managed directory.

For a public checkout, install with:

```sh
curl -fsSL https://raw.githubusercontent.com/std-microblock/crossgram/main/deploy/install.sh \
  | sudo CROSSGRAM_PUBLIC_HOST=203.0.113.10 sh
```

For a private checkout, first install a read-only GitHub deploy key for the
`crossgram` user's home (`/var/lib/crossgram/.ssh`), clone the repository into
`/opt/crossgram`, and run `sudo CROSSGRAM_PUBLIC_HOST=203.0.113.10
/opt/crossgram/deploy/install.sh`.

The service reads QQNT's bearer token from `/etc/qqnt-bridge.env`. It is never
copied into the application YAML. An explicit `token` in the QQNT plugin config
still takes precedence over `QQNT_BRIDGE_TOKEN`.

The production configuration enables the platform management bot, self-hosted
Telegram Bot API (including `@BotFather`), and QQ Flash Transfer bot. Before its
first deployment, set a randomly generated persistent verifier secret in the
root-managed `/etc/crossgram.env`:

```sh
umask 077
printf 'TELEGRAM_BOT_TOKEN_VERIFIER_SECRET=%s\n' "$(openssl rand -base64 48 | tr -d '\n')" \
  | sudo tee -a /etc/crossgram.env >/dev/null
```

Sticker Importer remains opt-in because it needs an official Telegram Bot API
token to download public sticker packs. Set `TELEGRAM_STICKER_IMPORTER_BOT_TOKEN`
only after providing that token, then enable its plugin in the root-managed
runtime YAML.

Update and restart the checkout with:

```sh
sudo crossgram-update
```

The updater only accepts a fast-forward from `origin/main`, then runs
`yarn install --immutable`, `yarn build`, and restarts the service. It never
resets local data or overwrites the files under `/var/lib/crossgram`.
Yarn dependency build scripts are enabled only for the immutable install so
the locked native dependencies (including SQLite and Sharp) are usable.

After the first successful start creates the RSA key, generate one JSON file
that both Crossgram Android and Crossgram Desktop can import:

```sh
sudo crossgram-client-config --host 203.0.113.10 --port 4430 \
  --name 'CrossGram Server' --output /tmp/crossgram-server.json
```

The generator validates the IP address, port, and RSA public key and emits DC
entries 1 through 5 with `enable_special_config` disabled.
