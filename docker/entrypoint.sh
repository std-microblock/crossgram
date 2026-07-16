#!/usr/bin/env sh
set -eu

chown -R root:root /cordis
if [ ! -e "/cordis/package.json" ]; then
  unzip -d /cordis /boilerplate.zip
  sed -Ei 's/(([[:space:]]*)maxPort.*)/\1\n\2host: 0.0.0.0/' /cordis/cordis.yml
fi

exec "$@"
