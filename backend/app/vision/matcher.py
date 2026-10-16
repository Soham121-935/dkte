"""Recognise which printed reference card a photo shows.

Two detectors, in order:

1. **QR code** – every card carries ``MYCO:<species>:<phase>``.  When the camera
   can see the code the answer is exact.
2. **ORB feature matching** – binary keypoint descriptors of the photo are matched
   against each reference image (Lowe ratio test + RANSAC homography).  The
   number of geometrically consistent inliers is the score.  This recognises
   the *printed pictures* even when the QR code is cropped out or unreadable.

Neither detector knows anything about mushrooms in general; a photo of a real
mushroom will usually come back as *no match*, which the UI reports honestly.
"""
from __future__ import annotations

import logging
import threading
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from .reference import ReferenceCard, all_cards, parse_qr_payload

log = logging.getLogger(__name__)

try:  # pragma: no cover - exercised implicitly by the tests when OpenCV is installed
    import cv2
    import numpy as np

    CV_AVAILABLE = True
    CV_IMPORT_ERROR = ""
except Exception as exc:  # pragma: no cover - environment without OpenCV
    cv2 = None  # type: ignore[assignment]
    np = None  # type: ignore[assignment]
    CV_AVAILABLE = False
    CV_IMPORT_ERROR = f"{type(exc).__name__}: {exc}"

MAX_SIDE = 640
ORB_FEATURES = 1500
RATIO = 0.75
RANSAC_REPROJ = 5.0
MIN_GOOD_MATCHES = 8


@dataclass
class CandidateScore:
    key: str
    inliers: int
    good_matches: int

    def to_dict(self) -> dict[str, Any]:
        return {"key": self.key, "inliers": self.inliers, "good_matches": self.good_matches}


@dataclass
class MatchResult:
    status: str  # matched|no_match|unreadable|unavailable
    method: str | None = None  # qr|features
    card: ReferenceCard | None = None
    confidence: str | None = None  # high|medium|low
    inliers: int = 0
    second_inliers: int = 0
    second_key: str | None = None
    qr_text: str | None = None
    candidates: list[CandidateScore] = field(default_factory=list)
    query_keypoints: int = 0
    message: str = ""

    def to_dict(self) -> dict[str, Any]:
        return {
            "status": self.status,
            "method": self.method,
            "card_key": self.card.key if self.card else None,
            "confidence": self.confidence,
            "inliers": self.inliers,
            "second_inliers": self.second_inliers,
            "second_key": self.second_key,
            "qr_text": self.qr_text,
            "query_keypoints": self.query_keypoints,
            "candidates": [c.to_dict() for c in self.candidates[:5]],
            "message": self.message,
        }


def _prepare(gray):
    h, w = gray.shape[:2]
    scale = MAX_SIDE / float(max(h, w))
    if scale < 1.0:
        gray = cv2.resize(gray, (max(1, int(w * scale)), max(1, int(h * scale))), interpolation=cv2.INTER_AREA)
    clahe = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8))
    return clahe.apply(gray)


def decode_image(data: bytes):
    """JPEG/PNG bytes -> (bgr, gray) or (None, None) when undecodable."""
    if not CV_AVAILABLE or not data:
        return None, None
    arr = np.frombuffer(data, dtype=np.uint8)
    bgr = cv2.imdecode(arr, cv2.IMREAD_COLOR)
    if bgr is None:
        return None, None
    return bgr, cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)


class ReferenceIndex:
    """ORB descriptors of every reference card image, built lazily once."""

    def __init__(self, cards: list[ReferenceCard] | None = None, min_inliers: int = 20) -> None:
        self._cards = cards
        self.min_inliers = min_inliers
        self._lock = threading.Lock()
        self._built = False
        self._entries: list[tuple[ReferenceCard, Any, Any]] = []  # (card, keypoints, descriptors)
        self._missing: list[str] = []
        self._orb = None
        self._bf = None
        self._qr_detectors: list[Any] = []

    # ----------------------------------------------------------------- build
    @property
    def cards(self) -> list[ReferenceCard]:
        return self._cards if self._cards is not None else all_cards()

    def _ensure_built(self) -> None:
        if self._built or not CV_AVAILABLE:
            return
        with self._lock:
            if self._built:
                return
            self._orb = cv2.ORB_create(nfeatures=ORB_FEATURES, scaleFactor=1.2, nlevels=8)
            self._bf = cv2.BFMatcher(cv2.NORM_HAMMING)
            self._qr_detectors = [cv2.QRCodeDetector()]
            if hasattr(cv2, "QRCodeDetectorAruco"):
                self._qr_detectors.append(cv2.QRCodeDetectorAruco())
            entries = []
            missing = []
            for card in self.cards:
                if not card.path.exists():
                    missing.append(card.key)
                    continue
                gray = cv2.imread(str(card.path), cv2.IMREAD_GRAYSCALE)
                if gray is None:
                    missing.append(card.key)
                    continue
                kp, des = self._orb.detectAndCompute(_prepare(gray), None)
                if des is None or len(kp) < MIN_GOOD_MATCHES:
                    log.warning("reference image %s has too few features", card.path)
                    missing.append(card.key)
                    continue
                entries.append((card, kp, des))
            self._entries = entries
            self._missing = missing
            self._built = True
            if missing:
                log.warning("reference images missing/unusable: %s", ", ".join(missing))
            log.info("vision reference index built: %d card(s)", len(entries))

    def invalidate(self) -> None:
        with self._lock:
            self._built = False
            self._entries = []

    def info(self) -> dict[str, Any]:
        self._ensure_built()
        return {
            "available": CV_AVAILABLE,
            "error": CV_IMPORT_ERROR or None,
            "indexed": len(self._entries),
            "missing": list(self._missing),
            "min_inliers": self.min_inliers,
            "features_per_image": ORB_FEATURES,
        }

    def missing_keys(self) -> list[str]:
        self._ensure_built()
        return list(self._missing)

    # ----------------------------------------------------------------- match
    def _score(self, qkp, qdes, rkp, rdes) -> tuple[int, int]:
        if qdes is None or rdes is None or len(qkp) < MIN_GOOD_MATCHES or len(rkp) < MIN_GOOD_MATCHES:
            return 0, 0
        pairs = self._bf.knnMatch(qdes, rdes, k=2)
        good = [p[0] for p in pairs if len(p) == 2 and p[0].distance < RATIO * p[1].distance]
        if len(good) < MIN_GOOD_MATCHES:
            return 0, len(good)
        src = np.float32([qkp[m.queryIdx].pt for m in good]).reshape(-1, 1, 2)
        dst = np.float32([rkp[m.trainIdx].pt for m in good]).reshape(-1, 1, 2)
        homography, mask = cv2.findHomography(src, dst, cv2.RANSAC, RANSAC_REPROJ)
        if homography is None or mask is None:
            return 0, len(good)
        det = float(np.linalg.det(homography[:2, :2]))
        if not (1e-3 < abs(det) < 1e3):  # degenerate / folded mapping
            return 0, len(good)
        return int(mask.sum()), len(good)

    def _read_qr(self, bgr) -> str | None:
        """Decode a QR code if one is visible.

        OpenCV's detector is sensitive to module size, so the image is tried at a
        few scales (and lightly blurred) with both the classic and the ArUco-based
        detector.  Each attempt costs a few milliseconds; the first hit wins.
        """
        gray = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)
        h, w = gray.shape[:2]
        base_scale = 1.0 if max(h, w) <= 1600 else 1600.0 / max(h, w)
        for rel in (1.0, 0.75, 1.5, 0.5, 2.0):
            s = base_scale * rel
            if max(h, w) * s < 120 or max(h, w) * s > 3200:
                continue
            img = gray if s == 1.0 else cv2.resize(gray, None, fx=s, fy=s, interpolation=cv2.INTER_AREA if s < 1 else cv2.INTER_CUBIC)
            for blur in (False, True):
                candidate = cv2.GaussianBlur(img, (3, 3), 0) if blur else img
                for detector in self._qr_detectors:
                    try:
                        text, _points, _ = detector.detectAndDecode(candidate)
                    except cv2.error:  # pragma: no cover - defensive
                        text = ""
                    if text:
                        return text
        return None

    def match(self, data: bytes) -> MatchResult:
        if not CV_AVAILABLE:
            return MatchResult(status="unavailable", message=f"OpenCV is not installed on the server ({CV_IMPORT_ERROR}).")
        self._ensure_built()
        bgr, gray = decode_image(data)
        if bgr is None:
            return MatchResult(status="unreadable", message="The upload is not a decodable JPEG/PNG image.")

        with self._lock:
            qr_text = self._read_qr(bgr)
            card = parse_qr_payload(qr_text or "")
            if card is not None:
                return MatchResult(status="matched", method="qr", card=card, confidence="high", qr_text=qr_text,
                                   message=f"QR code on the card read as {qr_text}.")

            qkp, qdes = self._orb.detectAndCompute(_prepare(gray), None)
            scores: list[CandidateScore] = []
            for ref_card, rkp, rdes in self._entries:
                inliers, good = self._score(qkp, qdes, rkp, rdes)
                scores.append(CandidateScore(key=ref_card.key, inliers=inliers, good_matches=good))
        scores.sort(key=lambda s: (-s.inliers, -s.good_matches))
        if not scores:
            return MatchResult(status="unavailable", qr_text=qr_text, query_keypoints=len(qkp or []),
                               message="No reference images are indexed on the server.")
        best = scores[0]
        second = scores[1] if len(scores) > 1 else CandidateScore(key="", inliers=0, good_matches=0)
        result = MatchResult(status="no_match", method="features", inliers=best.inliers, second_inliers=second.inliers,
                             second_key=second.key or None, qr_text=qr_text, candidates=scores,
                             query_keypoints=len(qkp or []))
        if best.inliers < self.min_inliers:
            result.message = (f"Best candidate {best.key} has only {best.inliers} consistent feature matches "
                              f"(minimum {self.min_inliers}). Hold the printed card flat, fill the frame and avoid glare.")
            return result
        margin_ok = best.inliers >= 1.5 * max(second.inliers, 1)
        result.status = "matched"
        result.card = next(c for c, _, _ in self._entries if c.key == best.key)
        if best.inliers >= 2 * self.min_inliers and best.inliers >= 3 * max(second.inliers, 1):
            result.confidence = "high"
        elif margin_ok:
            result.confidence = "medium"
        else:
            result.confidence = "low"
        result.message = (f"{best.inliers} geometrically consistent feature matches with {best.key} "
                          f"(runner-up {second.key or '–'}: {second.inliers}).")
        return result


_INDEX: ReferenceIndex | None = None


def get_index(min_inliers: int | None = None) -> ReferenceIndex:
    global _INDEX
    if _INDEX is None:
        _INDEX = ReferenceIndex(min_inliers=min_inliers or 20)
    elif min_inliers is not None:
        _INDEX.min_inliers = min_inliers
    return _INDEX


def encode_qr(text: str, scale: int = 8, border: int = 4):
    """Render a QR code as an 8-bit grayscale numpy image (used by the PDF builder and tests)."""
    if not CV_AVAILABLE:
        raise RuntimeError("OpenCV is required to render QR codes")
    encoder = cv2.QRCodeEncoder.create()
    img = encoder.encode(text)
    img = cv2.resize(img, (img.shape[1] * scale, img.shape[0] * scale), interpolation=cv2.INTER_NEAREST)
    pad = border * scale
    return cv2.copyMakeBorder(img, pad, pad, pad, pad, cv2.BORDER_CONSTANT, value=255)


def reference_dir_status(directory: Path | None = None) -> dict[str, bool]:
    return {c.key: c.path.exists() for c in all_cards()}
