"""Tests for the Vercel Blob download path in extract_file/_download.

Uploaded source documents use Blob access:'private', not 'public': a public,
guessable (org id + filename), permanent URL to every uploaded source document
would otherwise be reachable by anyone with the link, no auth, no expiry, no
revocation. A private Blob rejects a bare unauthenticated GET, so _download
sends the store's BLOB_READ_WRITE_TOKEN as a Bearer header, exactly what
@vercel/blob's own `get()` helper does for a private blob (confirmed by
reading the installed 2.4.0 package's dist/index.js — there is no other
private-access protocol to satisfy, a plain Authorization header is the whole
mechanism).

Also pins two invariants: (1) the token must never be attached to a URL that
isn't actually a Vercel Blob store URL — /extract's `url` is caller-supplied
and otherwise unconstrained behind only a shared service API key, so a naive
"always attach the token" would let any client holding that key steal the
store-wide credential by pointing /extract at its own server; (2) a
Blob-store URL reaching _download with no token configured is always a
deployment misconfiguration (every production caller uploads with
access:'private'), so it fails fast with a clear reason instead of a
confusing 403 discovered later.
"""

import httpx
import pytest

from app.extractor import _download, extract_file

BLOB_URL = "https://storeid123.public.blob.vercel-storage.com/memory/org_1/contract.pdf"
NOT_A_BLOB_URL = "https://attacker.example.com/steal-my-token"


def _install_mock_transport(monkeypatch, handler):
    """_download builds its own httpx.Client() internally (no injectable transport
    param), so route every httpx.Client(...) construction in this test through a
    MockTransport instead of hitting the network."""
    original_client = httpx.Client

    def _fake_client(*args, **kwargs):
        kwargs["transport"] = httpx.MockTransport(handler)
        return original_client(*args, **kwargs)

    monkeypatch.setattr(httpx, "Client", _fake_client)


def test_download_sends_bearer_token_to_a_real_blob_url(monkeypatch):
    captured = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["authorization"] = request.headers.get("authorization")
        return httpx.Response(200, content=b"file-bytes")

    _install_mock_transport(monkeypatch, handler)

    content = _download(BLOB_URL, "rw_token_abc")

    assert content == b"file-bytes"
    assert captured["authorization"] == "Bearer rw_token_abc"


def test_download_never_attaches_the_token_to_a_non_blob_url(monkeypatch):
    """/extract's url is caller-supplied and otherwise unconstrained (only a
    shared service API key gates the endpoint), so a client holding that key
    could point /extract at its own server and, if the token were attached
    unconditionally, walk away with the store-wide read-write credential.
    The host check must hold even when a token IS configured."""
    captured = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["authorization"] = request.headers.get("authorization")
        return httpx.Response(200, content=b"whatever the attacker's server sends back")

    _install_mock_transport(monkeypatch, handler)

    content = _download(NOT_A_BLOB_URL, "rw_token_abc")

    assert content == b"whatever the attacker's server sends back"
    assert captured["authorization"] is None


def test_download_of_a_non_blob_url_works_unauthenticated_with_no_token_either(monkeypatch):
    """Not every _download call needs a token to begin with — only a genuine Blob
    store URL requires (and may fail-fast without) one."""
    captured = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["authorization"] = request.headers.get("authorization")
        return httpx.Response(200, content=b"file-bytes")

    _install_mock_transport(monkeypatch, handler)

    content = _download(NOT_A_BLOB_URL)

    assert content == b"file-bytes"
    assert captured["authorization"] is None


def test_download_fails_fast_on_a_blob_url_with_no_token_configured(monkeypatch):
    """Every production caller uploads with access:'private', so a real Blob
    URL reaching here with no BLOB_READ_WRITE_TOKEN configured is always a
    deployment misconfiguration (Node has the token, this service doesn't) —
    this must raise immediately with a clear reason, not attempt the request
    and surface Vercel's own 403 as an opaque extraction failure."""
    calls = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        if request.headers.get("authorization") != "Bearer rw_token_abc":
            return httpx.Response(403, content=b"Forbidden")
        return httpx.Response(200, content=b"file-bytes")

    _install_mock_transport(monkeypatch, handler)

    with pytest.raises(RuntimeError, match="BLOB_READ_WRITE_TOKEN"):
        _download(BLOB_URL)

    assert calls == []  # never even made the doomed request

    # Same URL, token supplied this time: proves the RuntimeError above was really
    # about the missing token, not the mock transport or the URL itself.
    content = _download(BLOB_URL, "rw_token_abc")
    assert content == b"file-bytes"
    assert len(calls) == 1


def test_extract_file_threads_the_blob_token_through_to_download(monkeypatch):
    """extract_file's own contract: the new blob_token parameter actually reaches
    _download, it isn't just accepted and dropped on the floor."""
    calls: list[tuple[str, str]] = []

    def fake_download(url: str, blob_token: str = "") -> bytes:
        calls.append((url, blob_token))
        return b"%PDF-1.4 fake"

    monkeypatch.setattr("app.extractor._download", fake_download)
    monkeypatch.setattr("app.extractor.extract_bytes", lambda *a, **k: ["chunk"])

    chunks = extract_file(BLOB_URL, "pdf", "contract.pdf", "sk-test", "rw_token_abc")

    assert chunks == ["chunk"]
    assert calls == [(BLOB_URL, "rw_token_abc")]
