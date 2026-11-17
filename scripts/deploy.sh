#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

if ! command -v npx >/dev/null 2>&1; then
  echo "Node 20+ is required (npx not found)." >&2
  exit 1
fi

if ! npx wrangler whoami >/dev/null 2>&1; then
  echo "Cloudflare login required. Opening wrangler login..."
  npx wrangler login
fi

if grep -q '00000000-0000-0000-0000-000000000000' wrangler.toml; then
  echo "D1 is not configured yet."
  echo "1) npx wrangler d1 create essay-coach-db --location apac"
  echo "2) Put the returned database_id into wrangler.toml (replace the all-zero placeholder)"
  echo "3) Re-run this script"
  exit 1
fi

if [ ! -f .admin-token ]; then
  python3 -c "import secrets; print(secrets.token_hex(32))" > .admin-token
  chmod 600 .admin-token
  echo "Generated .admin-token"
fi

if [ ! -f .env.production ]; then
  printf 'ADMIN_TOKEN="%s"\n' "$(cat .admin-token)" > .env.production
  chmod 600 .env.production
  echo "Created .env.production with ADMIN_TOKEN"
fi

npx wrangler d1 execute essay-coach-db --remote --file=./schema.sql
npx wrangler deploy --secrets-file .env.production

echo
echo "Deployed. Admin token file: $(pwd)/.admin-token"
echo "Optional: npx wrangler secret put AI_API_KEY   # DeepSeek / OpenAI-compatible key"
