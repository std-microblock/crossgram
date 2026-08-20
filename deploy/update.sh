#!/bin/sh
set -eu

if [ "$(id -u)" -ne 0 ] && [ "${CROSSGRAM_ALLOW_NON_ROOT_TEST:-0}" != 1 ]; then
  echo "crossgram-update must run as root" >&2
  exit 1
fi

install_dir=${CROSSGRAM_INSTALL_DIR:-/opt/crossgram}
service_user=${CROSSGRAM_USER:-crossgram}
branch=${CROSSGRAM_BRANCH:-main}
git_command=${CROSSGRAM_GIT:-git}
corepack_command=${CROSSGRAM_COREPACK:-corepack}
node_command=${CROSSGRAM_NODE:-node}
systemctl_command=${CROSSGRAM_SYSTEMCTL:-systemctl}

run_as_service() {
  if [ -n "${CROSSGRAM_RUN_AS:-}" ]; then
    "$CROSSGRAM_RUN_AS" "$@"
  else
    runuser -u "$service_user" -- env HOME="/var/lib/$service_user" "$@"
  fi
}

if [ ! -d "$install_dir/.git" ]; then
  echo "Crossgram checkout is missing from $install_dir" >&2
  exit 1
fi

cd "$install_dir"
run_as_service "$git_command" fetch --prune origin "$branch"
run_as_service "$git_command" merge --ff-only "origin/$branch"
run_as_service env YARN_ENABLE_SCRIPTS=true "$corepack_command" yarn install --immutable
run_as_service "$corepack_command" yarn build
run_as_service "$node_command" "$install_dir/deploy/migrate-runtime-config.mjs" "$install_dir/.runtime/app.yml"

if [ "${1:-}" != "--no-restart" ]; then
  "$systemctl_command" restart crossgram.service
fi

revision=$(run_as_service "$git_command" rev-parse --short HEAD)
echo "Crossgram updated to $revision"
