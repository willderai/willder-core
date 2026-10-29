// The Access audit column is drawn at
// maxWidth 16ch in Geist Mono 12px. Chromium lays that out at 115.1875px (16ch is
// 115.2px, floored to layout units), which is less than fifteen glyphs plus the
// ellipsis, so the column shows fourteen characters of a writer label, not fifteen.
// Each name below differs from a product agent's label only from its fifteenth
// character on, is left unmarked, and was screenshotted pixel-identical to the
// product label in that slot (Chromium 1228, Geist Mono from Google Fonts, DPR 1
// and 2): "Architecture a…", "Github Secret …", "Outreach agent…", "Research agent…".
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({
  db: {
    source: { findFirst: vi.fn(), findMany: vi.fn() },
    agent: { findMany: vi.fn() },
  },
}));

import { db } from "@/lib/db";
import { splitWriterLabel } from "@/components/audit/format";
import { resolveAgentNames } from "./actor-names";

async function customLabel(name: string): Promise<string> {
  vi.mocked(db.agent.findMany).mockResolvedValueOnce([{ agentKey: "custom-1", name }] as never);
  return (await resolveAgentNames("org1", ["custom-1"]))["custom-1"]!;
}

describe("a name that shares the 14 characters the Access column shows is marked", () => {
  it.each([
    ["Architecture assistant", "Architecture agent Agent"],
    ["Github Secret Keeper", "Github Secret Scanning Agent"],
    ["Outreach agentive", "Outreach agent Agent"],
    ["Research agentive", "Research agent Agent"],
  ])("%j (shows like %j)", async (name) => {
    expect(splitWriterLabel(await customLabel(name)).marker).not.toBe("");
  });

  it("a name that differs within the first 14 characters stays unmarked", async () => {
    expect(await customLabel("Architect review")).toBe("Architect review Agent");
  });
});
