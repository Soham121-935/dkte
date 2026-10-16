"""Camera-based growth-phase recognition for the demo set-up.

The ESP32-CAM (or the browser upload fallback) sends a JPEG to the backend.
The backend identifies which *printed reference card* is in front of the camera
(QR code first, ORB feature matching second) and maps it onto a cultivation
profile stage so the deterministic control service applies that stage's
temperature / humidity ranges.

The recogniser knows the reference cards shipped in ``app/vision/reference``
and nothing else – it is not a general mushroom classifier.
"""
