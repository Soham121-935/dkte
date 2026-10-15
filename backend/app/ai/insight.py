"""Plain-language chamber briefing ("MYCO AI says …").

The briefing is what a grower sees first on the home page.  Its *structure*
(status, headline, bullet points, next step) is always computed
deterministically from the assistant context, so it works without an AI
provider and never contains invented numbers.  When a language model is
configured, the service additionally asks it for a short friendly narrative
that is shown next to the computed points and labelled as AI-written.
"""
from __future__ import annotations

from typing import Any

STATUS_RANK = {"good": 0, "watch": 1, "attention": 2, "unknown": 3}

HEADLINES = {
    "good": "Everything looks good",
    "watch": "Mostly fine – a few things to watch",
    "attention": "Needs your attention",
    "unknown": "No readings yet",
}


def _fmt(value: float | None, digits: int = 1, unit: str = "") -> str:
    if value is None:
        return "unknown"
    text = f"{value:.{digits}f}"
    if digits > 0 and text.endswith("0" * digits) and "." in text:
        text = text.rstrip("0").rstrip(".")
    return f"{text}{unit}"


def _age(seconds: int | None) -> str:
    if seconds is None:
        return "an unknown time"
    if seconds < 90:
        return f"{seconds} seconds"
    if seconds < 5400:
        return f"{round(seconds / 60)} minutes"
    if seconds < 172800:
        return f"{seconds / 3600:.1f} hours"
    return f"{seconds / 86400:.1f} days"


def _range_point(label: str, value: float | None, lo: Any, hi: Any, unit: str, digits: int, *,
                 low_helper: tuple[str, bool | None], high_helper: tuple[str, bool | None], far: float) -> dict[str, Any]:
    """Describe one measured value against its target band in plain words.

    ``low_helper``/``high_helper`` name the actuator that normally corrects a
    low/high value together with its last reported state, so the sentence can
    say whether that actuator is currently running.
    """
    if value is None:
        return {"tone": "warn", "kind": "measured", "text": f"{label} is not available right now – the sensor did not report a valid value."}
    if lo is None or hi is None:
        return {"tone": "info", "kind": "measured", "text": f"{label} is {_fmt(value, digits, unit)} (no target range is set for this stage)."}
    lo_f, hi_f = float(lo), float(hi)
    band = f"{_fmt(lo_f, digits)}–{_fmt(hi_f, digits, unit)}"
    if lo_f <= value <= hi_f:
        return {"tone": "good", "kind": "measured", "text": f"{label} is {_fmt(value, digits, unit)} – inside the target range ({band})."}
    if value < lo_f:
        diff, helper = lo_f - value, low_helper
        qualifier = "well below" if diff >= far else "a little below"
    else:
        diff, helper = value - hi_f, high_helper
        qualifier = "well above" if diff >= far else "a little above"
    severity = "bad" if diff >= far else "warn"
    text = f"{label} is {_fmt(value, digits, unit)} – {qualifier} the target range ({band})."
    name, state = helper
    if state is True:
        text += f" The {name} is on."
    elif state is False:
        text += f" The {name} is currently off."
    return {"tone": severity, "kind": "measured", "text": text}


def build_briefing(ctx: dict[str, Any]) -> dict[str, Any]:
    """Compute the deterministic part of the briefing from ``build_context`` output."""
    points: list[dict[str, Any]] = []
    cr = ctx.get("current_reading")
    device = ctx.get("device") or {}
    targets = ctx.get("targets") or {}
    simulated = bool(cr and cr.get("source") == "simulation")
    data_note = None
    if cr:
        data_note = ("These readings come from the built-in simulated chamber, not from real hardware."
                     if simulated else "Readings are measured by your chamber's sensors.")

    status = "good"

    def bump(level: str) -> None:
        nonlocal status
        if STATUS_RANK[level] > STATUS_RANK[status]:
            status = level

    # ------------------------------------------------------------ freshness
    if not cr:
        points.append({"tone": "info", "kind": "data",
                       "text": "The chamber has not sent any readings yet, so there is nothing to assess."})
        next_step = "Check that the device is powered and connected (Device Management), or start the simulator to explore the app."
        return {"status": "unknown", "headline": HEADLINES["unknown"], "points": points, "next_step": next_step,
                "data_note": None, "simulated": False}

    offline = device.get("connection_status") not in (None, "online")
    if offline:
        bump("attention")
        points.append({"tone": "bad", "kind": "data",
                       "text": f"The chamber appears to be disconnected – the last reading arrived {_age(cr.get('age_seconds'))} ago. "
                               "The values below may be out of date."})
    elif cr.get("stale"):
        bump("attention")
        points.append({"tone": "bad", "kind": "data",
                       "text": f"The last reading is {_age(cr.get('age_seconds'))} old. New data is expected every minute or so."})

    # --------------------------------------------------------- measurements
    quality = cr.get("quality") or {}
    def _state(key: str) -> bool | None:
        v = cr.get(key)
        return v if isinstance(v, bool) else None

    t_point = _range_point("Temperature", cr.get("temperature_c"), targets.get("temperature_min_c"), targets.get("temperature_max_c"), " °C", 1,
                           low_helper=("heater", _state("heater_state")), high_helper=("fan", _state("fan_state")), far=2.0)
    h_point = _range_point("Humidity", cr.get("relative_humidity_percent"), targets.get("humidity_min_percent"), targets.get("humidity_max_percent"), " %", 0,
                           low_helper=("humidifier", _state("humidifier_state")), high_helper=("fan", _state("fan_state")), far=8.0)
    for key, point in (("temperature_c", t_point), ("relative_humidity_percent", h_point)):
        q = quality.get(key)
        if q in ("invalid", "sensor_error"):
            point = {"tone": "bad", "kind": "measured",
                     "text": f"{point['text'].split(' is ')[0]} could not be measured properly (sensor reported {'an error' if q == 'sensor_error' else 'an impossible value'}). Check the sensor wiring."}
        elif q == "suspect":
            point = {**point, "tone": "warn" if point["tone"] == "good" else point["tone"],
                     "text": point["text"] + " This value is outside what the sensor can measure reliably, so treat it as approximate."}
        if point["tone"] == "bad":
            bump("attention")
        elif point["tone"] == "warn":
            bump("watch")
        points.append(point)
    if cr.get("substrate_moisture_raw") is not None and quality.get("substrate_moisture_raw") in ("invalid", "sensor_error"):
        bump("watch")
        points.append({"tone": "warn", "kind": "measured", "text": "The growing-medium moisture sensor reported an unusable value. Check its connection."})

    # ---------------------------------------------------------------- alerts
    alerts = [a for a in (ctx.get("alerts") or {}).get("items", []) if a.get("status") == "active"]
    if alerts:
        critical = [a for a in alerts if a.get("severity") == "critical"]
        bump("attention" if critical else "watch")
        titles = ", ".join(dict.fromkeys(a["title"] for a in alerts[:3]))
        more = f" and {len(alerts) - 3} more" if len(alerts) > 3 else ""
        points.append({"tone": "bad" if critical else "warn", "kind": "alert",
                       "text": f"{len(alerts)} open alert{'s' if len(alerts) != 1 else ''}: {titles}{more}."})
    else:
        points.append({"tone": "good", "kind": "alert", "text": "No open alerts."})

    # --------------------------------------------------------------- history
    hist = ctx.get("history") or {}
    t_hist = hist.get("temperature_c")
    h_hist = hist.get("relative_humidity_percent")
    if t_hist and h_hist:
        text = (f"Over the last 24 hours temperature stayed between {_fmt(t_hist['min'])} and {_fmt(t_hist['max'], 1, ' °C')}, "
                f"humidity between {_fmt(h_hist['min'], 0)} and {_fmt(h_hist['max'], 0, ' %')}.")
        outside = hist.get("outside_range") or {}
        fractions = [v.get("outside_fraction") for v in outside.values() if isinstance(v, dict) and v.get("outside_fraction") is not None]
        tone = "info"
        if fractions and max(fractions) >= 0.25:
            worst = max(fractions)
            text += f" Conditions were outside the target range about {round(worst * 100)} % of that time."
            bump("watch")
            tone = "warn"
        points.append({"tone": tone, "kind": "history", "text": text})
    completeness = hist.get("data_completeness")
    if completeness is not None and completeness < 0.8 and hist.get("n_readings", 0) > 0:
        bump("watch")
        points.append({"tone": "warn", "kind": "data",
                       "text": f"About {round((1 - completeness) * 100)} % of yesterday's readings are missing – the connection may be unreliable."})

    # ----------------------------------------------------------------- batch
    batch = ctx.get("batch")
    est = ctx.get("stage_estimate") or {}
    next_step: str | None = None
    if batch:
        species = batch.get("species") or "mushroom"
        if est.get("available"):
            cur = est.get("current_stage") or {}
            day = int(cur.get("elapsed_days") or 0) + 1
            timing = est.get("timing")
            text = f"Your {species} batch ({batch.get('code')}) is on day {day} of the {cur.get('name', 'current')} stage"
            if timing == "early":
                text += " – a stage change is not expected yet."
            elif timing == "within_window":
                text += " – this is when the next stage typically starts, so look for the signs."
            elif timing == "beyond_window":
                text += " – longer than usual for this stage. Take a close look at the batch."
                bump("watch")
            else:
                text += "."
            points.append({"tone": "info", "kind": "estimate", "text": text})
            nxt = est.get("next_stage") or {}
            signs = nxt.get("observable_signs") or []
            if signs and timing in ("within_window", "beyond_window"):
                next_step = f"Inspect the batch for signs of {nxt.get('name', 'the next stage').lower()}: {signs[0].rstrip('.').lower()}. Confirm the stage in the app when you see them."
        else:
            points.append({"tone": "info", "kind": "estimate",
                           "text": f"Your {species} batch ({batch.get('code')}) has no confirmed stage yet, so stage timing cannot be estimated."})
            next_step = "Open the batch and confirm its current stage so MYCO AI can track its timing."

    # -------------------------------------------------------- recommendation
    recs = (ctx.get("recommendations") or {}).get("items", [])
    if recs:
        top = recs[0]
        action = (top.get("action") or "").strip()
        if action:
            next_step = action if not top.get("requires_confirmation") else f"{action} (please check the chamber before acting)"
    if not next_step:
        if offline or cr.get("stale"):
            next_step = "Check the chamber's power and Wi-Fi connection, then open Device Management to see when it last reported."
        elif status == "good":
            next_step = "Nothing to do right now – check back later or record an observation if you looked at the batch."
        else:
            next_step = "Open Live Monitoring to see the trend and decide whether the chamber needs adjusting."

    return {"status": status, "headline": HEADLINES[status], "points": points, "next_step": next_step,
            "data_note": data_note, "simulated": simulated}


NARRATIVE_INSTRUCTIONS = (
    "Write a short, friendly briefing for a home mushroom grower about their chamber right now. "
    "Plain language only: no jargon, no acronyms, no markdown headings, at most 80 words, two or three sentences. "
    "Say what is good, what (if anything) needs attention, and one practical next step. "
    "Use only facts from the CONTEXT; quote at most two numbers and never invent values or percentages. "
    "If the readings are simulated, say so in a few words. Do not mention timestamps unless data is stale."
)
