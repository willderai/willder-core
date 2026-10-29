// Whether an answer written from memory says only what its served facts say
// (services/memory/answer-grounding.ts).
import { describe, expect, it } from "vitest";
import {
  AnswerGrounder,
  figuresIn,
  groundAnswer,
  isAboutTheQuestion,
  questionTerms,
  servedFactTerms,
} from "./answer-grounding";

/** An organization's memory that holds nothing about the release asked of it, as Ask served it. */
const UNRELATED = [
  "severity is currently ship-before-users at zero users.",
  "Root files that ship are in every set.",
  "the release train leaves on Tuesday",
  "Date: November-05-2023\nUSER: Sounds good! I'll send her that message and see what she says.\n\nASSISTANT: You're welcome! Good luck, and I hope you both enjoy the book club together!",
  "ActorPicker's goal is to ship minimal retry/refetch correctness fix now.",
  "The scorer pin a4ca6a7a matches release CHECKSUMS.",
  "The release train leaves on Wednesday.",
];
const MARKER = "Seeded test record 8196: the Bokaro Torromi release ships on day 18 of the cycle.";
const QUESTION = "When does the Bokaro Torromi release ship?";

const about = (question: string, text: string, similarity?: number) =>
  isAboutTheQuestion([questionTerms(question)], { terms: servedFactTerms(text).terms, similarity });

describe("isAboutTheQuestion", () => {
  it("finds no fact about a question when every fact shares only a common word with it", () => {
    expect(UNRELATED.filter((text) => about(QUESTION, text))).toEqual([]);
  });

  it("finds the fact that names what the question asks about", () => {
    expect(about(QUESTION, MARKER)).toBe(true);
  });

  it("counts a fact the vector search found close to the question, whatever words it shares", () => {
    expect(about(QUESTION, "Shipping for the autumn cycle is on track.", 0.8)).toBe(true);
    expect(about(QUESTION, "Shipping for the autumn cycle is on track.", 0.6)).toBe(false);
  });

  it("matches inflections and ignores how the question is asked", () => {
    expect(about("Can you remember when the invoices were shipped?", "Invoice shipping happens on Fridays.")).toBe(
      true,
    );
  });

  it("is about any wording of the question, so a search that resolved 'it' still counts", () => {
    const wordings = [questionTerms("and when does it ship?"), questionTerms("Bokaro Torromi release ship date")];
    expect(isAboutTheQuestion(wordings, { terms: servedFactTerms(MARKER).terms })).toBe(true);
  });

  it("counts every fact for a question with no terms, which cannot be judged", () => {
    expect(about("What is it?", "Anything at all.")).toBe(true);
  });
});

describe("figuresIn", () => {
  it("reads a day beside its month as one date, either way round, and a year", () => {
    expect([...figuresIn("It leaves on November 5, 2023.")].sort()).toEqual(["11-5", "2023"]);
    expect([...figuresIn("Date: November-05-2023")].sort()).toEqual(["11-5", "2023"]);
    expect([...figuresIn("due on the 1st of June")]).toEqual(["6-1"]);
    expect([...figuresIn("logged 2024-03-15")].sort()).toEqual(["2024", "3-15"]);
  });

  it("reads amounts, decimals and percentages, without separators", () => {
    expect([...figuresIn("It costs $1,200 a month, 2.5 times more, a 15% rise.")].sort()).toEqual([
      "1200",
      "15",
      "2.5",
    ]);
  });

  it("reads a dotted version whole, as a fact writes it", () => {
    expect([...figuresIn("Flask-Login v0.6.2 on Bootstrap 5.3.0")].sort()).toEqual(["0.6.2", "5.3.0"]);
  });

  it("leaves a small bare number out: it may be a count the answer worked out", () => {
    expect([...figuresIn("There are 4 weeks between them, on day 18.")]).toEqual([]);
  });
});

describe("groundAnswer", () => {
  const served = (texts: string[]) => texts.map(servedFactTerms);

  it("removes the made-up answer whose date its cited fact does not hold", () => {
    const answer = "The Bokaro Torromi release ship is scheduled to leave on November 5, 2023 [1].";
    expect(groundAnswer(answer, served(UNRELATED), QUESTION)).toEqual({
      text: "",
      removedSentences: 1,
      removedCitations: 0,
    });
  });

  it("keeps a sentence its cited fact states", () => {
    const answer = "The Bokaro Torromi release ships on day 18 of the cycle [8].";
    expect(groundAnswer(answer, served([...UNRELATED, MARKER]), QUESTION)).toEqual({
      text: answer,
      removedSentences: 0,
      removedCitations: 0,
    });
  });

  // Word overlap is no evidence a citation is wrong: a correct paraphrase shares few words.
  it("keeps a paraphrase citing the right fact, however few words they share", () => {
    const answer = "Acme must re-sign by November 1 [1].";
    expect(
      groundAnswer(answer, served(["The Acme renewal is due on 1 November."]), "When is Acme's renewal?").text,
    ).toBe(answer);
  });

  it("removes a citation to a fact that was not served and keeps the sentence", () => {
    const result = groundAnswer(
      "The Bokaro Torromi release ships on day 18 of the cycle [5][9].",
      served([...UNRELATED, MARKER]),
      QUESTION,
    );
    expect(result).toEqual({
      text: "The Bokaro Torromi release ships on day 18 of the cycle [5].",
      removedSentences: 0,
      removedCitations: 1,
    });
  });

  it("reads a citation list written with commas", () => {
    const result = groundAnswer(
      "The Bokaro Torromi release ships on day 18 of the cycle [8, 12].",
      served([...UNRELATED, MARKER]),
      QUESTION,
    );
    expect(result.text).toBe("The Bokaro Torromi release ships on day 18 of the cycle [8].");
  });

  it("removes a cited sentence whose date its cited fact does not hold, though another day number matches", () => {
    expect(
      groundAnswer("The Bokaro Torromi release ships on November 18 [1].", served([MARKER]), QUESTION).removedSentences,
    ).toBe(1);
  });

  it("checks a cited sentence against the facts it cites, not every fact served", () => {
    // Fact 4 holds November 5; the sentence cites fact 8, which does not.
    const result = groundAnswer(
      "The Bokaro Torromi release ships on November 5 [8].",
      served([...UNRELATED, MARKER]),
      QUESTION,
    );
    expect(result.removedSentences).toBe(1);
  });

  it("checks a sentence whose every citation was unserved as an uncited one", () => {
    const facts = served([...UNRELATED, MARKER]);
    expect(groundAnswer("It was set on November 5 [9].", facts, QUESTION)).toEqual({
      text: "It was set on November 5.",
      removedSentences: 0,
      removedCitations: 1,
    });
    expect(groundAnswer("It was set on March 3 [9].", facts, QUESTION)).toEqual({
      text: "",
      removedSentences: 1,
      removedCitations: 1,
    });
  });

  it("keeps a date the question itself states", () => {
    const answer = "It is not on March 3; it ships on day 18 of the cycle [1].";
    expect(groundAnswer(answer, served([MARKER]), "Does the Bokaro Torromi release ship on March 3?").text).toBe(
      answer,
    );
  });

  it("removes an uncited sentence stating a figure no served fact holds, and keeps the rest", () => {
    const answer = "The Bokaro Torromi release ships on day 18 of the cycle [1]. It was first planned for 2023.";
    expect(groundAnswer(answer, served([MARKER]), QUESTION)).toEqual({
      text: "The Bokaro Torromi release ships on day 18 of the cycle [1].",
      removedSentences: 1,
      removedCitations: 0,
    });
  });

  it("keeps an uncited figure some served fact holds", () => {
    const answer = "The scorer pin is a4ca6a7a, checked in 2026.";
    expect(
      groundAnswer(answer, served(["The scorer pin a4ca6a7a was checked in 2026."]), "What is the scorer pin?").text,
    ).toBe(answer);
  });

  it("keeps a count worked out from the cited facts' dates", () => {
    const facts = served(["The draft review meeting is on March 22.", "The mock interview is on April 18."]);
    const answer =
      "There are 27 days between the draft review meeting on March 22 and the mock interview on April 18 [1][2].";
    expect(groundAnswer(answer, facts, "How many days between the draft review and the mock interview?").text).toBe(
      answer,
    );
  });

  it("keeps lines and list markers, dropping a line whose every sentence was removed", () => {
    const answer =
      "Two things are known:\n- The Bokaro Torromi release ships on day 18 of the cycle [8].\n- It leaves on November 5, 2023 [2].\n1. It ships on March 3 [8].";
    expect(groundAnswer(answer, served([...UNRELATED, MARKER]), QUESTION)).toEqual({
      text: "Two things are known:\n- The Bokaro Torromi release ships on day 18 of the cycle [8].",
      removedSentences: 2,
      removedCitations: 0,
    });
  });

  it("treats a citation after the full stop as part of its sentence", () => {
    const result = groundAnswer(
      "The Bokaro Torromi release ships on day 18 of the cycle. [1] Version 2.5 is unrelated.",
      served([MARKER]),
      QUESTION,
    );
    expect(result.text).toBe("The Bokaro Torromi release ships on day 18 of the cycle. [1]");
    expect(result.removedSentences).toBe(1);
  });

  it("leaves an answer with no citations and no figures as written", () => {
    const answer = "Memory does not say when it ships.";
    expect(groundAnswer(answer, served(UNRELATED), QUESTION)).toEqual({
      text: answer,
      removedSentences: 0,
      removedCitations: 0,
    });
  });
});

describe("AnswerGrounder", () => {
  const facts = [...UNRELATED, MARKER].map(servedFactTerms);

  it("releases each sentence once it is complete and checked, so the answer can stream", () => {
    const grounder = new AnswerGrounder(facts, QUESTION);
    expect(grounder.push("The Bokaro Torromi release ships on day 18 ")).toBe("");
    expect(grounder.push("of the cycle [8]. It left on November 5, 2023 [1]. It")).toBe(
      "The Bokaro Torromi release ships on day 18 of the cycle [8].",
    );
    expect(grounder.push(" ships from the main line [8].")).toBe("");
    expect(grounder.end()).toBe(" It ships from the main line [8].");
    expect(grounder.removedSentences).toBe(1);
  });

  it("waits for a citation written after the full stop before releasing the sentence", () => {
    const grounder = new AnswerGrounder(facts, QUESTION);
    expect(grounder.push("It ships on day 18 of the cycle.")).toBe("");
    expect(grounder.push(" [8] Then")).toBe("It ships on day 18 of the cycle. [8]");
  });

  it("checks against facts served after it was made", () => {
    const later: ReturnType<typeof servedFactTerms>[] = [];
    const grounder = new AnswerGrounder(later, QUESTION);
    later.push(servedFactTerms(MARKER));
    expect(grounder.push("It ships on day 18 of the cycle [1].") + grounder.end()).toBe(
      "It ships on day 18 of the cycle [1].",
    );
  });

  it("streams the same text the whole answer grounds to", () => {
    const answer =
      "Two things are known:\n- It ships on day 18 of the cycle [8].\n- It leaves on November 5, 2023 [2].\nThat is all [8][9].";
    const grounder = new AnswerGrounder(facts, QUESTION);
    const streamed = [...answer].map((char) => grounder.push(char)).join("") + grounder.end();
    expect(streamed).toBe(groundAnswer(answer, facts, QUESTION).text);
  });
});
