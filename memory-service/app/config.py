"""Settings for the Willder memory service.

Reads from environment (Railway/Render set these in prod; locally, export from
the repo root .env or copy memory-service/.env.example). Field names map to
upper-snake env vars: neo4j_uri -> NEO4J_URI, etc. In lab mode memory-service/.env
is not read either: every value comes from the command that started the service
(app/lab_guard.py).
"""

import json
import os

from pydantic import field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

from .lab_guard import lab_mode


EXTRACT_EXTRA_BODY_ENV = "OPENAI_EXTRACT_EXTRA_BODY"

# Fields OPENAI_EXTRACT_EXTRA_BODY may not set: they decide what an extraction request is, not
# how it is sampled, or whether the provider keeps it. The same list as RESERVED_EXTRACT_FIELDS
# in lib/llm-extract-options.ts; lib/llm-extract-options.test.ts checks the two agree.
RESERVED_EXTRACT_FIELDS = (
    "model",
    "messages",
    "tools",
    "tool_choice",
    "functions",
    "function_call",
    "response_format",
    "stream",
    "stream_options",
    "n",
    # Whether the provider retains the request: OpenAI keeps a stored completion with its
    # prompt, which here is the customer's content.
    "store",
    "metadata",
    "prompt_cache_retention",
)


def _invalid_extract_extra_body(problem: str) -> ValueError:
    return ValueError(
        f"{EXTRACT_EXTRA_BODY_ENV} {problem}. Set it to a JSON object of extra request fields, "
        'e.g. {"reasoning_effort":"none"}, or unset it (docs/self-host.md).'
    )


def _refuse_constant(name: str):
    raise ValueError(f"{name} is not JSON")


def parse_extract_extra_body(raw: str | None) -> dict:
    """The fields OPENAI_EXTRACT_EXTRA_BODY adds to every extraction request; {} when unset.

    A JSON object only, and none of RESERVED_EXTRACT_FIELDS: anything else raises ValueError
    naming the variable. Mirrors parseExtractExtraBody in lib/llm-extract-options.ts.
    """
    if raw is None or raw.strip() == "":
        return {}
    try:
        # NaN and Infinity are not JSON; Node's JSON.parse refuses them, so this does too.
        parsed = json.loads(raw, parse_constant=_refuse_constant)
    except ValueError:
        raise _invalid_extract_extra_body("is not valid JSON") from None
    if not isinstance(parsed, dict):
        raise _invalid_extract_extra_body("must be a JSON object")
    reserved = [key for key in parsed if key in RESERVED_EXTRACT_FIELDS]
    if reserved:
        raise _invalid_extract_extra_body(f"may not set {', '.join(reserved)}")
    return parsed


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    # Shared secret the Node app sends as `Authorization: Bearer <key>`.
    graphiti_service_api_key: str = ""  # GRAPHITI_SERVICE_API_KEY

    # Neo4j — the memory graph Graphiti runs on (AuraDB free tier at MVP).
    neo4j_uri: str = ""
    neo4j_username: str = "neo4j"
    neo4j_password: str = ""
    # Empty = use the connection's home database. This AuraDB instance's database is
    # named after the instance id, not "neo4j" (Graphiti's hardcoded default), so we
    # must not assume "neo4j". Home-database routing works regardless of the name.
    neo4j_database: str = ""
    # Connection-pool lifecycle for both Neo4j drivers (raw and Graphiti's). AuraDB
    # closes idle connections after roughly four to five minutes; a pooled connection
    # that outlives that is "defunct" and the next query on it fails. Lifetime stays
    # under the cutoff so the pool retires connections before Aura does; acquisition
    # fails fast so a dead pool costs 10 s, not the caller's whole 60 s budget;
    # idle connections are pinged before reuse; TCP keepalive is on.
    neo4j_max_connection_lifetime_s: int = 240
    neo4j_connection_acquisition_timeout_s: float = 10.0
    neo4j_liveness_check_timeout_s: float = 30.0
    neo4j_keep_alive: bool = True

    # How long the event loop may go without running before the service ends itself so
    # the platform restarts it (app/watchdog.py). Far above any legitimate pause: model
    # calls, file extraction and Neo4j waits all leave the loop free to run.
    loop_stall_limit_s: float = 60.0

    # Azure OpenAI — required for extraction (structured outputs).
    # OPENAI_BASE_URL: https://<resource>.openai.azure.com/openai/deployments/<deployment>
    # OPENAI_API_VERSION: e.g. 2024-08-01-preview
    openai_api_key: str = ""
    openai_model_extract: str = "gpt-4o-mini"
    openai_base_url: str = "https://api.openai.com/v1"
    openai_api_version: str = ""

    @field_validator("openai_base_url", mode="before")
    @classmethod
    def _default_base_url(cls, v: str) -> str:
        return v or "https://api.openai.com/v1"

    @property
    def llm_api_key(self) -> str:
        return self.openai_api_key

    @property
    def llm_base_url(self) -> str:
        return self.openai_base_url

    @property
    def llm_model_extract(self) -> str:
        return self.openai_model_extract

    # Extra JSON fields merged into every extraction request, e.g. {"reasoning_effort":"none"}
    # for a local reasoning model that would otherwise think for minutes per call. Unset, the
    # requests are unchanged. A bad value stops the service at startup, naming the variable.
    openai_extract_extra_body: str = ""

    @field_validator("openai_extract_extra_body", mode="after")
    @classmethod
    def _valid_extract_extra_body(cls, v: str) -> str:
        parse_extract_extra_body(v)
        return v

    @property
    def llm_extract_extra_body(self) -> dict:
        return parse_extract_extra_body(self.openai_extract_extra_body)

    # Embeddings: BGE, run locally on CPU (free, data stays in-service).
    bge_model: str = "BAAI/bge-small-en-v1.5"
    bge_dim: int = 384  # bge-small-en-v1.5 = 384. MUST match the Neo4j vector index.

    # Vercel Blob read-write token. The Node app uploads source documents with
    # access:'private'; /extract's download of that blobUrl needs this same
    # token as a Bearer header or a private blob 403s (see extractor.py's _download).
    blob_read_write_token: str = ""  # BLOB_READ_WRITE_TOKEN


settings = Settings(_env_file=None) if lab_mode(os.environ) else Settings()
