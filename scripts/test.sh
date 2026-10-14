#!/usr/bin/env bash
# Runs the complete automated test-suite (backend + frontend + type-check).
set -euo pipefail
cd "$(dirname "$0")/.."

echo "== backend tests"
(cd backend && .venv/bin/python -m pytest -q -p no:warnings)

echo "== schema export check"
backend/.venv/bin/python scripts/export_schemas.py --check

echo "== frontend type-check"
(cd frontend && npm run lint)

echo "== frontend tests"
(cd frontend && npx vitest run)

echo "== production bundle secret scan"
(cd frontend && npm run build >/dev/null)
if grep -lE "nvapi-[A-Za-z0-9_-]{8,}|sk-[A-Za-z0-9]{20,}|integrate\.api\.nvidia\.com|api\.openai\.com" frontend/dist/assets/*.js; then
  echo "ERROR: provider key or URL found in the frontend bundle"; exit 1
fi
echo "bundle clean"
