"""The reference set: 3 species x visual phases, each mapped to a profile stage.

Every entry corresponds to one printable card (see ``scripts/build_reference_pdf.py``)
and one image file in ``app/vision/reference/<key>.jpg``.  The temperature /
humidity ranges are *not* stored here – they come from the built-in reference
cultivation profiles (``app/services/profiles.py``) so the camera result and the
grower's batch use exactly the same numbers.
"""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

REFERENCE_DIR = Path(__file__).resolve().parent / "reference"

# QR payload format shared with the printed cards: MYCO:<species code>:<phase or stage key>
QR_PREFIX = "MYCO"


@dataclass(frozen=True)
class Species:
    key: str
    code: str  # 3-letter code used inside the QR payload
    common_name: str
    latin_name: str
    profile_name: str  # name of the built-in reference profile


@dataclass(frozen=True)
class Phase:
    key: str
    label: str
    stage_key: str  # stage key inside the cultivation profile
    what_you_see: str


@dataclass(frozen=True)
class ReferenceCard:
    key: str
    species: Species
    phase: Phase

    @property
    def filename(self) -> str:
        return f"{self.key}.jpg"

    @property
    def path(self) -> Path:
        return REFERENCE_DIR / self.filename

    @property
    def qr_payload(self) -> str:
        return f"{QR_PREFIX}:{self.species.code}:{self.phase.key}"


SPECIES: list[Species] = [
    Species("oyster", "OYS", "Oyster", "Pleurotus ostreatus", "Oyster – straw/sawdust (reference)"),
    Species("shiitake", "SHI", "Shiitake", "Lentinula edodes", "Shiitake – supplemented sawdust block (reference)"),
    Species("lions_mane", "LMN", "Lion's mane", "Hericium erinaceus", "Lion's mane – supplemented sawdust (reference)"),
]

_COMMON_PHASES: list[Phase] = [
    Phase("colonising", "Colonising", "incubation", "White mycelium spreading through the substrate; no fruit bodies."),
    Phase("pinning", "Pinning", "pinning", "First tiny primordia (pins) at the openings."),
    Phase("fruiting", "Fruiting", "fruiting", "Young fruit bodies growing, caps still small / domed."),
    Phase("harvest_ready", "Harvest ready", "harvest_ready", "Mature fruit bodies at harvest size."),
]
_SHIITAKE_BROWNING = Phase("browning", "Browning", "browning",
                           "Block has left the bag and formed a brown protective skin; popcorning bumps.")

PHASES_BY_SPECIES: dict[str, list[Phase]] = {
    "oyster": list(_COMMON_PHASES),
    "shiitake": [_COMMON_PHASES[0], _SHIITAKE_BROWNING, *_COMMON_PHASES[1:]],
    "lions_mane": list(_COMMON_PHASES),
}

# Aliases accepted inside QR payloads (older demo cards used the stage key directly).
_PHASE_ALIASES = {
    "incubation": "colonising",
    "colonisation": "colonising",
    "colonization": "colonising",
    "harvest": "harvest_ready",
    "harvest-ready": "harvest_ready",
    "harvestready": "harvest_ready",
}


def all_cards() -> list[ReferenceCard]:
    cards: list[ReferenceCard] = []
    for sp in SPECIES:
        for ph in PHASES_BY_SPECIES[sp.key]:
            cards.append(ReferenceCard(key=f"{sp.key}_{ph.key}", species=sp, phase=ph))
    return cards


def card_by_key(key: str) -> ReferenceCard | None:
    for c in all_cards():
        if c.key == key:
            return c
    return None


def species_by_code(code: str) -> Species | None:
    code = code.strip().upper()
    for sp in SPECIES:
        if sp.code == code or sp.key.upper() == code:
            return sp
    return None


def parse_qr_payload(text: str) -> ReferenceCard | None:
    """``MYCO:OYS:pinning`` -> the matching card (or None when the payload is foreign)."""
    if not text:
        return None
    parts = [p.strip() for p in text.strip().split(":")]
    if len(parts) != 3 or parts[0].upper() != QR_PREFIX:
        return None
    sp = species_by_code(parts[1])
    if sp is None:
        return None
    phase_key = parts[2].strip().lower().replace(" ", "_")
    phase_key = _PHASE_ALIASES.get(phase_key, phase_key)
    for ph in PHASES_BY_SPECIES[sp.key]:
        if ph.key == phase_key or ph.stage_key == phase_key:
            return ReferenceCard(key=f"{sp.key}_{ph.key}", species=sp, phase=ph)
    return None


def card_to_dict(card: ReferenceCard, *, available: bool | None = None) -> dict:
    data = {
        "key": card.key,
        "species_key": card.species.key,
        "species": card.species.common_name,
        "latin_name": card.species.latin_name,
        "profile_name": card.species.profile_name,
        "phase_key": card.phase.key,
        "phase": card.phase.label,
        "stage_key": card.phase.stage_key,
        "what_you_see": card.phase.what_you_see,
        "qr_payload": card.qr_payload,
        "image_url": f"/api/vision/reference/{card.key}.jpg",
    }
    if available is not None:
        data["image_available"] = available
    return data
