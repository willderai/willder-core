"""The service key is compared in constant time (app/main.py `require_api_key`).

A QA finding: the bearer token was compared with `!=`, which returns at
the first differing byte, so response timing says how much of a guessed key is right.
These tests hold that the comparison goes through `hmac.compare_digest`, and that every
near miss (a prefix, an extension, one changed byte, a non-ASCII header) is a 401, never
a pass or a 500.
"""

import asyncio
import hmac

import pytest
from fastapi import HTTPException

from app import main
from conftest import API_KEY


def _check(authorization: str) -> None:
    asyncio.run(main.require_api_key(authorization))


def test_the_right_key_passes():
    _check(f"Bearer {API_KEY}")


@pytest.mark.parametrize(
    "token",
    [
        pytest.param("", id="empty"),
        pytest.param(API_KEY[:-1], id="prefix"),
        pytest.param(API_KEY + "4", id="extension"),
        pytest.param(API_KEY[:-1] + "x", id="last-byte"),
        pytest.param("x" + API_KEY[1:], id="first-byte"),
        pytest.param(API_KEY + "é", id="non-ascii"),
    ],
)
def test_a_near_miss_is_refused(token):
    with pytest.raises(HTTPException) as refused:
        _check(f"Bearer {token}")
    assert refused.value.status_code == 401


def test_the_comparison_is_constant_time(monkeypatch):
    seen = []
    real = hmac.compare_digest

    def spy(a, b):
        seen.append((a, b))
        return real(a, b)

    monkeypatch.setattr(main.hmac, "compare_digest", spy)
    _check(f"Bearer {API_KEY}")
    with pytest.raises(HTTPException):
        _check("Bearer wrong")
    assert len(seen) == 2, "require_api_key must compare the key with hmac.compare_digest"


def test_no_configured_key_refuses_everything(monkeypatch):
    monkeypatch.setattr(main.settings, "graphiti_service_api_key", "")
    with pytest.raises(HTTPException) as refused:
        _check("Bearer ")
    assert refused.value.status_code == 401


def test_a_non_ascii_header_is_a_401_through_the_app(client):
    # Starlette decodes header bytes as latin-1, so this reaches require_api_key as "é".
    r = client.post(
        "/search",
        json={"group_id": "org_1", "query": "pricing"},
        headers={"authorization": b"Bearer " + API_KEY.encode() + b"\xe9"},
    )
    assert r.status_code == 401
