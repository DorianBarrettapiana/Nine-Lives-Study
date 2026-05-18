"""Tests for /auth routes and the auth dependency."""

from fastapi.testclient import TestClient


def test_register_with_valid_invite_creates_user(client: TestClient):
    r = client.post(
        "/auth/register",
        json={"username": "alice", "password": "Hunter2!Hunter2!", "invite_code": "test-invite-code"},
    )
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["username"] == "alice"
    assert "password" not in body and "password_hash" not in body
    # Cookie should be set
    assert "nl_session" in r.cookies


def test_register_rejects_bad_invite(client: TestClient):
    r = client.post(
        "/auth/register",
        json={"username": "bob", "password": "Hunter2!Hunter2!", "invite_code": "wrong"},
    )
    assert r.status_code == 403


def test_register_rejects_short_password(client: TestClient):
    r = client.post(
        "/auth/register",
        json={"username": "bob", "password": "short", "invite_code": "test-invite-code"},
    )
    assert r.status_code == 422


def test_register_rejects_duplicate_username(client: TestClient):
    payload = {"username": "alice", "password": "Hunter2!Hunter2!", "invite_code": "test-invite-code"}
    assert client.post("/auth/register", json=payload).status_code == 201
    r2 = client.post("/auth/register", json=payload)
    assert r2.status_code == 409


def test_login_returns_user_and_sets_cookie(client: TestClient):
    client.post(
        "/auth/register",
        json={"username": "alice", "password": "Hunter2!Hunter2!", "invite_code": "test-invite-code"},
    )
    # Logout to clear cookie, then try login
    client.post("/auth/logout")
    r = client.post("/auth/login", json={"username": "alice", "password": "Hunter2!Hunter2!"})
    assert r.status_code == 200, r.text
    assert r.json()["username"] == "alice"
    assert "nl_session" in r.cookies


def test_login_wrong_password_returns_401(client: TestClient):
    client.post(
        "/auth/register",
        json={"username": "alice", "password": "Hunter2!Hunter2!", "invite_code": "test-invite-code"},
    )
    client.post("/auth/logout")
    r = client.post("/auth/login", json={"username": "alice", "password": "WrongPass123!"})
    assert r.status_code == 401


def test_login_unknown_user_returns_401(client: TestClient):
    r = client.post("/auth/login", json={"username": "ghost", "password": "anything12345"})
    assert r.status_code == 401


def test_me_requires_auth(client: TestClient):
    r = client.get("/auth/me")
    assert r.status_code == 401


def test_me_returns_current_user(auth_client: TestClient):
    r = auth_client.get("/auth/me")
    assert r.status_code == 200
    assert r.json()["username"] == "tester"


def test_logout_clears_session(auth_client: TestClient):
    assert auth_client.get("/auth/me").status_code == 200
    r = auth_client.post("/auth/logout")
    assert r.status_code == 204
    # After logout the cookie is cleared on the client; /auth/me should 401
    assert auth_client.get("/auth/me").status_code == 401


def test_password_change_works(auth_client: TestClient):
    r = auth_client.post(
        "/auth/password",
        json={"current_password": "Hunter2!Hunter2!", "new_password": "NewPassword456!"},
    )
    assert r.status_code == 204
    # Logout and re-login with new password
    auth_client.post("/auth/logout")
    r = auth_client.post("/auth/login", json={"username": "tester", "password": "NewPassword456!"})
    assert r.status_code == 200


def test_password_change_rejects_wrong_current(auth_client: TestClient):
    r = auth_client.post(
        "/auth/password",
        json={"current_password": "Wrong!Wrong!", "new_password": "NewPassword456!"},
    )
    assert r.status_code == 403
