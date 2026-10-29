"""The credential-boundary cases _download's own host check cannot cover,
because they are decided by httpx rather than by our code.

test_extractor.py pins the host check on the URL as submitted: the Bearer
token is attached to a *.blob.vercel-storage.com URL and withheld from
anything else. That closes the direct half of the credential boundary.

It does not close the redirect half: redirect destinations must not be able
to cross the trusted origin and still receive credentials, and _download
still runs with follow_redirects=True. So a URL that passes the host check on
submission can still be answered with a 307 to an attacker host, and the
question of whether the Authorization header travels with it is decided
entirely inside httpx.

Empirically, on the installed httpx 0.28.1, it does not: httpx rebuilds the
request across a cross-origin redirect and drops Authorization. The code is
therefore correct today — but correct by a transitive library's behavior that no
test in this repo asserts and no comment in extractor.py mentions. An httpx
upgrade that changed or regressed that stripping would hand the store-wide
read-write credential to whoever controls the redirect target, silently, with
every other test in the suite still green.

That is the same class as lib/blob-access-invariant.test.ts on the Node side:
a security property that currently holds for a reason outside the diff, pinned
so that it fails loudly if the reason stops holding.
"""

import httpx
import pytest

from app.extractor import _download

BLOB_URL = "https://store123.private.blob.vercel-storage.com/memory/org_1/contract.pdf"
TOKEN = "vercel_blob_rw_STORE_SECRET"


def _install_mock_transport(monkeypatch, handler):
    """_download constructs its own httpx.Client() with no injectable transport,
    so patch the constructor (same approach as test_extractor.py)."""
    original_client = httpx.Client

    def _fake_client(*args, **kwargs):
        kwargs["transport"] = httpx.MockTransport(handler)
        return original_client(*args, **kwargs)

    monkeypatch.setattr(httpx, "Client", _fake_client)


def test_the_token_does_not_follow_a_redirect_off_the_blob_host(monkeypatch):
    """The exfiltration path the host check alone does not close: submit a URL
    that legitimately passes the check, then redirect off-host and see whether
    the credential comes along."""
    seen: list[tuple[str, str | None]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append((request.url.host, request.headers.get("authorization")))
        if request.url.host.endswith(".blob.vercel-storage.com"):
            return httpx.Response(307, headers={"location": "https://attacker.example/collect"})
        return httpx.Response(200, content=b"attacker response")

    _install_mock_transport(monkeypatch, handler)

    _download(BLOB_URL, TOKEN)

    # The redirect was actually followed — otherwise this test proves nothing.
    assert [host for host, _ in seen] == [
        "store123.private.blob.vercel-storage.com",
        "attacker.example",
    ]

    first_hop_auth = seen[0][1]
    redirect_target_auth = seen[1][1]

    assert first_hop_auth == f"Bearer {TOKEN}"
    # The whole point. If this ever fails, the Blob store's read-write credential
    # is being handed to whoever controls the redirect, and _download must set
    # follow_redirects=False (or re-check the host on each hop) rather than rely
    # on httpx to strip it.
    assert redirect_target_auth is None


def test_a_same_host_redirect_still_carries_the_token(monkeypatch):
    """The complementary case, so the assertion above is understood as
    'stripped when crossing origin', not 'never sent on any redirect'. Vercel
    Blob does redirect within its own infrastructure, and extraction would break
    if the token were dropped on those hops."""
    seen: list[tuple[str, str | None]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append((request.url.host, request.headers.get("authorization")))
        if request.url.path == "/memory/org_1/contract.pdf":
            return httpx.Response(
                307,
                headers={"location": "https://store123.private.blob.vercel-storage.com/redirected"},
            )
        return httpx.Response(200, content=b"file-bytes")

    _install_mock_transport(monkeypatch, handler)

    assert _download(BLOB_URL, TOKEN) == b"file-bytes"
    assert len(seen) == 2
    assert seen[1][1] == f"Bearer {TOKEN}"


@pytest.mark.parametrize(
    "hostile_url",
    [
        # Suffix-confusion: the trusted string appears, but as a prefix of the
        # attacker's own domain. The leading dot in the constant is what stops it.
        "https://store.blob.vercel-storage.com.attacker.example/f",
        # The trusted string in a path, query or fragment rather than the host.
        "https://attacker.example/x.blob.vercel-storage.com",
        "https://attacker.example/f?x=.blob.vercel-storage.com",
        "https://attacker.example/f#.blob.vercel-storage.com",
        # userinfo before the real host — the classic urlparse confusion.
        "https://store.private.blob.vercel-storage.com@attacker.example/f",
        # Sibling domain that shares the registrable suffix but not the subdomain.
        "https://evilblob.vercel-storage.com/f",
    ],
)
def test_the_token_is_withheld_from_hostnames_that_only_look_like_blob_urls(
    monkeypatch, hostile_url
):
    """Pins the host check against the standard near-miss set, so a future
    refactor to a looser test (`in` instead of `endswith`, a regex without an
    anchor, dropping the leading dot) fails here rather than in production."""
    captured = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["authorization"] = request.headers.get("authorization")
        return httpx.Response(200, content=b"attacker response")

    _install_mock_transport(monkeypatch, handler)

    _download(hostile_url, TOKEN)

    # Assert on the credential, not on the header's absence. The userinfo case
    # (`https://host@attacker/`) makes httpx synthesize its OWN `Basic ...` header
    # from the userinfo, so "no Authorization header at all" is the wrong property
    # to pin — what must never happen is the Blob token reaching this host.
    assert TOKEN not in (captured["authorization"] or "")
