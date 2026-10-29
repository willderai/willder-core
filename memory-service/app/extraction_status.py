"""Model-provider refusals, and whether graph extraction is working right now.

Every /ingest runs the extraction model. When its provider refuses the call (the
account's quota or spend limit is used up, or the provider rate-limits it), every
ingest fails while Neo4j and every read stay healthy. On 2026-10-16 that answered a
bare 500 on every /ingest for a day while /health said "ok". This module names the
refusal, turns it into a 503 the caller can act on, and keeps the latest ingest
outcome for /health.

The one rule: a refusal is reported by its kind, never with the provider's own
message, which names the account's project id.
"""

from __future__ import annotations

import time
from dataclasses import dataclass
from typing import Literal

import openai
from fastapi import HTTPException
from graphiti_core.llm_client.errors import RateLimitError as GraphitiRateLimitError

# The 429 error codes and types that mean the account cannot pay for more calls, as
# opposed to calling too fast. "project_spend_limit_exceeded" arrives with type
# "insufficient_quota" when a project's enforced spend limit is reached.
QUOTA_CODES = frozenset({"insufficient_quota", "project_spend_limit_exceeded"})

# How long after a refused ingest /health reports extraction as degraded, unless an
# ingest succeeds sooner.
DEGRADED_WINDOW_S = 600.0

# Retry-After for each kind. A quota refusal lasts until someone raises the limit, so
# asking again in seconds only adds load; a rate limit clears on its own.
RETRY_AFTER_S = {"quota": 300, "rate_limit": 30}

RefusalKind = Literal["quota", "rate_limit"]


class ExtractionQuotaExhausted(Exception):
    """The model provider refused a call because the account's quota or spend limit is
    used up. Not a Graphiti RateLimitError, so Graphiti's own retry does not ask again:
    four more attempts with backoff would take the caller past its timeout and still fail."""


def is_quota_refusal(exc: BaseException | None) -> bool:
    """Whether `exc` is the provider refusing for an exhausted quota, spend limit or credit:
    a 402, or any error status whose code or type names a quota (OpenAI sends 429;
    OpenAI-compatible providers also use 402 and 403)."""
    if not isinstance(exc, openai.APIStatusError):
        return False
    return exc.status_code == 402 or exc.code in QUOTA_CODES or exc.type in QUOTA_CODES


def refusal_kind(exc: BaseException) -> RefusalKind | None:
    """The kind of provider refusal behind `exc`, following its cause chain, or None
    when `exc` is not one. Graphiti re-raises the provider's error as its own
    RateLimitError "from" the original, so the original is found on the chain."""
    chain = _cause_chain(exc)
    if any(isinstance(e, ExtractionQuotaExhausted) or is_quota_refusal(e) for e in chain):
        return "quota"
    if any(isinstance(e, (openai.RateLimitError, GraphitiRateLimitError)) for e in chain):
        return "rate_limit"
    return None


def _cause_chain(exc: BaseException) -> list[BaseException]:
    """`exc` and every exception it was raised from or while handling, without repeats."""
    chain: list[BaseException] = []
    current: BaseException | None = exc
    while current is not None and all(current is not e for e in chain):
        chain.append(current)
        current = current.__cause__ or current.__context__
    return chain


def refusal_detail(kind: RefusalKind, what: str) -> str:
    """The 503 detail for a refusal of `what` (e.g. "graph extraction")."""
    if kind == "quota":
        return (
            f"{what} unavailable: the model provider refused the call because the account's "
            "quota or spend limit is used up; raise the limit or fund the key, then retry"
        )
    return f"{what} rate-limited by the model provider; retry after the Retry-After interval"


def refusal_reason(kind: RefusalKind) -> str:
    """The machine-readable name of a refusal, for callers and /health."""
    return "model_quota_exhausted" if kind == "quota" else "model_rate_limited"


def refusal_error(kind: RefusalKind, what: str) -> HTTPException:
    """The 503 answered for a refusal: retryable, with the wait that suits its kind."""
    return HTTPException(
        status_code=503,
        detail=refusal_detail(kind, what),
        headers={"Retry-After": str(RETRY_AFTER_S[kind])},
    )


@dataclass
class _Outcome:
    at: float
    kind: RefusalKind | None  # None for a success


class ExtractionStatus:
    """The latest ingest outcome, for /health. One per process: the service runs one
    worker, so this is every ingest it served."""

    def __init__(self, clock=time.monotonic, wall_clock=time.time) -> None:
        self._clock = clock
        self._wall_clock = wall_clock
        self._last: _Outcome | None = None
        self._last_failure_wall: float | None = None

    def record_success(self) -> None:
        self._last = _Outcome(self._clock(), None)

    def record_failure(self, kind: RefusalKind) -> None:
        self._last = _Outcome(self._clock(), kind)
        self._last_failure_wall = self._wall_clock()

    def snapshot(self) -> dict:
        """`status` is "ok" when the latest ingest succeeded, "degraded" when it was
        refused within DEGRADED_WINDOW_S, and "unknown" when no ingest ran since start
        or the latest refusal is older than that window."""
        last = self._last
        if last is None:
            return {
                "status": "unknown",
                "reason": None,
                "detail": "no ingest since the service started",
            }
        if last.kind is None:
            return {"status": "ok", "reason": None, "detail": None}
        age = self._clock() - last.at
        failed_at = _iso(self._last_failure_wall)
        if age > DEGRADED_WINDOW_S:
            return {
                "status": "unknown",
                "reason": refusal_reason(last.kind),
                "detail": f"no ingest in the last {DEGRADED_WINDOW_S / 60:g} minutes; the latest one, at {failed_at}, was refused",
            }
        return {
            "status": "degraded",
            "reason": refusal_reason(last.kind),
            "detail": f"{refusal_detail(last.kind, 'graph extraction')} (latest refusal {failed_at})",
        }


def _iso(epoch_s: float | None) -> str | None:
    if epoch_s is None:
        return None
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(epoch_s))


extraction_status = ExtractionStatus()
