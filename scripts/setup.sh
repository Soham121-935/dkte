#!/usr/bin/env bash
# One-time setup: Python venv + dependencies, Node dependencies, .env from the example.
set -euo pipefail
cd "$(dirname "$0")/.."

echo "== backend"
python3 -m venv backend/.venv
backend/.venv/bin/pip install --upgrade pip >/dev/null
backend/.venv/bin/pip install -r backend/requirements-dev.txt
if [ ! -f backend/.env ]; then
  cp backend/.env.example backend/.env
  # generate a random JWT secret so the example value never ends up in use
  secret=$(python3 -c 'import secrets; print(secrets.token_urlsafe(48))')
  sed -i.bak "s|^JWT_SECRET=.*|JWT_SECRET=${secret}|" backend/.env && rm -f backend/.env.bak
  echo "created backend/.env – set ADMIN_PASSWORD and (optionally) AI_API_KEY"
fi

echo "== frontend"
(cd frontend && npm install --no-audit --no-fund)

echo
echo "done. start with: scripts/dev.sh"
