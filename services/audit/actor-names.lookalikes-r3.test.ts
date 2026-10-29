// A custom Agent row (any org member, POST /api/agents, free-text name) must never be drawn
// on a writer surface as the product's own writer. These cases cover what the bidi and
// case fixes did not: names that are not marked because they only start like a product
// writer, and the Timeline lane, which shows at most 22 characters of a label.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({
  db: {
    source: { findFirst: vi.fn(), findMany: vi.fn() },
    agent: { findMany: vi.fn() },
  },
}));

import { db } from "@/lib/db";
import { displayWriterLabel, truncateWriterLabel } from "@/components/audit/format";
import { fallbackAgentName, resolveActorNames } from "./actor-names";

const LANE = 22; // components/audit/timeline-chart.tsx, non-compact lane width

beforeEach(() => {
  vi.mocked(db.source.findFirst).mockReset();
  vi.mocked(db.source.findMany)
    .mockReset()
    .mockResolvedValue([] as never);
  vi.mocked(db.agent.findMany)
    .mockReset()
    .mockResolvedValue([] as never);
});

async function customLabel(name: string): Promise<string> {
  vi.mocked(db.agent.findMany).mockResolvedValueOnce([{ agentKey: "custom-99", name }] as never);
  return (await resolveActorNames("org1", ["custom-99"]))["custom-99"]!;
}

async function sourceSyncLabel(name: string): Promise<string> {
  vi.mocked(db.source.findMany).mockResolvedValueOnce([{ id: "src1", name }] as never);
  return (await resolveActorNames("org1", ["github-sync:src1"]))["github-sync:src1"]!;
}

// The product writers whose label is longer than a Timeline lane, as each surface resolves
// them: the seeded Agent row ("<name> Agent") and the no-row fallback.
const LONG_PRODUCT_LABELS = [
  "Architecture agent Agent",
  fallbackAgentName("architecture-agent"),
  fallbackAgentName("github-secret-scanning"),
];

describe("a custom agent's Timeline lane never reads as a product writer's lane", () => {
  it.each([
    ["Architecture agent Agency", "Architecture agent Agent"],
    ["Architecture agent Agent v2", "Architecture agent Agent"],
    ["Architecture Agent Agents", fallbackAgentName("architecture-agent")],
    ["Github Secret Scanning bot", fallbackAgentName("github-secret-scanning")],
  ])("%j does not draw the lane of %j", async (name, product) => {
    const label = await customLabel(name);
    expect(truncateWriterLabel(label, LANE)).not.toBe(truncateWriterLabel(product, LANE));
  });
});

describe("cases that already held before this round", () => {
  it("bidi controls in a connector source name are escaped wherever the sync label is drawn", async () => {
    const label = await sourceSyncLabel("‮metsyS‬");
    expect(displayWriterLabel(label)).toBe("[U+202E]metsyS[U+202C] sync");
    expect(truncateWriterLabel(label, LANE)).not.toMatch(/\p{Bidi_Control}/u);
    expect(truncateWriterLabel(label, LANE)).not.toContain("System");
  });

  it("a name that literally contains the text [U+202E] is shown as written and never as a product writer", async () => {
    const label = await customLabel("[U+202E]metsyS[U+202C]");
    expect(displayWriterLabel(label)).toBe("[U+202E]metsyS[U+202C] Agent");
    expect(displayWriterLabel(label)).not.toMatch(/^System/);
  });

  it("a combining mark at the end of a marked name stays on the name; the marker is whole", async () => {
    for (const name of ["QA agent̶", "System⃝", "QA agent́́́"]) {
      const label = await customLabel(name);
      expect(label.endsWith(' (agent key "custom-99")')).toBe(true);
      expect(truncateWriterLabel(label, LANE).endsWith(' (agent key "custom-99")')).toBe(true);
    }
  });

  it("truncation never cuts an escaped control in half, even with many of them", async () => {
    const label = await customLabel("‮".repeat(10) + "System");
    const lane = truncateWriterLabel(label, LANE);
    expect(lane.endsWith(' (agent key "custom-99")')).toBe(true);
    expect(lane.replace(/\[U\+[0-9A-F]{4,6}\]/g, "")).not.toMatch(/\[U?\+?[0-9A-F]*…/);
  });

  it("product labels are unchanged by display and truncation keeps their own prefix", () => {
    for (const label of ["QA agent Agent", "System", ...LONG_PRODUCT_LABELS]) {
      expect(displayWriterLabel(label)).toBe(label);
      expect(label.startsWith(truncateWriterLabel(label, LANE).replace(/…$/, ""))).toBe(true);
    }
  });

  it("right-to-left names without controls are neither escaped nor marked", async () => {
    for (const name of ["نظام المراجعة", "מערכת בדיקה", "Ассистент"]) {
      const label = await customLabel(name);
      expect(label).toBe(`${name} Agent`);
      expect(displayWriterLabel(label)).toBe(label);
    }
  });
});
