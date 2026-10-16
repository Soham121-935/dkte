#!/usr/bin/env python3
"""Build the printable reference card set (docs/mushroom-reference-cards.pdf).

One A4 page per card: the reference photo, the species / phase, what the grower
would see, the temperature & humidity ranges the controller applies for that
phase (taken from the built-in reference profiles) and a QR code with the same
``MYCO:<species>:<phase>`` payload the backend recognises.

Run from the repository root with the backend virtualenv:

    backend/.venv/bin/python scripts/build_reference_pdf.py [--out docs/mushroom-reference-cards.pdf]

The images in backend/app/vision/reference are the *same* files the recogniser
indexes, so a photo of a printed page matches the card it was printed from.
"""
from __future__ import annotations

import argparse
import sys
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

from PIL import Image  # noqa: E402
from reportlab.lib import colors  # noqa: E402
from reportlab.lib.pagesizes import A4  # noqa: E402
from reportlab.lib.units import mm  # noqa: E402
from reportlab.lib.utils import ImageReader  # noqa: E402
from reportlab.pdfgen import canvas  # noqa: E402

from app.services import profiles as profile_defs  # noqa: E402
from app.vision import matcher  # noqa: E402
from app.vision.reference import PHASES_BY_SPECIES, SPECIES, all_cards  # noqa: E402

PAGE_W, PAGE_H = A4
MARGIN = 14 * mm
INK = colors.HexColor("#1f2a24")
MUTED = colors.HexColor("#5f6b64")
LINE = colors.HexColor("#d7ddd9")
BRAND = colors.HexColor("#2f6f4e")


def builtin_profiles() -> dict[str, dict]:
    out = {}
    for fn in (profile_defs.oyster_profile, profile_defs.shiitake_profile, profile_defs.lions_mane_profile):
        p = fn()
        out[p["name"]] = p
    return out


def stage_of(profile: dict, key: str) -> dict | None:
    return next((s for s in profile["stages"] if s["key"] == key), None)


def fmt_range(lo, hi, unit: str) -> str:
    if lo is None or hi is None:
        return "–"
    return f"{lo:g}–{hi:g} {unit}"


def qr_reader(text: str) -> ImageReader:
    arr = matcher.encode_qr(text, scale=8, border=2)
    return ImageReader(Image.fromarray(arr).convert("RGB"))


def wrap(c: canvas.Canvas, text: str, width: float, font: str, size: float) -> list[str]:
    words, lines, cur = text.split(), [], ""
    for w in words:
        trial = f"{cur} {w}".strip()
        if c.stringWidth(trial, font, size) <= width:
            cur = trial
        else:
            lines.append(cur)
            cur = w
    if cur:
        lines.append(cur)
    return lines


def draw_cover(c: canvas.Canvas, profiles: dict[str, dict], missing: list[str]) -> None:
    y = PAGE_H - MARGIN
    c.setFillColor(BRAND)
    c.setFont("Helvetica-Bold", 22)
    c.drawString(MARGIN, y - 8 * mm, "MYCO AI – mushroom phase reference cards")
    c.setFillColor(MUTED)
    c.setFont("Helvetica", 10)
    c.drawString(MARGIN, y - 14 * mm, f"Printable demo set · built {date.today().isoformat()} · 3 species · {len(all_cards())} cards")
    y -= 24 * mm

    c.setFillColor(INK)
    c.setFont("Helvetica-Bold", 12)
    c.drawString(MARGIN, y, "How the demo works")
    y -= 6 * mm
    c.setFont("Helvetica", 9.5)
    steps = [
        "1. Print this PDF (A4, colour if possible) and cut out the cards you want to demonstrate.",
        "2. Hold a card flat in front of the ESP32-CAM, 20–40 cm away, filling most of the frame, without glare.",
        "3. Press “Take a photo now” on the MYCO AI Overview page (or wait for the automatic interval).",
        "4. The backend recognises the card – first by its QR code, otherwise by matching the picture’s features –",
        "    and sets the chamber’s batch to the matching growth phase.",
        "5. The deterministic controller then drives fan, humidifier and bulb towards that phase’s ranges below.",
        "The recogniser only knows these printed cards. It is not a general mushroom classifier.",
    ]
    for line in steps:
        c.drawString(MARGIN, y, line)
        y -= 5 * mm
    y -= 4 * mm

    # ranges table
    c.setFont("Helvetica-Bold", 12)
    c.drawString(MARGIN, y, "Phases and the ranges the controller applies")
    y -= 7 * mm
    col_x = [MARGIN, MARGIN + 34 * mm, MARGIN + 66 * mm, MARGIN + 102 * mm, MARGIN + 132 * mm, MARGIN + 156 * mm]
    headers = ["Species", "Phase (card)", "Profile stage", "Temperature", "Humidity", "Fresh air"]
    c.setFont("Helvetica-Bold", 8.5)
    c.setFillColor(MUTED)
    for x, h in zip(col_x, headers):
        c.drawString(x, y, h)
    y -= 2.2 * mm
    c.setStrokeColor(LINE)
    c.line(MARGIN, y, PAGE_W - MARGIN, y)
    y -= 4.5 * mm
    c.setFillColor(INK)
    for sp in SPECIES:
        profile = profiles[sp.profile_name]
        for i, ph in enumerate(PHASES_BY_SPECIES[sp.key]):
            st = stage_of(profile, ph.stage_key) or {}
            t = st.get("targets", {})
            fae = t.get("fae_cycle_minutes") or 0
            fae_txt = f"{t.get('fae_duration_minutes', 0)} min / {fae} min" if fae else "passive"
            c.setFont("Helvetica-Bold" if i == 0 else "Helvetica", 8.5)
            c.drawString(col_x[0], y, sp.common_name if i == 0 else "")
            c.setFont("Helvetica", 8.5)
            c.drawString(col_x[1], y, ph.label)
            c.drawString(col_x[2], y, st.get("name", ph.stage_key)[:26])
            c.drawString(col_x[3], y, fmt_range(t.get("temperature_min_c"), t.get("temperature_max_c"), "°C"))
            c.drawString(col_x[4], y, fmt_range(t.get("humidity_min_percent"), t.get("humidity_max_percent"), "% RH"))
            c.drawString(col_x[5], y, fae_txt)
            y -= 4.8 * mm
        c.setStrokeColor(LINE)
        c.line(MARGIN, y + 1.5 * mm, PAGE_W - MARGIN, y + 1.5 * mm)
        y -= 2.5 * mm

    y -= 3 * mm
    c.setFont("Helvetica", 8)
    c.setFillColor(MUTED)
    for line in wrap(c, profile_defs.REFERENCE_NOTE + " Humidity targets are capped at 95 % because that is the DHT11's usable limit; "
                        "the 12 V fan cannot cool below room temperature, so temperatures above a phase's maximum are reported, not fixed.",
                     PAGE_W - 2 * MARGIN, "Helvetica", 8):
        c.drawString(MARGIN, y, line)
        y -= 4 * mm
    if missing:
        y -= 3 * mm
        c.setFillColor(colors.HexColor("#b4541f"))
        c.drawString(MARGIN, y, f"Images still missing for: {', '.join(missing)} – those pages show a placeholder.")
    c.setFillColor(MUTED)
    c.setFont("Helvetica", 7.5)
    c.drawString(MARGIN, MARGIN, "QR payload format: MYCO:<species code>:<phase>. OYS = Oyster, SHI = Shiitake, LMN = Lion's mane.")
    c.showPage()


def draw_card(c: canvas.Canvas, card, profile: dict, index: int, total: int) -> None:
    st = stage_of(profile, card.phase.stage_key) or {}
    t = st.get("targets", {})

    # header
    c.setFillColor(BRAND)
    c.setFont("Helvetica-Bold", 20)
    c.drawString(MARGIN, PAGE_H - MARGIN - 6 * mm, f"{card.species.common_name} · {card.phase.label}")
    c.setFillColor(MUTED)
    c.setFont("Helvetica-Oblique", 11)
    c.drawString(MARGIN, PAGE_H - MARGIN - 12 * mm, card.species.latin_name)
    c.setFont("Helvetica", 9)
    c.drawRightString(PAGE_W - MARGIN, PAGE_H - MARGIN - 6 * mm, f"Card {index}/{total}")
    c.drawRightString(PAGE_W - MARGIN, PAGE_H - MARGIN - 11 * mm, card.key)

    # picture
    box_top = PAGE_H - MARGIN - 18 * mm
    box_h = 150 * mm
    box_w = PAGE_W - 2 * MARGIN
    box_bottom = box_top - box_h
    c.setStrokeColor(LINE)
    c.setLineWidth(0.6)
    c.rect(MARGIN, box_bottom, box_w, box_h, stroke=1, fill=0)
    if card.path.exists():
        img = Image.open(card.path)
        iw, ih = img.size
        scale = min((box_w - 4 * mm) / iw, (box_h - 4 * mm) / ih)
        dw, dh = iw * scale, ih * scale
        x = MARGIN + (box_w - dw) / 2
        y = box_bottom + (box_h - dh) / 2
        # pass the file path so reportlab embeds the JPEG bytes as-is (small PDF) instead of re-encoding
        c.drawImage(str(card.path), x, y, dw, dh, preserveAspectRatio=True)
    else:
        c.setFillColor(MUTED)
        c.setFont("Helvetica", 12)
        c.drawCentredString(PAGE_W / 2, box_bottom + box_h / 2, "reference image not generated yet")

    # info block (left) + QR (right)
    y = box_bottom - 8 * mm
    qr_size = 38 * mm
    text_w = box_w - qr_size - 10 * mm
    c.setFillColor(INK)
    c.setFont("Helvetica-Bold", 11)
    c.drawString(MARGIN, y, "What you see")
    y -= 5 * mm
    c.setFont("Helvetica", 9.5)
    for line in wrap(c, card.phase.what_you_see, text_w, "Helvetica", 9.5):
        c.drawString(MARGIN, y, line)
        y -= 4.5 * mm
    signs = st.get("observable_signs") or []
    if signs:
        for sgn in signs[:3]:
            c.drawString(MARGIN, y, f"• {sgn}")
            y -= 4.5 * mm
    y -= 2 * mm
    c.setFont("Helvetica-Bold", 11)
    c.drawString(MARGIN, y, f"Controller targets for this phase (profile stage “{st.get('name', card.phase.stage_key)}”)")
    y -= 6 * mm
    c.setFont("Helvetica-Bold", 13)
    c.drawString(MARGIN, y, fmt_range(t.get("temperature_min_c"), t.get("temperature_max_c"), "°C"))
    c.drawString(MARGIN + 42 * mm, y, fmt_range(t.get("humidity_min_percent"), t.get("humidity_max_percent"), "% RH"))
    fae = t.get("fae_cycle_minutes") or 0
    c.setFont("Helvetica", 9.5)
    c.drawString(MARGIN + 92 * mm, y, f"fresh air: {t.get('fae_duration_minutes', 0)} min every {fae} min" if fae else "fresh air: passive")
    y -= 5 * mm
    c.setFillColor(MUTED)
    c.setFont("Helvetica", 8.5)
    dur = st.get("typical_duration_days")
    if dur:
        c.drawString(MARGIN, y, f"Typical duration {dur['min']:g}–{dur['max']:g} days · next: {st.get('transition_criteria', '')[:90]}")
        y -= 4.5 * mm
    c.drawString(MARGIN, y, "Humidifier raises RH, fan lowers RH / exchanges air, bulb (relay) heats – all with hysteresis and interlocks.")

    # QR
    qx = PAGE_W - MARGIN - qr_size
    qy = box_bottom - 10 * mm - qr_size
    c.drawImage(qr_reader(card.qr_payload), qx, qy, qr_size, qr_size)
    c.setFillColor(INK)
    c.setFont("Courier-Bold", 9)
    c.drawCentredString(qx + qr_size / 2, qy - 4 * mm, card.qr_payload)

    c.setFillColor(MUTED)
    c.setFont("Helvetica", 7.5)
    c.drawString(MARGIN, MARGIN, "MYCO AI demo reference card – recognised by QR code or by matching this picture's features. Ranges from the built-in reference profile; verify for your strain.")
    c.showPage()


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=str(ROOT / "docs" / "mushroom-reference-cards.pdf"))
    args = ap.parse_args()
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)

    profiles = builtin_profiles()
    cards = all_cards()
    missing = [c.key for c in cards if not c.path.exists()]

    c = canvas.Canvas(str(out), pagesize=A4)
    c.setTitle("MYCO AI – mushroom phase reference cards")
    c.setAuthor("MYCO AI")
    draw_cover(c, profiles, missing)
    for i, card in enumerate(cards, start=1):
        draw_card(c, card, profiles[card.species.profile_name], i, len(cards))
    c.save()
    print(f"wrote {out} ({len(cards)} cards, {len(missing)} missing image(s){': ' + ', '.join(missing) if missing else ''})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
