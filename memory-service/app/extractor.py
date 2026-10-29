"""File-to-text extraction for PDF, DOCX, and images.

Each extractor returns a list of text chunks ready for `add_episode`. The chunks
are sized so they fit comfortably in the extraction LLM's context window (~3k chars
each). Caller feeds them to `/ingest` one at a time.
"""

import base64
import io
import logging
from urllib.parse import urlparse

import httpx
import pdfplumber
import docx as python_docx
from openai import OpenAI

from .extraction_status import refusal_kind

logger = logging.getLogger(__name__)

MAX_CHUNK_CHARS = 3_000
VISION_MODEL = "gpt-4o-mini"

_MIME = {
    "jpg": "image/jpeg",
    "jpeg": "image/jpeg",
    "png": "image/png",
    "gif": "image/gif",
    "webp": "image/webp",
}

# Same suffix @vercel/blob's own get() validates a URL against before treating it as a
# real Blob store URL (dist/index.js, installed 2.4.0). /extract's `url` is a caller-
# supplied string with no other validation (only a shared service API key gates the
# endpoint), so without this check any client holding that key could point /extract at
# an attacker-controlled server and have it hand over the store-wide read-write
# credential. The token is only ever attached to a request that
# is actually going to Vercel's own Blob infrastructure.
_BLOB_HOSTNAME_SUFFIX = ".blob.vercel-storage.com"


def _download(url: str, blob_token: str = "") -> bytes:
    # Vercel Blob private-access blobs require the store's read-write token
    # as a Bearer header; a bare unauthenticated GET 403s.
    hostname = urlparse(url).hostname or ""
    is_blob_url = hostname.endswith(_BLOB_HOSTNAME_SUFFIX)
    if is_blob_url and not blob_token:
        # Every production caller of _download now uploads with access:'private', so a
        # Blob URL reaching here with no token configured is always a deployment
        # misconfiguration (Node has BLOB_READ_WRITE_TOKEN, this service doesn't) — fail
        # fast with a clear reason instead of a confusing 403-wrapped extraction error
        # discovered only after the request round-trips.
        raise RuntimeError(
            "BLOB_READ_WRITE_TOKEN is not configured on the memory service, "
            "cannot fetch a private Vercel Blob URL without it"
        )
    headers = {"authorization": f"Bearer {blob_token}"} if is_blob_url else {}
    with httpx.Client(follow_redirects=True, timeout=60) as client:
        r = client.get(url, headers=headers)
        r.raise_for_status()
        return r.content


def _split_text(text: str) -> list[str]:
    """Break a long text into ≤MAX_CHUNK_CHARS chunks on paragraph boundaries."""
    paragraphs = [p.strip() for p in text.split("\n") if p.strip()]
    chunks, current, current_len = [], [], 0
    for p in paragraphs:
        if current_len + len(p) > MAX_CHUNK_CHARS and current:
            chunks.append("\n".join(current))
            current, current_len = [], 0
        current.append(p)
        current_len += len(p) + 1
    if current:
        chunks.append("\n".join(current))
    return chunks


def extract_pdf(content: bytes) -> list[str]:
    chunks = []
    with pdfplumber.open(io.BytesIO(content)) as pdf:
        for i, page in enumerate(pdf.pages, 1):
            text = page.extract_text() or ""
            text = text.strip()
            if not text:
                continue
            # Label each page so facts can be traced back.
            labelled = f"[Page {i}]\n{text}"
            chunks.extend(_split_text(labelled))
    return chunks


def extract_docx(content: bytes) -> list[str]:
    doc = python_docx.Document(io.BytesIO(content))
    chunks, current, current_len = [], [], 0

    for para in doc.paragraphs:
        text = para.text.strip()
        if not text:
            continue
        is_heading = para.style.name.lower().startswith("heading")
        # Start a new chunk on each heading or when current is full.
        if (is_heading or current_len >= MAX_CHUNK_CHARS) and current:
            chunks.append("\n".join(current))
            current, current_len = [], 0
        current.append(text)
        current_len += len(text) + 1

    if current:
        chunks.append("\n".join(current))
    return chunks


def extract_image(content: bytes, filename: str, openai_api_key: str) -> list[str]:
    ext = (filename or "").lower().rsplit(".", 1)[-1]
    mime = _MIME.get(ext, "image/jpeg")
    b64 = base64.b64encode(content).decode()

    client = OpenAI(api_key=openai_api_key)
    try:
        resp = client.chat.completions.create(
            model=VISION_MODEL,
            messages=[
                {
                    "role": "user",
                    "content": [
                        {
                            "type": "image_url",
                            "image_url": {"url": f"data:{mime};base64,{b64}"},
                        },
                        {
                            "type": "text",
                            "text": (
                                "Describe this image thoroughly for a business memory system. "
                                "Transcribe all visible text exactly. "
                                "Identify people, companies, products, dates, and key facts. "
                                "If it is a chart or diagram, describe what it shows and its key data points. "
                                "Be specific and complete."
                            ),
                        },
                    ],
                }
            ],
            max_tokens=1024,
        )
        description = (resp.choices[0].message.content or "").strip()
        return [f"[Image: {filename}]\n{description}"] if description else []
    except Exception as exc:
        # A provider refusal is not "no text in this image": raise it, so the route answers
        # a retryable 503 instead of an empty, successful extraction.
        if refusal_kind(exc) is not None:
            raise
        logger.error("Vision extraction failed for %s: %s", filename, exc)
        return []


def extract_file(
    url: str, file_type: str, filename: str, openai_api_key: str, blob_token: str = ""
) -> list[str]:
    """Download `url` and extract text chunks. Raises on download/parse failure."""
    content = _download(url, blob_token)
    return extract_bytes(content, file_type, filename, openai_api_key)


def extract_bytes(content: bytes, file_type: str, filename: str, openai_api_key: str) -> list[str]:
    """Extract text chunks from raw bytes. Used for local dev (no Blob URL needed)."""
    if file_type == "pdf":
        return extract_pdf(content)
    if file_type == "docx":
        return extract_docx(content)
    if file_type == "image":
        return extract_image(content, filename, openai_api_key)
    raise ValueError(f"Unsupported file_type: {file_type!r}")
