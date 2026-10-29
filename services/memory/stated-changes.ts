// What a stored record's text states: the values its sentences give, and the changes it asserts.
//
// update-links.ts asks two questions of a record's words. Of an answer's first line: which
// values does it state about the queried thing (`statementsOf`)? Of a later line: which named
// thing does it say changed, and to what value (`changesOf`)? Both are lexical and English only,
// with no model asked.
//
// The one rule: a change is read only where the words plainly assert it, because what is read
// here moves a later record above the answer's first line and marks that line. A change is one
// of four shapes, "<thing> was increased to <value>", "I increased <thing> to <value>" (with the
// person, "I" or "we", as its subject), "my new <thing> of <value>" and "<thing> is now <value>",
// said by the person: in text no speaker label opens, or under a "User:", "Human:", "Me:" or
// "You" label, never in a quoted line or after a line that ends in a colon. Its clause must not
// be denied, asked, conditional, wished, planned, proposed, reported second hand, dated to
// another time, temporary or undone, and its sentence must not open with a time, place,
// condition or question verb ("Last year, …", "Do you remember …"). Each of those is a word
// list below: a qualifier worded some other way is not seen, which is the limit of a lexical
// reader. Anything this does not read as a change leaves the answer as ranked.
import {
  MONTH,
  STOPWORDS,
  attributeTerms,
  capitalsChosen,
  firstWordAfter,
  folded,
  periodOf,
  termSequence,
  valuesOf,
  wordSet,
  wordsOf,
  type Value,
  type Word,
} from "./stated-values";

/** Past forms of change: "was increased to $550", "I adjusted the budget to $450", "my increased budget of $650". */
const CHANGE_VERBS = wordSet(
  "updated changed adjusted increased decreased improved reduced extended rescheduled moved revised " +
    "raised lowered dropped grew rose fell pushed postponed shifted shortened lengthened expanded bumped cut reached",
);
/** Words that open a noun phrase and are not part of it. */
const DETERMINERS = wordSet("the my our your his her their a an this that these those its");
/** Owners other than the asker: "her rent was raised" is not the asker's rent, unless the query asks about hers. */
const OTHER_OWNERS = wordSet("your his her their its");
const PRONOUNS = wordSet("i we you he she they it me us them one");
/** Prepositions a thing's name may run through once: "the budget for groceries", "the meeting with Professor Danielle". */
const NAME_PREPOSITIONS = wordSet("of in for on with");
/** Prepositions whose object is never the thing a change is said of: "the reminder for my meeting", "the fee at Acme". */
const PREPOSITIONS = wordSet(
  "of in for on with at about from to by into onto over under after before during near than via per like regarding around behind",
);
/** Words between a thing and its past change: "has recently been", "was just". */
const AUXILIARIES = wordSet(
  "was were has have been got just now finally recently officially also again already since then further significantly slightly actually",
);
/** Words that may stand before a thing's name at the start of its clause: "since my final draft reached …". */
const CLAUSE_LEAD = wordSet(
  "and but so since because while whereas although though however when after before which or then especially also just",
);
/** Adverbs that may stand between a verb of change and its "to": "was adjusted again, to $600". */
const ADVERBS = wordSet(
  "again further slightly significantly officially finally recently now just already back down up",
);
/** Particles after an object: "cut it down to 5 hours". */
const PARTICLES = wordSet("down up back off out");
/** Words that make a clause conditional, possible or imagined, wherever they stand in it. */
const HYPOTHETICAL = wordSet(
  "if unless whether would could might may should can cannot suppose supposing imagine imagining hypothetically maybe perhaps possibly " +
    "assume assuming provided providing case once until dream dreaming pretend say example scenario would-be",
);
/** Words that make a change wished, planned, proposed, asked for or still to be checked, not made. */
const INTENT = wordSet(
  "consider considering considered suggest suggested suggesting suggests propose proposed proposing proposes " +
    "recommend recommended recommending want wanted wants wish wished hope hoped hoping plan plans planned planning " +
    "ask asked asking request requested will going gonna aim aiming intend intended expect expected expecting need needs needed let's " +
    "offer offered counteroffer proposal option idea please confirm check verify approval approve sign-off",
);
/** Words that make a change second hand or unsure, anywhere in the person's words of a record: "Alexis said the budget was increased", "… was raised, I think". */
const HEARSAY = wordSet(
  "said says say told tells claim claims claimed apparently reportedly supposedly allegedly rumored rumoured heard hear think thinks " +
    "believe believes guess mentioned mention texted emailed messaged wrote informed notified according",
);
/** Words that date a change away from now: "two years ago", "next month", "originally". */
const ANOTHER_TIME = wordSet(
  "ago last originally previously formerly initially next tomorrow soon upcoming eventually",
);
const NEGATIONS = /^(?:not|never|no|nor|neither|nobody|cannot|\p{L}+n't)$/u;
/** The subjects a change the person made is said with: "I've adjusted …", "we cut …". */
const PERSON_SUBJECTS = wordSet("i we i've we've");
/** Verbs after which "to <change>" reports a change made: "I've managed to cut it down to 5 hours". */
const MANAGED = wordSet("managed able");
/** Words that undo or doubt a change anywhere in its sentence: "…; I refused", "…, but that was a mistake". */
const REVERSALS = wordSet(
  "refused rejected declined denied cancelled canceled reverted reversed undone undid retracted withdrew withdrawn vetoed " +
    "mistake mistakenly erroneously incorrectly wrongly wrong bug glitch error false fake scam doubt unlikely dreams",
);
/** Phrases that undo, bound, date or fictionalize a change anywhere in its sentence. */
const QUALIFYING_PHRASES = new RegExp(
  String.raw`\b(?:` +
    [
      String.raw`said no|turned (?:it |that )?down|fell through|rolled back|back in|used to|yeah right|or so|read that`,
      String.raw`this (?:week|month|year|time|summer|winter|spring|fall)|so far|for now|only|temporar(?:y|ily)|tentative(?:ly)?`,
      String.raw`provisional(?:ly)?|pending|awaiting|trial|if needed|effective|kicks? in|for (?:the )?holidays?`,
      String.raw`for ${MONTH}|in ${MONTH}|in (?:19|20)\d\d|every \w+ (?:days|weeks|months|years)|per (?!(?:day|week|month|quarter|year)\b)\w+`,
      String.raw`for (?:a|an|one|the|this|that|\w+) (?:days?|weeks?|months?|quarters?|years?)|for q[1-4]|in q[1-4]|for (?:19|20)\d\d`,
      String.raw`back when|when (?:i|we) (?:was|were|lived|had|used)|during|in (?:college|school|high school)|as a (?:kid|child|student)`,
      String.raw`game|simulation|test entry|role ?play|hypothetical`,
    ].join("|") +
    String.raw`)\b`,
  "i",
);
/** Words a sentence that opens with is conditioned or dated: "Last year, …", "When I lived in Boston …", "Each summer …". */
const CONDITIONED_OPENERS = wordSet(
  "before when after if once until while in during as unless whenever each every sometimes starting from back according last next yeah " +
    "at for on with among within",
);
/** Words in any of the person's sentences that make a whole record second hand, imagined or about someone else. */
const RECORD_CONTEXT = wordSet(
  "scenario scenarios dream dreamed dreamt dreaming hypothetically planning sister brother mom dad mother father parents friend son daughter wife husband " +
    "boss coworker colleague neighbor roommate",
);
/** Words around a first line's value that make it something other than the thing's value: "$480 spent", "$120 left". */
const NOT_THE_VALUE = wordSet(
  "spent spend spending left remaining remains covers cover covered allows allow allowed used saved owe owed paid costs cost",
);
/** Words that open a question when they open a clause: "was my budget increased to $550". */
const INVERTED = wordSet("was is has did do does are were have had can could will would should");
/** With a negation in its clause, a word that says the change did not happen: "but it didn't happen". */
const DID_NOT_HAPPEN = wordSet("happen happened through approved");
/** Phrases that take back what a record says: "Never mind, it's still $500.", "… jk". */
const RETRACTIONS =
  /\b(?:never ?mind|scratch that|disregard|ignore (?:that|this)|i was wrong|my mistake|correction|oops|i mean\b|i meant\b|just kidding|jk\b|not really|actually no|wait, no)/;
/** Words that open a clause as its subject: after "and", they start a new statement, not a list ("… and I'm relieved"). */
const NEW_SUBJECTS = wordSet("i i'm i've we we're we've you he she they it that this there so then");
/** Words that open a new clause; a clause's conditions do not reach into the next one. */
const CLAUSE_OPENERS = wordSet(
  "and but so since because while whereas although though however when after before which or then",
);
/** Words that open a question clause after a statement: "I've increased it to $550, how should I spend it?". */
const QUESTION_OPENERS = wordSet(
  "how what can could would should do does did is are will which where when why any may shall",
);
/** Words after a value that make it a difference or a bound, not the thing's value: "$50 more than last month", "$550 max". */
const DIFFERENCES = wordSet(
  "more less over above below under short extra higher lower fewer off max maximum min minimum bigger smaller too behind ahead",
);
/**
 * Prepositions that, after a value, can put it on another thing: "for my side business", "in the
 * Seattle branch", "across the APAC region", "through the staffing agency", "by the board". "On"
 * counts only after a "to <value>" change ("to $10,000 on Sam's project"): after "my increased
 * budget of $50", "on a new series" says what the money is spent on.
 */
const SCOPE_PREPOSITIONS = wordSet(
  "for in at on across within inside outside under among throughout per through thru via by with w from toward towards beyond alongside upon",
);
/**
 * After-value phrases that name no other thing: "for good", "for everyone", "at my annual review".
 * Only the whole phrase is neutral: "for everyone on the Denver team" names the Denver team.
 */
const NEUTRAL_SCOPE = /^(?:good|everyone|everybody|sure|(?:my|our|the) (?:annual|yearly) review)$/;
/** Words joining a value to the changed one just before it: "rescheduled to March 22 at 4:30 PM". */
const JOINED = wordSet("at on by");
/** The most words a thing's name may have. */
const MAX_NAME_WORDS = 6;
/** A longer sentence is data (a table, a code block, a list run together), not a statement; it is skipped. */
const MAX_SENTENCE_CHARS = 2_000;
/**
 * Sentence ends: `.`, `!` or `?` (with any closing quote or bracket) before a space and a
 * character that can open a sentence. "Mar. 22" and "4 p.m. the sync" stay one sentence. Line
 * breaks end a sentence too (`sentencesOf` reads a text line by line).
 */
const SENTENCE_END = /(?<=[.!?])["')\]]*\s+(?=[^\p{Ll}\p{N}])/u;
/** Where a first line's sentence turns to another subject: "...hasn't moved, but rent was increased". */
const TURN = /;|\s[-–—]\s|,?\s+(?:but|while|whereas|although|though|however)\s+/i;
/** A speaker label opening a line: "USER: ", "**Assistant:** ", "Nurse Janelle (nurse): ", "Alexis — ", "## ChatGPT", "[user] ". */
const LINE_LABEL =
  /^\s*(?:#{1,6}\s*([\p{L}][\p{L}\p{N} .'’-]{0,30}?)\s*$|\[([\p{L}][\p{L}\p{N} .'’-]{0,30}?)\]\s*|\**([\p{L}][\p{L}\p{N} .'’-]{0,30}?(?:\s?\([^)\n]{0,30}\))?)\**\s?(?::|[—–]|-(?=\s))\**\s*)/u;
/** A role label inside a line: "… ->-> 2,22 ASSISTANT: …". The lookbehind keeps a run of "*" linear. */
const INLINE_LABEL =
  /(?<![\p{L}\p{N}*])\**(user|human|me|assistant|ai|bot|agent|system|model|claude|chatgpt|gpt|gemini|copilot|bard|siri|alexa|response|answer)\**\s?:\**\s/giu;
/** The labels the person writes under. */
const PERSON_LABEL = /^(?:user|human|me|you)$/i;
/** A clause boundary at the end of a word: "budget," or "fees;". */
const ENDS_CLAUSE = /[,;)]$/;

/** A value a first line states, with the terms within a few words of it: the thing it is the value of. */
export interface StatedValue extends Value {
  near: Set<string>;
  /** False when the words around it make it something else: spent, left, someone else's, conditional. */
  isTheValue: boolean;
}

/** How many words either side of a first line's value name the thing it is the value of. */
const NEAR_WORDS = 4;

/** A part of a first line's sentence that names the queried thing and states values. */
export interface Statement {
  /** The query terms the part names. */
  terms: Set<string>;
  /** Every term the part names. */
  allTerms: Set<string>;
  /** The part's terms in order, with "" where a stopword, number or clause end breaks a name. */
  sequence: string[];
  values: StatedValue[];
  /** The periods the part names, by modifier or after a value. */
  periods: Set<string>;
}

/** The thing a change is said of: its head noun, every term of its name, and the terms after its head ("budget for dining"). */
interface Thing {
  head: string;
  name: string[];
  after: string[];
}

/** A change a later line asserts: the thing that changed, the value it changed to, and the one it changed from when said. */
export interface Change extends Thing {
  value: Value;
  from?: Value;
  /** The values its sentence gives after it: "increased to $550, then cut back to $500". */
  laterValues: Value[];
  /** The terms of a "for/in/at …" phrase after the value in its clause: "for the Austin office", "for FY25". */
  scope: string[];
}

/** The sentences of `text` no longer than MAX_SENTENCE_CHARS, each with whether the person said it. */
function sentencesOf(text: string): { sentence: string; person: boolean }[] {
  const said: { text: string; person: boolean }[] = [];
  let person = true;
  let introduced = false;
  for (const line of text.split("\n")) {
    // A quoted line is someone else's words.
    if (/^\s*>/.test(line)) continue;
    let rest = line;
    const label = LINE_LABEL.exec(line);
    if (label) {
      person = PERSON_LABEL.test((label[1] ?? label[2] ?? label[3]).trim());
      introduced = false;
      rest = line.slice(label[0].length);
    }
    let from = 0;
    for (const inline of rest.matchAll(INLINE_LABEL)) {
      said.push({ text: rest.slice(from, inline.index), person: person && !introduced });
      person = PERSON_LABEL.test(inline[1]);
      introduced = false;
      from = inline.index + inline[0].length;
    }
    said.push({ text: rest.slice(from), person: person && !introduced });
    // "Ideas for the blog post:" introduces what follows; it is not said as fact.
    if (/:\s*$/.test(rest)) introduced = true;
  }
  return said.flatMap((part) =>
    part.text
      .split(SENTENCE_END)
      .filter((sentence) => sentence.trim() !== "" && sentence.length <= MAX_SENTENCE_CHARS)
      .map((sentence) => ({ sentence, person: part.person })),
  );
}

/**
 * Each part of each sentence of a first line that names at least two query terms and a value.
 * Parts that name the same terms are one statement, so a long line of like sentences is read
 * as few statements.
 */
export function statementsOf(text: string, query: ReadonlySet<string>): Statement[] {
  const byTerms = new Map<string, Statement>();
  for (const { sentence } of sentencesOf(text)) {
    for (const part of sentence.split(TURN)) {
      if (!part) continue;
      const allTerms = new Set(attributeTerms(part));
      const terms = new Set([...allTerms].filter((t) => query.has(t)));
      if (terms.size < 2) continue;
      const values = statedValuesOf(part);
      if (values.length === 0) continue;
      const key = [...allTerms].sort().join(" ");
      const statement = byTerms.get(key) ?? { terms, allTerms, sequence: [], values: [], periods: new Set<string>() };
      statement.sequence.push("", ...termSequence(part));
      statement.values.push(...values);
      for (const term of allTerms) if (periodOf(term)) statement.periods.add(periodOf(term)!);
      for (const value of values) if (value.period) statement.periods.add(value.period);
      byTerms.set(key, statement);
    }
  }
  return [...byTerms.values()];
}

/** Contractions that end in "'s" and own nothing: "it's $500", "that's my budget". */
const NOT_OWNERS = wordSet("it's that's here's there's what's who's he's she's let's");

/** Whether a word names an owner: "Alexis's", "my parents'". */
function isPossessive(word: Word): boolean {
  return /\p{L}{2,}['’]s$|\p{L}s['’]$/u.test(word.raw.replace(/[^\p{L}'’]+$/u, "")) && !NOT_OWNERS.has(word.bare);
}

/**
 * Whether word `i` of `words` opens a new clause. "OR" written in capitals right after a
 * preposition or determiner, in text that chose its capitals, is a code ("in OR", "for the OR"),
 * as `attributeTerms` reads it, not the word "or"; "… for good OR at least …" still opens one.
 */
function opensClause(words: readonly Word[], i: number, text: string): boolean {
  const word = words[i];
  if (!CLAUSE_OPENERS.has(word.bare)) return false;
  const before = words[i - 1]?.bare ?? "";
  const code = /^\p{Lu}{2}$/u.test(word.raw.replace(/[^\p{L}]/gu, "")) && capitalsChosen(text);
  return !(code && (PREPOSITIONS.has(before) || DETERMINERS.has(before)));
}

/** The values a first line's sentence part states, each with the words around it read. */
function statedValuesOf(part: string): StatedValue[] {
  const words = wordsOf(part);
  // The clauses (by first word) whose words make a value something other than the thing's own,
  // so "…, which is $8 over my $35 monthly budget, can you help" reads $35 in its clause alone.
  const clauseOf: number[] = [];
  const notTheValue = new Set<number>();
  words.forEach((word, i) => {
    clauseOf.push(
      i > 0 && (ENDS_CLAUSE.test(words[i - 1].raw) || opensClause(words, i, part)) ? i : (clauseOf[i - 1] ?? 0),
    );
    const conditional = HYPOTHETICAL.has(word.bare) && word.bare !== "may";
    if (NOT_THE_VALUE.has(word.bare) || conditional || OTHER_OWNERS.has(word.bare) || isPossessive(word))
      notTheValue.add(clauseOf[i]);
  });
  return valuesOf(part).map(({ value, match }) => {
    const at = firstWordAfter(words, match.index);
    const near = words
      .slice(Math.max(0, at - NEAR_WORDS), at + NEAR_WORDS + 1)
      .flatMap((word) => attributeTerms(word.bare));
    return { ...value, near: new Set(near), isTheValue: !notTheValue.has(clauseOf[at]) };
  });
}

/**
 * One sentence of a later line, read for the changes it asserts. Every per-word fact a change
 * needs (its clause, a qualifier anywhere in it, where a question starts) is read once in the
 * constructor, so a sentence is read in time linear in its length.
 */
class ChangeReader {
  private readonly words: Word[];
  /** For each word, the index of the first word of its clause. */
  private readonly clauseStart: number[] = [];
  /** The clauses (by first word) that are denied, dated away or asked by an inverted verb. */
  private readonly deniedClauses = new Set<number>();
  /** The clauses that hold a condition anywhere, and those a condition word opens (", if Alexis agrees,"). */
  private readonly qualifiedClauses = new Set<number>();
  private readonly conditionClauses: number[] = [];
  /** The clauses that hold a wish, plan or proposal, each with where its last such word stands. */
  private readonly lastIntentIn = new Map<number, number>();
  /** The first word of the question in the sentence, or Infinity when it asks nothing. */
  private readonly questionFrom: number;
  /** Whether nothing in the sentence is read as a change at all. */
  private readonly unread: boolean;

  constructor(
    private readonly sentence: string,
    private readonly queryWords: ReadonlySet<string>,
  ) {
    const w = (this.words = wordsOf(sentence));
    let start = 0;
    const didNotHappen = new Set<number>();
    for (let i = 0; i < w.length; i++) {
      if (i > 0 && (ENDS_CLAUSE.test(w[i - 1].raw) || /^[-–—]+$/.test(w[i - 1].raw) || opensClause(w, i, sentence)))
        start = i;
      const bare = w[i].bare;
      // "was my budget increased to $550": a clause that opens with its verb asks or supposes.
      if (NEGATIONS.test(bare) || ANOTHER_TIME.has(bare) || (i === start && INVERTED.has(bare)))
        this.deniedClauses.add(start);
      // "May 20" is a date, not "may".
      const month = bare === "may" && /^\d/.test(w[i + 1]?.raw ?? "");
      if ((HYPOTHETICAL.has(bare) && !month) || bare.endsWith("'d")) {
        this.qualifiedClauses.add(start);
        if (i === start) this.conditionClauses.push(start);
      }
      if (INTENT.has(bare) || bare.endsWith("'ll")) this.lastIntentIn.set(start, i);
      if (DID_NOT_HAPPEN.has(bare)) didNotHappen.add(start);
      this.clauseStart.push(start);
    }
    this.unread =
      w.length === 0 ||
      CONDITIONED_OPENERS.has(w[0].bare) ||
      // "Do you remember when my budget was raised to $550": a sentence that opens on its verb asks.
      INVERTED.has(w[0].bare) ||
      // "Draft: …", "Target for Q3: …": a label inside the sentence makes it something other than a statement.
      w.some((word) => word.raw.endsWith(":") || REVERSALS.has(word.bare)) ||
      QUALIFYING_PHRASES.test(folded(sentence)) ||
      [...didNotHappen].some((clause) => this.deniedClauses.has(clause));
    this.questionFrom = this.questionStart();
  }

  /** Where the sentence's question begins: at the last comma a question word follows before its "?", else at its start. */
  private questionStart(): number {
    const w = this.words;
    const asked = w.findIndex((word) => word.raw.includes("?"));
    if (asked < 0) return Number.POSITIVE_INFINITY;
    for (let i = asked; i > 0; i--) {
      const opens =
        QUESTION_OPENERS.has(w[i].bare) || (w[i].bare === "so" && QUESTION_OPENERS.has(w[i + 1]?.bare ?? ""));
      if (opens && w[i - 1].raw.endsWith(",")) return i;
    }
    return 0;
  }

  changes(): Change[] {
    if (this.unread) return [];
    const values = valuesOf(this.sentence).map(({ value, match }) => ({
      value,
      at: firstWordAfter(this.words, match.index),
      endWord: firstWordAfter(this.words, match.index + match[0].length - 1),
    }));
    // "at 4:30 PM": the words of a value are that value, never the name of a thing.
    const valueWords = new Set(
      values.flatMap(({ at, endWord }) => Array.from({ length: endWord - at + 1 }, (_, k) => at + k)),
    );
    const found: Change[] = [];
    let last: { change: Change; endWord: number } | null = null;
    for (const [n, { value, at, endWord }] of values.entries()) {
      if (at >= this.questionFrom) break;
      // "$50 more than last month" is a difference, not the thing's value.
      if (DIFFERENCES.has(this.words[endWord + 1]?.bare ?? "")) continue;
      const joined: boolean = last !== null && last.endWord === at - 2 && JOINED.has(this.words[at - 1].bare);
      const thing: Thing | null = joined ? last!.change : this.changeBefore(at, value);
      if (!thing) continue;
      // "from $400 to $500" and "to $500 from $400": the value after "from" is the one replaced.
      const previous = values[n - 1];
      const next = values[n + 1];
      const replaced =
        previous &&
        previous.endWord === at - 2 &&
        this.words[at - 1].bare === "to" &&
        this.words[previous.at - 1]?.bare === "from"
          ? previous.value
          : next && next.at === endWord + 2 && this.words[endWord + 1].bare === "from"
            ? next.value
            : undefined;
      const laterValues = values.slice(n + 1).map((later) => later.value);
      const scope = this.scopeAfter(at, endWord, valueWords);
      const change: Change = { ...thing, value, laterValues, scope, ...(replaced ? { from: replaced } : {}) };
      found.push(change);
      last = { change, endWord };
    }
    return found;
  }

  /**
   * The terms of the scope phrases after the value that runs from word `at` to `end`: the first one
   * in the value's clause, read to the end of that clause, and each next clause that opens with a
   * scope preposition, after an "and" or "or" at most ("for good, for the Denver team"). A scope
   * preposition is "for", "in", "at", "across", "through", "by", …, and "on" only after "to
   * <value>". "To $10,000 for my side business" is the side business's budget. Its terms are read
   * as any name's are, so a number adds nothing and "FY25", "Q3", "H2", "UK", "R&D" and, in text
   * that chose its capitals, "IT" stay. The words of a value (`valueWords`, the "PM" of "at 4:30
   * PM") add nothing, and neither does a phrase that is wholly a neutral one ("for good").
   */
  private scopeAfter(at: number, end: number, valueWords: ReadonlySet<number>): string[] {
    const w = this.words;
    const afterTo = w[at - 1]?.bare === "to";
    const opensScope = (i: number) =>
      i < w.length && SCOPE_PREPOSITIONS.has(w[i].bare) && (w[i].bare !== "on" || afterTo);
    const terms: string[] = [];
    let clause = this.clauseStart[end];
    let i = end + 1;
    while (i < w.length && this.clauseStart[i] === clause && !opensScope(i)) i++;
    while (i < w.length) {
      if (this.clauseStart[i] === clause) {
        const phrase: Word[] = [];
        for (i++; i < w.length && this.clauseStart[i] === clause; i++) if (!valueWords.has(i)) phrase.push(w[i]);
        // "for good :)": marks alone are no words of the phrase.
        const named = NEUTRAL_SCOPE.test(phrase.flatMap((word) => word.bare || []).join(" "))
          ? []
          : attributeTerms(phrase.map((word) => word.raw).join(" "), this.sentence);
        terms.push(...named);
        if (i >= w.length) break;
        // "for marketing and sales", "for I.T. and HR": an "and" or "or" after a phrase that named
        // something names more of it, unless a new subject follows ("… and I'm relieved").
        const next = w[i + 1]?.bare ?? "";
        const listed = (w[i].bare === "and" || w[i].bare === "or") && !NEW_SUBJECTS.has(next) && !NOT_OWNERS.has(next);
        if (named.length > 0 && listed && !opensScope(i + 1)) {
          clause = this.clauseStart[i];
          continue;
        }
      }
      clause = this.clauseStart[i];
      if ((w[i].bare === "and" || w[i].bare === "or") && this.clauseStart[i + 1] === clause) i++;
      if (!opensScope(i)) break;
    }
    return terms;
  }

  /** The thing a change just before word `at` is said of, when one introduces the value there. */
  private changeBefore(at: number, value: Value): Thing | null {
    const w = this.words;
    const before = w[at - 1]?.bare;
    if (before === "to") {
      // "up to $550" is a bound, not a value.
      if (w[at - 2]?.bare === "up") return null;
      let j = at - 2;
      for (let k = j; k >= Math.max(0, j - 4); k--) {
        if (w[k].bare === "from") {
          j = k - 1;
          break;
        }
      }
      return this.linkedChange(j, at);
    }
    if (before === "of") return this.adjectivalChange(at - 2, at);
    if (before === "reached") return this.asserted(at - 1, at, "verb") ? this.subjectOf(at - 1) : null;
    const now = before === "now" ? at - 1 : before === "at" && w[at - 2]?.bare === "now" ? at - 2 : -1;
    // "it's now July 20" says what day it is, not that a date changed.
    if (now < 0 || value.kind === "date" || !this.asserted(now, at, "verb")) return null;
    let k = now - 1;
    if (["is", "are", "was", "stands", "sits"].includes(w[k]?.bare ?? "")) k--;
    return this.nameEndingAt(k, false);
  }

  /** "<thing> was increased to", "I increased <thing> to", "the increased <thing> to": `j` is the word before the value's "to". */
  private linkedChange(j: number, at: number): Thing | null {
    const w = this.words;
    let k = j;
    while (k >= 0 && ADVERBS.has(w[k].bare)) k--;
    if (k < 0) return null;
    if (CHANGE_VERBS.has(w[k].bare)) return this.asserted(k, at, "verb") ? this.subjectOf(k) : null;
    for (let c = j - 1; c >= Math.max(0, j - MAX_NAME_WORDS); c--) {
      if (ENDS_CLAUSE.test(w[c].raw)) return null;
      if (!CHANGE_VERBS.has(w[c].bare) && w[c].bare !== "new") continue;
      if (DETERMINERS.has(w[c - 1]?.bare ?? "")) return this.adjectivalChange(j, at);
      if (w[c].bare === "new" || !this.asserted(c, at, "verb") || !this.hasSubject(c)) return null;
      let end = j;
      while (end > c && PARTICLES.has(w[end].bare)) end--;
      return this.nameBetween(c + 1, end);
    }
    return null;
  }

  /** "my new <thing> of", "the increased <thing> to": `j` is the last word of the thing. */
  private adjectivalChange(j: number, at: number): Thing | null {
    const w = this.words;
    for (let c = j - 1; c >= Math.max(1, j - MAX_NAME_WORDS); c--) {
      if (ENDS_CLAUSE.test(w[c].raw)) return null;
      if (w[c].bare !== "new" && !CHANGE_VERBS.has(w[c].bare)) continue;
      const determiner = w[c - 1].bare;
      if (!DETERMINERS.has(determiner) || !this.ownedByAsker(determiner)) return null;
      // "my increased budget of $650" refers to a change already made; "a new milestone of …" may be one proposed.
      const definite = determiner !== "a" && determiner !== "an";
      return this.asserted(c - 1, at, definite ? "definite" : "verb") ? this.nameBetween(c + 1, j) : null;
    }
    return null;
  }

  /**
   * Whether a change worded from word `from`, introducing the value at word `at`, is asserted:
   * nothing anywhere in its clause denies it, asks it, dates it away or makes it conditional, and
   * nothing wishes, plans or proposes it (before it, in the clause, unless it is a definite "my new
   * …"; or after it). Second-hand words, and a change in the sentence's question, leave the whole
   * sentence unread (`changes`).
   */
  private asserted(from: number, at: number, form: "verb" | "definite"): boolean {
    if (from < 0) return false;
    for (const clause of new Set([this.clauseStart[from], this.clauseStart[at]])) {
      if (this.deniedClauses.has(clause) || this.qualifiedClauses.has(clause)) return false;
      if (form === "verb" && this.lastIntentIn.has(clause)) return false;
    }
    // "My new budget of $550, if Alexis agrees, starts soon": a later clause that opens with a condition conditions it.
    if (this.conditionClauses.some((clause) => clause > at && clause < this.questionFrom)) return false;
    // "my new budget of $550 still needs approval": a definite "my new …" may follow a wish, never precede one.
    if ((this.lastIntentIn.get(this.clauseStart[at]) ?? -1) > at) return false;
    return true;
  }

  /** Whether a determiner names the asker's own thing: "my", "our", "the", or the owner the query itself names. */
  private ownedByAsker(determiner: string): boolean {
    return !OTHER_OWNERS.has(determiner) || this.queryWords.has(determiner);
  }

  /**
   * Whether a verb of change at `c` has the person as its subject, in its clause: "I've adjusted
   * …", "we managed to cut …". A command has none, and "The Fed raised the rate" is someone else's.
   */
  private hasSubject(c: number): boolean {
    const w = this.words;
    let k = c - 1;
    while (k >= 0 && AUXILIARIES.has(w[k].bare)) k--;
    if (k >= 1 && w[k].bare === "to" && MANAGED.has(w[k - 1].bare)) {
      k -= 2;
      while (k >= 0 && AUXILIARIES.has(w[k].bare)) k--;
    }
    return k >= this.clauseStart[c] && PERSON_SUBJECTS.has(w[k].bare);
  }

  /** The subject of a verb of change at `v`: "the deadline was extended", "the response time, which has improved". */
  private subjectOf(v: number): Thing | null {
    const w = this.words;
    let k = v - 1;
    while (k >= 0 && AUXILIARIES.has(w[k].bare) && !ENDS_CLAUSE.test(w[k].raw)) k--;
    // "is increased", "had been raised": "is" and "had" are stopwords, so they name no thing.
    if (k < 0) return null;
    const relative = w[k].bare === "which" || w[k].bare === "that";
    if (relative) k--;
    // With no auxiliary ("my final draft reached 4,700 words"), the thing must open its clause:
    // "I wanted the budget increased to $550" and "Get my budget raised to $550" are not changes made.
    return this.nameEndingAt(k, k === v - 1 && !relative);
  }

  /**
   * The thing whose name ends at word `k`, read backward to its determiner. A name that is the
   * object of a preposition ("the reminder for my meeting", "the fee at Acme") names no thing:
   * the thing is the noun before the preposition, which this does not read.
   */
  private nameEndingAt(k: number, opensClause: boolean): Thing | null {
    const w = this.words;
    if (k < 0) return null;
    const last = w[k].bare;
    if (STOPWORDS.has(last) || PRONOUNS.has(last) || /\d/.test(last)) return null;
    let first = k;
    let head = k;
    let crossed = false;
    let stop = -1;
    for (let i = k - 1; i >= Math.max(0, k - MAX_NAME_WORDS); i--) {
      const bare = w[i].bare;
      if (/[,;:)]$/.test(w[i].raw) || /\d/.test(bare)) {
        stop = i;
        break;
      }
      if (NAME_PREPOSITIONS.has(bare) && !crossed && i > 0) {
        crossed = true;
        head = i - 1;
        continue;
      }
      // "the deadline for the first sprint": a determiner just after the name's preposition belongs to it.
      if (DETERMINERS.has(bare) && !crossed && NAME_PREPOSITIONS.has(w[i - 1]?.bare ?? "")) continue;
      if (DETERMINERS.has(bare) || PRONOUNS.has(bare) || STOPWORDS.has(bare) || CHANGE_VERBS.has(bare) || bare === "") {
        stop = i;
        break;
      }
      first = i;
    }
    if (crossed && head < first) return null;
    // "the deadline for the March 22 report": a name that runs into a number is part of a longer one.
    if (stop >= 0 && /\d/.test(w[stop].bare)) return null;
    if (stop >= 0 && DETERMINERS.has(w[stop].bare) && !this.ownedByAsker(w[stop].bare)) return null;
    const beforeName = stop >= 0 && DETERMINERS.has(w[stop].bare) ? stop - 1 : stop;
    if (beforeName >= 0 && PREPOSITIONS.has(w[beforeName].bare) && !/[,;:)]$/.test(w[beforeName].raw)) return null;
    if (opensClause) {
      for (let i = this.clauseStart[k]; i <= beforeName; i++) {
        if (!CLAUSE_LEAD.has(w[i].bare) && !DETERMINERS.has(w[i].bare)) return null;
      }
    }
    return this.named(first, k, crossed ? head : k);
  }

  /** "I've increased my grocery budget to": the words from `from` to `to` are the thing. */
  private nameBetween(from: number, to: number): Thing | null {
    const w = this.words;
    if (from <= to && DETERMINERS.has(w[from].bare) && !this.ownedByAsker(w[from].bare)) return null;
    while (from <= to && DETERMINERS.has(w[from].bare)) from++;
    if (from > to || to - from >= MAX_NAME_WORDS) return null;
    let head = to;
    for (let i = from; i <= to; i++) {
      const bare = w[i].bare;
      if (/\d/.test(bare) || (i < to && ENDS_CLAUSE.test(w[i].raw))) return null;
      if (NAME_PREPOSITIONS.has(bare) && head === to) {
        head = i - 1;
        continue;
      }
      if (STOPWORDS.has(bare) || PRONOUNS.has(bare)) return null;
    }
    return head < from ? null : this.named(from, to, head);
  }

  private named(from: number, to: number, head: number): Thing | null {
    const nameWords = this.words.slice(from, to + 1);
    // "Alexis's budget": someone's own thing, never the asker's. ("My budget's been raised" ends the name.)
    if (nameWords.slice(0, -1).some((word) => /['’]s\W*$/.test(word.raw))) return null;
    // "Professor Danielle was moved", "Acme has now reached": a name, not a thing that has a value.
    if (head > 0 && /^\p{Lu}\p{Ll}/u.test(this.words[head].raw)) return null;
    const headTerms = attributeTerms(this.words[head].bare);
    const headTerm = headTerms[headTerms.length - 1];
    if (!headTerm) return null;
    const termsOf = (list: Word[]) =>
      attributeTerms(
        list
          .map((word) => word.bare)
          .filter((bare) => !NAME_PREPOSITIONS.has(bare))
          .join(" "),
      );
    return { head: headTerm, name: termsOf(nameWords), after: termsOf(this.words.slice(head + 1, to + 1)) };
  }
}

/**
 * The changes the later line `text` asserts, sentence by sentence. Only the person's sentences
 * are read, and a record that takes something back ("never mind", "jk") asserts none.
 * `queryWords` are the query's lower-cased words, for the owner it names ("her rent").
 */
export function changesOf(text: string, queryWords: ReadonlySet<string>): Change[] {
  if (RETRACTIONS.test(folded(text))) return [];
  const said = sentencesOf(text).filter(({ person }) => person);
  // "Here's what Alexis wrote. My budget was increased …": second hand, imagined or someone else's, record wide.
  const context = said.some(({ sentence }) =>
    wordsOf(sentence).some((word) => HEARSAY.has(word.bare) || RECORD_CONTEXT.has(word.bare)),
  );
  if (context) return [];
  return said.flatMap(({ sentence }) => new ChangeReader(sentence, queryWords).changes());
}

/** A query's lower-cased words. */
export function wordsOfQuery(query: string): Set<string> {
  return new Set(wordsOf(query).map((word) => word.bare));
}

/** The query's terms that only ever stand as a preposition's object ("at Acme"): never the thing it asks a value of. */
export function prepositionObjects(query: string): Set<string> {
  const words = wordsOf(query);
  const objects = new Set<string>();
  const others = new Set<string>();
  words.forEach((word, i) => {
    const before = words[i - 1]?.bare ?? "";
    const object = PREPOSITIONS.has(before) || (DETERMINERS.has(before) && PREPOSITIONS.has(words[i - 2]?.bare ?? ""));
    for (const term of attributeTerms(word.bare)) (object ? objects : others).add(term);
  });
  return new Set([...objects].filter((term) => !others.has(term)));
}
