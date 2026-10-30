// OPENAI_EXTRACT_EXTRA_BODY's parsing: a JSON object of sampling fields, or a refusal naming
// the variable. memory-service/tests/test_extract_extra_body.py holds the Python half to the
// same cases.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  EXTRACT_EXTRA_BODY_ENV,
  RESERVED_EXTRACT_FIELDS,
  extractRequestExtras,
  parseExtractExtraBody,
} from "./llm-extract-options";

describe("parseExtractExtraBody", () => {
  it.each([undefined, "", "   "])("adds nothing for %j", (raw) => {
    expect(parseExtractExtraBody(raw)).toEqual({});
  });

  it("returns the object's fields", () => {
    expect(parseExtractExtraBody(' {"reasoning_effort":"none","think":false} ')).toEqual({
      reasoning_effort: "none",
      think: false,
    });
  });

  it.each([
    ["not JSON", "reasoning_effort=none", /is not valid JSON/],
    ["an array", '["reasoning_effort"]', /must be a JSON object/],
    ["a string", '"none"', /must be a JSON object/],
    ["null", "null", /must be a JSON object/],
    ["a number", "1", /must be a JSON object/],
  ])("refuses %s, naming the variable and an example", (_, raw, problem) => {
    expect(() => parseExtractExtraBody(raw)).toThrow(problem);
    expect(() => parseExtractExtraBody(raw)).toThrow(/^OPENAI_EXTRACT_EXTRA_BODY .*\{"reasoning_effort":"none"\}/);
  });

  it.each(RESERVED_EXTRACT_FIELDS.map((field) => [field]))("refuses a value that sets %s", (field) => {
    expect(() => parseExtractExtraBody(JSON.stringify({ reasoning_effort: "none", [field]: "x" }))).toThrow(
      `may not set ${field}`,
    );
  });

  it("covers what the request is and whether it is retained: model, messages, tools, store among the refused fields", () => {
    expect(RESERVED_EXTRACT_FIELDS).toEqual(
      expect.arrayContaining([
        "model",
        "messages",
        "tools",
        "tool_choice",
        "response_format",
        "stream",
        "store",
        "metadata",
      ]),
    );
  });

  it("refuses NaN and Infinity, which are not JSON (the memory service refuses them too)", () => {
    for (const raw of ['{"temperature":NaN}', '{"temperature":Infinity}', '{"temperature":-Infinity}']) {
      expect(() => parseExtractExtraBody(raw)).toThrow(/is not valid JSON/);
    }
  });

  it("is the same list the memory service refuses, in memory-service/app/config.py", () => {
    const source = readFileSync(join(process.cwd(), "memory-service", "app", "config.py"), "utf8");
    const tuple = /^RESERVED_EXTRACT_FIELDS = \(([\s\S]*?)^\)/m.exec(source)?.[1];
    expect(tuple, "RESERVED_EXTRACT_FIELDS in config.py").toBeDefined();
    const python = [...tuple!.replace(/#.*$/gm, "").matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    expect(python).toEqual([...RESERVED_EXTRACT_FIELDS]);
  });
});

describe("extractRequestExtras", () => {
  it("reads OPENAI_EXTRACT_EXTRA_BODY", () => {
    expect(EXTRACT_EXTRA_BODY_ENV).toBe("OPENAI_EXTRACT_EXTRA_BODY");
    expect(extractRequestExtras({ OPENAI_EXTRACT_EXTRA_BODY: '{"reasoning_effort":"low"}' })).toEqual({
      reasoning_effort: "low",
    });
    expect(extractRequestExtras({})).toEqual({});
  });
});
