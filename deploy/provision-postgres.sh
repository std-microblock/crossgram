#!/bin/sh
set -eu

if [ "$(id -u)" -ne 0 ]; then
  echo "Run this PostgreSQL provisioner as root." >&2
  exit 1
fi
if ! command -v psql >/dev/null 2>&1 || ! id postgres >/dev/null 2>&1; then
  echo "Install and start PostgreSQL before provisioning Crossgram." >&2
  exit 1
fi

env_file=${CROSSGRAM_ENV_FILE:-/etc/crossgram.env}
database=${CROSSGRAM_POSTGRES_DATABASE:-crossgram}
user=${CROSSGRAM_POSTGRES_USER:-crossgram}
case "$database:$user" in
  *[!A-Za-z0-9_:-]*) echo "PostgreSQL database and user names must be identifiers." >&2; exit 2 ;;
esac

password=$(sed -n 's/^CROSSGRAM_POSTGRES_PASSWORD=//p' "$env_file" 2>/dev/null | tail -1)
if [ -z "$password" ]; then
  password=$(openssl rand -hex 32)
fi
password_hex=$(printf '%s' "$password" | od -An -tx1 | tr -d ' \n')

runuser -u postgres -- psql --set=ON_ERROR_STOP=1 postgres <<SQL
SELECT format(
  'CREATE ROLE %I LOGIN PASSWORD %L', '$user',
  convert_from(decode('$password_hex', 'hex'), 'UTF8')
) WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '$user') \gexec
SELECT format(
  'ALTER ROLE %I LOGIN PASSWORD %L', '$user',
  convert_from(decode('$password_hex', 'hex'), 'UTF8')
) \gexec
SELECT format('CREATE DATABASE %I OWNER %I', '$database', '$user')
WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = '$database') \gexec
SELECT format('ALTER DATABASE %I OWNER TO %I', '$database', '$user') \gexec
SQL

CROSSGRAM_POSTGRES_PASSWORD=$password node - "$env_file" <<'NODE'
const { chmodSync, chownSync, existsSync, readFileSync, renameSync, statSync, writeFileSync } = require('node:fs')
const path = process.argv[2]
const key = 'CROSSGRAM_POSTGRES_PASSWORD'
const value = process.env[key]
if (!value) throw new Error('missing generated PostgreSQL password')
const previous = existsSync(path) ? statSync(path) : undefined
const lines = existsSync(path) ? readFileSync(path, 'utf8').split(/\r?\n/) : []
const filtered = lines.filter((line) => line && !line.startsWith(`${key}=`))
filtered.push(`${key}=${value}`)
const temporary = `${path}.tmp-${process.pid}`
writeFileSync(temporary, `${filtered.join('\n')}\n`, { encoding: 'utf8', mode: 0o600 })
if (previous) chownSync(temporary, previous.uid, previous.gid)
renameSync(temporary, path)
chmodSync(path, 0o600)
NODE

echo "PostgreSQL database $database and role $user are ready."
