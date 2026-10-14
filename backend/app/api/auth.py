from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..core.deps import CurrentUser, get_current_user, require_role
from ..core.security import create_access_token, hash_password, verify_password
from ..db.models import User
from ..db.session import get_db
from ..schemas.api import LoginRequest, PasswordChange, UserCreate, UserUpdate
from ..services.telemetry import log_event

router = APIRouter(prefix="/api/auth", tags=["auth"])


def _user_dict(u: User) -> dict:
    return {"id": u.id, "username": u.username, "role": u.role, "is_active": u.is_active, "created_at": u.created_at.isoformat()}


@router.post("/login")
def login(body: LoginRequest, db: Session = Depends(get_db)):
    user = db.execute(select(User).where(User.username == body.username)).scalar_one_or_none()
    if user is None or not user.is_active or not verify_password(body.password, user.password_hash):
        log_event(db, "auth", f"failed login for '{body.username}'", level="warning")
        db.commit()
        raise HTTPException(status_code=401, detail="Invalid username or password")
    token = create_access_token(str(user.id), user.role)
    log_event(db, "auth", f"user '{user.username}' logged in")
    db.commit()
    return {"access_token": token, "token_type": "bearer", "user": _user_dict(user)}


@router.get("/me")
def me(user: CurrentUser = Depends(get_current_user)):
    return {"id": user.id, "username": user.username, "role": user.role}


@router.post("/change-password")
def change_password(body: PasswordChange, user: CurrentUser = Depends(get_current_user), db: Session = Depends(get_db)):
    row = db.get(User, user.id)
    if row is None or not verify_password(body.current_password, row.password_hash):
        raise HTTPException(status_code=400, detail="Current password is incorrect")
    row.password_hash = hash_password(body.new_password)
    db.commit()
    return {"ok": True}


@router.get("/users")
def list_users(_: CurrentUser = Depends(require_role("admin")), db: Session = Depends(get_db)):
    return [_user_dict(u) for u in db.execute(select(User).order_by(User.id)).scalars()]


@router.post("/users", status_code=201)
def create_user(body: UserCreate, actor: CurrentUser = Depends(require_role("admin")), db: Session = Depends(get_db)):
    if db.execute(select(User).where(User.username == body.username)).scalar_one_or_none():
        raise HTTPException(status_code=409, detail="Username already exists")
    user = User(username=body.username, password_hash=hash_password(body.password), role=body.role)
    db.add(user)
    log_event(db, "auth", f"user '{body.username}' ({body.role}) created by {actor.username}")
    db.commit()
    return _user_dict(user)


@router.patch("/users/{user_id}")
def update_user(user_id: int, body: UserUpdate, actor: CurrentUser = Depends(require_role("admin")), db: Session = Depends(get_db)):
    user = db.get(User, user_id)
    if user is None:
        raise HTTPException(status_code=404, detail="User not found")
    if body.role is not None:
        if user.id == actor.id and body.role != "admin":
            raise HTTPException(status_code=400, detail="You cannot demote yourself")
        user.role = body.role
    if body.is_active is not None:
        if user.id == actor.id and not body.is_active:
            raise HTTPException(status_code=400, detail="You cannot deactivate yourself")
        user.is_active = body.is_active
    if body.password:
        user.password_hash = hash_password(body.password)
    db.commit()
    return _user_dict(user)
