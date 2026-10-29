// A person outside the team names a fact's writer from the interface alone. Tests the "no caller-chosen id or name can make a write read
// as the product's" rule in services/audit/actor-names.ts, with lookalikes the main suite does
// not try: Unicode confusables, trailing and doubled spaces, mixed separators.
//
// A reader compares labels by eye, so two labels are "the same" when their confusable
// skeletons match: NFKC, the common Cyrillic/Greek Latin lookalikes folded to Latin, case,
// and anything that is not a letter or digit ignored.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({
  db: { source: { findFirst: vi.fn(), findMany: vi.fn() }, agent: { findMany: vi.fn() } },
}));

import { db } from "@/lib/db";
import { fallbackAgentName, resolveActorNames } from "./actor-names";
import { isProductActorId } from "@/services/access/system-actors";

const CONFUSABLE: Record<string, string> = {
  а: "a",
  е: "e",
  о: "o",
  р: "p",
  с: "c",
  х: "x",
  у: "y",
  ѕ: "s",
  і: "i",
  ј: "j",
  А: "A",
  В: "B",
  Е: "E",
  К: "K",
  М: "M",
  Н: "H",
  О: "O",
  Р: "P",
  С: "C",
  Т: "T",
  Х: "X",
  Ѕ: "S",
  І: "I",
  Α: "A",
  Β: "B",
  Ε: "E",
  Ι: "I",
  Κ: "K",
  Ο: "O",
  Ρ: "P",
  Τ: "T",
  ο: "o",
};
const skeleton = (label: string) =>
  [...label.normalize("NFKC")]
    .map((c) => CONFUSABLE[c] ?? c)
    .join("")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");

// The seeded built-in Agent rows (lib/tenant.ts) and the product ids with no row.
const SEEDED_ROWS = [
  { agentKey: "qa-agent", name: "QA agent" },
  { agentKey: "copy-agent", name: "Outreach agent" },
  { agentKey: "handoff-agent", name: "Handoff agent" },
  { agentKey: "architecture-agent", name: "Architecture agent" },
  { agentKey: "research-agent", name: "Research agent" },
];
const ROWLESS_PRODUCT_IDS = ["system", "unknown", "github-secret-scanning", "workflow:review", "github-sync:gone"];

beforeEach(() => {
  vi.mocked(db.source.findFirst).mockReset();
  vi.mocked(db.source.findMany)
    .mockReset()
    .mockResolvedValue([] as never);
  vi.mocked(db.agent.findMany)
    .mockReset()
    .mockResolvedValue([] as never);
});

async function realLabels(): Promise<Set<string>> {
  vi.mocked(db.agent.findMany).mockResolvedValueOnce(SEEDED_ROWS as never);
  const names = await resolveActorNames("org1", [...SEEDED_ROWS.map((r) => r.agentKey), ...ROWLESS_PRODUCT_IDS]);
  return new Set(Object.values(names).map(skeleton));
}

describe("lookalike token ids (fallback label)", () => {
  const SPOOF_IDS = [
    "qа-agent", // Cyrillic а
    "Ѕystem", // Cyrillic Ѕ
    "ѕystem",
    "systеm", // Cyrillic е
    "ｑａ-ａｇｅｎｔ", // fullwidth
    "qa-agent ", // trailing space
    " qa-agent",
    "qa--agent",
    "qa.agent",
    "qa‐agent", // U+2010 hyphen
    "qa​agent", // zero width space
    "QA-Agent",
    "github sync",
    "Github-Secret_Scanning",
    "workflow：review", // fullwidth colon
  ];

  it("no lookalike id is a product id", () => {
    for (const id of SPOOF_IDS) expect(isProductActorId(id), id).toBe(false);
  });

  it("no lookalike id's label reads like any real product label", async () => {
    const real = await realLabels();
    for (const id of SPOOF_IDS) {
      const label = fallbackAgentName(id);
      expect(label.endsWith(" (agent token)"), label).toBe(true);
      expect(real.has(skeleton(label)), label).toBe(false);
    }
  });
});

describe("lookalike Agent row names (resolveAgentNames)", () => {
  // A non-product Agent row, created by any org member through POST /api/agents with a
  // free-text name, must never render like a seeded built-in agent or the system.
  const SPOOF_NAMES = [
    "QA agent ", // trailing space
    "QA  agent", // doubled space
    "QA_agent",
    "QА agent", // Cyrillic А
    "QA agеnt", // Cyrillic е
    "Ѕystem", // Cyrillic Ѕ
    "Architecture agеnt", // Cyrillic е
    "github sync",
    "System",
    "QA agent",
  ];

  it.each(SPOOF_NAMES)("an Agent row named %j does not read as a product writer", async (name) => {
    const real = await realLabels();
    vi.mocked(db.agent.findMany).mockResolvedValueOnce([{ agentKey: "custom-99", name }] as never);
    const label = (await resolveActorNames("org1", ["custom-99"]))["custom-99"]!;
    expect(real.has(skeleton(label)), label).toBe(false);
  });

  it("real labels are unchanged", async () => {
    vi.mocked(db.agent.findMany).mockResolvedValueOnce(SEEDED_ROWS as never);
    const names = await resolveActorNames("org1", [...SEEDED_ROWS.map((r) => r.agentKey), ...ROWLESS_PRODUCT_IDS]);
    expect(names).toEqual({
      "qa-agent": "QA agent Agent",
      "copy-agent": "Outreach agent Agent",
      "handoff-agent": "Handoff agent Agent",
      "architecture-agent": "Architecture agent Agent",
      "research-agent": "Research agent Agent",
      system: "System Agent",
      unknown: "Unknown Agent",
      "github-secret-scanning": "Github Secret Scanning Agent",
      "workflow:review": "Workflow:Review Agent",
      "github-sync:gone": "Github Sync:Gone Agent",
    });
  });
});
