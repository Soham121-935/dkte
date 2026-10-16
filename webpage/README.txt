MYCO AI – the webpage, ready to go
==================================

This folder is the built website (index.html + assets/). It needs the MYCO AI
backend for data – the page shows what the ESP32 and the ESP32-CAM report, it
has no demo numbers of its own.

Run it (one process serves the page AND the API):

    Windows:   double-click start.bat        (or run it in a terminal)
    Linux/Mac: ./start.sh

then open  http://localhost:8000  on this computer, or
           http://<this computer's LAN IP>:8000  from a phone on the same Wi-Fi.

First run only: start.* creates backend/.venv, installs the Python packages and
creates backend/.env from the example. Put your tokens / NVIDIA key in
backend/.env afterwards (HARDWARE_DEVICE_TOKEN, CAMERA_DEVICE_TOKEN, AI_API_KEY)
and run start.* again.

Printable reference cards for the camera demo:  http://localhost:8000/api/vision/reference.pdf
API docs:                                       http://localhost:8000/api/docs

Rebuild this folder after changing the frontend:  cd frontend && npm run build:webpage
