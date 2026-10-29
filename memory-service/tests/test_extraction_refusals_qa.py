"""Provider errors that are not refusals, and
what reaches the caller and the service's own log.

The PR's rule (app/extraction_status.py): a refusal is reported by its kind, never with the
provider's message, which names the account's project id. These cases check the edges of
that rule against the exact error bodies OpenAI sends, raised by the real SDK:
  - a 403 that names the project but is not a quota refusal is not reported as one, and
    the caller's response still carries neither the project id nor the key;
  - a 401 naming part of the key stays out of the response the same way;
  - a quota refusal writes no provider text to the service's log, at any level.
"""

import logging

import httpx
import openai
import pytest
from fastapi.testclient import TestClient

from app import main
from tests.test_extraction_refusals import INGEST, PROJECT_ID, SPEND_LIMIT_BODY, _raising

MODEL_ACCESS_403 = {
    "error": {
        "message": f"Project `{PROJECT_ID}` does not have access to model `gpt-4o-mini`",
        "type": "invalid_request_error",
        "param": None,
        "code": "model_not_found",
    }
}
BAD_KEY_401 = {
    "error": {
        "message": "Incorrect API key provided: sk-proj-********************SECRET. You can find your API key at https://platform.openai.com/account/api-keys.",
        "type": "invalid_request_error",
        "param": None,
        "code": "invalid_api_key",
    }
}


def _sdk_error(status: int, body: dict) -> openai.APIStatusError:
    client = openai.OpenAI(
        api_key="sk-test",
        base_url="https://api.openai.test/v1",
        max_retries=0,
        http_client=httpx.Client(
            transport=httpx.MockTransport(lambda r: httpx.Response(status, json=body))
        ),
    )
    with pytest.raises(openai.APIStatusError) as caught:
        client.chat.completions.create(model="m", messages=[{"role": "user", "content": "x"}])
    return caught.value


@pytest.fixture
def server_errors_as_responses():
    return TestClient(main.app, raise_server_exceptions=False)


@pytest.mark.parametrize(
    "status,body,leak",
    [(403, MODEL_ACCESS_403, PROJECT_ID), (401, BAD_KEY_401, "SECRET")],
    ids=["403-model-access", "401-bad-key"],
)
def test_a_provider_error_that_is_not_a_refusal_is_not_reported_as_one_and_names_nothing(
    server_errors_as_responses,
    headers,
    fake_graphiti,
    monkeypatch,
    _fresh_status,
    status,
    body,
    leak,
):
    _raising(fake_graphiti, monkeypatch, _sdk_error(status, body))

    r = server_errors_as_responses.post("/ingest", json=INGEST, headers=headers)

    assert r.status_code == 500
    assert leak not in r.text and "platform.openai.com" not in r.text
    assert _fresh_status.snapshot()["status"] == "unknown"


def test_a_quota_refusal_logs_no_provider_text(client, headers, fake_graphiti, monkeypatch, caplog):
    from tests.test_extraction_refusals import _provider_error

    _raising(fake_graphiti, monkeypatch, _provider_error(SPEND_LIMIT_BODY))
    with caplog.at_level(logging.DEBUG):
        r = client.post("/ingest", json=INGEST, headers=headers)

    assert r.status_code == 503
    logged = "\n".join(
        rec.getMessage() + (str(rec.exc_info[1]) if rec.exc_info else "") for rec in caplog.records
    )
    assert PROJECT_ID not in logged and "platform.openai.com" not in logged


def test_a_403_carrying_a_quota_code_is_a_quota_refusal(
    client, headers, fake_graphiti, monkeypatch
):
    body = {"error": {**SPEND_LIMIT_BODY["error"]}}
    _raising(fake_graphiti, monkeypatch, _sdk_error(403, body))

    r = client.post("/ingest", json=INGEST, headers=headers)

    assert r.status_code == 503 and r.headers["retry-after"] == "300"
    assert PROJECT_ID not in r.text
