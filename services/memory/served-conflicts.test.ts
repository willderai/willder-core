// servedConflicts: which of a task's served facts conflict, and which retired or partner versions
// are served at all. The rendering of a conflicting set is covered in mcp/task-start-sources.test.ts.
import { describe, expect, it } from "vitest";
import { servedConflicts, type ConflictCandidate } from "./served-conflicts";

const builder = { actorType: "agent", actorId: "builder" };
const reviewer = { actorType: "agent", actorId: "reviewer" };
const nobody = { actorType: "agent", actorId: null };

const version = (id: string, content: string, more: Partial<ConflictCandidate> = {}): ConflictCandidate => ({
  id,
  entityName: "Acme pricing",
  content,
  role: "decision",
  scopePath: "org_a.sales",
  writtenAt: `2026-10-15T10:00:0${id.length % 10}.000Z`,
  writer: builder,
  ...more,
});

describe("servedConflicts", () => {
  const cases: { name: string; facts: ConflictCandidate[]; set: string[]; served: string[] }[] = [
    {
      name: "two writers' versions of one fact with different text conflict",
      facts: [version("a", "Price is $10."), version("bb", "Price is $12.", { writer: reviewer })],
      set: ["a", "bb"],
      served: ["a", "bb"],
    },
    {
      name: "one writer's two versions never conflict",
      facts: [version("a", "Price is $10."), version("bb", "Price is $12.")],
      set: [],
      served: ["a", "bb"],
    },
    {
      name: "two writers agreeing, in other case and punctuation, do not conflict",
      facts: [version("a", "Price is $10."), version("bb", "price is 10", { writer: reviewer })],
      set: [],
      served: ["a", "bb"],
    },
    {
      name: "the same name in another scope is another fact",
      facts: [
        version("a", "Price is $10."),
        version("bb", "Price is $12.", { writer: reviewer, scopePath: "org_a.sales_eu" }),
      ],
      set: [],
      served: ["a", "bb"],
    },
    {
      name: "facts under different names never conflict, whatever they say",
      facts: [
        version("a", "Price is $10."),
        version("bb", "Price is $12.", { writer: reviewer, entityName: "Acme discount" }),
      ],
      set: [],
      served: ["a", "bb"],
    },
    {
      name: "a fact stored without a name is a fact of its own",
      facts: [
        version("a", "Price is $10.", { entityName: null }),
        version("bb", "Price is $12.", { writer: reviewer, entityName: null }),
      ],
      set: [],
      served: ["a", "bb"],
    },
    {
      name: "two versions of unknown writers conflict: nothing shows they share one",
      facts: [version("a", "Price is $10.", { writer: nobody }), version("bb", "Price is $12.", { writer: nobody })],
      set: ["a", "bb"],
      served: ["a", "bb"],
    },
    {
      name: "a version that lost a conflict is served beside the version that beat it",
      facts: [version("a", "Price is $10."), version("bb", "Price is $12.", { writer: reviewer, retired: true })],
      set: ["a", "bb"],
      served: ["a", "bb"],
    },
    {
      name: "a retired version saying what the current one says is left out",
      facts: [version("a", "Price is $10."), version("bb", "Price is $10.", { writer: reviewer, retired: true })],
      set: [],
      served: ["a"],
    },
    {
      name: "a retired version alone is left out, as before",
      facts: [
        version("bb", "Price is $12.", { writer: reviewer, retired: true }),
        version("c", "Other.", { entityName: "Other" }),
      ],
      set: [],
      served: ["c"],
    },
    {
      name: "a partner read past the limit is served only in a conflict",
      facts: [
        version("a", "Price is $10."),
        version("bb", "Price is $12.", { partner: true }),
        version("ccc", "Price is $11.", { writer: reviewer, partner: true }),
      ],
      set: ["a", "bb", "ccc"],
      served: ["a", "bb", "ccc"],
    },
    {
      name: "a partner of the same writer is left out",
      facts: [version("a", "Price is $10."), version("bb", "Price is $12.", { partner: true })],
      set: [],
      served: ["a"],
    },
    {
      name: "a write's parts are compared as one text",
      facts: [
        version("a", "Price is $10", { writtenAt: "2026-10-15T10:00:00.000Z" }),
        version("bb", "for annual plans.", { writtenAt: "2026-10-15T10:00:00.000Z" }),
        version("ccc", "Price is $10 for annual plans.", { writer: reviewer }),
      ],
      set: [],
      served: ["a", "bb", "ccc"],
    },
  ];

  it.each(cases)("$name", ({ facts, set, served }) => {
    const result = servedConflicts(facts);
    expect([...result.setOf.keys()].sort()).toEqual(set);
    expect(result.facts.map((fact) => fact.id)).toEqual(served);
  });
});
