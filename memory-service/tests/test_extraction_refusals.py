"""A model-provider refusal on /ingest: a named, retryable 503, and /health says so.

On 2026-10-16 the extraction model's provider answered every call with 429
insufficient_quota (project_spend_limit_exceeded). Graphiti retried each one for about
45 s and the service then answered a bare 500, while /health said "ok". The provider's
429 is built here by the real OpenAI SDK from the body the provider sent, so the shape
under test is the one production saw.
"""

import asyncio
import json
from types import SimpleNamespace

import httpx
import openai
import pytest
from graphiti_core.llm_client import LLMConfig
from graphiti_core.llm_client.client import is_server_or_retry_error
from graphiti_core.llm_client.errors import RateLimitError as GraphitiRateLimitError
from graphiti_core.prompts.models import Message

from app import main
from app.extraction_status import (
    DEGRADED_WINDOW_S,
    ExtractionQuotaExhausted,
    ExtractionStatus,
    refusal_kind,
)
from app.graphiti_client import ModelProviderClient, QuotaAwareLLMClient

PROJECT_ID = "proj_TESTPROJECT0000000000"
SPEND_LIMIT_BODY = {
    "error": {
        "message": (
            "Your project has reached its configured enforced spend limit. Update your limit at "
            f"https://platform.openai.com/settings/{PROJECT_ID}/limits."
        ),
        "type": "insufficient_quota",
        "param": None,
        "code": "project_spend_limit_exceeded",
    }
}
INSUFFICIENT_QUOTA_BODY = {
    "error": {
        "message": "You exceeded your current quota, please check your plan and billing details.",
        "type": "insufficient_quota",
        "param": None,
        "code": "insufficient_quota",
    }
}
# The same refusal with only its type set, as older API responses carried it.
QUOTA_TYPE_ONLY_BODY = {
    "error": {
        "message": "You exceeded your current quota.",
        "type": "insufficient_quota",
        "param": None,
        "code": None,
    }
}
# A quota refusal with only its code set, as OpenAI-compatible providers may send it.
QUOTA_CODE_ONLY_BODY = {
    "error": {
        "message": "Quota exceeded.",
        "type": None,
        "param": None,
        "code": "insufficient_quota",
    }
}
RATE_LIMIT_BODY = {
    "error": {
        "message": "Rate limit reached for gpt-4o-mini on requests per min (RPM): Limit 500.",
        "type": "requests",
        "param": None,
        "code": "rate_limit_exceeded",
    }
}


def _provider(body: dict, calls: list | None = None) -> openai.AsyncOpenAI:
    """An OpenAI SDK client whose every call is answered 429 with `body`, no SDK retries."""

    def handler(request: httpx.Request) -> httpx.Response:
        if calls is not None:
            calls.append(request)
        return httpx.Response(429, json=body)

    return openai.AsyncOpenAI(
        api_key="sk-test",
        base_url="https://api.openai.test/v1",
        max_retries=0,
        http_client=httpx.AsyncClient(transport=httpx.MockTransport(handler)),
    )


def _provider_error(body: dict) -> openai.RateLimitError:
    """The exception the SDK raises for a 429 carrying `body`."""
    call = _provider(body).chat.completions.create(
        model="m", messages=[{"role": "user", "content": "x"}]
    )
    with pytest.raises(openai.RateLimitError) as caught:
        asyncio.run(call)
    return caught.value


def _production_client(responses: list, calls: list) -> QuotaAwareLLMClient:
    """The client as _build_graphiti builds it, SDK retry settings included, with only the
    transport swapped: each call is answered by the next of `responses` (the last repeats)."""

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        status, body = responses[min(len(calls), len(responses)) - 1]
        return httpx.Response(status, json=body)

    provider = ModelProviderClient(
        api_key="sk-test",
        base_url="https://api.openai.test/v1",
        http_client=httpx.AsyncClient(transport=httpx.MockTransport(handler)),
    )
    return QuotaAwareLLMClient(
        LLMConfig(api_key="sk-test", model="m", small_model="m"), max_tokens=64, client=provider
    )


def _client(body: dict, calls: list) -> QuotaAwareLLMClient:
    return _production_client([(429, body)], calls)


def _raising(fake_graphiti, monkeypatch, exc: BaseException):
    async def _add_episode(**kwargs):
        raise exc

    monkeypatch.setattr(fake_graphiti, "add_episode", _add_episode)


def _graphiti_wrapped(provider_error: openai.RateLimitError) -> GraphitiRateLimitError:
    """The provider's error the way Graphiti re-raises it: its RateLimitError, from the original."""
    try:
        raise GraphitiRateLimitError() from provider_error
    except GraphitiRateLimitError as wrapped:
        return wrapped


def _quota_exhausted(provider_error: openai.RateLimitError) -> ExtractionQuotaExhausted:
    try:
        raise ExtractionQuotaExhausted() from provider_error
    except ExtractionQuotaExhausted as exc:
        return exc


INGEST = {"group_id": "org_1", "content": "Acme renewed at $40k.", "actor_id": "agent-1"}


# --- the LLM client: a quota refusal is not retried, a rate limit still is ----------------


@pytest.mark.parametrize(
    "body",
    [SPEND_LIMIT_BODY, INSUFFICIENT_QUOTA_BODY, QUOTA_TYPE_ONLY_BODY, QUOTA_CODE_ONLY_BODY],
    ids=["spend-limit", "insufficient-quota", "type-only", "code-only"],
)
def test_a_quota_refusal_fails_on_the_first_call_without_graphitis_retries(body):
    calls: list = []
    with pytest.raises(ExtractionQuotaExhausted) as caught:
        asyncio.run(
            _client(body, calls).generate_response(
                [Message(role="system", content="s"), Message(role="user", content="u")]
            )
        )
    assert len(calls) == 1
    assert isinstance(caught.value.__cause__, openai.RateLimitError)
    assert not is_server_or_retry_error(caught.value)


def test_a_plain_rate_limit_stays_a_graphiti_rate_limit_that_graphiti_retries():
    calls: list = []
    with pytest.raises(GraphitiRateLimitError) as caught:
        asyncio.run(
            _client(RATE_LIMIT_BODY, calls)._generate_response([Message(role="user", content="u")])
        )
    assert len(calls) == 1
    assert is_server_or_retry_error(caught.value)


def test_the_provider_client_still_retries_a_server_error_itself(monkeypatch):
    monkeypatch.setattr(ModelProviderClient, "_calculate_retry_timeout", lambda *a, **k: 0)
    calls: list = []
    ok = {
        "id": "x",
        "object": "chat.completion",
        "created": 0,
        "model": "m",
        "choices": [
            {"index": 0, "finish_reason": "stop", "message": {"role": "assistant", "content": "{}"}}
        ],
    }
    result = asyncio.run(
        _production_client(
            [(500, {"error": {"message": "boom"}}), (200, ok)], calls
        )._generate_response([Message(role="user", content="u")])
    )
    assert result == {}
    assert len(calls) == 2


# --- classifying the error, wherever it surfaces ------------------------------------------


def test_refusal_kind_reads_the_provider_error_on_every_form_it_arrives_in():
    spend = _provider_error(SPEND_LIMIT_BODY)
    quota = _provider_error(INSUFFICIENT_QUOTA_BODY)
    rate = _provider_error(RATE_LIMIT_BODY)
    assert refusal_kind(spend) == "quota"
    assert refusal_kind(quota) == "quota"
    assert refusal_kind(_graphiti_wrapped(spend)) == "quota"
    assert refusal_kind(_quota_exhausted(spend)) == "quota"
    assert refusal_kind(ExtractionQuotaExhausted()) == "quota"
    assert refusal_kind(rate) == "rate_limit"
    assert refusal_kind(_graphiti_wrapped(rate)) == "rate_limit"
    assert refusal_kind(GraphitiRateLimitError()) == "rate_limit"
    assert refusal_kind(RuntimeError("boom")) is None


def _status_error(status: int, body: dict) -> openai.APIStatusError:
    call = _provider_with_status(status, body).chat.completions.create(
        model="m", messages=[{"role": "user", "content": "x"}]
    )
    with pytest.raises(openai.APIStatusError) as caught:
        asyncio.run(call)
    return caught.value


def _provider_with_status(status: int, body: dict) -> openai.AsyncOpenAI:
    return openai.AsyncOpenAI(
        api_key="sk-test",
        base_url="https://api.openai.test/v1",
        max_retries=0,
        http_client=httpx.AsyncClient(
            transport=httpx.MockTransport(lambda r: httpx.Response(status, json=body))
        ),
    )


def test_quota_refusals_on_other_statuses_are_quota_too():
    credits = {"error": {"message": "Insufficient credits", "code": 402}}
    forbidden = {
        "error": {
            "message": "Quota exceeded",
            "type": "insufficient_quota",
            "code": "insufficient_quota",
        }
    }
    assert refusal_kind(_status_error(402, credits)) == "quota"
    assert refusal_kind(_status_error(403, forbidden)) == "quota"
    assert (
        refusal_kind(_status_error(403, {"error": {"message": "no access", "code": "forbidden"}}))
        is None
    )
    assert refusal_kind(_status_error(500, {"error": {"message": "boom"}})) is None


# --- /ingest and /ingest-bulk ---------------------------------------------------------------


@pytest.mark.parametrize("form", ["sdk", "graphiti-wrapped", "fail-fast"])
def test_ingest_answers_a_named_503_for_a_used_up_quota_never_500(
    client, headers, fake_graphiti, monkeypatch, form
):
    spend = _provider_error(SPEND_LIMIT_BODY)
    exc = {
        "sdk": spend,
        "graphiti-wrapped": _graphiti_wrapped(spend),
        "fail-fast": _quota_exhausted(spend),
    }[form]
    _raising(fake_graphiti, monkeypatch, exc)

    r = client.post("/ingest", json=INGEST, headers=headers)

    assert r.status_code == 503
    assert r.headers["retry-after"] == "300"
    detail = r.json()["detail"]
    assert "quota or spend limit is used up" in detail
    assert detail.startswith("graph extraction unavailable")
    assert (
        PROJECT_ID not in r.text and "sk-test" not in r.text and "platform.openai.com" not in r.text
    )


def test_ingest_answers_a_retryable_503_for_a_plain_rate_limit(
    client, headers, fake_graphiti, monkeypatch
):
    _raising(fake_graphiti, monkeypatch, _graphiti_wrapped(_provider_error(RATE_LIMIT_BODY)))

    r = client.post("/ingest", json=INGEST, headers=headers)

    assert r.status_code == 503
    assert r.headers["retry-after"] == "30"
    assert r.json()["detail"].startswith("graph extraction rate-limited")


def test_ingest_bulk_answers_the_same_503(client, headers, fake_graphiti, monkeypatch):
    spend = _provider_error(SPEND_LIMIT_BODY)

    async def _bulk(**kwargs):
        raise _graphiti_wrapped(spend)

    monkeypatch.setattr(fake_graphiti, "add_episode_bulk", _bulk, raising=False)
    body = {"group_id": "org_1", "episodes": [INGEST]}

    r = client.post("/ingest-bulk", json=body, headers=headers)

    assert r.status_code == 503
    assert r.headers["retry-after"] == "300"
    assert PROJECT_ID not in r.text


def test_any_other_ingest_failure_still_raises(
    client, headers, fake_graphiti, monkeypatch, _fresh_status
):
    _raising(fake_graphiti, monkeypatch, RuntimeError("extractor bug"))
    with pytest.raises(RuntimeError):
        client.post("/ingest", json=INGEST, headers=headers)
    assert _fresh_status.snapshot()["status"] == "unknown"


# --- /health ---------------------------------------------------------------------------------


def test_health_reports_extraction_degraded_after_a_refusal_and_ok_after_a_success(
    client, headers, fake_graphiti, monkeypatch
):
    assert client.get("/health").json()["extraction"]["status"] == "unknown"

    original = fake_graphiti.add_episode
    _raising(fake_graphiti, monkeypatch, _graphiti_wrapped(_provider_error(SPEND_LIMIT_BODY)))
    client.post("/ingest", json=INGEST, headers=headers)

    body = client.get("/health").json()
    assert body["status"] == "degraded"
    assert body["neo4j"] is True
    assert body["extraction"]["status"] == "degraded"
    assert body["extraction"]["reason"] == "model_quota_exhausted"
    assert "quota or spend limit" in body["extraction"]["detail"]
    assert PROJECT_ID not in json.dumps(body)

    monkeypatch.setattr(fake_graphiti, "add_episode", original)
    assert client.post("/ingest", json=INGEST, headers=headers).status_code == 200

    body = client.get("/health").json()
    assert body["status"] == "ok"
    assert body["extraction"] == {"status": "ok", "reason": None, "detail": None}


def test_a_refusal_older_than_the_window_reads_unknown_not_degraded():
    now = [1000.0]
    status = ExtractionStatus(clock=lambda: now[0], wall_clock=lambda: 1_792_000_000.0)
    status.record_failure("quota")
    now[0] += DEGRADED_WINDOW_S
    assert status.snapshot()["status"] == "degraded"
    now[0] += 1
    snap = status.snapshot()
    assert snap["status"] == "unknown"
    assert snap["reason"] == "model_quota_exhausted"


def test_health_is_degraded_when_neo4j_is_down_whatever_extraction_says(
    client, monkeypatch, _fresh_status
):
    async def _down():
        return False

    monkeypatch.setattr(main, "neo4j_healthy", _down)
    _fresh_status.record_success()
    body = client.get("/health").json()
    assert body["status"] == "degraded"
    assert body["extraction"]["status"] == "ok"


# --- /extract: the same refusal, without the provider's message -----------------------------


def test_file_extraction_answers_503_without_the_provider_message(client, headers, monkeypatch):
    spend = _provider_error(SPEND_LIMIT_BODY)

    class _RefusingOpenAI:
        def __init__(self, **kwargs):
            self.chat = SimpleNamespace(completions=SimpleNamespace(create=self._create))

        def _create(self, **kwargs):
            raise spend

    import app.extractor as extractor

    monkeypatch.setattr(extractor, "OpenAI", _RefusingOpenAI)
    r = client.post(
        "/extract-bytes",
        json={"content_b64": "aGk=", "file_type": "image", "filename": "a.png"},
        headers=headers,
    )
    assert r.status_code == 503
    assert r.json()["detail"].startswith("file extraction unavailable")
    assert PROJECT_ID not in r.text
