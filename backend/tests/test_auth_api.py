"""Authentication, roles and public-read behaviour."""
from __future__ import annotations

import jwt

from tests.conftest import create_user, login


def test_login_and_me(client):
    r = client.post("/api/auth/login", json={"username": "admin", "password": "admin12345"})
    assert r.status_code == 200
    body = r.json()
    assert body["token_type"] == "bearer"
    assert body["user"]["role"] == "admin"
    me = client.get("/api/auth/me", headers={"Authorization": f"Bearer {body['access_token']}"})
    assert me.status_code == 200 and me.json()["username"] == "admin"


def test_login_rejects_bad_password_and_unknown_user(client):
    assert client.post("/api/auth/login", json={"username": "admin", "password": "wrong-password"}).status_code == 401
    assert client.post("/api/auth/login", json={"username": "nobody", "password": "whatever123"}).status_code == 401
    # validation of the request body itself
    assert client.post("/api/auth/login", json={"username": "a", "password": ""}).status_code == 422


def test_me_requires_valid_token(client):
    assert client.get("/api/auth/me").status_code == 401
    assert client.get("/api/auth/me", headers={"Authorization": "Bearer not-a-jwt"}).status_code == 401
    forged = jwt.encode({"sub": "admin", "role": "admin"}, "some-other-secret", algorithm="HS256")
    assert client.get("/api/auth/me", headers={"Authorization": f"Bearer {forged}"}).status_code == 401


def test_public_read_allows_dashboards_but_not_mutations(client):
    assert client.get("/api/system/status").status_code == 200
    assert client.get("/api/devices").status_code == 200
    assert client.get("/api/alerts").status_code == 200
    # mutations always need a token
    assert client.post("/api/control/myco-esp32-01/mode", json={"mode": "auto"}).status_code == 401
    assert client.post("/api/batches", json={"name": "x", "species": "y"}).status_code == 401
    assert client.patch("/api/settings/alerts", json={"value": {}}).status_code == 401


def test_role_matrix(client, admin, operator, viewer):
    # viewer: read only
    assert client.post("/api/control/myco-esp32-01/mode", json={"mode": "monitor"}, headers=viewer).status_code == 403
    assert client.post("/api/batches", json={"name": "B", "species": "Pleurotus ostreatus"}, headers=viewer).status_code == 403
    # operator: can run cultivation + control, cannot administer
    assert client.post("/api/control/myco-esp32-01/mode", json={"mode": "monitor"}, headers=operator).status_code == 200
    assert client.post("/api/devices", json={"id": "esp32-x", "name": "x"}, headers=operator).status_code == 403
    assert client.get("/api/auth/users", headers=operator).status_code == 403
    assert client.patch("/api/settings/alerts", json={"value": {"cooldown_seconds": 300}}, headers=operator).status_code == 403
    assert client.post("/api/ai/diagnostics", headers=operator).status_code == 403
    # admin: everything
    assert client.get("/api/auth/users", headers=admin).status_code == 200
    assert client.patch("/api/settings/alerts", json={"value": {"cooldown_seconds": 300}}, headers=admin).status_code == 200


def test_user_management(client, admin):
    r = client.post("/api/auth/users", json={"username": "grower", "password": "short", "role": "operator"}, headers=admin)
    assert r.status_code == 422  # password policy
    r = client.post("/api/auth/users", json={"username": "grower", "password": "longenough1", "role": "operator"}, headers=admin)
    assert r.status_code == 201
    uid = r.json()["id"]
    assert client.post("/api/auth/users", json={"username": "grower", "password": "longenough1", "role": "operator"}, headers=admin).status_code == 409
    headers = login(client, "grower", "longenough1")
    # deactivate -> token no longer accepted
    assert client.patch(f"/api/auth/users/{uid}", json={"is_active": False}, headers=admin).status_code == 200
    assert client.get("/api/auth/me", headers=headers).status_code == 401
    assert client.post("/api/auth/login", json={"username": "grower", "password": "longenough1"}).status_code == 401
    # admin cannot demote / deactivate themselves
    me = client.get("/api/auth/me", headers=admin).json()
    assert client.patch(f"/api/auth/users/{me['id']}", json={"role": "viewer"}, headers=admin).status_code in (400, 409, 422)


def test_change_password_flow(client, admin):
    headers = create_user(client, admin, "pwuser", "viewer", password="initialpass1")
    r = client.post("/api/auth/change-password", json={"current_password": "wrong", "new_password": "anothergood1"}, headers=headers)
    assert r.status_code in (400, 401, 403)
    r = client.post("/api/auth/change-password", json={"current_password": "initialpass1", "new_password": "anothergood1"}, headers=headers)
    assert r.status_code == 200
    assert client.post("/api/auth/login", json={"username": "pwuser", "password": "initialpass1"}).status_code == 401
    assert client.post("/api/auth/login", json={"username": "pwuser", "password": "anothergood1"}).status_code == 200


def test_passwords_are_hashed(db, client):
    from sqlalchemy import select
    from app.db.models import User

    user = db.execute(select(User).where(User.username == "admin")).scalar_one()
    assert "admin12345" not in user.password_hash
    assert user.password_hash.startswith("pbkdf2")
