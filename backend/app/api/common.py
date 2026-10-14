"""Shared helpers for routers."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

from fastapi import HTTPException, Query

RANGE_PRESETS = {"15m": timedelta(minutes=15), "1h": timedelta(hours=1), "6h": timedelta(hours=6),
                 "24h": timedelta(hours=24), "7d": timedelta(days=7), "30d": timedelta(days=30)}


def parse_range(
    range_: str | None = Query(default=None, alias="range", description="Preset: 15m, 1h, 6h, 24h, 7d, 30d"),
    start: datetime | None = Query(default=None, alias="from"),
    end: datetime | None = Query(default=None, alias="to"),
) -> tuple[datetime, datetime]:
    now = datetime.now(timezone.utc)
    if start is not None or end is not None:
        if start is None:
            raise HTTPException(status_code=422, detail="'from' is required when 'to' is given")
        start = start if start.tzinfo else start.replace(tzinfo=timezone.utc)
        end = (end if end.tzinfo else end.replace(tzinfo=timezone.utc)) if end else now
        if end <= start:
            raise HTTPException(status_code=422, detail="'to' must be after 'from'")
        if end - start > timedelta(days=366):
            raise HTTPException(status_code=422, detail="range too large (max 366 days)")
        return start, end
    delta = RANGE_PRESETS.get(range_ or "24h")
    if delta is None:
        raise HTTPException(status_code=422, detail=f"unknown range preset '{range_}'")
    return now - delta, now
