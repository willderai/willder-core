"""OPENAI_EXTRACT_EXTRA_BODY in the memory service: Graphiti's extraction requests carry it.

The Node half (lib/llm-extract-options.ts, lib/llm-extract-options.test.ts) parses the same
variable by the same rule: a JSON object of sampling fields, never one that replaces the
request's model, messages, tools, streaming or response format. A reasoning model on a local
OpenAI-compatible server (qwen3 on Ollama) thinks for minutes per call unless the request
says otherwise, e.g. {"reasoning_effort": "none"}; unset, every request is what it was.
"""

import asyncio
import json

import httpx
import pytest
from graphiti_core.llm_client import LLMConfig
from graphiti_core.prompts.models import Message
from pydantic import ValidationError

from app import graphiti_client
from app.config import RESERVED_EXTRACT_FIELDS, Settings, parse_extract_extra_body
from app.graphiti_client import ModelProviderClient, QuotaAwareLLMClient

OK = {
    "id": "x",
    "object": "chat.completion",
    "created": 0,
    "model": "m",
    "choices": [
        {"index": 0, "finish_reason": "stop", "message": {"role": "assistant", "content": "{}"}}
    ],
}


def _extract(extra_body: dict | None) -> dict:
    """Send one extraction call through the production client pair; return the request body."""
    bodies: list = []

    def handler(request: httpx.Request) -> httpx.Response:
        bodies.append(json.loads(request.content))
        return httpx.Response(200, json=OK)

    kwargs = {} if extra_body is None else {"extra_body": extra_body}
    provider = ModelProviderClient(
        api_key="sk-test",
        base_url="https://api.openai.test/v1",
        http_client=httpx.AsyncClient(transport=httpx.MockTransport(handler)),
        **kwargs,
    )
    llm = QuotaAwareLLMClient(
        LLMConfig(api_key="sk-test", model="m", small_model="m", temperature=0),
        max_tokens=64,
        client=provider,
    )
    asyncio.run(llm._generate_response([Message(role="user", content="u")]))
    assert len(bodies) == 1
    return bodies[0]


def test_an_unset_value_leaves_the_request_as_it_was():
    plain = _extract(None)
    assert _extract({}) == plain
    assert "reasoning_effort" not in plain
    assert set(plain) == {"model", "messages", "temperature", "max_tokens", "response_format"}


def test_the_request_carries_the_fields_and_they_win_over_its_sampling_fields():
    body = _extract({"reasoning_effort": "none", "temperature": 0.3})
    assert body["reasoning_effort"] == "none"
    assert body["temperature"] == 0.3
    assert body["model"] == "m"
    assert body["messages"] == [{"role": "user", "content": "u"}]
    assert body["response_format"] == _extract(None)["response_format"]


@pytest.mark.parametrize("raw", [None, "", "   "])
def test_parse_adds_nothing_when_unset(raw):
    assert parse_extract_extra_body(raw) == {}


def test_parse_returns_the_objects_fields():
    assert parse_extract_extra_body(' {"reasoning_effort":"none","think":false} ') == {
        "reasoning_effort": "none",
        "think": False,
    }


@pytest.mark.parametrize(
    "raw,problem",
    [
        ("reasoning_effort=none", "is not valid JSON"),
        ('["reasoning_effort"]', "must be a JSON object"),
        ('"none"', "must be a JSON object"),
        ("null", "must be a JSON object"),
        ("1", "must be a JSON object"),
        ('{"temperature": NaN}', "is not valid JSON"),
        ('{"temperature": Infinity}', "is not valid JSON"),
        ('{"temperature": -Infinity}', "is not valid JSON"),
    ],
)
def test_parse_refuses_anything_but_an_object_naming_the_variable(raw, problem):
    with pytest.raises(ValueError) as caught:
        parse_extract_extra_body(raw)
    assert str(caught.value).startswith("OPENAI_EXTRACT_EXTRA_BODY ")
    assert problem in str(caught.value)
    assert '{"reasoning_effort":"none"}' in str(caught.value)


@pytest.mark.parametrize("field", RESERVED_EXTRACT_FIELDS)
def test_parse_refuses_a_field_that_decides_what_the_request_is(field):
    with pytest.raises(ValueError, match=f"may not set {field}"):
        parse_extract_extra_body(json.dumps({"reasoning_effort": "none", field: "x"}))


def test_the_refused_fields_match_the_node_half():
    assert set(RESERVED_EXTRACT_FIELDS) >= {
        "model",
        "messages",
        "tools",
        "tool_choice",
        "response_format",
        "stream",
        "store",
        "metadata",
    }


def test_settings_read_the_variable_and_refuse_a_bad_value_at_startup(monkeypatch):
    monkeypatch.setenv("OPENAI_EXTRACT_EXTRA_BODY", '{"reasoning_effort":"none"}')
    assert Settings(_env_file=None).llm_extract_extra_body == {"reasoning_effort": "none"}
    monkeypatch.delenv("OPENAI_EXTRACT_EXTRA_BODY")
    assert Settings(_env_file=None).llm_extract_extra_body == {}
    monkeypatch.setenv("OPENAI_EXTRACT_EXTRA_BODY", '{"messages":[]}')
    with pytest.raises(ValidationError, match="OPENAI_EXTRACT_EXTRA_BODY may not set messages"):
        Settings(_env_file=None)


def test_the_engine_hands_the_configured_fields_to_its_model_client(monkeypatch):
    seen: dict = {}

    def _provider(*_args, **kwargs):
        seen.update(kwargs)
        return None

    monkeypatch.setattr(
        graphiti_client.settings, "openai_extract_extra_body", '{"reasoning_effort":"none"}'
    )
    monkeypatch.setattr(graphiti_client, "ModelProviderClient", _provider)
    monkeypatch.setattr(graphiti_client, "QuotaAwareLLMClient", lambda *_a, **_k: None)

    class _Stop(Exception):
        pass

    async def _driver():
        raise _Stop()

    monkeypatch.setattr(graphiti_client, "open_graph_driver", _driver)
    monkeypatch.setattr(graphiti_client, "_graphiti", None)
    with pytest.raises(_Stop):
        asyncio.run(graphiti_client._build_graphiti())
    assert seen["extra_body"] == {"reasoning_effort": "none"}
