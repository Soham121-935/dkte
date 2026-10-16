"""ESP32-CAM phase recognition: matcher behaviour and the camera workflow API.

The matcher tests photograph the reference cards *synthetically* (perspective
warp, downscale to camera resolution, blur, exposure change, JPEG re-encode)
so they exercise the same pipeline a real printout photo goes through.
"""
from __future__ import annotations

import io

import numpy as np
import pytest

from app.vision import matcher
from app.vision.reference import all_cards, card_by_key, parse_qr_payload
from tests.conftest import post_telemetry

cv2 = pytest.importorskip("cv2")

AVAILABLE_CARDS = [c for c in all_cards() if c.path.exists()]
pytestmark = pytest.mark.skipif(not AVAILABLE_CARDS, reason="reference images not present")


# ----------------------------------------------------------------- image helpers
def photograph(path, *, seed: int = 0, size: int = 800, quality: int = 60, angle: float = 0.0) -> bytes:
    """Simulate the ESP32-CAM photographing a printed card."""
    rng = np.random.default_rng(seed)
    img = cv2.imread(str(path))
    h, w = img.shape[:2]
    d = 0.08
    src = np.float32([[0, 0], [w, 0], [w, h], [0, h]])
    dst = np.float32([
        [w * d * rng.random(), h * d * rng.random()],
        [w - w * d * rng.random(), h * d * rng.random()],
        [w - w * d * rng.random(), h - h * d * rng.random()],
        [w * d * rng.random(), h - h * d * rng.random()],
    ])
    out = cv2.warpPerspective(img, cv2.getPerspectiveTransform(src, dst), (w, h), borderValue=(190, 190, 190))
    if angle:
        rot = cv2.getRotationMatrix2D((w / 2, h / 2), angle, 1.0)
        out = cv2.warpAffine(out, rot, (w, h), borderValue=(190, 190, 190))
    out = cv2.resize(out, (size, int(size * h / w)), interpolation=cv2.INTER_AREA)
    out = cv2.GaussianBlur(out, (3, 3), 0)
    out = np.clip(out.astype(np.float32) * 0.85 + 15 + rng.normal(0, 5, out.shape), 0, 255).astype(np.uint8)
    ok, buf = cv2.imencode(".jpg", out, [cv2.IMWRITE_JPEG_QUALITY, quality])
    assert ok
    return buf.tobytes()


def noise_jpeg(seed: int = 3) -> bytes:
    rng = np.random.default_rng(seed)
    img = (rng.random((480, 640, 3)) * 255).astype(np.uint8)
    ok, buf = cv2.imencode(".jpg", img)
    return buf.tobytes()


def qr_jpeg(text: str) -> bytes:
    qr = matcher.encode_qr(text, scale=10)
    canvas = np.full((qr.shape[0] + 200, qr.shape[1] + 300), 235, dtype=np.uint8)
    canvas[100:100 + qr.shape[0], 150:150 + qr.shape[1]] = qr
    ok, buf = cv2.imencode(".jpg", cv2.cvtColor(canvas, cv2.COLOR_GRAY2BGR), [cv2.IMWRITE_JPEG_QUALITY, 80])
    return buf.tobytes()


def camera_token(client, admin) -> str:
    r = client.post("/api/devices/myco-cam-01/token", headers=admin)
    assert r.status_code == 200, r.text
    return r.json()["token"]


def chamber_token(client, admin) -> str:
    r = client.post("/api/devices/myco-esp32-01/token", headers=admin)
    assert r.status_code == 200, r.text
    return r.json()["token"]


# ----------------------------------------------------------------- reference set
class TestReferenceSet:
    def test_every_species_has_phases_mapped_to_profile_stages(self, client):
        data = client.get("/api/vision/reference").json()
        assert [s["key"] for s in data["species"]] == ["oyster", "shiitake", "lions_mane"]
        for sp in data["species"]:
            assert sp["profile_id"] is not None, sp["profile_name"]
            assert sp["profile_source"] == "reference"
            keys = [p["phase_key"] for p in sp["phases"]]
            assert keys[0] == "colonising" and keys[-1] == "harvest_ready"
            for ph in sp["phases"]:
                t = ph["targets"]
                assert t["temperature_min_c"] < t["temperature_max_c"], ph
                assert t["humidity_min_percent"] < t["humidity_max_percent"] <= 95, ph
                assert ph["qr_payload"].startswith(f"MYCO:{sp['code']}:")
        shiitake = next(s for s in data["species"] if s["key"] == "shiitake")
        assert "browning" in [p["phase_key"] for p in shiitake["phases"]]
        assert data["recognition"]["available"] is True

    def test_qr_payload_parsing_accepts_old_card_format(self):
        assert parse_qr_payload("MYCO:OYS:pinning").key == "oyster_pinning"
        assert parse_qr_payload("MYCO:OYS:incubation").key == "oyster_colonising"  # earlier demo cards
        assert parse_qr_payload("MYCO:OYS:harvest").key == "oyster_harvest_ready"
        assert parse_qr_payload("MYCO:SHI:fruiting").key == "shiitake_fruiting"
        assert parse_qr_payload("MYCO:LMN:fruiting").key == "lions_mane_fruiting"
        assert parse_qr_payload("MYCO:BTN:fruiting") is None  # species not in the set
        assert parse_qr_payload("https://example.com") is None
        assert parse_qr_payload("") is None

    def test_reference_image_endpoint(self, client):
        card = AVAILABLE_CARDS[0]
        r = client.get(f"/api/vision/reference/{card.key}.jpg")
        assert r.status_code == 200 and r.headers["content-type"] == "image/jpeg"
        assert client.get("/api/vision/reference/not_a_card.jpg").status_code == 404


# ----------------------------------------------------------------- matcher
@pytest.fixture(scope="module")
def index():
    return matcher.ReferenceIndex(min_inliers=20)


class TestMatcher:
    @pytest.mark.parametrize("card", AVAILABLE_CARDS, ids=[c.key for c in AVAILABLE_CARDS])
    def test_photographed_card_is_recognised(self, index, card):
        result = index.match(photograph(card.path, seed=hash(card.key) % 1000))
        assert result.status == "matched", result.message
        assert result.card.key == card.key
        assert result.method == "features"
        assert result.confidence in ("high", "medium")
        assert result.inliers >= 20 and result.inliers >= 1.5 * max(result.second_inliers, 1)

    def test_low_resolution_rotated_photo_still_matches(self, index):
        card = AVAILABLE_CARDS[0]
        result = index.match(photograph(card.path, seed=7, size=640, quality=45, angle=12))
        assert result.status == "matched" and result.card.key == card.key

    def test_random_noise_and_blank_images_do_not_match(self, index):
        assert index.match(noise_jpeg()).status == "no_match"
        blank = np.full((480, 640, 3), 200, dtype=np.uint8)
        ok, buf = cv2.imencode(".jpg", blank)
        res = index.match(buf.tobytes())
        assert res.status == "no_match" and res.card is None

    def test_qr_code_wins_even_without_the_picture(self, index):
        result = index.match(qr_jpeg("MYCO:SHI:pinning"))
        assert result.status == "matched" and result.method == "qr"
        assert result.card.key == "shiitake_pinning" and result.confidence == "high"

    def test_foreign_qr_falls_back_to_features(self, index):
        result = index.match(qr_jpeg("MYCO:BTN:fruiting"))
        assert result.status == "no_match"
        assert result.qr_text == "MYCO:BTN:fruiting"

    def test_garbage_bytes_are_unreadable(self, index):
        assert index.match(b"not an image at all").status == "unreadable"


# ----------------------------------------------------------------- API workflow
class TestCameraApi:
    def test_camera_endpoints_require_the_camera_token(self, client, admin):
        assert client.get("/api/vision/pending").status_code == 401
        # another device's token is not accepted on the camera endpoints
        other = chamber_token(client, admin)
        assert client.get("/api/vision/pending", headers={"X-Device-Token": other}).status_code == 403
        cam = camera_token(client, admin)
        r = client.get("/api/vision/pending", headers={"X-Device-Token": cam})
        assert r.status_code == 200
        assert r.json()["capture_now"] is False and r.json()["auto_interval_seconds"] == 1800

    def test_camera_is_listed_as_a_device_with_the_camera_role(self, client):
        devices = {d["id"]: d for d in client.get("/api/devices").json()}
        assert devices["myco-cam-01"]["role"] == "camera"
        assert all(d["role"] == "chamber" for k, d in devices.items() if k != "myco-cam-01")
        assert client.get("/api/devices/myco-cam-01").json()["role"] == "camera"

    def test_manual_request_is_delivered_once_and_marks_camera_online(self, client, admin, operator):
        status = client.get("/api/vision/status").json()
        assert status["online"] is False and status["manual_pending"] is False
        r = client.post("/api/vision/capture-request", json={}, headers=operator)
        assert r.status_code == 202 and r.json()["camera_online"] is False
        assert client.get("/api/vision/status").json()["manual_pending"] is True

        cam = camera_token(client, admin)
        first = client.get("/api/vision/pending", headers={"X-Device-Token": cam}).json()
        assert first["capture_now"] is True and first["trigger"] == "manual" and first["target_device_id"] == "myco-esp32-01"
        second = client.get("/api/vision/pending", headers={"X-Device-Token": cam}).json()
        assert second["capture_now"] is False
        status = client.get("/api/vision/status").json()
        assert status["online"] is True and status["manual_pending"] is False
        cam_dev = client.get("/api/devices/myco-cam-01").json()
        assert cam_dev["connection_status"] == "online"

    def test_capture_request_needs_operator_and_known_chamber(self, client, viewer, operator):
        assert client.post("/api/vision/capture-request", json={}, headers=viewer).status_code == 403
        assert client.post("/api/vision/capture-request", json={"device_id": "ghost"}, headers=operator).status_code == 404

    def test_camera_upload_creates_batch_sets_stage_and_switches_to_auto(self, client, admin, operator, db):
        cam = camera_token(client, admin)
        hw_token = chamber_token(client, admin)
        post_telemetry(client, hw_token, "myco-esp32-01")  # chamber online, in monitor mode
        card = card_by_key("oyster_pinning") if card_by_key("oyster_pinning").path.exists() else AVAILABLE_CARDS[0]

        r = client.post("/api/vision/capture?trigger=manual", content=photograph(card.path, seed=11),
                        headers={"X-Device-Token": cam, "Content-Type": "image/jpeg"})
        assert r.status_code == 201, r.text
        body = r.json()
        assert body["status"] == "matched" and body["card_key"] == card.key and body["applied"] is True

        status = client.get("/api/vision/status").json()
        cap = status["last_capture"]
        assert cap["source"] == "esp32cam" and cap["trigger"] == "manual"
        assert cap["card"]["species_key"] == card.species.key and cap["stage_key"] == card.phase.stage_key
        assert cap["image_url"].startswith("/api/uploads/captures/")
        assert client.get(cap["image_url"]).status_code == 200

        batch = client.get(f"/api/batches/{cap['applied_batch_id']}").json()
        assert batch["device_id"] == "myco-esp32-01" and batch["status"] == "active"
        assert batch["current_stage_key"] == card.phase.stage_key
        assert batch["species"] == card.species.latin_name
        assert batch["stage_events"][-1]["source"] == "camera"
        assert any(o["kind"] == "camera" for o in batch["observations"])

        device = client.get("/api/devices/myco-esp32-01").json()
        assert device["control_mode"] == "auto"
        # the deterministic controller now works towards the phase's ranges
        ctl = client.get("/api/control/myco-esp32-01").json()
        targets = ctl["targets"]
        expected = next(s for s in batch["profile"]["stages"] if s["key"] == card.phase.stage_key)["targets"] if batch.get("profile") else None
        if expected:
            assert targets["temperature_min_c"] == expected["temperature_min_c"]
            assert targets["humidity_min_percent"] == expected["humidity_min_percent"]
        assert targets["stage_key"] == card.phase.stage_key

    def test_browser_upload_fallback_and_no_match_is_not_applied(self, client, operator):
        files = {"file": ("photo.jpg", io.BytesIO(noise_jpeg()), "image/jpeg")}
        r = client.post("/api/vision/upload", files=files, headers=operator)
        assert r.status_code == 201, r.text
        cap = r.json()
        assert cap["status"] == "no_match" and cap["applied"] is False and cap["source"] == "upload"
        assert cap["message"]
        # nothing was created for the chamber
        assert client.get("/api/vision/status").json()["active_batch"] is None
        assert client.post(f"/api/vision/captures/{cap['id']}/apply", json={}, headers=operator).status_code == 409

        bad = {"file": ("x.txt", io.BytesIO(b"hello"), "text/plain")}
        assert client.post("/api/vision/upload", files=bad, headers=operator).status_code == 415

    def test_species_change_archives_previous_batch(self, client, admin, operator):
        oyster = card_by_key("oyster_fruiting")
        shiitake = card_by_key("shiitake_fruiting")
        if not (oyster.path.exists() and shiitake.path.exists()):
            pytest.skip("needs both oyster and shiitake reference images")
        chamber_token(client, admin)
        r1 = client.post("/api/vision/upload", files={"file": ("a.jpg", io.BytesIO(photograph(oyster.path, seed=1)), "image/jpeg")}, headers=operator)
        assert r1.status_code == 201 and r1.json()["applied"] is True
        first_batch = r1.json()["applied_batch_id"]
        # same species, later phase -> same batch, new stage
        r2 = client.post("/api/vision/upload", files={"file": ("b.jpg", io.BytesIO(photograph(card_by_key("oyster_harvest_ready").path, seed=2)), "image/jpeg")}, headers=operator)
        assert r2.status_code == 201 and r2.json()["applied_batch_id"] == first_batch
        assert client.get(f"/api/batches/{first_batch}").json()["current_stage_key"] == "harvest_ready"
        # different species -> previous batch archived, new batch created
        r3 = client.post("/api/vision/upload", files={"file": ("c.jpg", io.BytesIO(photograph(shiitake.path, seed=3)), "image/jpeg")}, headers=operator)
        assert r3.status_code == 201 and r3.json()["applied"] is True
        assert r3.json()["applied_batch_id"] != first_batch
        assert client.get(f"/api/batches/{first_batch}").json()["status"] == "archived"
        new_batch = client.get(f"/api/batches/{r3.json()['applied_batch_id']}").json()
        assert new_batch["species"] == "Lentinula edodes" and new_batch["current_stage_key"] == "fruiting"
        captures = client.get("/api/vision/captures").json()
        assert [c["id"] for c in captures][:3] == [r3.json()["id"], r2.json()["id"], r1.json()["id"]]

    def test_upload_with_apply_false_then_explicit_apply(self, client, admin, operator, viewer):
        card = AVAILABLE_CARDS[0]
        chamber_token(client, admin)
        r = client.post("/api/vision/upload?apply=false", files={"file": ("a.jpg", io.BytesIO(photograph(card.path, seed=5)), "image/jpeg")}, headers=operator)
        assert r.status_code == 201 and r.json()["status"] == "matched" and r.json()["applied"] is False
        cid = r.json()["id"]
        assert client.post(f"/api/vision/captures/{cid}/apply", json={}, headers=operator).status_code == 200
        detail = client.get(f"/api/vision/captures/{cid}").json()
        assert detail["applied"] is True and detail["applied_stage_key"] == card.phase.stage_key
        # applying the same capture again is idempotent – the batch is already in that stage
        again = client.post(f"/api/vision/captures/{cid}/apply", json={}, headers=operator)
        assert again.status_code == 200 and again.json()["result"]["stage_changed"] is False
        assert client.post(f"/api/vision/captures/{cid}/apply", json={}, headers=viewer).status_code == 403

    def test_capture_rejects_non_jpeg_bodies(self, client, admin):
        cam = camera_token(client, admin)
        r = client.post("/api/vision/capture", content=b"{}", headers={"X-Device-Token": cam, "Content-Type": "application/json"})
        assert r.status_code == 415

    def test_status_without_token_on_chamber_keeps_mode(self, client, admin, operator, monkeypatch):
        """Without a device token the chamber cannot receive commands, so the camera must not flip it to auto."""
        card = AVAILABLE_CARDS[0]
        r = client.post("/api/vision/upload", files={"file": ("a.jpg", io.BytesIO(photograph(card.path, seed=9)), "image/jpeg")}, headers=operator)
        assert r.status_code == 201 and r.json()["applied"] is True
        assert "no device token" in r.json()["apply_note"]
        assert client.get("/api/devices/myco-esp32-01").json()["control_mode"] == "monitor"
