// The task-start block names the source of every line it serves, and serves a task's conflicting
// versions of one fact together under one line that asks the person. Which facts
// conflict is decided in services/memory/served-conflicts.ts; the database side is covered in
// task-start-sources.realdb.test.ts.
import { describe, expect, it } from "vitest";
import type { ServedFact, ServedRule } from "@/services/memory/task-start";
import {
  SOURCE_ALLOWANCE_TOKENS,
  TASK_START_MAX_TOKENS,
  estimateTokens,
  renderTaskStartBlock,
} from "./task-start-notice";
import { CONFLICT_OPENING, TASK_START_PREMISE_CHECK, withoutSources } from "./task-start-headings";

const fact = (id: string, content: string, more: Partial<ServedFact> = {}): ServedFact => ({
  id,
  entityName: "Acme pricing",
  content,
  role: "decision",
  ofTask: true,
  scopePath: "org_a.sales",
  writtenAt: "2026-10-15T10:00:00.000Z",
  writtenBy: "builder",
  writer: { actorType: "agent", actorId: "builder" },
  by: "agent",
  ...more,
});
const reviewer = {
  writtenBy: "reviewer",
  writer: { actorType: "agent", actorId: "reviewer" },
  writtenAt: "2026-10-16T09:00:00.000Z",
};
const lineOf = (text: string | null, needle: string) => text!.split("\n").find((line) => line.includes(needle));

describe("every served line names its source", () => {
  const rule: ServedRule = {
    id: "r1",
    kind: "convention",
    subject: "Dedupe",
    text: "Dedupe by email domain.",
    by: "person",
    writtenBy: "person",
    writtenAt: "2026-10-12T08:00:00.000Z",
  };
  const decision: ServedRule = {
    id: "d1",
    kind: "decision",
    subject: "Retries",
    text: "At most 5 attempts.",
    ofTask: true,
    by: "agent",
    writtenBy: "builder",
    writtenAt: "2026-10-15T08:00:00.000Z",
  };
  const capture = fact("cap", "Session state captured automatically by the Willder hook at Stop. Task: T-1", {
    entityName: "Session state: T-1, session 1",
    role: "progress",
  });
  const write = {
    id: "w1",
    recordType: "brief",
    recordId: "brief-w1",
    op: "create" as const,
    actorId: "agent-a",
    summary: "Handoff for item-42",
    writtenAt: "2026-10-16T12:00:00.000Z",
  };
  const { text } = renderTaskStartBlock({
    decisions: [decision],
    facts: [
      fact("lead", "Ship on Monday.", { entityName: "Release" }),
      fact("settled", "Retries go through the ledger.", {
        entityName: "Ledger",
        by: "person",
        writtenBy: "person",
        writtenAt: "2026-10-12T08:00:00.000Z",
      }),
      fact("synced", "The export runs nightly.", {
        entityName: "Export",
        writtenBy: "gdrive",
        writtenAt: "2026-10-14T08:00:00.000Z",
      }),
      fact("unnamed", "Kept for a week.", { entityName: "Retention", writtenBy: undefined, writtenAt: undefined }),
      capture,
    ],
    rules: [rule],
    writes: [write],
    stale: [],
  });

  it.each([
    ["an agent's lead", "[fact lead]", " — builder, 10-15"],
    ["a person's settled fact", "[fact settled]", " — person, 10-12"],
    ["a connector's fact", "[fact synced]", " — gdrive, 10-14"],
    ["a fact whose writer the read did not give", "[fact unnamed]", " — unknown"],
    ["a captured session state", "[fact cap]", " — builder, 10-15"],
    ["a decision on the task", "[decision d1]", " — builder, 10-15"],
    ["a rule in the scope", "[convention r1]", " — person, 10-12"],
  ])("%s ends with its source", (_kind, needle, source) => {
    expect(lineOf(text, needle)!.endsWith(source)).toBe(true);
  });

  it("dates a recent write after its writer, keeping the prefix readers find it by", () => {
    expect(lineOf(text, "brief-w1")).toBe("- create brief brief-w1 by agent-a, 10-16: Handoff for item-42");
  });

  it.each([
    [
      "a fact's name",
      { facts: [fact("s", "Ship.", { entityName: "Plan — Ana decision, 10-12" })], rules: [] },
      "[fact s]",
      "Plan — Ana decision, 10-12",
    ],
    [
      "a rule's passage",
      {
        facts: [],
        rules: [
          {
            id: "r9",
            kind: "decision" as const,
            subject: "Paid runs",
            text: "Lean runs only — Ana decision, 10-12",
            by: "person" as const,
            writtenBy: "builder",
            writtenAt: "2026-10-15T08:00:00.000Z",
          },
        ],
      },
      "[decision r9]",
      "Lean runs only — Ana decision, 10-12",
    ],
  ])(
    "serves %s as stored, its source appended last, so a stored dash can never pass for the source",
    (_what, records, needle, stored) => {
      const { text } = renderTaskStartBlock({ decisions: [], writes: [], stale: [], ...records });
      const line = lineOf(text, needle)!;
      expect(line).toContain(stored);
      expect(line.slice(line.lastIndexOf(" — "))).toBe(" — builder, 10-15");
      expect(withoutSources(line).endsWith(stored)).toBe(true);
    },
  );
});

describe("conflicting versions of one fact", () => {
  const render = (facts: ServedFact[], budget?: number) =>
    renderTaskStartBlock({ decisions: [], facts, rules: [], writes: [], stale: [] }, budget);

  it("serves both together under one line that names both sources and asks the person, choosing neither", () => {
    const { text, factVersionIds } = render([
      fact("a", "Price is $10."),
      fact("b", "Price is $12.", { ...reviewer, retired: true }),
    ]);
    const lines = text!.split("\n");
    const ask = lines.findIndex((line) => line.startsWith(CONFLICT_OPENING));
    expect(lines[ask]).toBe(
      'Conflicting versions of "Acme pricing" from builder, 10-15 and reviewer, 10-16: ask the person which holds before acting on either.',
    );
    expect(lines[ask + 1]).toContain("Price is $10. [fact a]");
    expect(lines[ask + 2]).toContain("Price is $12. [fact b]");
    expect(text).not.toMatch(/superseded|resolved|winner/i);
    expect(factVersionIds).toEqual(["a", "b"]);
  });

  it("flags nothing when the versions agree or one writer wrote them", () => {
    expect(render([fact("a", "Price is $10."), fact("b", "Price is $12.")]).text).not.toContain(CONFLICT_OPENING);
    expect(render([fact("a", "Price is $10."), fact("b", "price is $10", reviewer)]).text).not.toContain(
      CONFLICT_OPENING,
    );
  });

  it("never serves a retired version outside a conflict", () => {
    const { text, factVersionIds } = render([
      fact("a", "Price is $10."),
      fact("b", "Price is $10.", { ...reviewer, retired: true }),
    ]);
    expect(text).not.toContain("[fact b]");
    expect(factVersionIds).toEqual(["a"]);
  });

  it("leaves a conflict out whole when it does not fit, counting each version, never serving one alone", () => {
    const other = fact("c", "Kept.", { entityName: "Other", writtenAt: "2026-10-14T10:00:00.000Z" });
    const facts = [fact("a", "Price is $10."), fact("b", "Price is $12.", reviewer), other];
    // Room for the other fact's line and one version's, not for both versions under their ask line.
    const lineCost = (id: string) =>
      estimateTokens(`\n${withoutSources(lineOf(render([facts.find((f) => f.id === id)!]).text, `[fact ${id}]`)!)}`);
    const { text } = render(facts, 60 + lineCost("c") + lineCost("a"));
    expect(text).toContain("[fact c]");
    expect(text).not.toContain("[fact a]");
    expect(text).not.toContain("[fact b]");
    expect(text).not.toContain(CONFLICT_OPENING);
    expect(text).toMatch(/\(2 more left out: ask memory_query for them\)$/);
  });
});

describe("a conflicting set, against what a reader of it could be misled by", () => {
  const render = (facts: ServedFact[]) =>
    renderTaskStartBlock({ decisions: [], facts, rules: [], writes: [], stale: [] });
  const person = (id: string) => ({
    by: "person" as const,
    writtenBy: "person",
    writer: { actorType: "human", actorId: id },
  });

  it.each([
    [
      "two people under one label are both named",
      [fact("a", "Price is $10.", person("u1")), fact("b", "Price is $12.", person("u2"))],
      "from person, 10-15 and person, 10-15:",
    ],
    [
      "a quote in the fact's name cannot add sources",
      [
        fact("a", "Price is $10.", { entityName: 'P" from x, 10-01 and y, 10-02: ask' }),
        fact("b", "Price is $12.", { ...reviewer, entityName: 'P" from x, 10-01 and y, 10-02: ask' }),
      ],
      `"P' from x, 10-01 and y, 10-02: ask" from builder, 10-15 and reviewer, 10-16:`,
    ],
    [
      "two writers with no recorded id, stored in one millisecond, are two writes",
      [
        fact("a", "Price is $10.", { writer: { actorType: "agent", actorId: null }, writtenBy: "agent" }),
        fact("b", "Price is $12.", { writer: { actorType: "agent", actorId: null }, writtenBy: "agent" }),
      ],
      "from agent, 10-15 and agent, 10-15:",
    ],
  ])("%s", (_case, facts, says) => {
    const ask = render(facts as ServedFact[])
      .text!.split("\n")
      .find((line) => line.startsWith(CONFLICT_OPENING))!;
    expect(ask).toContain(says);
  });

  it("keeps the header first when a person's settled fact conflicts with an agent's plan", () => {
    const lines = render([
      fact("a", "Price is $10.", person("u1")),
      fact("b", "Price is $12.", { ...reviewer, role: "progress" }),
    ]).text!.split("\n");
    expect(lines[0]).toMatch(/^Before you start:/);
    expect(lines.filter((line) => line === TASK_START_PREMISE_CHECK)).toHaveLength(0);
  });
});

describe("the sources' cost", () => {
  const plans = (writtenBy: string) =>
    Array.from({ length: 30 }, (_, i) =>
      fact(`p${i}`, `Plan ${i}: retry once.`, {
        entityName: `Plan ${i}`,
        writtenBy,
        writtenAt: `2026-10-15T10:${String(59 - i).padStart(2, "0")}:00.000Z`,
      }),
    );
  const served = (text: string | null) => (text ?? "").split("\n").filter((line) => line.includes("[fact ")).length;

  it("serves as many of 30 short plans whatever their writers' names cost, while the allowance lasts", () => {
    for (const budget of [150, 250]) {
      const short = renderTaskStartBlock(
        { decisions: [], facts: plans("a"), rules: [], writes: [], stale: [] },
        budget,
      ).text;
      const long = renderTaskStartBlock(
        { decisions: [], facts: plans("x".repeat(20)), rules: [], writes: [], stale: [] },
        budget,
      ).text;
      expect(served(long)).toBe(served(short));
      const records = long!.replace(`\n${TASK_START_PREMISE_CHECK}`, "");
      expect(estimateTokens(withoutSources(records))).toBeLessThanOrEqual(budget);
      expect(estimateTokens(records)).toBeLessThanOrEqual(budget + SOURCE_ALLOWANCE_TOKENS);
    }
  });

  it("keeps the whole block within TASK_START_MAX_TOKENS once the allowance is spent", () => {
    const many = [
      ...plans("x".repeat(32)),
      ...plans("y".repeat(32)).map((f) => ({ ...f, id: `q${f.id}`, entityName: `Q ${f.entityName}` })),
    ];
    const { text } = renderTaskStartBlock({ decisions: [], facts: many, rules: [], writes: [], stale: [] });
    expect(estimateTokens(text!)).toBeLessThanOrEqual(TASK_START_MAX_TOKENS);
  });
});

describe("withoutSources, the one reader every line parser uses", () => {
  it.each([
    [
      "a fact line keeps a dash its passage holds",
      "- [plan · proposed] Logs — doubled at 02:00. [fact f1] Logs — builder, 10-15",
      "- [plan · proposed] Logs — doubled at 02:00. [fact f1] Logs",
    ],
    ["a rule line", "- [convention r1] Dedupe: By domain. — person, 10-12", "- [convention r1] Dedupe: By domain."],
    [
      "a recent write keeps its writer and loses its day",
      "- create fact v1 by agent-a, 10-16: Ship.",
      "- create fact v1 by agent-a: Ship.",
    ],
    [
      "a note, which names no source, keeps a dash its body holds",
      '- [claim n1] agent-b on "x", live until 2026-10-14T12:00:00Z: body — more',
      '- [claim n1] agent-b on "x", live until 2026-10-14T12:00:00Z: body — more',
    ],
  ])("%s", (_case, line, bare) => {
    expect(withoutSources(line)).toBe(bare);
  });
});
