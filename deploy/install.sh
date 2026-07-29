#!/bin/sh
set -eu

if [ "$(id -u)" -ne 0 ]; then
  echo "Run this installer as root (for example: curl ... | sudo sh)." >&2
  exit 1
fi

public_host=${CROSSGRAM_PUBLIC_HOST:-}
port=${CROSSGRAM_PORT:-4430}
repo_url=${CROSSGRAM_REPO_URL:-git@github.com:std-microblock/crossgram.git}
branch=${CROSSGRAM_BRANCH:-main}
install_dir=${CROSSGRAM_INSTALL_DIR:-/opt/crossgram}
state_dir=${CROSSGRAM_STATE_DIR:-/var/lib/crossgram}
service_user=${CROSSGRAM_USER:-crossgram}
deploy_base_url=${CROSSGRAM_DEPLOY_BASE_URL:-https://raw.githubusercontent.com/std-microblock/crossgram/main/deploy}
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" 2>/dev/null && pwd || true)

case "$public_host" in
  ''|*[!A-Za-z0-9.-]*)
    echo "Set CROSSGRAM_PUBLIC_HOST to this server's public IP or hostname." >&2
    exit 2
    ;;
esac
case "$port" in
  ''|*[!0-9]*) echo "CROSSGRAM_PORT must be a TCP port number." >&2; exit 2 ;;
esac
if [ "$port" -lt 1 ] || [ "$port" -gt 65535 ]; then
  echo "CROSSGRAM_PORT must be between 1 and 65535." >&2
  exit 2
fi

install_packages() {
  if command -v apt-get >/dev/null 2>&1; then
    apt-get update
    DEBIAN_FRONTEND=noninteractive apt-get install -y ca-certificates curl git openssh-client
  elif command -v dnf >/dev/null 2>&1; then
    dnf install -y ca-certificates curl git openssh-clients
  else
    echo "Install Node.js 24+, git, curl, and OpenSSH first, then rerun this installer." >&2
    return 1
  fi
}

node_is_recent_enough() {
  command -v node >/dev/null 2>&1 && [ "$(node -p 'Number(process.versions.node.split(`.`)[0])')" -ge 24 ]
}

if ! command -v git >/dev/null 2>&1 || ! command -v curl >/dev/null 2>&1; then
  install_packages
fi
if ! node_is_recent_enough; then
  if ! command -v apt-get >/dev/null 2>&1; then
    echo "Crossgram requires Node.js 24 or newer." >&2
    exit 1
  fi
  curl -fsSL https://deb.nodesource.com/setup_24.x | sh
  DEBIAN_FRONTEND=noninteractive apt-get install -y nodejs
fi
if ! command -v corepack >/dev/null 2>&1; then
  npm install --global corepack@0.34.0
fi
corepack enable

if ! id "$service_user" >/dev/null 2>&1; then
  useradd --system --create-home --home-dir "$state_dir" --shell /usr/sbin/nologin "$service_user"
fi
install -d -m 0755 -o "$service_user" -g "$service_user" "$install_dir"
install -d -m 0700 -o "$service_user" -g "$service_user" "$state_dir" "$state_dir/data"

if [ ! -d "$install_dir/.git" ]; then
  if ! runuser -u "$service_user" -- env HOME="$state_dir" git clone --branch "$branch" "$repo_url" "$install_dir"; then
    echo "Clone failed. For a private repository, put a read-only deploy key in $state_dir/.ssh first." >&2
    exit 1
  fi
fi

fetch_deploy_file() {
  name=$1
  output=$2
  mode=$3
  if [ -n "$script_dir" ] && [ -f "$script_dir/$name" ]; then
    install -m "$mode" "$script_dir/$name" "$output"
  else
    curl -fsSL "$deploy_base_url/$name" -o "$output"
    chmod "$mode" "$output"
  fi
}

install -d -m 0755 /etc/crossgram
install -d -m 0750 -o root -g "$service_user" "$install_dir/.runtime"
template=$(mktemp)
trap 'rm -f "$template"' EXIT HUP INT TERM
fetch_deploy_file app.production.yml "$template" 0600
sed -e "s/__CROSSGRAM_PUBLIC_HOST__/$public_host/g" -e "s/__CROSSGRAM_PORT__/$port/g" "$template" > "$install_dir/.runtime/app.yml"
chown root:"$service_user" "$install_dir/.runtime/app.yml"
chmod 0640 "$install_dir/.runtime/app.yml"
fetch_deploy_file crossgram.service /etc/systemd/system/crossgram.service 0644
fetch_deploy_file update.sh /usr/local/sbin/crossgram-update 0755
fetch_deploy_file generate-client-config.mjs /usr/local/sbin/crossgram-client-config 0755

if [ ! -e /etc/crossgram.env ]; then
  install -m 0600 /dev/null /etc/crossgram.env
fi

systemctl daemon-reload
CROSSGRAM_INSTALL_DIR="$install_dir" CROSSGRAM_USER="$service_user" CROSSGRAM_BRANCH="$branch" \
  /usr/local/sbin/crossgram-update --no-restart
systemctl enable --now crossgram.service

echo "Crossgram is running on $public_host:$port"
echo "Update later with: sudo crossgram-update"
echo "Generate client JSON with: sudo crossgram-client-config --host $public_host --port $port"
echo "Configuration: $install_dir/.runtime/app.yml"
