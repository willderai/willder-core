// Extra request-body fields for every call to the extraction model (OPENAI_MODEL_EXTRACT),
// from OPENAI_EXTRACT_EXTRA_BODY. The memory service reads the same variable for its own
// extraction calls (memory-service/app/config.py), so one value covers both halves.
//
// Why: a reasoning model on an OpenAI-compatible server (qwen3 on Ollama, for one) thinks
// before every reply by default. On 2026-10-29 a local qwen3:14b took about 2.5 minutes per
// distill call, so a stdio memory_ingest waited past its client's 60 s timeout; the same
// request with `"reasoning_effort": "none"` answered in seconds. That field means nothing to
// some servers and is refused by others, so it is opt-in: unset, every request is exactly
// what it was.
//
// The one rule: the value is a JSON object, and it can add or change sampling fields only.
// It cannot replace what the request is (its model, messages, tools, streaming or response
// format) or have the provider retain it (store, metadata, prompt_cache_retention): a value
// naming one of those is refused, as is anything that is not an object.
// A malformed value is an error naming the variable, never a silently ignored setting.
// Mirrored in memory-service/app/config.py (`parse_extract_extra_body`).

export const EXTRACT_EXTRA_BODY_ENV = "OPENAI_EXTRACT_EXTRA_BODY";

/**
 * Fields the value may not set: they decide what the request is, not how it is sampled, or
 * whether the provider keeps it (`store`, `metadata`, `prompt_cache_retention`: OpenAI
 * retains a stored completion with its prompt, which here is the customer's content).
 * memory-service/app/config.py holds the same list; lib/llm-extract-options.test.ts checks.
 */
export const RESERVED_EXTRACT_FIELDS: readonly string[] = [
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
  "store",
  "metadata",
  "prompt_cache_retention",
];

/** Thrown for an OPENAI_EXTRACT_EXTRA_BODY that is not a JSON object of allowed fields. */
export class InvalidExtractExtraBodyError extends Error {
  constructor(problem: string) {
    super(
      `${EXTRACT_EXTRA_BODY_ENV} ${problem}. Set it to a JSON object of extra request fields, ` +
        `e.g. {"reasoning_effort":"none"}, or unset it (docs/self-host.md).`,
    );
    this.name = "InvalidExtractExtraBodyError";
  }
}

/** The fields `raw` adds to an extraction request; {} when it is unset or blank. */
export function parseExtractExtraBody(raw: string | undefined): Record<string, unknown> {
  if (raw === undefined || raw.trim() === "") return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new InvalidExtractExtraBodyError("is not valid JSON");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new InvalidExtractExtraBodyError("must be a JSON object");
  }
  const reserved = Object.keys(parsed).filter((key) => RESERVED_EXTRACT_FIELDS.includes(key));
  if (reserved.length > 0) {
    throw new InvalidExtractExtraBodyError(`may not set ${reserved.join(", ")}`);
  }
  return parsed as Record<string, unknown>;
}

/**
 * The extra fields for an extraction request, read from the environment on each call (cheap,
 * and a test or a long-lived process sees the current value). Spread them after the request's
 * own sampling fields, so a configured `temperature` or `max_tokens` wins.
 *
 * @throws InvalidExtractExtraBodyError when the variable is set to anything but a JSON object
 *   of allowed fields.
 */
export function extractRequestExtras(env: Record<string, string | undefined> = process.env): Record<string, unknown> {
  return parseExtractExtraBody(env[EXTRACT_EXTRA_BODY_ENV]);
}
