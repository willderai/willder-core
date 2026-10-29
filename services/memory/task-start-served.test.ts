// How the served-vs-used log reads a call (services/memory/task-start-served.ts): which texts it
// looks in, how it finds a served id there, and how it reads a block line's revision key. The
// database side is in task-start-served.realdb.test.ts.
import { describe, expect, it } from "vitest";
import { RESULT_FIELD, idsNamedIn, itemOfRevisionKey, textsOfCall } from "./task-start-served";

const found = (text: string, ids: string[]) =>
  idsNamedIn([{ field: "content", text }], ids)
    .map((use) => use.namedId)
    .sort();

describe("idsNamedIn: a served id as a whole token", () => {
  const ID = "cm1abc2def3ghi4jkl5mno6pq";
  const UUID = "3f2b7c1e-9a4d-4e8b-b1c2-0d9e8f7a6b5c";

  it("finds an id between spaces, punctuation, brackets, quotes and line ends", () => {
    for (const text of [
      ID,
      `see ${ID}.`,
      `[fact ${ID}]`,
      `"${ID}"`,
      `(${ID})`,
      `x\n${ID}\ny`,
      `${ID},${UUID}`,
      `id=${ID}&`,
    ]) {
      expect(found(text, [ID])).toEqual([ID]);
    }
    expect(found(`supersedes ${UUID}`, [UUID])).toEqual([UUID]);
  });

  it("never finds an id inside a longer token, in another case, or broken by an invisible character", () => {
    for (const text of [
      `${ID}x`,
      `x${ID}`,
      `${ID}-2`,
      `${ID}_old`,
      `é${ID}`,
      `${ID}д`,
      `${ID}́`,
      ID.toUpperCase(),
      `${ID.slice(0, 10)}​${ID.slice(10)}`,
      `${UUID}0`,
    ]) {
      expect(found(text, [ID, UUID])).toEqual([]);
    }
  });

  it("treats LIKE wildcards and escapes as text: an id is never a pattern", () => {
    expect(found("rule-%", ["rule-1"])).toEqual([]);
    expect(found("rule_1", ["rule-1"])).toEqual([]);
    expect(found("a rule-1 b", ["rule-_"])).toEqual([]);
    expect(found("path\\rule-1", ["rule-1"])).toEqual(["rule-1"]);
  });

  it("finds an id made of other characters only with no token character on either side", () => {
    expect(found("see task:42.", ["task:42"])).toEqual(["task:42"]);
    expect(found("see xtask:42", ["task:42"])).toEqual([]);
    expect(found("see task:420", ["task:42"])).toEqual([]);
    expect(found("task:420 then task:42", ["task:42"])).toEqual(["task:42"]);
    expect(found("\u{1F4E6}task:42\u{1F4E6}", ["task:42"])).toEqual(["task:42"]);
  });

  it("finds each id once per field, and ignores an empty id", () => {
    expect(
      idsNamedIn(
        [
          { field: "content", text: "a a" },
          { field: "content", text: "a" },
          { field: "query", text: "a" },
        ],
        ["a", ""],
      ),
    ).toEqual([
      { namedId: "a", field: "content" },
      { namedId: "a", field: "query" },
    ]);
  });

  it("reads 200,000 characters of hostile text in linear time", () => {
    const text = `a ${"a-".repeat(50_000)}${"\u{1F4E6}é".repeat(30_000)}${"x:".repeat(20_000)}`;
    const started = performance.now();
    expect(found(text, ["a", "x:y", "zz"])).toEqual(["a"]);
    expect(performance.now() - started).toBeLessThan(1000);
  });
});

describe("textsOfCall", () => {
  it("reads every string of every argument, under its top-level name, and the reply's text parts", () => {
    const texts = textsOfCall(
      { query: "q", nested: { deep: ["d1", { d2: "d2" }] }, limit: 5, flag: true, none: null },
      {
        content: [
          { type: "text", text: "reply" },
          { type: "image", data: "aWQ=", mimeType: "image/png" },
        ],
      },
    );
    expect(texts).toEqual([
      { field: "query", text: "q" },
      { field: "nested", text: "d1" },
      { field: "nested", text: "d2" },
      { field: RESULT_FIELD, text: "reply" },
    ]);
  });

  it("reads no arguments from a call whose input is not an object", () => {
    expect(textsOfCall("x", { content: [] })).toEqual([]);
    expect(textsOfCall(["x"], { content: [] })).toEqual([]);
    expect(textsOfCall(null, { content: [] })).toEqual([]);
  });

  it("stops at a bounded depth, so a cyclic or very deep argument cannot run away", () => {
    const deep: Record<string, unknown> = {};
    let at = deep;
    for (let i = 0; i < 50; i++) at = (at.next = {}) as Record<string, unknown>;
    at.id = "too-deep";
    expect(textsOfCall({ deep, shallow: { id: "found" } }, { content: [] })).toEqual([
      { field: "shallow", text: "found" },
    ]);
  });
});

describe("itemOfRevisionKey", () => {
  it("reads the record type and id of a revision key, whatever the revision holds", () => {
    expect(itemOfRevisionKey("convention:rule-1@1")).toEqual({ itemType: "convention", itemId: "rule-1" });
    expect(itemOfRevisionKey("note:n1@2026-10-14T03:00:00.000Z")).toEqual({ itemType: "note", itemId: "n1" });
    expect(itemOfRevisionKey("change:3f2b7c1e-9a4d-4e8b-b1c2-0d9e8f7a6b5c@1")).toEqual({
      itemType: "change",
      itemId: "3f2b7c1e-9a4d-4e8b-b1c2-0d9e8f7a6b5c",
    });
  });

  it("reads none from a key of another shape", () => {
    for (const key of ["", "convention", "convention:", ":id@1", "convention:@1", "convention:id"])
      expect(itemOfRevisionKey(key)).toBeNull();
  });
});
