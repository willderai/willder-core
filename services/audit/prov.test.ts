// The PROV-JSON builder against a real PROV validator: the W3C PROV-JSON schema plus the
// reference `prov` Python package (scripts/prov/validate_prov_json.py), gated on PROV_PYTHON.
import { describe, expect, it } from "vitest";
import { type ChangeAnswers, changeToProvJson } from "./prov";
import { PROV_PYTHON, validateProv } from "./prov-validator.testsupport";

const connectorWrite: ChangeAnswers = {
  change: {
    id: "chg 1/a",
    op: "create",
    at: "2026-09-25T12:00:00.000Z",
    recordType: "fact",
    recordId: "fact-2",
    scopePath: "org_a.eng_x",
  },
  author: {
    writer: { actorType: "extraction", actorId: "github-sync:src_1", name: "GitHub sync" },
    authorizedById: "audit-connect-1",
    authorizationKind: "connect",
    authority: { actorType: "human", actorId: "u-ada", name: "Ada Admin" },
  },
  source: { id: "src_1", name: "acme/api", type: "github" },
  readers: [
    {
      readId: "read-2",
      at: "2026-09-25T12:00:09.000Z",
      reader: { actorType: "agent", actorId: "beta", name: "Beta Agent" },
    },
    {
      readId: "read-1",
      at: "2026-09-25T12:00:06.000Z",
      reader: { actorType: "agent", actorId: "alpha", name: "Alpha Agent" },
    },
  ],
  readersTruncated: false,
  replaced: { replacesIds: ["fact-1"], replacedById: "fact-3" },
};

const directWrite: ChangeAnswers = {
  ...connectorWrite,
  author: {
    writer: { actorType: "human", actorId: "u-ada", name: "Ada Admin" },
    authorizedById: "audit-write-1",
    authorizationKind: "direct",
    authority: null,
  },
  source: null,
  readers: [],
  replaced: { replacesIds: [], replacedById: null },
};

/** The four answers in the validator's output shape. */
function expected(a: ChangeAnswers) {
  return {
    recordId: a.change.recordId,
    changeId: a.change.id,
    author: {
      writer: a.author.writer,
      authorizedById: a.author.authorizedById,
      authorizationKind: a.author.authorizationKind,
      authority: a.author.authority,
    },
    source: a.source,
    readers: [...a.readers]
      .sort((x, y) => x.readId.localeCompare(y.readId))
      .map(({ readId, reader }) => ({ readId, reader })),
    replaced: { replacesIds: [...a.replaced.replacesIds].sort(), replacedById: a.replaced.replacedById },
  };
}

describe("changeToProvJson", () => {
  it("states no fact text and mints every identifier under the willder prefix", () => {
    const doc = changeToProvJson(connectorWrite);
    expect(doc.prefix).toEqual({ willder: "https://willder.ai/ns/prov/" });
    for (const [type, records] of Object.entries(doc)) {
      if (type === "prefix") continue;
      for (const id of Object.keys(records)) expect(id).toMatch(/^(willder:|_:)/);
    }
    // A colon or slash inside an id stays inside the local name.
    expect(Object.keys(doc.agent)).toContain("willder:extraction/github-sync%3Asrc_1");
    expect(Object.keys(doc.activity)).toContain("willder:change/chg%201%2Fa");
  });

  it("marks a reader list cut short, and only one cut short", () => {
    const marked = (doc: Record<string, Record<string, Record<string, unknown>>>) =>
      Object.values(doc.entity).some((e) => e["willder:readersTruncated"] === true);
    expect(marked(changeToProvJson({ ...connectorWrite, readersTruncated: true }) as never)).toBe(true);
    expect(marked(changeToProvJson(connectorWrite) as never)).toBe(false);
  });

  it("omits the delegation when the writer authorized its own write", () => {
    expect(changeToProvJson(directWrite).actedOnBehalfOf).toBeUndefined();
    expect(changeToProvJson(directWrite).used).toBeUndefined();
  });
});

describe.skipIf(!PROV_PYTHON)("PROV-JSON passes a PROV validator and round-trips the four answers", () => {
  it.each([
    ["a connector sync that replaced a version and was read twice", connectorWrite],
    ["a person's direct write nobody has read", directWrite],
  ])("%s", (_, answers) => {
    const result = validateProv(changeToProvJson(answers));
    expect(result).toEqual({ ok: true, answers: expected(answers) });
  });

  it("refuses a document the schema rejects", () => {
    const doc = changeToProvJson(connectorWrite);
    const broken = { ...doc, wasAttributedTo: { "_:x": { "prov:entity": provVersion(doc) } } };
    expect(validateProv(broken)).toMatchObject({
      ok: false,
      error: expect.stringMatching(/schema: 'prov:agent' is a required property/),
    });
  });

  it("refuses a relation naming an element the document never declares", () => {
    const doc = changeToProvJson(connectorWrite);
    const dangling = {
      ...doc,
      used: { ...doc.used, "_:x": { "prov:activity": "willder:read/ghost", "prov:entity": provVersion(doc) } },
    };
    expect(validateProv(dangling)).toMatchObject({
      ok: false,
      error: expect.stringMatching(/prov:activity names willder:read\/ghost, which is not a declared activity/),
    });
  });

  // Neither the schema nor `prov` catches these: the schema has no cross-references, and
  // `prov` accepts a relation naming an element of the wrong kind or none at all, and turns
  // an unparseable time into nothing rather than refusing it.
  it.each<[string, (doc: Doc) => void, RegExp]>([
    [
      "a source that is an agent, not an entity",
      (doc) => {
        for (const r of Object.values(doc.wasDerivedFrom)) {
          if (r["prov:usedEntity"] === "willder:source/src_1") r["prov:usedEntity"] = "willder:agent/alpha";
        }
      },
      /prov:usedEntity names willder:agent\/alpha, which is not a declared entity/,
    ],
    [
      "a usage of an entity the document never declares",
      (doc) => {
        doc.used["_:extra"] = { "prov:activity": "willder:read/read-1", "prov:entity": "willder:record/ghost" };
      },
      /prov:entity names willder:record\/ghost, which is not a declared entity/,
    ],
    [
      "an association with an undeclared plan",
      (doc) => {
        for (const r of Object.values(doc.wasAssociatedWith)) r["prov:plan"] = "willder:plan/ghost";
      },
      /prov:plan names willder:plan\/ghost, which is not a declared entity/,
    ],
    [
      "a delegation for an undeclared activity",
      (doc) => {
        for (const r of Object.values(doc.actedOnBehalfOf)) r["prov:activity"] = "willder:change/ghost";
      },
      /prov:activity names willder:change\/ghost, which is not a declared activity/,
    ],
    [
      "a person whose willder:actorType says agent",
      (doc) => {
        for (const a of Object.values(doc.agent))
          if (a["willder:actorType"] === "human") a["willder:actorType"] = "agent";
      },
      /willder:human\/u-ada is willder:actorType agent but is typed prov:Person/,
    ],
    [
      "a software agent whose willder:actorType says human",
      (doc) => {
        for (const a of Object.values(doc.agent))
          if (a["willder:actorType"] === "extraction") a["willder:actorType"] = "human";
      },
      /willder:extraction\/github-sync%3Asrc_1 is willder:actorType human but is not typed prov:Person/,
    ],
    [
      "an actor with no willder:actorType",
      (doc) => {
        for (const a of Object.values(doc.agent)) delete a["willder:actorType"];
      },
      /has willder:actorType None, expected one of human, agent, extraction/,
    ],
    [
      "a time that is not an xsd:dateTime",
      (doc) => {
        for (const r of Object.values(doc.wasGeneratedBy)) r["prov:time"] = "yesterday";
      },
      /prov:time "yesterday" is not an xsd:dateTime/,
    ],
    [
      "a qualified name under a prefix the document never declares",
      (doc) => {
        doc.entity["willder:x"] = { "prov:type": { $: "zz:Thing", type: "prov:QUALIFIED_NAME" } };
      },
      /zz:Thing uses the undeclared prefix zz/,
    ],
    [
      "a prefix that is not an absolute URI",
      (doc) => {
        doc.prefix = { willder: "not a uri" } as never;
      },
      /prefix willder is not an absolute URI/,
    ],
  ])("refuses %s", (_, mutate, why) => {
    const doc = structuredClone(changeToProvJson(connectorWrite)) as Doc;
    mutate(doc);
    expect(validateProv(doc)).toMatchObject({ ok: false, error: expect.stringMatching(why) });
  });

  // The schema, `prov` and the reference checks above accept these, but PROV-CONSTRAINTS
  // (https://www.w3.org/TR/prov-constraints/), which defines when a PROV document is valid,
  // refuses each one. Every case is a change to a document the builder emits.
  it.each<[string, (doc: Doc) => void]>([
    [
      "an identifier declared as both an entity and an activity (entity-activity-disjoint)",
      (doc) => {
        doc.entity[Object.keys(doc.activity)[0]] = {};
      },
    ],
    [
      "a version generated before its write started (generation-within-activity)",
      (doc) => {
        for (const r of Object.values(doc.wasGeneratedBy)) r["prov:time"] = "2020-01-01T00:00:00Z";
      },
    ],
    [
      "a read of the version timed before the version was generated (generation-precedes-usage)",
      (doc) => {
        for (const r of Object.values(doc.used)) r["prov:time"] = "2020-01-01T00:00:00Z";
      },
    ],
    [
      "a write that ends before it starts (start-precedes-end)",
      (doc) => {
        for (const a of Object.values(doc.activity)) {
          if ("prov:startTime" in a) a["prov:startTime"] = "2027-01-01T00:00:00Z";
        }
      },
    ],
  ])("refuses %s", (_, mutate) => {
    const doc = structuredClone(changeToProvJson(connectorWrite)) as Doc;
    mutate(doc);
    expect(validateProv(doc).ok).toBe(false);
  });

  // Each case moves one time so that exactly one constraint is broken, and names it. The
  // emitted document has the write start, generate and end at the same instant, and each
  // read start and use the version at the same later instant.
  const WRITE = "willder:change/chg%201%2Fa";
  const READ = "willder:read/read-1";
  const timeOf = (records: Record<string, Record<string, unknown>>, key: string, value: string) => {
    for (const r of Object.values(records)) if (r["prov:activity"] === key) r["prov:time"] = value;
  };
  it.each<[string, (doc: Doc) => void, RegExp]>([
    [
      "an identifier declared as both an entity and an activity",
      (doc) => {
        doc.entity[WRITE] = {};
      },
      /willder:change\/chg%201%2Fa is declared as both an entity and an activity \(PROV-CONSTRAINTS 55, entity-activity-disjoint\)/,
    ],
    [
      "a write that ends before it starts",
      (doc) => {
        doc.activity[WRITE]["prov:endTime"] = "2026-09-25T11:00:00.000Z";
        timeOf(doc.wasGeneratedBy, WRITE, "2026-09-25T11:00:00.000Z");
      },
      /ends at 2026-09-25T11:00:00\+00:00, before it starts at 2026-09-25T12:00:00\+00:00 \(PROV-CONSTRAINTS 30, start-precedes-end\)/,
    ],
    [
      "a generation before its activity starts",
      (doc) => timeOf(doc.wasGeneratedBy, WRITE, "2026-09-25T11:59:59.000Z"),
      /precedes the start of willder:change\/chg%201%2Fa \(PROV-CONSTRAINTS 34, generation-within-activity\)/,
    ],
    [
      "a generation after its activity ends",
      (doc) => timeOf(doc.wasGeneratedBy, WRITE, "2026-09-25T12:00:01.000Z"),
      /follows the end of willder:change\/chg%201%2Fa \(PROV-CONSTRAINTS 34, generation-within-activity\)/,
    ],
    [
      "a usage before its activity starts",
      (doc) => timeOf(doc.used, READ, "2026-09-25T12:00:05.000Z"),
      /a usage by willder:read\/read-1 at .* precedes the start of willder:read\/read-1 \(PROV-CONSTRAINTS 33, usage-within-activity\)/,
    ],
    [
      "a usage of the version before it was generated, inside the reading activity",
      (doc) => {
        doc.activity[READ]["prov:startTime"] = "2026-09-25T11:59:00.000Z";
        timeOf(doc.used, READ, "2026-09-25T11:59:00.000Z");
      },
      /willder:read\/read-1 uses willder:record\/fact-2 at .*, before it was generated at .* \(PROV-CONSTRAINTS 37, generation-precedes-usage\)/,
    ],
  ])("names the PROV-CONSTRAINTS rule broken by %s", (_, mutate, why) => {
    const doc = structuredClone(changeToProvJson(connectorWrite)) as Doc;
    mutate(doc);
    expect(validateProv(doc)).toMatchObject({ ok: false, error: expect.stringMatching(why) });
  });

  // PROV-CONSTRAINTS 42, derivation-generation-generation-ordering: an entity's generation
  // strictly precedes the generation of anything derived from it, so a derivation cycle is
  // invalid on event order alone, whatever the times say. The emitted document has fact-2
  // revising fact-1 and fact-3 revising fact-2; each case adds one derivation that closes a loop.
  const revision = (generated: string, used: string) => ({
    "prov:generatedEntity": `willder:record/${generated}`,
    "prov:usedEntity": `willder:record/${used}`,
    "prov:type": { $: "prov:Revision", type: "prov:QUALIFIED_NAME" },
  });
  it.each<[string, Record<string, unknown>, RegExp]>([
    ["a version derived from itself", revision("fact-2", "fact-2"), /fact-2 <- willder:record\/fact-2:/],
    ["a version derived from the version derived from it", revision("fact-2", "fact-3"), /derivation cycle/],
    ["a loop through three versions", revision("fact-1", "fact-3"), /derivation cycle/],
  ])("refuses %s (PROV-CONSTRAINTS 42, derivation-generation-generation-ordering)", (_, derivation, cycle) => {
    const doc = structuredClone(changeToProvJson(connectorWrite)) as Doc;
    doc.wasDerivedFrom["_:loop"] = derivation;
    const result = validateProv(doc);
    expect(result).toMatchObject({
      ok: false,
      error: expect.stringMatching(/PROV-CONSTRAINTS 42, derivation-generation-generation-ordering/),
    });
    expect(result).toMatchObject({ ok: false, error: expect.stringMatching(cycle) });
  });

  // The audit lineage can loop on bad data: a version listed as replacing itself, as replaced
  // by itself, or as replacing the version that replaced it. No PROV states that validly, so
  // the builder states no revision inside the loop and marks the versions in it.
  it.each<[string, ChangeAnswers["replaced"], string[], ChangeAnswers["replaced"]]>([
    [
      "replacing itself",
      { replacesIds: ["fact-2", "fact-1"], replacedById: "fact-3" },
      ["fact-2"],
      { replacesIds: ["fact-1"], replacedById: "fact-3" },
    ],
    [
      "replaced by itself",
      { replacesIds: ["fact-1"], replacedById: "fact-2" },
      ["fact-2"],
      { replacesIds: ["fact-1"], replacedById: null },
    ],
    [
      "replacing the version that replaced it",
      { replacesIds: ["fact-3", "fact-1"], replacedById: "fact-3" },
      ["fact-2", "fact-3"],
      { replacesIds: ["fact-1"], replacedById: null },
    ],
  ])(
    "emits valid PROV for a lineage %s, with the loop marked and no revision inside it",
    (_, replaced, loopIds, statedRevisions) => {
      const doc = changeToProvJson({ ...connectorWrite, replaced });
      const marked = Object.entries(doc.entity)
        .filter(([, e]) => (e as Record<string, unknown>)["willder:lineageLoop"] === true)
        .map(([id]) => id);
      expect(marked.sort()).toEqual(loopIds.map((id) => `willder:record/${id}`));
      expect(validateProv(doc)).toEqual({
        ok: true,
        answers: expected({ ...connectorWrite, replaced: statedRevisions }),
      });
    },
  );

  it("accepts a read at the very instant of the write: precedes allows equal times", () => {
    const doc = structuredClone(changeToProvJson(connectorWrite)) as Doc;
    doc.activity[READ]["prov:startTime"] = "2026-09-25T12:00:00.000Z";
    timeOf(doc.used, READ, "2026-09-25T12:00:00.000Z");
    expect(validateProv(doc)).toMatchObject({ ok: true });
  });

  it("accepts a time without a timezone as UTC, equal to the same instant written with one", () => {
    const doc = structuredClone(changeToProvJson(connectorWrite)) as Doc;
    timeOf(doc.wasGeneratedBy, WRITE, "2026-09-25T12:00:00");
    expect(validateProv(doc)).toMatchObject({ ok: true });
  });

  it("accepts a urn: namespace, and refuses a urn: without a namespace identifier", () => {
    const doc = structuredClone(changeToProvJson(connectorWrite)) as Doc;
    doc.prefix = { willder: "urn:example:willder:prov:" } as never;
    expect(validateProv(doc)).toEqual({ ok: true, answers: expected(connectorWrite) });
    doc.prefix = { willder: "urn:prov" } as never;
    expect(validateProv(doc)).toMatchObject({
      ok: false,
      error: expect.stringMatching(/prefix willder is not an absolute URI/),
    });
  });

  it("refuses an unknown record type", () => {
    expect(validateProv({ ...changeToProvJson(directWrite), wasReadBy: {} })).toMatchObject({ ok: false });
  });
});

type Doc = Record<string, Record<string, Record<string, unknown>>>;

function provVersion(doc: ReturnType<typeof changeToProvJson>): string {
  return Object.keys(doc.entity).find((id) => id.startsWith("willder:record/fact-2"))!;
}
