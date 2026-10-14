#!/usr/bin/env bash
# Starts backend (uvicorn, :8000) and frontend (vite, :5173) for development.
set -euo pipefail
cd "$(dirname "$0")/.."
trap 'kill 0' EXIT

(cd backend && exec .venv/bin/uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload) &
(cd frontend && exec npm run dev) &
wait
