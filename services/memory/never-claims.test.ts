// A served "never" claim about the question is reported with one first-person mention of its
// thing from another served line; nothing else is reported, and nothing on the page changes.
import { describe, expect, it } from "vitest";
import { neverClaimConflicts, neverClaimsIn } from "./never-claims";

const page = (...facts: string[]) => facts.map((fact) => ({ fact }));

const NEVER_ZOTERO = "USER: I've never used Zotero, so how do I start?";
const DOWNLOADED = "USER: I downloaded Zotero on March 2 and tagged forty sources with it.";
const ADVICE = "ASSISTANT: Zotero is a free tool that many students like.";
const UNRELATED = "USER: My essay outline has five sections and a conclusion.";
const ASKED = "Have I ever used Zotero?";

describe("neverClaimsIn", () => {
  it.each([
    ["I've never used Zotero", "I've never used Zotero", ["zotero"]],
    ["Honestly, I've never used Zotero.", "Honestly, I've never used Zotero.", ["zotero"]],
    ["Up till now I've never used Zotero.", "Up till now I've never used Zotero.", ["zotero"]],
    [
      "We have never deployed the billing service on a Friday",
      "We have never deployed the billing service on a Friday",
      ["bill", "servic", "friday"],
    ],
    [
      "I have actually never attended any ATS workshops, but I want to",
      "I have actually never attended any ATS workshops, but I want to",
      ["ats", "workshop"],
    ],
    [
      "I've never actually met attorney Stephanie before",
      "I've never actually met attorney Stephanie before",
      ["attorney", "stephani"],
    ],
    ["I had not ever written Flask routes", "I had not ever written Flask routes", ["flask", "rout"]],
    ["I've never attended any production meetings", "I've never attended any production meetings", ["product", "meet"]],
    [
      "and I've also never met Michael or worked on editing timelines?",
      "and I've also never met Michael or worked on editing timelines",
      ["michael", "edit", "timelin"],
    ],
    [
      "USER: I spent the whole of Tuesday sorting the reading list for my seminar on memory, which I've never used Zotero for",
      "…which I've never used Zotero for",
      ["zotero"],
    ],
  ])("reads %j", (text, said, terms) => {
    const [claim, ...rest] = neverClaimsIn(text);
    expect(rest).toEqual([]);
    expect(claim!.text).toBe(said);
    expect([...claim!.terms].sort()).toEqual([...terms].sort());
  });

  it.each([
    ["a claim naming no thing", "I've never done that"],
    ["a claim about someone else", "You have never used Zotero"],
    ["an instruction", "Never use tabs in this repo"],
    ["a supposition", "If I had never used Zotero, I'd be lost"],
    ["a question", "Have I never used Zotero"],
    ['"never fail to", which means always', "I never fail to cite with Zotero"],
    ['"never forget", which means always', "I never forget to back up my Zotero library"],
    ["someone else's quoted words", 'My advisor wrote: "I\'ve never used Zotero."'],
    ["someone else's report", "My sister thinks I've never used Zotero"],
    ["the speaker's report of an old claim", "Correction: I said I'd never used Zotero, but that was wrong"],
    ["a denial", "It's not true that I've never used Zotero"],
    ['a claim bounded by a leading "until"', "Until March, I had never used Zotero."],
    ['a claim bounded by a trailing "until"', "I had never used Zotero until March, when I installed it."],
    ['a claim bounded by "before" and a time', "Before college I'd never been to Japan."],
    ['a claim bounded by "before" and an event', "I've never actually met attorney Stephanie before the call"],
    ['a claim bounded by "as of"', "As of May, I have never used Zotero."],
    ["a claim bounded by a year", "In 2019 I had never used Zotero."],
    // Red-team round 3 (claim side): reports, denials and bounds in other positions.
    ["a denial before a report", "It's not true, as Sam says, that I've never used Zotero"],
    [
      "a long denial",
      "It isn't true, as my colleague who always exaggerates keeps telling everyone at our weekly group meeting, that I've never used Zotero.",
    ],
    ['"according to"', "According to Sam, I've never used Zotero"],
    ["a colon", "Sam: I've never used Zotero"],
    ["an introducing clause", "Sam replied, I've never used Zotero"],
    ["a report after the claim", "I've never used Zotero, Sam claims."],
    ['"or so I thought"', "I've never used Zotero, or so I thought."],
    ['"now" after the claim', "I'd never used Zotero, now I use it daily."],
    ['"like" before the claim', "It feels like I've never used Zotero"],
    ['a "when" bound', "When I started grad school, I had never used Zotero."],
    ['"at that time"', "At that time I had never used Zotero."],
    ['"then"', "I'd never used Zotero then."],
    ['"not until"', "I had never used Zotero, not until May."],
    ["a leading scope", "In college I never used Zotero."],
    ["an exception", "Except for one class, I've never used Zotero."],
    ["not absolute", "I've never used Zotero much."],
    [
      "a long leading bound",
      "Before I started my PhD at the university where I am now enrolled in the history program, I had never used Zotero.",
    ],
  ])("reads no claim in %s", (_case, text) => {
    expect(neverClaimsIn(text)).toEqual([]);
  });
});

describe("neverClaimConflicts", () => {
  it("reports the claim, how many other lines mention its thing, and the first mention", () => {
    expect(
      neverClaimConflicts(
        page(NEVER_ZOTERO, DOWNLOADED, UNRELATED, "USER: I synced Zotero with my laptop last night."),
        ASKED,
      ),
    ).toEqual([
      {
        claim: "I've never used Zotero, so how do I start",
        mentions: 2,
        example: "USER: I downloaded Zotero on March 2 and tagged forty sources with it.",
      },
    ]);
  });

  it.each([
    ["no other line names the thing", page(NEVER_ZOTERO, UNRELATED), ASKED],
    [
      "the question asks about another thing",
      page(NEVER_ZOTERO, DOWNLOADED),
      "How many sections does my essay outline have?",
    ],
    ["the only mention is not in the first person", page(NEVER_ZOTERO, ADVICE), ASKED],
    [
      "the only mention is in the claim's own line",
      page("USER: I've never used Zotero, but my lab mate says I downloaded Zotero once."),
      ASKED,
    ],
    ["the only mention is negated, so it agrees", page(NEVER_ZOTERO, "USER: I didn't download Zotero yet."), ASKED],
    [
      "the only mention repeats the claim",
      page(NEVER_ZOTERO, "USER: Since I have never used Zotero, which tool is easiest?"),
      ASKED,
    ],
    [
      "the mention names one term of a thing of several",
      page("USER: I've never written any Flask routes in this project.", "USER: Flask installs cleanly on my laptop."),
      "Have I written Flask routes?",
    ],
  ])("reports nothing when %s", (_case, served, query) => {
    expect(neverClaimConflicts(served, query)).toEqual([]);
  });

  it("asks a thing of several terms to be mostly in the question", () => {
    const served = page(
      "USER: I've never approved any holiday medical supply budgets.",
      "USER: I approved the holiday medical supply budgets on Monday.",
    );
    expect(neverClaimConflicts(served, "What is my total budget for holiday gifts this year?")).toEqual([]);
    expect(neverClaimConflicts(served, "Have I approved holiday medical supply budgets?")).toHaveLength(1);
  });

  it("quotes the mention naming the most of the thing, not the first served", () => {
    const served = page(
      "USER: I've also never met Michael or worked on editing timelines.",
      "USER: I met Michael about the editing schedule.",
      "USER: Michael and I met on the editing timelines on Monday.",
    );
    expect(neverClaimConflicts(served, "Have I worked with Michael on editing timelines?")).toEqual([
      {
        claim: "I've also never met Michael or worked on editing timelines.",
        mentions: 2,
        example: "USER: Michael and I met on the editing timelines on Monday.",
      },
    ]);
  });

  it("counts a later part of the claim's own line as nothing, and a repeat that also reports the thing as a mention", () => {
    const repeat = "USER: I have never used Zotero before, but yesterday I opened Zotero 6.";
    expect(neverClaimConflicts(page(NEVER_ZOTERO, repeat), ASKED)).toEqual([
      { claim: "I've never used Zotero, so how do I start", mentions: 1, example: "but yesterday I opened Zotero 6." },
    ]);
  });

  it("reports each thing once however many lines repeat its claim, and at most two things", () => {
    const served = page(
      NEVER_ZOTERO,
      "USER: I have never used Zotero at all.",
      DOWNLOADED,
      "USER: I've never used EndNote, and I've never tried Mendeley.",
      "USER: I used EndNote and Mendeley last week.",
    );
    const reported = neverClaimConflicts(served, "Have I used Zotero, EndNote or Mendeley?");
    expect(reported.map((c) => c.claim)).toEqual([
      "I've never used Zotero, so how do I start",
      "I've never used EndNote, and I've never tried Mendeley.",
    ]);
  });

  it("quotes the claim from its sentence's start, and the mention with its date line", () => {
    const served = page(
      "USER: Honestly, I've never used Zotero.",
      "Date: March-15-2024 USER: I opened Zotero ->-> 2,6 ASSISTANT: Great, I used Zotero too.",
    );
    expect(neverClaimConflicts(served, ASKED)).toEqual([
      { claim: "Honestly, I've never used Zotero.", mentions: 1, example: "Date: March-15-2024 USER: I opened Zotero" },
    ]);
  });

  it("reads at most 64 first-person events in one clause", () => {
    const clause = (events: number) => `${"I opened Mendeley and ".repeat(events - 1)}I used Zotero yesterday.`;
    expect(neverClaimConflicts(page(NEVER_ZOTERO, clause(64)), ASKED)).toHaveLength(1);
    expect(neverClaimConflicts(page(NEVER_ZOTERO, clause(65)), ASKED)).toEqual([]);
  });

  it("quotes at most 200 characters, cut at a word", () => {
    const long = `USER: I downloaded Zotero ${"and tagged a source ".repeat(20)}today.`;
    const [reported] = neverClaimConflicts(page(NEVER_ZOTERO, long), ASKED);
    const kept = reported!.example.slice(0, -1);
    expect(reported!.example.endsWith("…")).toBe(true);
    expect(kept.length).toBeLessThanOrEqual(200);
    expect(long.startsWith(`${kept} `)).toBe(true);
  });
});

// Precision and recall of the whole detector on short pages: one claim, one other record.
// Non-conflicts: 14 QA probes (8 of which fired before this
// table existed), 11 more, 12 from a red-team pass, and QA's delta classes
// with their siblings. Conflicts: 9 written here and 9
// claim/statement pairs from BEAM's contradiction-resolution conversations (MIT licence), cut to
// the two sentences that disagree.
describe("neverClaimConflicts on conflicts and look-alikes", () => {
  type Row = [label: string, query: string, claim: string, other: string];
  const nonConflicts: Row[] = [
    [
      "no claim, a paraphrase",
      "Which reference manager do I use?",
      "I use Zotero for citations.",
      "My Zotero library has 400 items.",
    ],
    [
      "no claim, an update",
      "Where is the standup?",
      "Standup moved to room 4 on Monday.",
      "We hold standup in room 2.",
    ],
    ["no claim, negations only", "Did I use Mendeley?", "I don't use Mendeley.", "I didn't install Mendeley."],
    [
      "a rule, an unrelated record",
      "Can we deploy on a Friday?",
      "We never deploy on Fridays.",
      "Our Friday standup ran long this week.",
    ],
    [
      "a rule, a merge",
      "Can I push straight to main?",
      "We never push to main directly; every change goes through a PR.",
      "I merged my PR into main after review.",
    ],
    [
      "a rule, then an exception",
      "Can we deploy on a Friday?",
      "We never deploy on Fridays.",
      "We deployed the hotfix on Friday.",
    ],
    [
      "a rule, a related act",
      "Do we commit secrets to the repo?",
      "We never commit secrets to the repo.",
      "I rotated our repo secrets yesterday.",
    ],
    ["a habit that agrees", "Have I used Zotero?", "I've never used Zotero.", "I avoid Zotero and keep my own notes."],
    ["a plan", "Have I been to Japan?", "I've never been to Japan.", "I'm planning my first trip to Japan in May."],
    ["someone else's act", "Have I used Zotero?", "I've never used Zotero.", "My advisor recommended Zotero to me."],
    ["a negation", "Have I used Zotero?", "I've never used Zotero.", "I still haven't opened Zotero."],
    ["yet to", "Have I used Zotero?", "I've never used Zotero.", "I have yet to open Zotero."],
    [
      "a first time",
      "Have I given a conference talk?",
      "I had never given a conference talk.",
      "Update: I gave my first conference talk at PyCon in May.",
    ],
    [
      "a rule kept",
      "Do we store passwords in plain text?",
      "We never store passwords in plain text.",
      "We hash our passwords with argon2.",
    ],
    [
      "a plan on the same noun",
      "Have I been late to a client meeting?",
      "I've never been late to a client meeting.",
      "I scheduled my client meeting for 3pm.",
    ],
    ["the team's tool", "Have I used Jira?", "I've never used Jira.", "Our team tracks bugs in Jira."],
    [
      "a booking",
      "Have I been to Berlin?",
      "I've never been to Berlin.",
      "I booked a flight to Berlin for next month.",
    ],
    [
      "another day",
      "Have we shipped on a holiday?",
      "We have never shipped on a holiday.",
      "We shipped the release on Tuesday.",
    ],
    ["a wish", "Have I run a marathon?", "I've never run a marathon.", "I want to run a marathon this fall."],
    [
      "the present",
      "Have I met Priya in person?",
      "I've never met Priya in person.",
      "Priya and I talk on Zoom every week.",
    ],
    ["a question", "Have I used Docker?", "I've never used Docker.", "Should I use Docker for the API?"],
    [
      "someone else's miss",
      "Have I missed a standup?",
      "I've never missed a standup.",
      "Tom missed the standup on Monday.",
    ],
    ["a conditional", "Have I tried sushi?", "I had never tried sushi.", "I would try sushi if you recommend a place."],
    ["the future", "Have I used Zotero?", "I've never used Zotero.", "I'll download Zotero tonight."],
    [
      "in progress",
      "Have I taken a statistics course?",
      "I've never taken a statistics course.",
      "I'm taking a statistics course this spring.",
    ],
    [
      "possession",
      "Have I met attorney Stephanie?",
      "I've never met attorney Stephanie.",
      "I've got a meeting with attorney Stephanie on March 22.",
    ],
    [
      "another act on the same object",
      "Have I deleted the production database?",
      "I've never deleted the production database.",
      "I backed up the production database last night.",
    ],
    [
      "reading about it",
      "Have I written Rust?",
      "I've never written Rust.",
      "I read a blog post about Rust last week.",
    ],
    ["a discussion", "Have I used Zotero?", "I've never used Zotero.", "We discussed Zotero in the lab meeting."],
    ["looking into it", "Have I used Zotero?", "I've never used Zotero.", "I looked into Zotero vs Mendeley."],
    ["used to", "Have I used Zotero?", "I've never used Zotero.", "I used to think Zotero was only for scientists."],
    ["a wish", "Have I used Zotero?", "I've never used Zotero.", "I wish I'd used Zotero for my thesis."],
    ["an unreal past", "Have I used Zotero?", "I've never used Zotero.", "I would have used Zotero if I had known."],
    [
      "installed, never opened",
      "Have I used Docker?",
      "I've never used Docker.",
      "I installed Docker but never opened it.",
    ],
    ["a documentary", "Have I been to Japan?", "I've never been to Japan.", "I watched a documentary about Japan."],
    ["a tour application", "Have I been to Japan?", "I've never been to Japan.", "I've applied for a tour to Japan."],
    ["a cancelled trip", "Have I been to Japan?", "I've never been to Japan.", "I cancelled my trip to Japan."],
    [
      "an email about it",
      "Have I met Priya in person?",
      "I've never met Priya in person.",
      "I emailed Priya about meeting in person.",
    ],
    // QA delta (1): "was"/"were" as a helper is not being there.
    [
      "was + -ing",
      "Have I been to Japan?",
      "I've never been to Japan.",
      "I was planning a trip to Japan but cancelled.",
    ],
    ["was + -ing, about", "Have I been to Japan?", "I've never been to Japan.", "I was reading about Japan yesterday."],
    ["were + -ing", "Have I been to Japan?", "I've never been to Japan.", "We were hoping to visit Japan next year."],
    ["was + participle", "Have I been to Japan?", "I've never been to Japan.", "I was told Japan is expensive."],
    [
      "was + adjective",
      "Have I been to Japan?",
      "I've never been to Japan.",
      "I was curious about Japan's rail passes.",
    ],
    ["been + -ing", "Have I been to Japan?", "I've never been to Japan.", "I've been reading about Japan all week."],
    [
      "was + another adjective",
      "Have I been late to a client meeting?",
      "I've never been late to a client meeting.",
      "I was nervous before the client meeting.",
    ],
    // (2) a question or a supposition says nothing happened.
    [
      "a stored question",
      "Have I used Zotero?",
      "I've never used Zotero.",
      "Have I used Zotero before? I can't remember.",
    ],
    [
      "a question about telling",
      "Have I used Zotero?",
      "I've never used Zotero.",
      "Did I tell you I used Zotero yesterday?",
    ],
    [
      "an inverted conditional",
      "Have I used Zotero?",
      "I've never used Zotero.",
      "Had I used Zotero, I would have saved hours.",
    ],
    ["suppose", "Have I used Zotero?", "I've never used Zotero.", "Suppose I used Zotero, how would tagging work?"],
    ["assume", "Have I used Zotero?", "I've never used Zotero.", "Assume I've used Zotero before when you explain it."],
    [
      "an inversion inside a clause",
      "Have I used Zotero?",
      "I've never used Zotero.",
      "Honestly had I used Zotero I would have saved hours.",
    ],
    [
      "a question to the reader",
      "Have I used Zotero?",
      "I've never used Zotero.",
      "Did you see that I used Zotero yesterday?",
    ],
    // (3) another person's quoted or reported words.
    [
      "quoted speech",
      "Have I used Zotero?",
      "I've never used Zotero.",
      'My sister said, "I used Zotero all through grad school."',
    ],
    [
      "curly-quoted speech",
      "Have I used Zotero?",
      "I've never used Zotero.",
      "My sister said, “I used Zotero all through grad school.”",
    ],
    [
      "reported speech",
      "Have I used Zotero?",
      "I've never used Zotero.",
      "My sister told me I used Zotero wrong in her class.",
    ],
    [
      "a quoted claim, someone else's",
      "Have I used Zotero?",
      'My advisor wrote: "I\'ve never used Zotero."',
      "I used Zotero yesterday.",
    ],
    // (4) a claim bounded in time is not contradicted by a later act.
    ['a leading "until"', "Have I used Zotero?", "Until March, I had never used Zotero.", "I used Zotero in April."],
    [
      'a leading "before"',
      "Have I been to Japan?",
      "Before college I'd never been to Japan.",
      "I went to Japan in 2021.",
    ],
    ['a trailing "until"', "Have I used Zotero?", "I had never used Zotero until March.", "I used Zotero in April."],
    // The thing acted on must be the claim's thing (BEAM c4-multi-session-1, c19-CR-0).
    [
      "a sibling object",
      "Have I ever worked on triangle classification problems before?",
      "I've never attempted any triangle classification problems before.",
      "I scored 18/20 on my practice test involving triangle congruence proofs and similarity ratio problems.",
    ],
    [
      "the thing beside another act",
      "Have I met attorney Stephanie to discuss my will?",
      "I've never met attorney Stephanie.",
      "I was wondering if attorney Stephanie's review on May 1 confirms that I've met all the requirements for a valid will.",
    ],
    ["an alternative", "Have I used Zotero?", "I've never used Zotero.", "I used Mendeley instead of Zotero."],
    // CONTRADICTING_ACTS: an act not listed for the claim's verb.
    ["try, another act", "Have I tried sushi?", "I've never tried sushi.", "I ordered sushi for the team yesterday."],
    [
      "work, another act",
      "Have I worked with Priya?",
      "I've never worked with Priya.",
      "I emailed Priya about the launch deck yesterday.",
    ],
    [
      "listen, another act",
      "Have I listened to the Serial podcast?",
      "I've never listened to the Serial podcast.",
      "I downloaded the Serial podcast yesterday.",
    ],
    // Red-team round 3 (mention side). The act's object is not the thing:
    ["a review of it", "Have I read Dune?", "I've never read Dune.", "I read a review of Dune last week."],
    [
      "a place themed on it",
      "Have I visited Paris?",
      "I've never visited Paris.",
      "I visited a Paris-themed cafe in Ohio.",
    ],
    [
      "someone's possession",
      "Have I met attorney Stephanie?",
      "I've never met attorney Stephanie.",
      "I met attorney Stephanie's paralegal.",
    ],
    [
      "another tool, for it",
      "Have I used Zotero?",
      "I've never used Zotero.",
      "I used Word to read the Zotero manual.",
    ],
    [
      "a thing named for it",
      "Have I used Zotero?",
      "I've never used Zotero.",
      "I worked on the Zotero comparison slide.",
    ],
    [
      "a sibling object with the other term after",
      "Have I written a Python script?",
      "I've never written a Python script.",
      "I wrote a Bash script that calls Python.",
    ],
    [
      "was in a meeting about it",
      "Have I been to Japan?",
      "I've never been to Japan.",
      "I was in a meeting about Japan yesterday.",
    ],
    ["was to", "Have I been to Japan?", "I've never been to Japan.", "I was to visit Japan but it got cancelled."],
    [
      "been to an event named for it",
      "Have I been to Japan?",
      "I've never been to Japan.",
      "I've been to the Japan Society event in NYC.",
    ],
    // a question, hedge or report around the act:
    ["a tag question", "Have I used Zotero?", "I've never used Zotero.", "I used Zotero, didn't I?"],
    ["a hedge after", "Have I used Zotero?", "I've never used Zotero.", "I used Zotero, I think."],
    ["a hedge before", "Have I used Zotero?", "I've never used Zotero.", "Maybe I used Zotero back then."],
    ["a clause asked", "Have I used Zotero?", "I've never used Zotero.", "So I used Zotero for this?"],
    ['"or was it"', "Have I used Zotero?", "I've never used Zotero.", "I used Zotero — or was it Mendeley?"],
    ['"rather"', "Have I used Zotero?", "I've never used Zotero.", "I'd rather we used Zotero."],
    [
      '"according to"',
      "Have I used Zotero?",
      "I've never used Zotero.",
      "According to my sister, I used Zotero in college.",
    ],
    ["a colon", "Have I used Zotero?", "I've never used Zotero.", "My sister: I used Zotero for my thesis."],
    ['"she was like"', "Have I used Zotero?", "I've never used Zotero.", "She was like, I used Zotero for my thesis."],
    [
      "curly single quotes",
      "Have I used Zotero?",
      "I've never used Zotero.",
      "My sister's email reads ‘I used Zotero for my thesis’.",
    ],
    // coordination and alternatives:
    [
      "another person's act before mine",
      "Have I used Zotero?",
      "I've never used Zotero.",
      "Sam used Zotero and I used EndNote.",
    ],
    ["neither", "Have I used Zotero?", "I've never used Zotero.", "I used neither Zotero nor Mendeley."],
    ['"over"', "Have I used Zotero?", "I've never used Zotero.", "I used Mendeley over Zotero."],
    ["a semicolon", "Have I used Zotero?", "I've never used Zotero.", "I used EndNote; Zotero is what Sam uses."],
    [
      "a question typed without a question mark",
      "Have I used Zotero?",
      "I've never used Zotero.",
      "Did you see that I used Zotero yesterday.",
    ],
    [
      '"or was it" without a question mark',
      "Have I used Zotero?",
      "I've never used Zotero.",
      "I used Zotero — or was it Mendeley.",
    ],
    [
      "a sibling object as the act's object",
      "Have I ever worked on triangle classification problems before?",
      "I've never attempted any triangle classification problems before.",
      "I solved some triangle congruence problems.",
    ],
    [
      "another's act before mine, with the thing",
      "Have I met Priya?",
      "I've never met Priya.",
      "Sam met Priya and I met Tom.",
    ],
  ];
  const conflicts: Row[] = [
    [
      "an act on the thing",
      "Have I used Zotero?",
      "I've never used Zotero.",
      "I opened Zotero last night and exported my library.",
    ],
    [
      "a team deploy",
      "Did we ever deploy on a Friday?",
      "We have never deployed on a Friday.",
      "We deployed the billing fix on Friday night.",
    ],
    [
      "the same verb",
      "Have I met Priya in person?",
      "I've never met Priya in person.",
      "I met Priya in person at the Austin offsite.",
    ],
    [
      "a perfect",
      "Have we deployed the billing service on a Friday?",
      "We have never deployed the billing service on a Friday.",
      "We've deployed the billing service on a Friday twice this quarter.",
    ],
    [
      "someone else and I",
      "Have I missed a standup?",
      "I've never missed a standup.",
      "Tom and I missed the standup on Monday.",
    ],
    ["a state in the past", "Have I been to Japan?", "I've never been to Japan.", "We were in Japan last spring."],
    [
      "an irregular past",
      "Have I run a marathon?",
      "I've never run a marathon.",
      "I ran a marathon in Boston in April.",
    ],
    ["a first use", "Have I used Zotero?", "I've never used Zotero.", "I first used Zotero in 2019."],
    [
      "and another verb",
      "Have I used Zotero?",
      "I've never used Zotero.",
      "I downloaded Zotero on March 2 and tagged forty sources with it.",
    ],
    [
      "BEAM 1",
      "Have I worked with Flask routes and handled HTTP requests in this project?",
      "I've never written any Flask routes or handled HTTP requests in this project.",
      "I've already implemented basic homepage route with Flask and tested response time.",
    ],
    [
      "BEAM 2",
      "Have I obtained an API key for this project?",
      "I've never actually obtained an API key for this project.",
      "I've configured the `OPENWEATHER_API_KEY` in my `.env` file for local development.",
    ],
    [
      "BEAM 5",
      "Have I completed any coin toss problems before?",
      "I've never completed any coin toss problems before.",
      "I've already completed 5 coin toss problems with 80% mastery of simple probability ratios.",
    ],
    [
      "BEAM 8",
      "Have I submitted my cover letter to Greg for review?",
      "I've never submitted my cover letter to Greg for review.",
      "I've submitted my cover letter to Greg for review on April 10.",
    ],
    [
      "BEAM 11",
      "Have I ever implemented two-factor authentication for platform access?",
      "I've never implemented two-factor authentication for any platform access.",
      "I'm not sure our security measures, like the two-factor authentication we set up on April 20, are sufficient.",
    ],
    [
      "BEAM 13",
      "Have I ever met Kelly at any book club or library event?",
      "I've never met Kelly at any book club or library event.",
      "I met Kelly at the East Janethaven Library book club on October 12.",
    ],
    [
      "BEAM 15",
      "Have I ever met Kyle or been to any sneaker expos?",
      "I've never met anyone like Kyle or been to sneaker expos.",
      "I met Kyle back in 2018 at a sneaker expo in Bridgetown.",
    ],
    [
      "BEAM 18",
      "Have I ever delegated any of my tasks to Greg or other colleagues?",
      "I've never actually delegated tasks to Greg or any other colleague.",
      "I delegated 30% of my editing tasks to Greg starting April 2.",
    ],
    [
      "BEAM 19",
      "Have I ever used WillMaker Pro or any digital software to draft my will?",
      "I've never used WillMaker Pro or any digital software to draft my will.",
      'I\'m trying to finalize my will and I used "WillMaker Pro" software.',
    ],
    // Siblings of the QA delta guards that must still fire.
    ["been to a place", "Have I been to Japan?", "I've never been to Japan.", "I've been to Japan twice for work."],
    [
      "was at a place",
      "Have I been to a sneaker expo?",
      "I've never been to a sneaker expo.",
      "I was at the sneaker expo in Bridgetown last spring.",
    ],
    [
      "was + the claim's own word",
      "Have I been late to a client meeting?",
      "I've never been late to a client meeting.",
      "I was late to the client meeting on Monday.",
    ],
    [
      "a question, then a statement",
      "Have I used Zotero?",
      "I've never used Zotero.",
      "Did you know? I used Zotero yesterday.",
    ],
    ["a leading time", "Have I used Zotero?", "I've never used Zotero.", "Yesterday, I used Zotero for my thesis."],
    [
      "a quoted title",
      "Have I read Elbow Room?",
      'I\'ve never read "Elbow Room".',
      'I finished "Elbow Room" last week.',
    ],
    ["a leading word kept", "Have I used Zotero?", "Honestly, I've never used Zotero.", "I opened Zotero last night."],
    [
      '"before" with no bound',
      "Have I attempted triangle classification problems?",
      "I've never attempted any triangle classification problems before, but I want to.",
      "I've completed 10 classification problems.",
    ],
    [
      "the object without a modifier",
      "Have I ever worked on triangle classification problems before?",
      "I've never attempted any triangle classification problems before.",
      "I've completed 10 classification problems.",
    ],
    [
      "the object after its act",
      "Have I met attorney Stephanie?",
      "I've never met attorney Stephanie.",
      "I met attorney Stephanie on May 1 to review my will.",
    ],
    ["try", "Have I tried sushi?", "I've never tried sushi.", "I ate sushi in Osaka last week."],
    [
      "work",
      "Have I worked with Priya?",
      "I've never worked with Priya.",
      "I collaborated with Priya on the launch deck last month.",
    ],
    [
      "listen",
      "Have I listened to the Serial podcast?",
      "I've never listened to the Serial podcast.",
      "I finished the Serial podcast last week.",
    ],
    ["a co-subject", "Have I met Priya?", "I've never met Priya.", "Priya and I met for coffee on Monday."],
    [
      "the claim's second alternative",
      "Have I attended workshops or professional development events?",
      "I've never attended any workshops or professional development events.",
      "I attended the Workflow Optimization workshop yesterday.",
    ],
    [
      "a quantity of the thing",
      "Have I delegated tasks to Greg?",
      "I've never delegated tasks to Greg.",
      "I delegated 30% of my editing tasks to Greg starting April 2.",
    ],
    [
      "an identifier holding the thing",
      "Have I obtained an API key?",
      "I've never obtained an API key.",
      "I've configured the `OPENWEATHER_API_KEY` in my `.env` file.",
    ],
  ];
  // Real conflicts these words miss: the act is not one that contradicts the claim's verb, or
  // the thing is split from it. Pinned so a fix shows up here.
  const missed: Row[] = [
    [
      "BEAM 20, another verb",
      "Have I ever attended production meetings related to my invention?",
      "I've never attended any production meetings related to my invention.",
      "I shared some insights about the patent process with Heather during our production meeting on May 1.",
    ],
    [
      "a comma inside the thing",
      "Have I been to Japan?",
      "I've never been to Japan.",
      "I visited Tokyo, Japan in 2019.",
    ],
    [
      "the thing as a modifier of the act's object",
      "Have I used Zotero?",
      "I've never used Zotero.",
      "I exported my Zotero library last night.",
    ],
    ["the present tense", "Have I been to Japan?", "I've never been to Japan.", "I'm in Japan right now!"],
  ];
  it("checks at most ten distinct claims about the question, in served order", () => {
    const tools = "alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo".split(" ");
    const claims = tools.map((tool) => `I've never used ${tool}.`);
    const query = `Have I used ${tools.join(", ")}?`;
    expect(neverClaimConflicts(page(...claims, "I used kilo yesterday."), query)).toEqual([]);
    expect(neverClaimConflicts(page(...claims.slice(1), "I used kilo yesterday."), query)).toHaveLength(1);
  });

  const fires = (query: string, claim: string, other: string) =>
    neverClaimConflicts(page(claim, other), query).length > 0;

  it.each(nonConflicts)("stays quiet on %s", (_label, query, claim, other) =>
    expect(fires(query, claim, other)).toBe(false),
  );
  it.each(conflicts)("reports %s", (_label, query, claim, other) => expect(fires(query, claim, other)).toBe(true));
  it.each(missed)("misses %s", (_label, query, claim, other) => expect(fires(query, claim, other)).toBe(false));
});
