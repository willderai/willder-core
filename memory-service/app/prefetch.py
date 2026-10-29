"""Download the service's local model into the Hugging Face cache, then exit.

The service runs one model on CPU: the BGE embedder (`BGE_MODEL`, ~130 MB). Search
reranks nothing (see `UnusedCrossEncoder` in app/graphiti_client.py), so no reranker
is downloaded. Without this step the first start downloads the embedder before it
can answer a query. Run it once after installing requirements, while the rest of
local setup is still going:

    python -m app.prefetch

It needs no database, no API key and no `.env`; later starts load from the cache.
"""

from sentence_transformers import SentenceTransformer

from app.config import settings


def prefetch_models() -> None:
    """Load the embedder once, which downloads any weights missing from the cache."""
    SentenceTransformer(settings.bge_model)


if __name__ == "__main__":
    prefetch_models()
    print(f"model cached: {settings.bge_model}")
