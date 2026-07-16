# remove ^ from package.json
# do not use sed -i, it behaves differently on Linux and MacOS
cat package.json | sed 's/\^//g' > package.json.tmp
mv -f package.json.tmp package.json

set -e

# resolve `packageManager` into a pinned yarn release:
# - validate that packageManager is `yarn@<version>`
# - use `yarn set version` (via corepack) to download the binary and write yarnPath
PM=$(jq -r '.packageManager // empty' package.json)
if [ -z "$PM" ]; then
  echo 'package.json is missing the "packageManager" field' >&2
  exit 1
fi
VERSION=${PM#yarn@}
if [ "$VERSION" = "$PM" ]; then
  echo "unsupported packageManager: $PM (only \"yarn@<version>\" is supported)" >&2
  exit 1
fi
# corepack `enable` writes shims next to its own binary by default; on arm64 + nix
# that path is in the read-only /nix/store. Redirect to a writable bin dir.
COREPACK_DIR="$HOME/.local/bin"
mkdir -p "$COREPACK_DIR"
corepack enable --install-directory "$COREPACK_DIR"
export PATH="$COREPACK_DIR:$PATH"
if [ -n "$GITHUB_PATH" ]; then
  echo "$COREPACK_DIR" >> "$GITHUB_PATH"
fi
yarn set version --yarn-path "$VERSION"

# remove development-related fields and the packageManager field
jq '.scripts = {start: .scripts.start} | del(.yakumo, .workspaces, .devDependencies, .packageManager)' package.json > package.json.tmp
mv -f package.json.tmp package.json
