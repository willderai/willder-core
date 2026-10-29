"""`python -m app.prefetch` must cache the one model the running service loads, so a
first start after setup never downloads anything before it can answer, and must not
download a reranker the service never runs."""

import sentence_transformers
from graphiti_core.cross_encoder import bge_reranker_client

from app import prefetch
from app.config import settings


def test_prefetch_loads_the_configured_embedder_and_no_reranker(monkeypatch):
    loaded = []
    monkeypatch.setattr(
        prefetch, "SentenceTransformer", lambda name: loaded.append(("embedder", name))
    )

    def _cross_encoder(*args, **_kwargs):
        loaded.append(("cross-encoder", args))

    monkeypatch.setattr(sentence_transformers, "CrossEncoder", _cross_encoder)
    monkeypatch.setattr(bge_reranker_client, "CrossEncoder", _cross_encoder)

    prefetch.prefetch_models()

    assert loaded == [("embedder", settings.bge_model)]
