// The since-your-last-session line must not cost a returning session the record that decides
// its task. The line takes its room out of the block's budget first, so an unchecked line can
// push the deciding record out. At the default budget, the block with the line serves every
// record line it serves without it.
import { describe, expect, it } from "vitest";
import type { ServedRule } from "@/services/memory/task-start";
import type { SinceLastSession } from "@/services/memory/since-last-session";
import { renderTaskStartBlock } from "./task-start-notice";
import { SINCE_LAST_SESSION_OPENING } from "./task-start-headings";

const since: SinceLastSession = {
  lastCallAt: new Date("2026-10-13T09:12:00Z"),
  changes: 3,
  capped: false,
  writers: 1,
  onTask: 3,
};

// Enough rules that the default budget is full and some are left out.
const rules: ServedRule[] = Array.from({ length: 40 }, (_, i) => ({
  id: `conv-${i}`,
  kind: "convention",
  subject: `Rule ${i}`,
  text: `Rule ${i}: dedupe accounts by their primary domain before any merge, and keep the older record's owner.`,
}));

const render = (withSince: boolean) =>
  renderTaskStartBlock({ rules, writes: [], stale: [], since: withSince ? since : null });

describe("the since line and the block budget", () => {
  it("costs no record line: a returning session is served every record the same block serves without the line", () => {
    const without = render(false);
    const withLine = render(true);

    expect(withLine.text).toContain(SINCE_LAST_SESSION_OPENING);
    expect(without.lines.length).toBeGreaterThan(0);
    expect(withLine.lines).toEqual(without.lines);
  });
});
