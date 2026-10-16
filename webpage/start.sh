#!/usr/bin/env bash
# Starts the MYCO AI backend, which also serves this webpage folder at http://localhost:8000
set -euo pipefail
cd "$(dirname "$0")/../backend"
if [ ! -x .venv/bin/python ]; then
  echo "== first run: creating backend/.venv and installing packages (a few minutes)"
  python3 -m venv .venv
  .venv/bin/pip install --upgrade pip -q
  .venv/bin/pip install -r requirements.txt -q
fi
if [ ! -f .env ]; then
  cp .env.example .env
  secret=$(python3 -c 'import secrets; print(secrets.token_urlsafe(48))')
  sed -i.bak "s|^JWT_SECRET=.*|JWT_SECRET=${secret}|" .env && rm -f .env.bak
  echo "== created backend/.env – add HARDWARE_DEVICE_TOKEN, CAMERA_DEVICE_TOKEN and AI_API_KEY, then restart"
fi
echo "== MYCO AI on http://localhost:8000  (Ctrl+C to stop)"
exec .venv/bin/python -m uvicorn app.main:app --host 0.0.0.0 --port 8000
