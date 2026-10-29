// The words of memory_query's note on a served "never" claim that other served records
// mention (mcp/read-notes.ts). Where the note is placed on a real read is pinned in
// mcp/never-claim-note.realdb.test.ts; this file pins what it tells the reader to answer.
//
// The rule under test: the note detects and never resolves. It quotes both records. To a
// yes-or-no question it says to answer with both quotes and a question to the person when the
// mention says the thing happened, never with a bare yes or no; to any other question, which a
// record may answer outright, it only asks that the person be asked.
import { describe, expect, it } from "vitest";
import { neverClaimNote } from "./read-notes";

const CLAIM = "I've never used Zotero, so where do I start?";
const MENTION = "I downloaded Zotero on March 2 and tagged forty sources with it.";
const QUOTE_BOTH =
  "If that mention says it happened, these records do not settle it: answer by quoting both and asking the person which is correct, not with a bare yes or no.";
const ASK = "Ask the person which is right before relying on either.";

describe("the never-claim note's words", () => {
  it.each([
    ["Have I ever used Zotero?", 1, QUOTE_BOTH],
    ["  did we set up Zotero for the team?", 3, QUOTE_BOTH],
    ["Haven't I used Zotero before?", 1, QUOTE_BOTH],
    ["Do I usually tag sources in Zotero?", 1, QUOTE_BOTH],
    ["How many sources have I tagged in Zotero?", 1, ASK],
    ["When did I download Zotero?", 1, ASK],
    ["Tell me whether I have used Zotero.", 1, ASK],
    ["Havelock asked about Zotero: what did I say?", 1, ASK],
  ])("to %j it closes with the right instruction", (question, mentions, closing) => {
    const others = mentions === 1 ? "another record here mentions it" : `${mentions} other records here mention it`;
    expect(neverClaimNote(CLAIM, mentions, MENTION, question)).toBe(
      `Note: possible conflict detected, not resolved: a record here says "${CLAIM}", and ${others}, for example "${MENTION}". ${closing}`,
    );
  });
});
