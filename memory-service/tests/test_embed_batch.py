"""POST /embed-batch: several texts embedded in one request and one model call.

The app embeds a long memory row's passages through this endpoint instead of one
/embed request per passage, so a large ingest sends a few bounded requests rather than
thousands at once. The model queue (app/model_work.py) encodes texts that wait together
in one call; these tests pin that a batch is one call and comes back in order."""

from app import graphiti_client, schemas
from app.config import settings
from app.model_work import ModelQueue


class _CountingEmbedder:
    """An embedder on a real ModelQueue whose model records each call's texts."""

    def __init__(self):
        self.calls: list[list[str]] = []
        self.models = ModelQueue(self._encode)

    def _encode(self, texts):
        self.calls.append(list(texts))
        return [[float(len(text))] + [0.0] * (settings.bge_dim - 1) for text in texts]

    async def create(self, text):
        return await self.models.encode(text)


def test_embeds_every_text_in_one_model_call_and_in_order(client, headers, monkeypatch):
    embedder = _CountingEmbedder()
    monkeypatch.setattr(graphiti_client, "_embedder", embedder)

    texts = ["a", "bbb", "cc"]
    r = client.post("/embed-batch", json={"texts": texts}, headers=headers)

    assert r.status_code == 200
    assert [vector[0] for vector in r.json()["embeddings"]] == [1.0, 3.0, 2.0]
    assert embedder.calls == [texts]


def test_refuses_an_empty_or_oversized_batch(client, headers, monkeypatch):
    monkeypatch.setattr(graphiti_client, "_embedder", _CountingEmbedder())

    assert client.post("/embed-batch", json={"texts": []}, headers=headers).status_code == 422
    too_many = ["x"] * (schemas.EMBED_BATCH_MAX_TEXTS + 1)
    assert client.post("/embed-batch", json={"texts": too_many}, headers=headers).status_code == 422


def test_needs_the_service_key(client, monkeypatch):
    monkeypatch.setattr(graphiti_client, "_embedder", _CountingEmbedder())

    assert client.post("/embed-batch", json={"texts": ["a"]}).status_code == 401
