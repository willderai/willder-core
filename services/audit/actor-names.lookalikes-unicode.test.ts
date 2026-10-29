// The confusable-skeleton check in services/audit/actor-names.ts. Each name below is a custom Agent row (any org member can
// create one through POST /api/agents with a free-text name) that a reader would take for a
// product writer. The claim under test: such a row's label always carries the
// ` (agent key "...")` marker. Real labels must stay byte for byte as they were, and names
// that only share letters with a product writer must stay unmarked.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({
  db: {
    source: { findFirst: vi.fn(), findMany: vi.fn() },
    agent: { findMany: vi.fn() },
  },
}));

import { db } from "@/lib/db";
import { resolveActorNames } from "./actor-names";

const MARKER = ' (agent key "custom-99")';

beforeEach(() => {
  vi.mocked(db.source.findFirst).mockReset();
  vi.mocked(db.source.findMany)
    .mockReset()
    .mockResolvedValue([] as never);
  vi.mocked(db.agent.findMany)
    .mockReset()
    .mockResolvedValue([] as never);
});

async function labelFor(name: string): Promise<string> {
  vi.mocked(db.agent.findMany).mockResolvedValueOnce([{ agentKey: "custom-99", name }] as never);
  return (await resolveActorNames("org1", ["custom-99"]))["custom-99"]!;
}

describe("lookalike Agent row names are marked", () => {
  it.each([
    ["QΑ agent", "Greek capital alpha"],
    ["Ηandoff agent", "Greek capital eta"],
    ["Οutreach agent", "Greek capital omicron"],
    ["Ꭺrchitecture agent", "Cherokee A"],
    ["𝐐𝐀 agent", "mathematical bold"],
    ["𝖲𝗒𝗌𝗍𝖾𝗆", "mathematical sans-serif"],
    ["𝓢𝔂𝓼𝓽𝓮𝓶", "mathematical bold script"],
    ["ＱＡ　ａｇｅｎｔ", "fullwidth letters and ideographic space"],
    ["Ｓｙｓｔｅｍ", "fullwidth"],
    ["Sys\u034Ftem", "combining grapheme joiner"],
    ["Syste\u0301m", "combining acute accent"],
    ["Research\u200D agent", "zero-width joiner"],
    ["Systern", "rn for m"],
    ["0utreach agent", "digit zero for O"],
    ["Platform repo sуnc", "Cyrillic u in sync"],
    ["Workflow：review", "fullwidth colon"],
  ])("%j (%s)", async (name) => {
    expect(await labelFor(name)).toBe(`${name} Agent${MARKER}`);
  });

  // A right-to-left override reverses the characters it covers on screen, and a pop
  // directional formatting character ends it, so "\u202EmetsyS\u202C" is displayed as
  // "System" and its label "<that> Agent" reads exactly as the real "System Agent".
  it.each([
    ["\u202EmetsyS\u202C", "RLO ... PDF, displays as System"],
    ["\u202Etnega AQ\u202C", "RLO ... PDF, displays as QA agent"],
    ["\u202Etnega hcraeseR\u202C", "RLO ... PDF, displays as Research agent"],
  ])("%j (%s)", async (name) => {
    expect(await labelFor(name)).toBe(`${name} Agent${MARKER}`);
  });
});

// The module compares names with case ignored ("QA agent" and "qa agent" read alike). A
// skeleton taken before lowercasing breaks that for any letter whose prototype depends on
// case: "m" maps to "rn", "M" does not, so "SYSTEM" no longer matches "system".
describe("case variants of a product writer's name are marked, as they were before the skeleton", () => {
  it.each([
    "SYSTEM",
    "S.Y.S.T.E.M",
    "sYSTEM",
    "UNKNOWN",
    "QA AGENT",
    "RESEARCH AGENT",
    "HANDOFF AGENT",
    "OUTREACH AGENT",
    "ARCHITECTURE AGENT",
    "GITHUB SECRET SCANNING",
    "WORKFLOW:REVIEW",
    "PLATFORM SYNC",
    "ArchItecture agent",
  ])("%j", async (name) => {
    expect(await labelFor(name)).toBe(`${name} Agent${MARKER}`);
  });
});

describe("names a reader would not confuse stay unmarked", () => {
  it.each(["Researcher", "QB agent", "Systematic reviewer", "Handoff notes bot", "Asynchronous helper"])(
    "%j",
    async (name) => {
      expect(await labelFor(name)).toBe(`${name} Agent`);
    },
  );
});
