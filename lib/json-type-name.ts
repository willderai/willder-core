// The JSON type of a value parsed from a request body, for refusals that name what a
// field was sent as ("scope must be a string scope path, not a number").

/** The JSON type of a value parsed from a request body, with its article. */
export function jsonTypeName(value: unknown): string {
  if (Array.isArray(value)) return "an array";
  if (value === null) return "null";
  return typeof value === "object" ? "an object" : `a ${typeof value}`;
}

function isJsonObject(value: unknown): value is object {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The refusal for a parsed request body that is not a JSON object, or for the first of
 * `fields` it sends as the wrong JSON type; undefined when neither applies. A route
 * returns it as a 400 before reading a field, so a number where a string belongs is
 * refused by name instead of throwing on `.trim()` as a 500 that names nothing. A field
 * that is null or absent is not refused here: the route treats it as missing.
 *
 * Each field is a path into the body:
 * - `"name"`: a string.
 * - `"target.baseUrl"`: a string inside an object; `target` itself must be an object.
 * - `"aliases[]"`: an array of strings; every element is checked, null included.
 * - `"socialLinks{}"`: an object, whose contents are not checked.
 */
export function bodyTypeRefusal(body: unknown, fields: readonly string[]): string | undefined {
  if (!isJsonObject(body)) return `request body must be a JSON object, not ${jsonTypeName(body)}`;
  for (const field of fields) {
    const refusal = fieldTypeRefusal(body, field);
    if (refusal) return refusal;
  }
  return undefined;
}

function fieldTypeRefusal(body: object, field: string): string | undefined {
  const kind = field.endsWith("[]") ? "array" : field.endsWith("{}") ? "object" : "string";
  const path = kind === "string" ? field : field.slice(0, -2);
  const segments = path.split(".");

  let value: unknown = body;
  for (const [i, segment] of segments.entries()) {
    value = Reflect.get(value as object, segment);
    if (value == null) return undefined;
    const isLast = i === segments.length - 1;
    if (!isLast && !isJsonObject(value)) {
      return `${segments.slice(0, i + 1).join(".")} must be an object, not ${jsonTypeName(value)}`;
    }
  }

  if (kind === "string") {
    return typeof value === "string" ? undefined : `${path} must be a string, not ${jsonTypeName(value)}`;
  }
  if (kind === "object") {
    return isJsonObject(value) ? undefined : `${path} must be an object, not ${jsonTypeName(value)}`;
  }
  if (!Array.isArray(value)) return `${path} must be an array, not ${jsonTypeName(value)}`;
  const at = value.findIndex((element) => typeof element !== "string");
  return at === -1 ? undefined : `${path}[${at}] must be a string, not ${jsonTypeName(value[at])}`;
}
