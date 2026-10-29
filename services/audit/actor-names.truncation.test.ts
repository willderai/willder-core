// A custom Agent row's label, cut short on any width-capped surface, never
// reads as a product writer's label cut short there. The surfaces' widths come from
// WRITER_SLOT_CHARS, which the Timeline lanes, the Access audit column and the actors
// picker all draw with, so a new or narrower slot changes what this test checks.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({
  db: {
    source: { findFirst: vi.fn(), findMany: vi.fn() },
    agent: { findMany: vi.fn() },
  },
}));

import { db } from "@/lib/db";
import { WRITER_SLOT_CHARS, splitWriterLabel, truncateWriterLabel } from "@/components/audit/format";
import { BUILT_IN_AGENT_NAMES, EXACT_PRODUCT_ACTOR_IDS } from "@/services/access/system-actors";
import { fallbackAgentName, resolveAgentNames } from "./actor-names";

beforeEach(() => {
  vi.mocked(db.agent.findMany).mockReset();
});

/** Labels for many custom Agent rows at once, keyed by name. */
async function customLabels(names: string[]): Promise<Map<string, string>> {
  const rows = names.map((name, i) => ({ agentKey: `custom-${i}`, name }));
  vi.mocked(db.agent.findMany).mockResolvedValueOnce(rows as never);
  const labels = await resolveAgentNames(
    "org1",
    rows.map((r) => r.agentKey),
  );
  return new Map(rows.map((r) => [r.name, labels[r.agentKey]!]));
}

async function customLabel(name: string): Promise<string> {
  return (await customLabels([name])).get(name)!;
}

const isMarked = (label: string) => splitWriterLabel(label).marker !== "";

const PRODUCT_LABELS = [
  ...BUILT_IN_AGENT_NAMES.map((name) => `${name} Agent`),
  ...EXACT_PRODUCT_ACTOR_IDS.map((id) => fallbackAgentName(id)),
];
const SLOT_WIDTHS = Object.values(WRITER_SLOT_CHARS);

/** Names built to imitate a product label: every prefix of it, and of its name without the
 *  trailing " Agent" a custom row's label adds back, followed by a few different endings,
 *  as written and in either case. */
function namesImitating(productLabel: string): string[] {
  const bases = [productLabel, productLabel.replace(/ Agent$/, "")];
  const endings = ["", "x", "X v2", " notes", "-bot", "ncy"];
  const names = new Set<string>();
  for (const base of bases) {
    for (let cut = 1; cut <= base.length; cut++) {
      for (const ending of endings) {
        const name = base.slice(0, cut) + ending;
        if (name.trim() === "") continue;
        names.add(name);
        names.add(name.toLowerCase());
        names.add(name.toUpperCase());
      }
    }
  }
  return [...names];
}

describe("no unmarked custom label is cut to a product label's visible text", () => {
  it.each(PRODUCT_LABELS)("imitations of %j", async (productLabel) => {
    const labels = await customLabels(namesImitating(productLabel));
    const collisions: string[] = [];
    for (const [name, label] of labels) {
      if (isMarked(label)) continue;
      for (const width of SLOT_WIDTHS) {
        const shown = truncateWriterLabel(label, width);
        if (shown.toLowerCase() === truncateWriterLabel(productLabel, width).toLowerCase()) {
          collisions.push(`${JSON.stringify(name)} at ${width} chars shows ${JSON.stringify(shown)}`);
        }
      }
    }
    expect(collisions).toEqual([]);
  });
});

describe("a name that begins with a product writer's whole name is marked", () => {
  it.each(["QA agent notes", "System monitor", "Unknown caller", "qa-agent-v2", "Outreach agent (EU)"])(
    "%j",
    async (name) => {
      expect(isMarked(await customLabel(name))).toBe(true);
    },
  );

  it.each(["QA agentive", "Systematic reviewer", "Qualify agent", "Architect", "Researcher"])(
    "%j, which only shares part of a word or a word in another place, is not",
    async (name) => {
      expect(await customLabel(name)).toBe(`${name} Agent`);
    },
  );
});

describe("a label that begins as a cut-short product label does", () => {
  it.each(["Architecture agenda", "Github Secret Scanninx", "Github Secret Sauce", "ARCHITECTURE AGENCY"])(
    "%j is marked",
    async (name) => {
      expect(isMarked(await customLabel(name))).toBe(true);
    },
  );
});

describe("truncateWriterLabel", () => {
  it("never ends the cut between the two halves of a surrogate pair", () => {
    const label = "Release notes 😀😀😀😀😀😀😀😀😀😀 Agent";
    for (let width = 4; width < label.length; width++) {
      expect(truncateWriterLabel(label, width)).not.toMatch(/[\uD800-\uDBFF]…/);
    }
  });
});
