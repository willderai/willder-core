"""The service runs no cross-encoder: search_edges fuses BM25 and cosine by reciprocal
rank, so nothing scores pairs. Graphiti still needs a cross-encoder client, and when it
is given none it builds OpenAIRerankerClient, a paid hosted call. These tests hold both
lines: no local reranker model is loaded at startup, and no OpenAI reranker is built.
"""

import asyncio
from types import SimpleNamespace

import graphiti_core.graphiti as graphiti_module
import pytest
import sentence_transformers
from graphiti_core.cross_encoder import bge_reranker_client
from graphiti_core.cross_encoder.client import CrossEncoderClient
from graphiti_core.embedder.client import EmbedderClient, EmbedderConfig

from app import graphiti_client, main
from app.config import settings


class _CrossEncoderLoaded(Exception):
    pass


def _refuse_cross_encoder_models(monkeypatch):
    """Make loading any sentence-transformers CrossEncoder fail loudly, wherever it is
    imported from, and record each attempt."""
    attempts = []

    def _load(*args, **kwargs):
        attempts.append(args)
        raise _CrossEncoderLoaded(f"a cross-encoder model was loaded: {args}")

    monkeypatch.setattr(sentence_transformers, "CrossEncoder", _load)
    monkeypatch.setattr(bge_reranker_client, "CrossEncoder", _load)
    return attempts


def _refuse_openai_reranker(monkeypatch):
    built = []

    def _build(*args, **kwargs):
        built.append(args)
        raise AssertionError("Graphiti built its default OpenAI reranker")

    monkeypatch.setattr(graphiti_module, "OpenAIRerankerClient", _build)
    return built


class _Embedder(EmbedderClient):
    """Stands in for the BGE embedder, so no model is downloaded."""

    def __init__(self, *_args):
        self.config = EmbedderConfig(embedding_dim=settings.bge_dim)
        self.models = None

    async def create(self, _input_data):
        return [0.0] * settings.bge_dim

    async def create_batch(self, input_data_list):
        return [await self.create(text) for text in input_data_list]


def _fresh_engine_state(monkeypatch):
    monkeypatch.setattr(graphiti_client, "BGEEmbedder", _Embedder)
    for name, value in [
        ("_graphiti", None),
        ("_graph_driver", None),
        ("_indices_built", False),
        ("_embedder", None),
        ("_building", None),
    ]:
        monkeypatch.setattr(graphiti_client, name, value, raising=False)
    monkeypatch.setattr(main, "get_graphiti", graphiti_client.get_graphiti)

    async def _no_repair():
        return 0

    monkeypatch.setattr(graphiti_client, "repair_transferred_entities", _no_repair)
    monkeypatch.setattr(graphiti_client, "ensure_one_fallback_anchor_per_scope", _no_repair)


def test_startup_warmup_loads_no_reranker_model(monkeypatch):
    attempts = _refuse_cross_encoder_models(monkeypatch)
    _fresh_engine_state(monkeypatch)
    built = {}

    class _Engine:
        def __init__(self, **kwargs):
            built.update(kwargs)

        async def build_indices_and_constraints(self):
            return None

        async def search_(self, **_kwargs):
            return SimpleNamespace(edges=[])

    async def _driver():
        return SimpleNamespace(client=None)

    monkeypatch.setattr(graphiti_client, "Graphiti", _Engine)
    monkeypatch.setattr(graphiti_client, "QuotaAwareLLMClient", lambda *_a, **_k: None)
    monkeypatch.setattr(graphiti_client, "ModelProviderClient", lambda *_a, **_k: None)
    monkeypatch.setattr(graphiti_client, "open_graph_driver", _driver)

    asyncio.run(main._warmup())

    assert attempts == []
    assert isinstance(built["cross_encoder"], CrossEncoderClient)
    assert not isinstance(built["cross_encoder"], bge_reranker_client.BGERerankerClient)


def test_the_real_engine_is_built_without_an_openai_reranker(monkeypatch):
    # Graphiti's own constructor runs here, so a missing or falsy cross-encoder would
    # reach its OpenAIRerankerClient fallback. The driver is real but never connects.
    built = _refuse_openai_reranker(monkeypatch)
    attempts = _refuse_cross_encoder_models(monkeypatch)
    _fresh_engine_state(monkeypatch)
    monkeypatch.setenv("GRAPHITI_TELEMETRY_ENABLED", "false")
    monkeypatch.setattr(settings, "neo4j_uri", "bolt://127.0.0.1:1")
    monkeypatch.setattr(settings, "openai_api_key", "test-placeholder-not-a-key")

    async def _no_indices(self):
        return None

    monkeypatch.setattr(graphiti_module.Graphiti, "build_indices_and_constraints", _no_indices)

    async def build():
        engine = await graphiti_client.get_graphiti()
        await graphiti_client.close_graphiti()
        return engine

    engine = asyncio.run(build())

    assert built == []
    assert attempts == []
    assert engine.cross_encoder is engine.clients.cross_encoder
    assert type(engine.cross_encoder).__module__ == graphiti_client.__name__


def test_the_stub_refuses_to_rank():
    with pytest.raises(RuntimeError, match="reciprocal rank"):
        asyncio.run(graphiti_client.UnusedCrossEncoder().rank("q", ["a passage"]))
