// QA for the newest-source lead in rankTaskFacts (services/memory/task-start.ts): the lead is
// the newest source on the session's subject, and a write that restates the session's own text
// is served last. These cases hold both rules at once: a newer write that only quotes the
// session, or that says nothing on its subject, must not take the lead from the review before it.
import { describe, expect, it } from "vitest";
import { rankTaskFacts, weighTaskFacts, type ServedFact } from "./task-start";

const NAME = "acme/storefront pull request #140";
const link = (n: number) => `https://github.com/acme/storefront/pull/140#issuecomment-${n}`;

function comment(id: string, n: number, text: string, minutesAgo: number): ServedFact {
  const writtenAt = new Date(Date.UTC(2026, 9, 1, 12, 0) - minutesAgo * 60_000).toISOString();
  const content = `On pull request #140 of acme/storefront, someone wrote a comment (${link(n)}): ${text}`;
  return { id, entityName: NAME, content, role: null, writtenAt, ofTask: true };
}

const brief = "Fix the invoices cursor in app/api/invoices/route.ts";
const rank = (facts: ServedFact[]) => rankTaskFacts(facts, weighTaskFacts(brief, facts), brief).map((f) => f.id);

describe("rankTaskFacts: what can take the lead from the newest review", () => {
  const review = comment(
    "review",
    2,
    "Rejected: app/api/invoices/route.ts reads the cursor after the limit, so a row repeats.",
    3,
  );
  const older = comment("older", 1, "The invoices helper reads the cursor twice.", 6);

  it("a newer write that quotes the session's text is served last, never as the lead", () => {
    const quoting = comment("quoting", 3, `Working on: ${brief}.`, 1);
    const order = rank([quoting, review, older]);
    expect(order[0]).toBe("review");
    expect(order.at(-1)).toBe("quoting");
  });

  it("a newer write off the session's subject does not stop the review before it from leading", () => {
    // As in the lab's misses: an older write holds more of the session's words than the review.
    const wordy = comment(
      "wordy",
      1,
      "Before the fix: app/api/invoices/route.ts and app/api/invoices/route.ts again.",
      6,
    );
    const ack = comment("ack", 3, "Thanks, on it.", 1);
    expect(rank([review, wordy])[0]).toBe("review");
    expect(rank([ack, review, wordy])[0]).toBe("review");
  });
});
