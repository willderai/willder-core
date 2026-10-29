// The line a returning session's task-start block opens with: what changed in its scope while
// the agent was away (services/memory/since-last-session.ts reads the counts; this pins how the
// block says them). The reading itself, against Postgres, is in
// mcp/task-start-since-last-session.realdb.test.ts.
import { describe, expect, it } from "vitest";
import type { ServedRule } from "@/services/memory/task-start";
import type { SinceLastSession } from "@/services/memory/since-last-session";
import { MAX_WAITING_COUNTED } from "@/services/memory/change-feed";
import {
  SOURCE_ALLOWANCE_TOKENS,
  TASK_START_MAX_TOKENS,
  TASK_START_TOKEN_BUDGET,
  estimateTokens,
  renderTaskStartBlock,
  sinceLastSessionLine,
} from "./task-start-notice";
import { withoutSources } from "./task-start-headings";
import {
  SINCE_LAST_SESSION_OPENING,
  TASK_START_HEADER,
  TASK_START_HEADINGS,
  TASK_START_PREMISE_CHECK,
} from "./task-start-headings";

const LAST_CALL = new Date("2026-10-13T09:12:45.120Z");

const since = (counts: Partial<SinceLastSession> = {}): SinceLastSession => ({
  lastCallAt: LAST_CALL,
  changes: 7,
  capped: false,
  writers: 2,
  onTask: 3,
  ...counts,
});

const rule: ServedRule = {
  id: "conv-1",
  kind: "convention",
  subject: "Account dedupe",
  text: "Dedupe accounts by domain.",
};

/** What the block's lines cost as the renderer counts them: the header, then each line with its line break. */
const blockCost = (header: string, lines: readonly string[]) =>
  lines.reduce((tokens, line) => tokens + estimateTokens(`\n${line}`), estimateTokens(header));

const render = (opts: { since?: SinceLastSession | null; rules?: ServedRule[] } = {}, budget?: number) =>
  renderTaskStartBlock({ rules: opts.rules ?? [], writes: [], stale: [], since: opts.since }, budget);

describe("the since-your-last-session line", () => {
  it("says when the last call was, in UTC, then the changes, the writers and the task's share", () => {
    expect(sinceLastSessionLine(since())).toBe(
      `${SINCE_LAST_SESSION_OPENING} (last call 2026-10-13 09:12 UTC): 7 changes by 2 other writers in your scope, 3 on this task.`,
    );
  });

  it("agrees its nouns with their counts", () => {
    expect(sinceLastSessionLine(since({ changes: 1, writers: 1, onTask: 1 }))).toContain(
      ": 1 change by 1 other writer in your scope, 1 on this task.",
    );
    expect(sinceLastSessionLine(since({ changes: 2, writers: 1, onTask: 0 }))).toContain(
      ": 2 changes by 1 other writer in your scope.",
    );
  });

  it("leaves the task's share out when none of the changes was on the task", () => {
    expect(sinceLastSessionLine(since({ onTask: 0 }))).not.toContain("on this task");
  });

  it("past the cap, says 'or more' and leaves out the writers and the task's share, which were counted over the first changes only", () => {
    const line = sinceLastSessionLine(since({ changes: 1000, capped: true, writers: 4, onTask: 9 }));
    expect(line).toBe(
      `${SINCE_LAST_SESSION_OPENING} (last call 2026-10-13 09:12 UTC): 1000 or more changes by others in your scope.`,
    );
  });

  it("formats the time in UTC whatever the process time zone", () => {
    // The Date is an instant; toISOString is UTC by definition, which this pins against a
    // formatter that reads local time.
    expect(sinceLastSessionLine(since({ lastCallAt: new Date("2026-10-31T23:59:00.000Z") }))).toContain(
      "(last call 2026-10-31 23:59 UTC)",
    );
  });
});

describe("the line in the block", () => {
  it("is served on its own when nothing else is: the block is not empty, so the session is told and the read is audited", () => {
    const block = render({ since: since() });
    expect(block.text).toBe(`${TASK_START_HEADER}\n${sinceLastSessionLine(since())}`);
  });

  it("is not served when nothing changed, and the block stays empty", () => {
    expect(render({ since: null }).text).toBeNull();
    expect(render({}).text).toBeNull();
  });

  it("comes first under the header, before the premise check and every section", () => {
    const text = render({ since: since(), rules: [rule] }).text!;
    const lines = text.split("\n");
    expect(lines[0]).toBe(TASK_START_HEADER);
    expect(lines[1]).toBe(sinceLastSessionLine(since()));
    expect(lines[2]).toBe(TASK_START_HEADINGS.rules);
    expect(text).not.toContain(TASK_START_PREMISE_CHECK);
  });

  it("is not a record line: it does not start with '- ', and the served log's item lines leave it out", () => {
    const withLine = render({ since: since(), rules: [rule] });
    const without = render({ rules: [rule] });
    expect(sinceLastSessionLine(since()).startsWith("- ")).toBe(false);
    expect(withLine.lines).toEqual(without.lines);
  });

  it("is named in the block's revision, so a session told different counts holds a different revision", () => {
    const told = [
      since(),
      since({ changes: 8 }),
      since({ writers: 5 }),
      since({ onTask: 0 }),
      since({ lastCallAt: new Date("2026-10-14T00:00:00Z") }),
    ];
    const revisions = [
      ...told.map((s) => render({ since: s, rules: [rule] }).revision),
      render({ rules: [rule] }).revision,
    ];
    expect(new Set(revisions).size).toBe(revisions.length);
  });

  it("takes no room from the records: on any budget, the block is the one served without it, with the line under the header", () => {
    const rules = Array.from(
      { length: 30 },
      (_, i): ServedRule => ({ ...rule, id: `conv-${i}`, subject: `Rule ${i}`, text: `Rule ${i}: ${rule.text}` }),
    );
    const longest = since({ changes: 999, writers: 999, onTask: 999 });
    const line = sinceLastSessionLine(longest);
    // From the smallest budget that serves a record; below it, the line's own case is the next one.
    for (let budget = 60; budget <= TASK_START_TOKEN_BUDGET; budget += 7) {
      const withLine = render({ since: longest, rules }, budget);
      const without = render({ rules }, budget);
      expect(without.lines.length).toBeGreaterThan(0);
      expect(withLine.lines).toEqual(without.lines);
      const expected = without.text!.split("\n");
      expected.splice(1, 0, line);
      expect(withLine.text).toBe(expected.join("\n"));
    }
  });

  it("is shown when the budget holds no record at all, its cost added on top of the budget", () => {
    const frame =
      estimateTokens(TASK_START_HEADER) + estimateTokens("\n(999 more left out: ask memory_query for them)");
    const line = sinceLastSessionLine(since());
    const block = render({ since: since(), rules: [rule] }, frame);
    expect(block.text).toBe(`${TASK_START_HEADER}\n${line}\n(1 more left out: ask memory_query for them)`);
    expect(estimateTokens(block.text!)).toBeGreaterThan(frame);
    expect(estimateTokens(block.text!)).toBeLessThanOrEqual(frame + estimateTokens(`\n${line}`));
  });

  it("on a full block, leaves the records the room it would have taken: they fill the budget to within less than its cost", () => {
    // Charged to the records, the line would end their lines at least its own cost short of the
    // budget; one-word rules leave far less slack than that when the block is full.
    const rules = Array.from(
      { length: 60 },
      (_, i): ServedRule => ({ ...rule, id: `conv-${i}`, subject: `Rule ${i}`, text: `R${i}.` }),
    );
    const line = sinceLastSessionLine(since());
    const [header, ...rest] = render({ since: since(), rules }).text!.split("\n");
    expect(rest[0]).toBe(line);
    expect(rest.at(-1)).toMatch(/more left out/);
    const recordsCost = blockCost(header!, rest.slice(1).map(withoutSources));
    expect(recordsCost).toBeLessThanOrEqual(TASK_START_TOKEN_BUDGET);
    expect(recordsCost).toBeGreaterThan(TASK_START_TOKEN_BUDGET - estimateTokens(`\n${line}`));
  });

  it("keeps the whole block within TASK_START_MAX_TOKENS: the budget, the sources' allowance, the longest line and the premise check", () => {
    const longest = since({
      changes: MAX_WAITING_COUNTED - 1,
      writers: MAX_WAITING_COUNTED - 1,
      onTask: MAX_WAITING_COUNTED - 1,
    });
    const capped = since({ changes: MAX_WAITING_COUNTED, capped: true });
    expect(sinceLastSessionLine(longest).length).toBeGreaterThan(sinceLastSessionLine(capped).length);
    expect(TASK_START_MAX_TOKENS).toBe(
      TASK_START_TOKEN_BUDGET +
        SOURCE_ALLOWANCE_TOKENS +
        estimateTokens(`\n${TASK_START_PREMISE_CHECK}`) +
        estimateTokens(`\n${sinceLastSessionLine(longest)}`),
    );
    const rules = Array.from(
      { length: 40 },
      (_, i): ServedRule => ({ ...rule, id: `conv-${i}`, subject: `Rule ${i}`, text: `Rule ${i}: ${rule.text}` }),
    );
    const { text } = render({ since: longest, rules });
    expect(estimateTokens(withoutSources(text!))).toBeLessThanOrEqual(
      TASK_START_TOKEN_BUDGET + estimateTokens(`\n${sinceLastSessionLine(longest)}`),
    );
    expect(estimateTokens(text!)).toBeLessThanOrEqual(
      TASK_START_TOKEN_BUDGET + SOURCE_ALLOWANCE_TOKENS + estimateTokens(`\n${sinceLastSessionLine(longest)}`),
    );
  });
});
