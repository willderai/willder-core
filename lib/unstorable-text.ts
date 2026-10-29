// Text Postgres cannot store, refused before a write is accepted.
//
// THE ONE RULE: a write whose text holds a NUL (U+0000) is refused up front, before
// anything is stored or queued. Postgres `text` cannot hold that character, so the row
// write fails; on a path that stores later (a queued ingest job), the caller would already
// have been told the write was accepted. Valid JSON can carry a NUL, so any client can
// send one. Callers with stricter columns can also refuse malformed Unicode or
// impose a UTF-8 byte cap for an indexed key.

const NUL = "\u0000";

/** A write refused because a text field cannot be stored under its storage rules. */
export class UnstorableTextError extends Error {
  constructor(
    readonly field: string,
    problem = "contains a NUL (\\u0000) character, which cannot be stored. Remove it and retry.",
  ) {
    super(`${field} ${problem}`);
    this.name = "UnstorableTextError";
  }
}

/**
 * The refusal for the first string field that violates its storage rules, or undefined
 * when every field can be stored. NUL is always refused; callers may also require a
 * UTF-8 byte cap (for indexed keys) and well-formed Unicode. Non-string fields are left to the
 * caller's own validation.
 */
export function unstorableText(
  fields: Record<string, unknown>,
  options: { wellFormed?: boolean; maxBytes?: number } = {},
): UnstorableTextError | undefined {
  for (const [field, value] of Object.entries(fields)) {
    if (typeof value !== "string") continue;
    if (value.includes(NUL)) return new UnstorableTextError(field);
    if (options.wellFormed && !value.isWellFormed()) {
      return new UnstorableTextError(
        field,
        "contains half of a surrogate pair, which cannot be stored. Remove it and retry.",
      );
    }
    if (options.maxBytes !== undefined && Buffer.byteLength(value, "utf8") > options.maxBytes) {
      return new UnstorableTextError(field, `exceeds ${options.maxBytes} UTF-8 bytes. Shorten it and retry.`);
    }
  }
  return undefined;
}

/**
 * `text` with each backslash doubled and each NUL written as the six characters `\u0000`,
 * for the record of input that was refused: the refusal's audit row must store what the
 * caller sent, and Postgres cannot store the character itself. Only a NUL refusal's row is
 * escaped, so a row whose target reads `\u0000` is a NUL only when its reason is the NUL
 * refusal; any other row stores the target as sent, where `\u0000` is the typed text. With
 * the reason, the original is recoverable. Never used to accept a write; a write holding a
 * NUL is refused.
 */
export function withNulEscaped(text: string): string {
  return text.replaceAll("\\", "\\\\").replaceAll(NUL, "\\u0000");
}
