"""Cultivation profiles.

A profile describes the ordered growth stages for a species / cultivation
method, the *typical* duration window of each stage and the target
environment per stage.  Built-in profiles carry ``source="reference"``:
their numbers are typical ranges compiled from general cultivation
literature and are **not** validated for any particular strain, substrate or
chamber – the UI labels them accordingly.  Users can clone and edit profiles
(``source="user"``) or create their own from the generic template.
"""
from __future__ import annotations

from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..db.models import CultivationProfile

REFERENCE_NOTE = (
    "Typical ranges compiled from general cultivation literature. Not validated for your strain, substrate or "
    "chamber – verify and adjust. Note: the DHT11 is only rated to ~90 % RH and 0–50 °C; readings above 90 % RH "
    "should be treated as approximate."
)


def stage(
    key: str,
    name: str,
    *,
    days: tuple[float, float] | None,
    t: tuple[float, float] | None,
    rh: tuple[float, float] | None,
    fae: tuple[int, int] = (0, 0),
    description: str = "",
    signs: list[str] | None = None,
    transition: str = "",
    milestone: bool = False,
) -> dict[str, Any]:
    return {
        "key": key,
        "name": name,
        "description": description,
        "milestone": milestone,
        "typical_duration_days": {"min": days[0], "max": days[1]} if days else None,
        "targets": {
            "temperature_min_c": t[0] if t else None,
            "temperature_max_c": t[1] if t else None,
            "humidity_min_percent": rh[0] if rh else None,
            "humidity_max_percent": rh[1] if rh else None,
            "moisture_min_raw": None,
            "fae_cycle_minutes": fae[0],
            "fae_duration_minutes": fae[1],
        },
        "observable_signs": signs or [],
        "transition_criteria": transition,
        "requires_confirmation": True,
    }


def oyster_profile() -> dict[str, Any]:
    return {
        "name": "Oyster – straw/sawdust (reference)",
        "species": "Pleurotus ostreatus",
        "strain": None,
        "cultivation_method": "Pasteurised straw or supplemented sawdust, bag/bucket, top-fruiting or side-fruiting",
        "substrate_type": "Pasteurised straw / supplemented sawdust",
        "source": "reference",
        "source_notes": REFERENCE_NOTE,
        "is_builtin": True,
        "stages": [
            stage("substrate_preparation", "Substrate preparation", days=(0, 2), t=None, rh=None,
                  description="Hydrate, pasteurise or sterilise substrate; cool before inoculation.",
                  transition="Substrate cooled to below 30 °C and ready for inoculation.", milestone=True),
            stage("inoculation", "Inoculation", days=(0, 0), t=None, rh=None, milestone=True,
                  description="Spawn mixed through substrate under clean conditions.",
                  transition="Inoculation date recorded."),
            stage("incubation", "Incubation & colonisation", days=(10, 21), t=(20, 24), rh=(60, 80),
                  description="Dark, warm, stable. Container retains moisture so ambient RH is less critical.",
                  signs=["White mycelium spreading from spawn points", "Substrate consolidating into a block"],
                  transition="Substrate fully colonised (white throughout), no green/black patches."),
            stage("pinning", "Primordia formation (pinning)", days=(3, 7), t=(15, 20), rh=(90, 95), fae=(30, 5),
                  description="Lower temperature, high humidity, fresh air and indirect light trigger pins.",
                  signs=["Tiny pin clusters at openings", "Mycelium knots on surface"],
                  transition="Visible pin clusters at the fruiting openings (grower confirmation)."),
            stage("fruiting", "Fruiting-body development", days=(4, 7), t=(16, 21), rh=(85, 95), fae=(20, 5),
                  description="Caps expand rapidly; strong fresh-air exchange prevents long stems and small caps.",
                  signs=["Caps expanding daily", "Stems short and caps broad with good airflow"],
                  transition="Cap edges begin to flatten; largest caps near harvest size."),
            stage("harvest_ready", "Harvest readiness", days=(1, 2), t=(16, 21), rh=(85, 95), fae=(20, 5),
                  description="Harvest just before caps flatten/upturn and before heavy spore release.",
                  signs=["Cap edges still slightly curled downward", "Cluster firm"],
                  transition="Grower judges cluster ready and harvests."),
            stage("harvest", "Harvest", days=(0, 0), t=None, rh=None, milestone=True,
                  description="Cut cluster at the base; weigh and record yield.", transition="Harvest recorded."),
            stage("post_harvest", "Post-harvest evaluation / rest", days=(7, 14), t=(16, 21), rh=(85, 90), fae=(30, 5),
                  description="Evaluate yield and quality; rest the block before the next flush.",
                  transition="Second flush pins appear or block is retired."),
        ],
    }


def shiitake_profile() -> dict[str, Any]:
    return {
        "name": "Shiitake – supplemented sawdust block (reference)",
        "species": "Lentinula edodes",
        "strain": None,
        "cultivation_method": "Sterilised supplemented sawdust block, browning, cold-water soak to initiate",
        "substrate_type": "Sterilised supplemented hardwood sawdust",
        "source": "reference",
        "source_notes": REFERENCE_NOTE,
        "is_builtin": True,
        "stages": [
            stage("substrate_preparation", "Substrate preparation", days=(0, 2), t=None, rh=None, milestone=True,
                  description="Hydrate and sterilise supplemented sawdust blocks; cool fully.",
                  transition="Blocks sterile and cooled."),
            stage("inoculation", "Inoculation", days=(0, 0), t=None, rh=None, milestone=True,
                  description="Spawn added to block under sterile conditions.", transition="Inoculation date recorded."),
            stage("incubation", "Incubation & colonisation", days=(21, 40), t=(20, 24), rh=(60, 75),
                  description="Long dark incubation; shiitake colonises more slowly than oyster.",
                  signs=["White mycelium through block"], transition="Block fully white (colonised)."),
            stage("browning", "Browning (block maturation)", days=(14, 35), t=(20, 24), rh=(60, 75), fae=(60, 5),
                  description="Species-specific stage: surface mycelium forms a brown protective skin; popcorning may appear.",
                  signs=["Surface turning brown/tan", "Bumps (popcorning) on the surface"],
                  transition="Block mostly brown and firm; ready for cold-water soak / shock."),
            stage("pinning", "Pinning (after soak/shock)", days=(5, 10), t=(12, 18), rh=(85, 95), fae=(30, 5),
                  description="Cold shock and soaking initiate primordia.",
                  signs=["Small brown pins on block surface"], transition="Pins visible (grower confirmation)."),
            stage("fruiting", "Fruiting-body development", days=(7, 10), t=(14, 20), rh=(80, 90), fae=(30, 5),
                  description="Caps expand; moderate humidity keeps caps firm.",
                  signs=["Caps expanding", "Veil stretching"], transition="Veil just breaking on most caps."),
            stage("harvest_ready", "Harvest readiness", days=(1, 3), t=(14, 20), rh=(80, 90), fae=(30, 5),
                  description="Harvest when caps are 60–80 % open and still domed.",
                  transition="Grower judges caps ready and harvests."),
            stage("harvest", "Harvest", days=(0, 0), t=None, rh=None, milestone=True,
                  description="Twist or cut at base; record yield.", transition="Harvest recorded."),
            stage("post_harvest", "Post-harvest rest (dormancy)", days=(14, 21), t=(20, 24), rh=(60, 75), fae=(60, 5),
                  description="Rest block before re-soaking for the next flush.", transition="Block re-soaked."),
        ],
    }


def lions_mane_profile() -> dict[str, Any]:
    return {
        "name": "Lion's mane – supplemented sawdust (reference)",
        "species": "Hericium erinaceus",
        "strain": None,
        "cultivation_method": "Sterilised supplemented sawdust, side-fruiting bag",
        "substrate_type": "Sterilised supplemented hardwood sawdust",
        "source": "reference",
        "source_notes": REFERENCE_NOTE,
        "is_builtin": True,
        "stages": [
            stage("substrate_preparation", "Substrate preparation", days=(0, 2), t=None, rh=None, milestone=True,
                  description="Hydrate and sterilise; cool fully.", transition="Substrate sterile and cooled."),
            stage("inoculation", "Inoculation", days=(0, 0), t=None, rh=None, milestone=True,
                  description="Spawn added under sterile conditions.", transition="Inoculation date recorded."),
            stage("incubation", "Incubation & colonisation", days=(12, 21), t=(20, 24), rh=(60, 75),
                  description="Mycelium is wispy and can be hard to see; avoid disturbing the bag.",
                  signs=["Faint white growth", "Substrate smells sweet, not sour"], transition="Fully colonised."),
            stage("pinning", "Primordia formation", days=(3, 7), t=(18, 22), rh=(90, 95), fae=(30, 5),
                  description="Pins often form spontaneously; a small opening concentrates fruiting.",
                  signs=["White knots forming at openings"], transition="Pins visible (grower confirmation)."),
            stage("fruiting", "Fruiting-body development", days=(7, 14), t=(18, 22), rh=(85, 95), fae=(20, 5),
                  description="Spines lengthen; high humidity prevents browning/yellowing tips.",
                  signs=["Spines elongating", "Fruit body pure white"], transition="Spines approx. 0.5–1 cm long."),
            stage("harvest_ready", "Harvest readiness", days=(1, 3), t=(18, 22), rh=(85, 95), fae=(20, 5),
                  description="Harvest before spines yellow or release spores.",
                  transition="Grower judges fruit body ready and harvests."),
            stage("harvest", "Harvest", days=(0, 0), t=None, rh=None, milestone=True,
                  description="Cut at base; record yield.", transition="Harvest recorded."),
            stage("post_harvest", "Post-harvest evaluation / rest", days=(10, 14), t=(18, 22), rh=(85, 90), fae=(30, 5),
                  description="Evaluate; rest block before next flush.", transition="Next flush or block retired."),
        ],
    }


def generic_template() -> dict[str, Any]:
    return {
        "name": "Custom species – generic template (user)",
        "species": "Custom",
        "strain": None,
        "cultivation_method": "User defined",
        "substrate_type": None,
        "source": "user",
        "source_notes": "Blank template with the generic stage sequence. Enter your own verified target ranges and durations.",
        "is_builtin": True,
        "stages": [
            stage("substrate_preparation", "Substrate preparation", days=(0, 2), t=None, rh=None, milestone=True),
            stage("inoculation", "Inoculation", days=(0, 0), t=None, rh=None, milestone=True),
            stage("incubation", "Incubation & colonisation", days=(10, 28), t=(20, 24), rh=(60, 80)),
            stage("pinning", "Primordia / pinning", days=(3, 10), t=(16, 22), rh=(88, 95), fae=(30, 5)),
            stage("fruiting", "Fruiting-body development", days=(4, 14), t=(16, 22), rh=(85, 95), fae=(20, 5)),
            stage("harvest_ready", "Harvest readiness", days=(1, 3), t=(16, 22), rh=(85, 95), fae=(20, 5)),
            stage("harvest", "Harvest", days=(0, 0), t=None, rh=None, milestone=True),
            stage("post_harvest", "Post-harvest evaluation", days=(7, 14), t=(16, 22), rh=(80, 90)),
        ],
    }


BUILTIN_PROFILES = [oyster_profile, shiitake_profile, lions_mane_profile, generic_template]


def seed_profiles(db: Session) -> int:
    created = 0
    for factory in BUILTIN_PROFILES:
        data = factory()
        exists = db.execute(select(CultivationProfile).where(CultivationProfile.name == data["name"])).scalar_one_or_none()
        if exists is None:
            db.add(CultivationProfile(**data))
            created += 1
    db.flush()
    return created


def profile_to_dict(p: CultivationProfile) -> dict[str, Any]:
    return {
        "id": p.id,
        "name": p.name,
        "species": p.species,
        "strain": p.strain,
        "cultivation_method": p.cultivation_method,
        "substrate_type": p.substrate_type,
        "source": p.source,
        "source_notes": p.source_notes,
        "stages": p.stages or [],
        "is_builtin": p.is_builtin,
        "created_at": p.created_at.isoformat() if p.created_at else None,
        "updated_at": p.updated_at.isoformat() if p.updated_at else None,
    }
