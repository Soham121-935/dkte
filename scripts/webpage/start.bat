@echo off
REM Starts the MYCO AI backend, which also serves this webpage folder at http://localhost:8000
cd /d "%~dp0..\backend"
if not exist ".venv\Scripts\python.exe" (
  echo == first run: creating backend\.venv and installing packages ^(a few minutes^)
  python -m venv .venv || goto :fail
  .venv\Scripts\python -m pip install --upgrade pip -q
  .venv\Scripts\python -m pip install -r requirements.txt -q || goto :fail
)
if not exist ".env" (
  copy .env.example .env >nul
  echo == created backend\.env - add HARDWARE_DEVICE_TOKEN, CAMERA_DEVICE_TOKEN and AI_API_KEY, then restart
)
echo == MYCO AI on http://localhost:8000  (Ctrl+C to stop)
.venv\Scripts\python -m uvicorn app.main:app --host 0.0.0.0 --port 8000
goto :eof
:fail
echo Setup failed - is Python 3.11+ installed and on PATH?
pause
