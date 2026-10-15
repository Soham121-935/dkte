"""FastAPI dependencies for authentication and authorisation."""
from __future__ import annotations

from dataclasses import dataclass
from typing import Callable

from fastapi import Depends, Header, HTTPException, Request, status
from sqlalchemy.orm import Session

from ..config import get_settings
from ..db.models import Device, User
from ..db.session import get_db
from .security import decode_access_token, hash_token

ROLE_RANK = {"viewer": 1, "operator": 2, "admin": 3}


@dataclass
class CurrentUser:
    id: int
    username: str
    role: str

    def has_role(self, required: str) -> bool:
        return ROLE_RANK.get(self.role, 0) >= ROLE_RANK.get(required, 99)


def _extract_bearer(request: Request) -> str | None:
    auth = request.headers.get("authorization")
    if auth and auth.lower().startswith("bearer "):
        return auth.split(" ", 1)[1].strip()
    return None


def get_optional_user(request: Request, db: Session = Depends(get_db)) -> CurrentUser | None:
    token = _extract_bearer(request)
    if not token:
        return None
    payload = decode_access_token(token)
    if not payload:
        return None
    user = db.get(User, int(payload["sub"])) if str(payload.get("sub", "")).isdigit() else None
    if not user or not user.is_active:
        return None
    return CurrentUser(id=user.id, username=user.username, role=user.role)


LOCAL_OPERATOR = CurrentUser(id=0, username="local-operator", role="operator")


def get_current_user(user: CurrentUser | None = Depends(get_optional_user)) -> CurrentUser:
    if user is None:
        if get_settings().open_access:
            # OPEN_ACCESS=true: the dashboard has no sign-in; anonymous callers are a local operator
            return LOCAL_OPERATOR
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Authentication required")
    return user


def require_role(role: str) -> Callable[..., CurrentUser]:
    def _dep(user: CurrentUser = Depends(get_current_user)) -> CurrentUser:
        if not user.has_role(role):
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=f"Requires role '{role}' or higher")
        return user

    return _dep


def read_access(user: CurrentUser | None = Depends(get_optional_user)) -> CurrentUser | None:
    """Read endpoints are public unless PUBLIC_READ=false."""
    if get_settings().public_read:
        return user
    if user is None:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Authentication required")
    return user


def get_device_from_token(
    x_device_token: str | None = Header(default=None, alias="X-Device-Token"),
    db: Session = Depends(get_db),
) -> Device:
    """Authenticate a physical device using its per-device token (HTTP transport)."""
    if not x_device_token:
        raise HTTPException(status_code=401, detail="Missing X-Device-Token header")
    token_hash = hash_token(x_device_token)
    device = db.query(Device).filter(Device.token_hash == token_hash).one_or_none()
    if device is None or not device.is_enabled:
        raise HTTPException(status_code=401, detail="Invalid or disabled device token")
    return device
