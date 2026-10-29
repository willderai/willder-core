// A pull-request review history, shaped like a real repository's imported into memory, for the
// task-start block's tests.
//
// Each pull request is one task. Its records are what an import of its GitHub history writes,
// one fact per object, filed under the pull request and named by its task, up to the review
// that decides it, as a session starting the task would find them:
// - the pull request itself, quoting its title;
// - an automated review that names the changed path once;
// - progress notes;
// - the deciding review, newest: a rejection whose first lines are a verdict, the reviewer and
//   the commit, and whose defect is named two to five sentences in. In every third pull
//   request it is long enough that the import stored it in three parts at one instant, each
//   starting with the same header line, the defect in the second.
// Every comment starts with the import's own header line, which names the pull request and the
// repository.
//
// A block that shows each record's first line, cut short, does not show the defect; one that
// cuts each record around the task's words reaches either the defect or the closing instruction,
// both of which name the changed path.
/** The repository the history is from. */
export const REVIEW_REPO = "acme/storefront";

/** One fact the import writes, in write order. */
export interface ReviewRecord {
  id: string;
  entityName: string;
  content: string;
  /** The task the write names: its pull request. */
  task: string;
  /** A later part of the record before it: stored at the same instant, by the same write. */
  sameWriteAsPrevious?: boolean;
}

/** One review-decision task: its name and the record that decides it. */
export interface ReviewTask {
  pr: number;
  /** The task's name, as its sessions and its writes name it. */
  task: string;
  decidingId: string;
  /** How many parts the import stored the deciding review in. */
  decidingParts: number;
}

export interface ReviewHistory {
  records: ReviewRecord[];
  tasks: ReviewTask[];
}

const AREAS = [
  "invoices",
  "refunds",
  "coupons",
  "shipments",
  "returns",
  "carts",
  "wishlists",
  "receipts",
  "payouts",
  "vendors",
  "warehouses",
  "subscriptions",
  "giftcards",
  "taxes",
  "reviews",
  "bundles",
  "discounts",
  "orders",
  "customers",
  "catalogs",
];

/** A deterministic generator, so every run of a test sees the same history. */
function sequence(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 2 ** 32;
  };
}

const FILLER = [
  "I ran the full suite against a real Postgres and every test passes.",
  "The migration applies cleanly on a copy of last week's data.",
  "Types and lint are clean on the branch.",
  "The docs change reads well and matches what the code does.",
  "I read every changed file, not only the diff summary.",
  "The new route answers within its latency budget on a cold start.",
  "Nothing in the access checks changed, and the audit rows still land.",
  "The fixtures are realistic and the test names say what they prove.",
  "I rebased onto main locally and nothing conflicted.",
  "The error messages name the fix, which is what we want.",
  "Coverage of the touched module did not drop.",
  "The feature flag defaults to off, as the plan says.",
];

/**
 * What was written on a pull request after the review that decides it, before the session that
 * reads it starts: nothing; a short acknowledgement and a fix note; or one long automated
 * review, about 2,500 characters of varied text.
 */
export type AfterTheDecision = "nothing" | "acknowledgement" | "long automated review";

const BOT_WORDS =
  "the a handler returns cache layer retries request timeout header parser module emits value index query branch error state token buffer session limit order field schema record client server path event stream".split(
    " ",
  );

/**
 * The history of `count` pull requests, written oldest first, each up to the review that
 * decides it and then `after` it. Each has between 7 and 18 records. The deciding review's
 * defect sits after one to twelve filler sentences, up to about a thousand characters in.
 */
export function reviewHistory(count = 20, seed = 511, after: AfterTheDecision = "nothing"): ReviewHistory {
  const next = sequence(seed);
  const pick = <T>(items: readonly T[]) => items[Math.floor(next() * items.length)]!;
  const records: ReviewRecord[] = [];
  const tasks: ReviewTask[] = [];

  for (let i = 0; i < count; i++) {
    const pr = 140 + i * 3;
    const area = AREAS[i % AREAS.length]!;
    const path = `app/api/${area}/route.ts`;
    const commit = Math.floor(next() * 0xfffffff)
      .toString(16)
      .padStart(7, "0");
    const title = `Fix ${area} pagination cursor in ${path}`;
    const task = `${REVIEW_REPO} pull request #${pr}: ${title}`;
    const entityName = `${REVIEW_REPO} pull request #${pr}`;
    const url = `https://github.com/${REVIEW_REPO}/pull/${pr}`;
    let n = 0;
    const add = (content: string, sameWriteAsPrevious = false) => {
      const id = `pr${pr}-r${String(n++).padStart(2, "0")}`;
      records.push({ id, entityName, content, task, ...(sameWriteAsPrevious ? { sameWriteAsPrevious } : {}) });
      return id;
    };
    const header = (who: string, at: number) =>
      `On pull request #${pr} of ${REVIEW_REPO}, ${who} wrote a comment (${url}#c${at}):`;
    const comment = (lead: string, who: string, body: string) => add(`${lead}\n${header(who, n)}\n${body}`);

    add(
      `Pull request #${pr} of ${REVIEW_REPO}, "${title}", opened by builder-b (${url}).\nDescription: Pages of ${area} skipped or repeated a row when two rows shared a timestamp; this orders by id as well.`,
    );
    comment(
      "Automated review: three suggestions.",
      "automated reviewer review-bot[bot]",
      `Automated review of ${path}. The pagination cursor change looks reasonable. Consider a test for the empty page. Suggested fix: rename the cursor helper.`,
    );
    for (let k = 0; k < 4 + Math.floor(next() * 10); k++) {
      comment(`Progress: step ${k}.`, "builder-b", `Step ${k} on the ${area} pagination work. ${pick(FILLER)}`);
    }

    // The deciding review: its verdict and commit first, its defect a few sentences in.
    const defect = `The defect is in ${path}: the cursor for ${area} page ${i + 2} is read after the limit, so the first row of each page repeats the previous page's last row.`;
    const fillers = Array.from({ length: 1 + Math.floor(next() * 12) }, () => pick(FILLER));
    const verdict = `QA: rejected at ${commit}, not merged.`;
    const opening = `## ${verdict}\n\nTested at head \`${commit}\`. ${fillers.join(" ")}`;
    const closing = `Fix the ${area} pagination order and add a test for ${path} with two rows on one timestamp.`;
    const decidingParts = i % 3 === 0 ? 3 : 1;
    const decidingHeader = header("reviewer-a", n);
    const decidingId =
      decidingParts === 1
        ? add(`${verdict}\n${decidingHeader}\n${opening} ${defect} ${closing}`)
        : add(`${verdict}\n${decidingHeader}\n${opening}`);
    if (decidingParts === 3) {
      add(`${decidingHeader}\n${defect}`, true);
      add(`${decidingHeader}\n${closing}`, true);
    }

    if (after === "acknowledgement") {
      comment("LGTM, on it.", "builder-b", "LGTM, on it. I will push the fix today.");
      comment("Fix note.", "builder-b", `Pushed the ${area} cursor fix; please re-run QA.`);
    }
    if (after === "long automated review") {
      const sentence = () => `${Array.from({ length: 6 + Math.floor(next() * 8) }, () => pick(BOT_WORDS)).join(" ")}.`;
      let body = "";
      while (body.length < 2500) body += `${sentence()} `;
      comment("Automated review: updated after the latest push.", "automated reviewer review-bot[bot]", body.trim());
    }

    tasks.push({ pr, task, decidingId, decidingParts });
  }
  return { records, tasks };
}
