// "Never" claims about the thing a question asks, served beside records that mention that thing.
//
// A record that says something never happened ("I've never used Zotero", "we have never
// deployed on a Friday") is the self-statement later activity most often overtakes: a later
// record says Zotero was downloaded, or a Friday deploy went out. A reader handed both
// unmarked answers from one of them, so a question like "have I used Zotero?" gets a confident
// yes or no where the honest answer is to ask.
//
// The one rule: this detects, it never resolves. A claim is reported only when other served
// lines mention its thing, and the report quotes the claim and one mention, says nothing about
// which is right, and asks that the person be asked. A mention ("should I try Zotero?") is not
// proof the thing happened, so the report calls it a possible conflict. Nothing is hidden,
// fetched, reordered or rewritten, and every line quoted was served by this same read under its
// own access check, so the report never says anything about a record the reader cannot see.
//
// A false note costs more trust than a missed one, so every doubt below falls toward no note.
//
// What counts:
// - a claim: "I" or "we", then "never" or "not ever" ("I've never", "we had never", "I have
//   actually never", "I've also never"), then a past verb ("used", "been", "attended"). Not a
//   claim: one after "if" or "whether", one asked ("have I never used it"), one inside double or
//   curly quotes (someone's quoted words), one whose sentence reports, hedges or denies it ("my
//   sister thinks I've never", "according to Sam, I've never", "Sam: I've never", "I've never
//   used it, Sam claims", "it's not true that I've never", "it feels like I've never"), one bounded
//   in time or scope ("until March, I had never", "I'd never been to Japan before college", "as of
//   May", "in 2019", "when I started", "then", "in college", "except for one class", "..., now I
//   use it") and one not absolute ("never used it much"), which a later act does not contradict
//   ("up till now" is not a bound). A present verb is a standing rule or habit ("we never deploy
//   on Fridays"), and "never fail to" or "never forget" mean "always". Its thing is the rest of
//   that clause, cut at the first clause break ("," "but" "so" "because" "until" ...), less its
//   verb and words that name no thing, split at "or" into alternatives ("met anyone like Kyle or
//   been to sneaker expos"); each alternative's object is its first phrase ("triangle
//   classification problems" in "attempted triangle classification problems before"). The note
//   quotes the claim from its sentence's start (or, past 80 characters, from the clause before
//   it, marked "…"), so a leading word ("Honestly, I've never") is never cut off;
// - about the question: the question holds most of the thing's terms (both of two, two of
//   three, three of four or five, ...);
// - a mention: a clause of another served line, outside that line's own "never" claims, where
//   "I" or "we" is the subject of a past verb that contradicts an alternative's verb: the same
//   verb, or one listed for it in CONTRADICTING_ACTS ("I opened Zotero" against "never used
//   Zotero"). What the verb acts on must be that alternative: the noun phrase after the verb
//   (past a particle, a gerund or one preposition, plus one describing phrase: "route with
//   Flask") names it, ends on one of its terms or is a quoted title ("a review of Dune", "a
//   Paris-themed cafe", "my Zotero library" are not Dune, Paris or Zotero), and is no sibling
//   ("triangle congruence problems" is not "triangle classification problems"; "classification
//   problems" can be). When nothing named follows the verb ("the two-factor authentication we
//   set up"), the words before its subject are the object; an alternative that opens on a
//   preposition ("deployed on a Friday") need only be named after the verb; a co-subject that
//   names it counts ("Priya and I met"). "was"/"were" contradicts "never been" only with a place
//   word after it ("we were in Japan"; "been to Japan"), or the claim's own word ("I was late"
//   against "never been late"), never as a helper ("I was planning a trip to Japan", "I was
//   told", "I was to visit"). Not mentions: a plan or wish ("I want to", "I'll", "I'd rather we
//   used"), a habit ("I avoid"), someone else's act ("my advisor recommended it", "Sam used it
//   and I used EndNote"), "I used to", an unreal past ("I wish I'd used it"), a supposition or
//   hedge ("suppose I used it", "maybe I used it", "I used it, I think"), a question ("have I used
//   Zotero before?", "had I used it, ...", "I used it, didn't I?", "So I used it for this?"),
//   reported or quoted speech ("my sister told me I used it", 'she said, "I used it"', "According
//   to my sister, I used it", "My sister: I used it"), a negated clause ("neither", "without"), a
//   first time ("I gave my first talk", which says the claim held until then) and another act on
//   the same thing ("I installed it", "I read about it"). A clause of more than 64 first-person
//   events is not read. These are words, not speakers: a stored assistant turn written in the
//   first person counts the same as the person's own.
// Terms are read as stated-values.ts reads them, with a final "e" or "ing" dropped, so "routes"
// meets "route" and "meetings" meets "meeting". A thing with no term ("I've never done that")
// is never reported.
import { attributeTerms, termSequence } from "./stated-values";

/** A first-person "never" claim; group 1 is the rest of its sentence (cut before "->", a transcript marker). */
const NEVER_CLAIM =
  /\b(?:i|we)(?:\s+(?:have|had|has)|['’](?:ve|d))?\s+(?:(?:also|actually|really|honestly|personally|just|still)\s+)?(?:never|not\s+ever)\s+(?:ever\s+)?(?:(?:actually|really|once)\s+)?((?:(?!->)[^.?!;:\n])+)/giu;
/** Where a claim's clause ends: "never used Zotero, so ..." / "... but I want ...". */
const CLAUSE_BREAK = /,|\s(?:but|so|because|since|although|though|yet|while|and\s+(?:i|we)|which|until|as)\s/iu;
/** Where a mention's sentence ends: a full stop, a line break or a transcript marker ("->-> 2,6 ASSISTANT: ..."). */
const SENTENCE_END = /(?<=[.?!])\s+|\n|->->[^\p{L}]*/u;
/** The clause breaks inside a mention's sentence that a quote is cut at. */
const QUOTE_BREAK = /,\s|\s[—–-]+\s|\s(?:but|so|because|although|though|while)\s/iu;
/** Where a claim's sentence starts: after a full stop, a line break, a transcript marker or a speaker label. */
const SENTENCE_START = /[.?!]\s+|\n|->->[^\p{L}]*|\b(?:USER|ASSISTANT):\s*/gu;
/** `text` after its last speaker label (and the date line before it): "Date: May-02-2024 USER: I met Kelly" is "I met Kelly". */
function unlabelled(text: string): string {
  const at = Math.max(text.lastIndexOf("USER:"), text.lastIndexOf("ASSISTANT:"));
  return at < 0 ? text : text.slice(text.indexOf(":", at) + 1).trimStart();
}
/** The most of a claim's sentence quoted before its subject; a longer lead is cut to its last clause. */
const LEAD_MAX = 80;
/** The most of a claim's sentence before its subject read for bounds, reports and denials. */
const LEAD_READ = 400;
/** A negated clause: it agrees with a "never" claim rather than mentioning the thing as done. */
const NEGATED = /\b(?:not|no|never|neither|nor|without|zero|none|nothing)\b|n['’]t\b/iu;
/** Words just before a claim's subject that make it a supposition or a question: "if I had never", "have I never". */
const NOT_STATED = /\b(?:if|whether|have|has|had|did|do|does)\s+$/iu;
/**
 * Words in a clause before its subject that make what follows someone's report, a hedge or a
 * supposition, not the speaker's own statement: "my sister told me I used it", "I said I'd
 * never", "I think I've never", "suppose I used it", "assume I've used it".
 */
const REPORTED =
  /\b(?:say|says|said|tell|tells|told|think|thinks|thought|claim|claims|claimed|write|writes|wrote|mention|mentions|mentioned|insist|insists|insisted|remind|reminds|reminded|believe|believes|believed|hear|heard|suggest|suggests|suggested|remember|remembers|recall|recalls|guess|guessed|assume|assumes|assumed|suppose|supposes|supposed|swear|swears|swore|pretend|pretends|pretended|imagine|imagines|imagined|assuming|supposing|maybe|perhaps|possibly|probably|apparently|hypothetically|supposedly|allegedly|doubt|doubts|possible|according|saying|story|note|notes|noted|quote|quotes|quoting|quoted|ask|asks|asked|plan|plans|planned|lie|lies|lied|dream|dreamt|dreamed|knows)\b|\bas\s+far\s+as\b/iu;
/** A short clause beside a statement that makes it a report, hedge or question: "..., I think", "..., right?", "..., says Sam", "..., or so I thought". */
const HEDGE_CLAUSE =
  /^(?:(?:i|we)\s+(?:think|guess|believe|suppose|assume|reckon|thought)|right|correct|or\s+so|or\s+was\s+it|(?:\p{L}+\s+)?(?:says|said|claims|claimed|thinks|thought|insists|reckons)|(?:did|didn['’]t|have|haven['’]t|had|hadn['’]t|was|wasn['’]t|were|weren['’]t|is|isn['’]t|do|don['’]t)\s+(?:i|we|it|you))\b/iu;
/** The end of a clause that introduces someone's words: "My sister said," "She goes," "She was like,". */
const INTRODUCES_SPEECH = /(?:\b(?:said|says|goes|went|like|wrote|writes|replied|asked)|:)\s*$/iu;
/** A time bound on a claim: "until March", "before college", "as of May", "back then", "in 2019". */
const TIME_BOUND =
  /\b(?:(?:until|till|up\s+to|up\s+until)(?!\s+now\b)|prior\s+to|as\s+of|by\s+the\s+time|then|at\s+(?:the|that)\s+(?:time|point)|growing\s+up|as\s+an?\s+(?:kid|child|teen\p{L}*|student|undergrad\p{L}*)|when\s+(?:i|we)\b|(?:in|since)\s+(?:19|20)\d\d|before\s+(?!(?:but|so|and|yet|which|because|though|although|or)\b)(?=[\p{L}\p{N}]))/iu;
/** A claim's sentence that opens on a time, place or exception it is bounded by: "In college I never", "Except for one class, I've never". */
const SCOPED_LEAD =
  /^\s*(?:in|during|at|for|last|these|those|back|while|after|throughout|through|except|apart|besides|aside|outside|within|other\s+than|as\s+an?)\b/iu;
/** Words after a claim's clause that bound or withdraw it: ", not until May", "... until today", ", now I use it", ", Sam claims", ", or so I thought". */
const BOUND_AFTER =
  /^[\s,.;:…!'’"”-]*(?:but\s+)?(?:(?:not\s+)?(?:until|till)(?!\s+now\b)|now|today|these\s+days|or\s+so|(?:\p{L}+\s+)?(?:says|said|claims|claimed|thinks|thought|insists)\b|says|claims)/iu;
/** A claim's clause that is not absolute: "never used Zotero much", "never really used it properly". */
const NOT_ABSOLUTE = /\b(?:much|often|properly|seriously|fully|regularly|a\s+lot)\s*$/iu;
/** A lead that denies the claim that follows: "it's not true that I've never", "I deny that I've never". */
const DENIED =
  /(?:\bnot|n['’]t)\s+(?:true|the\s+case|correct|right|accurate)\b|\b(?:false|wrong|wrongly|untrue|incorrect)\b|\bden(?:y|ies|ied)\b|\bnot\s+that\s+$|\blike\s+$/iu;
/** Verbs after "never" that make it mean "always": "I never fail to", "I never forget". */
const ALWAYS = /^(?:fail|forget)/iu;
/**
 * A first-person event: "I" or "we" as the subject, then the verb, perhaps after "have"/"had" and
 * an adverb ("I've already configured", "we finally deployed"). Group 1 is the auxiliary, group 2
 * the verb.
 */
const EVENT =
  /\b(?:i|we)(['’](?:ve|d)|\s+(?:have|has|had))?(?:\s+(?:also|already|actually|finally|recently|just|then|successfully|even|really|since|first|once|ever))*\s+([\p{L}’']+)/giu;
/** Words just before an event's subject that make it unreal: "I wish I'd used it", "if we had deployed". */
const UNREAL = /\b(?:if|whether|wish|wished|unless|rather|time|case)\s+$/iu;
/** An auxiliary just before an event's subject, which makes it a question or an inverted supposition: "have I used", "had I used". */
const INVERTED =
  /\b(?:have|has|had|did|do|does|was|were|am|is|are|can|could|would|should|will|shall|may|might|must)\s+$/iu;
/** A clause that opens as a question: "Have I used Zotero before?", "Did I tell you I used it?", "Why did we ...". */
const QUESTION_START =
  /^[^\p{L}]*(?:(?:why|when|where|how|what|who|which)\s+)?(?:have|has|had|did|do|does|was|were|am|is|are|can|could|would|should|will|shall|may|might|must)(?:n['’]t)?\s+(?:i|we|you)\b/iu;
/** Double-quoted text: someone's words, or a title. */
const QUOTED = /"[^"\n]{0,500}"|“[^”\n]{0,500}”|‘[^’\n]{0,500}’(?!\p{L})/gu;
/** A first-person subject inside quoted text: then the quote is someone's words, not a title. */
const QUOTED_SPEAKER = /\b(?:I|[Ww]e)\b/u;
/** Words after "was"/"were" that put the speaker somewhere: "we were in Japan" ("was to" is a plan: "I was to visit Japan"). */
const PLACE = /^\s+(?:in|at|inside|on|aboard)\b/iu;
/** Words after "been" that put the speaker somewhere: "I've been to Japan". */
const BEEN_PLACE = /^\s+(?:in|at|to|inside|on|aboard)\b/iu;
/** Words an act's object can open with and skip: particles and a preposition ("set up my key", "worked on the slide", "listened to it"). */
const OBJECT_LEAD = /^(?:up|out|off|down|over|through|to|in|at|on|into|inside|aboard|with)$/iu;
/** Words that end an act's object: prepositions, conjunctions, relatives, times and participles. */
const ACT_OBJECT_STOP =
  /^(?:to|for|in|at|on|with|by|from|about|during|before|after|into|onto|of|or|nor|and|but|that|which|who|whom|while|like|related|since|until|than|over|as|near|instead|rather|via|versus|vs|without|because|so|when|where|if|then|last|yesterday|today|tonight|ago|again|once|twice|back|together|already|too|also|now|is|was|were|are|to)$|^\p{L}{3,}ed$/iu;
/** The prepositions whose phrase still describes an act's object: "route with Flask", "audiobook of The Poppy War". */
const OBJECT_PP = /^(?:with|for|in|at|on|to|from|by|of)$/iu;
/** Words that end a claim's object: a preposition, a relative or a participle ("audiobook narrated by"). */
const OBJECT_STOP =
  /^(?:to|for|in|at|on|with|by|from|about|during|before|after|into|onto|of|or|nor|and|that|which|who|while|like|related|since|until|than)$|^\p{L}{3,}ed$/iu;
/** Irregular past forms and past participles, each with its base form. */
const IRREGULAR_BASE = new Map(
  (
    "been:be was:be were:be went:go gone:go did:do done:do made:make met:meet got:get gotten:get gave:give given:give " +
    "took:take taken:take wrote:write written:write built:build bought:buy brought:bring sent:send spent:spend " +
    "paid:pay found:find kept:keep left:leave began:begin begun:begin became:become saw:see seen:see won:win " +
    "lost:lose sold:sell held:hold led:lead drove:drive driven:drive flew:fly flown:fly wore:wear worn:wear ate:eat " +
    "eaten:eat taught:teach caught:catch fought:fight felt:feel broke:break broken:break chose:choose chosen:choose " +
    "knew:know known:know rode:ride ridden:ride spoke:speak spoken:speak stood:stand threw:throw thrown:throw " +
    "understood:understand woke:wake sat:sit stuck:stick hung:hang shot:shoot slept:sleep fell:fall fallen:fall " +
    "grew:grow grown:grow drew:draw drawn:draw swam:swim swum:swim sang:sing sung:sing ran:run heard:hear " +
    "learnt:learn burnt:burn spelt:spell dreamt:dream dealt:deal meant:mean"
  )
    .split(" ")
    .map((pair) => pair.split(":") as [string, string]),
);
/** Past forms spelled like the present ("I read", "I set"): a past only after "have"/"had" or beside a past time. */
const PAST_AFTER_HAVE_ONLY = new Set("read set put cut hit let shut quit run come become spread split".split(" "));
/** A past time in a clause ("on April 20", "yesterday", "last week", "two days ago", "in 2021"). */
const PAST_TIME =
  /\b(?:yesterday|ago|last\s+(?:night|week|month|year|time|\p{L}+day)|on\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\p{L}*\.?\s+\d|in\s+(?:19|20)\d\d\b)/iu;
/** A past time anywhere in a text, to blank it before asking whether anything follows a verb. */
const PAST_TIMES = new RegExp(PAST_TIME.source, "giu");
/** A first time: "my first talk" says the claim held until then, not that it was wrong. */
const FIRST_TIME = /\b(?:my|our|the|a)\s+first\b|\bfirst\s+time\b/iu;

/** A verb's key: its base form, less a final "e", so "used", "use" and "uses" agree ("us"), and "wrote" and "write" ("writ"). */
function verbKey(verb: string): string {
  const word = verb.toLowerCase().replace(/[’']/g, "");
  let base = IRREGULAR_BASE.get(word) ?? word;
  if (base === word) {
    if (base.endsWith("ied")) base = `${base.slice(0, -3)}y`;
    else if (base.endsWith("ed") && !base.endsWith("eed"))
      base = base.slice(0, -2).replace(/([b-df-hj-np-tv-z])\1$/, "$1");
    else if (base.endsWith("es")) base = base.slice(0, -2);
    else if (base.endsWith("s") && !base.endsWith("ss")) base = base.slice(0, -1);
  }
  return base.length > 2 ? base.replace(/e$/, "") : base;
}

/** Whether `verb` is a past form, given whether "have"/"had" or a past time stands beside it. */
function isPast(verb: string, pastMarked: boolean): boolean {
  const word = verb.toLowerCase().replace(/[’']/g, "");
  if (PAST_AFTER_HAVE_ONLY.has(word)) return pastMarked;
  return IRREGULAR_BASE.has(word) || (word.length > 3 && word.endsWith("ed") && !word.endsWith("eed"));
}

/** The key of "be": a "never been" claim, contradicted only by being somewhere (PLACE). */
const BE = verbKey("be");

/**
 * The acts that make a claim's verb false, by the verb's key: "I've never used Zotero" is
 * contradicted by "I exported my Zotero library", "I've never been to Japan" by "we went to
 * Japan". A claim's own verb always counts. Every other act on the thing ("I installed it",
 * "I read about it", "I booked a flight there", "I discussed it") does not.
 */
const CONTRADICTING_ACTS = new Map(
  Object.entries({
    use: "use run open launch export import configure sync tag integrate implement deploy build work",
    try: "try use taste eat play",
    be: "be go visit travel fly stay live attend",
    write: "write implement code build create add",
    obtain: "obtain get receive configure set",
    get: "get obtain receive configure set",
    implement: "implement build set add deploy integrate configure",
    work: "work collaborate meet review edit",
    do: "do complete finish",
    practice: "practice complete solve",
    attend: "attend go join",
    take: "take enroll complete finish",
    attempt: "attempt try complete solve score finish",
    listen: "listen start finish",
    read: "read start finish",
    enroll: "enroll take complete join",
  }).map(([verb, acts]) => [verbKey(verb), new Set(acts.split(" ").map(verbKey))]),
);

/** Whether doing `act` makes a claim that the speaker never did `claimed` false. */
const contradicts = (claimed: string, act: string) =>
  act === claimed || (CONTRADICTING_ACTS.get(claimed)?.has(act) ?? false);

/** The longest quote a note carries, in characters. */
const QUOTE_MAX = 200;
/** The most claims one read reports. */
const CLAIMS_MAX = 2;
/** The most distinct claims about the question one read checks for mentions, so a page of claims stays cheap. */
const CLAIMS_CHECKED_MAX = 10;

/**
 * A term with a final "e" or "ing" dropped, so stated-values' stems of "routes" (rout) and
 * "route", or of "meetings" (meeting) and "meeting" (meet), meet.
 */
const key = (term: string) => (term.length > 4 ? term.replace(/(?:ing|e)$/, "") : term);
const termsOf = (text: string) => attributeTerms(text).map(key);
/** A text's terms in order, "" where a phrase breaks (stated-values termSequence). */
const sequenceOf = (text: string) => termSequence(text).map((t) => (t ? key(t) : ""));

/** Words a thing's terms leave out: they appear in records about anything. */
const NO_THING = new Set(
  (
    "project thing anything something everything anyone someone anybody somebody before ever actually really time times one " +
    "work worked working done kind sort way stuff yet still"
  )
    .split(" ")
    .flatMap((w) => termsOf(w)),
);

/** One "never" claim in a served line: its words as written, and its thing's terms. */
export interface NeverClaim {
  text: string;
  /** The key of the claim's verb (verbKey): what the speaker says never happened. */
  verb: string;
  terms: Set<string>;
  /** The terms of the thing's first phrase, in order: its object ("triangle classification problems"). */
  object: string[];
  /**
   * The thing's alternatives ("met anyone like Kyle or been to sneaker expos"), each with its own
   * verb key, terms and object; `adjunct` when it opens on a preposition ("deployed on a Friday"),
   * so the act's object need not be it.
   */
  alts: { verb: string; terms: Set<string>; object: string[]; adjunct: boolean }[];
  /** For a "never been" claim, the word after "been" ("late" in "never been late"), else "". */
  beWord: string;
}

/** A served "never" claim about the question, and the other served lines that mention its thing. */
export interface NeverClaimConflict {
  claim: string;
  /** How many other served lines mention the claim's thing. */
  mentions: number;
  /** The first-person clause of those lines that names the most of the thing (the first served of equals), as stored. */
  example: string;
}

/** `text` cut to QUOTE_MAX characters at a word, with an ellipsis when cut. */
function quoted(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= QUOTE_MAX) return flat;
  return `${flat.slice(0, QUOTE_MAX).replace(/\s+\S*$/, "")}…`;
}

/** `text` with each double-quoted passage that has a first-person speaker blanked, at the same length: someone's quoted words are not the speaker's. */
const withoutQuotedSpeech = (text: string) =>
  text.replace(QUOTED, (q) => (QUOTED_SPEAKER.test(q) ? " ".repeat(q.length) : q));

/** The terms of `phrase`'s first noun phrase, in order: up to a preposition, relative or participle. */
function objectOf(phrase: string): string[] {
  const words = phrase.trim().split(/\s+/);
  // "been to sneaker expos": the place after a leading preposition is the object.
  if (words.length > 1 && /^(?:to|in|at|on|with)$/iu.test(words[0]!)) words.shift();
  const stop = words.findIndex((w) => OBJECT_STOP.test(w.replace(/[^\p{L}]/gu, "")));
  return sequenceOf(words.slice(0, stop < 0 ? words.length : stop).join(" ")).filter((t) => t && !NO_THING.has(t));
}

/** The "never" claims in `text` that name a thing. */
export function neverClaimsIn(text: string): NeverClaim[] {
  const claims: NeverClaim[] = [];
  const plain = withoutQuotedSpeech(text);
  // Where each sentence starts, found once: claims come in order, so one pass serves them all.
  const starts = [...plain.matchAll(SENTENCE_START)].map((m) => m.index + m[0].length);
  let next = 0;
  for (const match of plain.matchAll(NEVER_CLAIM)) {
    const end = match.index + match[0].length;
    if (NOT_STATED.test(plain.slice(Math.max(0, match.index - 10), match.index))) continue;
    // The claim's sentence before its subject, from the sentence start (after a speaker label).
    while (starts[next] !== undefined && starts[next]! <= match.index) next++;
    // The claim's sentence before its subject, from the sentence start (after a speaker label);
    // read whole (to LEAD_READ characters) for bounds and denials, quoted to LEAD_MAX.
    const whole = plain.slice(Math.max(next > 0 ? starts[next - 1]! : 0, match.index - LEAD_READ), match.index);
    const nearby = whole
      .split(/[,;:]\s/)
      .slice(-3)
      .join(", ");
    // "My sister thinks I've never", "According to Sam, I've never", "It's not true, as Sam says, that
    // I've never", "In college I never", "Until March, I had never": not the speaker's own, unbounded claim.
    const own = unlabelled(whole);
    if (REPORTED.test(nearby) || DENIED.test(whole)) continue;
    // "Sam: I've never", "Sam replied, I've never": someone else's words.
    if (
      own.includes(":") ||
      own
        .split(/[,;]\s/)
        .slice(0, -1)
        .some((c) => INTRODUCES_SPEECH.test(c))
    )
      continue;
    if (TIME_BOUND.test(whole) || SCOPED_LEAD.test(whole)) continue;
    const rest = match[1]!;
    const clause = rest.split(CLAUSE_BREAK)[0]!;
    // "never used it until May", ", not until May", ", now I use it daily", ", Sam claims", "never used it much",
    // and a claim that is itself asked ("I've never used Zotero? That's what you think").
    const clauseEnd = match.index + match[0].length - rest.length + clause.length;
    if (
      TIME_BOUND.test(clause) ||
      NOT_ABSOLUTE.test(clause) ||
      BOUND_AFTER.test(plain.slice(clauseEnd, clauseEnd + 40))
    )
      continue;
    let lead = whole;
    let cut = false;
    if (lead.length > LEAD_MAX) {
      const at = lead.lastIndexOf(", ");
      lead =
        at >= 0 && lead.length - at - 2 <= LEAD_MAX ? lead.slice(at + 2) : lead.slice(-LEAD_MAX).replace(/^\S*\s*/, "");
      cut = true;
    }
    // The clause's first word is the claim's verb ("used", "attended"); the thing follows it.
    const [verb = "", ...thing] = clause.trim().split(/\s+/);
    // "We never deploy on Fridays" is a rule, not a record of what happened: only a past
    // verb ("used", "been", "attended") makes a claim a later record can contradict.
    if (ALWAYS.test(verb) || !isPast(verb, true)) continue;
    const terms = new Set(termsOf(thing.join(" ")).filter((t) => !NO_THING.has(t)));
    if (terms.size === 0) continue;
    const said = `${match[0].trim()}${text[end] === "." || text[end] === "!" ? text[end] : ""}`;
    const verbKeyed = verbKey(verb);
    claims.push({
      text: `${cut ? "…" : ""}${lead}${said}`.trim(),
      verb: verbKeyed,
      terms,
      object: objectOf(thing.join(" ")),
      alts: thing
        .join(" ")
        .split(/\s+(?:or|nor)\s+/iu)
        .flatMap((part, k) => {
          const [first = "", ...words] = part.trim().split(/\s+/);
          const own = k > 0 && isPast(first, true) && !ALWAYS.test(first);
          const altVerb = own ? verbKey(first) : verbKeyed;
          const body = own ? words.join(" ") : part;
          const altTerms = new Set(termsOf(body).filter((t) => !NO_THING.has(t)));
          if (altTerms.size === 0) return [];
          const adjunct =
            altVerb !== BE && /^(?:on|in|at|with|for|during|over|under|from|without)\b/iu.test(body.trim());
          return [{ verb: altVerb, terms: altTerms, object: objectOf(body), adjunct }];
        }),
      beWord:
        verbKeyed === BE && !/^(?:to|in|at|on|inside|into|aboard|abroad|there)$/iu.test(thing[0] ?? "")
          ? (thing[0] ?? "").toLowerCase()
          : "",
    });
  }
  return claims;
}

/** `text` with its "never" claims' clauses removed, so a repeated claim is not read as a mention. */
function withoutClaims(text: string): string {
  return text.replace(NEVER_CLAIM, (_whole, rest: string) => rest.slice(rest.split(CLAUSE_BREAK)[0]!.length));
}

/** How many of `claim`'s terms `terms` holds. */
function held(claim: ReadonlySet<string>, terms: readonly string[]): number {
  let n = 0;
  for (const t of claim) if (terms.includes(t)) n++;
  return n;
}

/** Whether `terms` name the claim's thing: all of it, or at least two of its terms. */
const names = (claim: ReadonlySet<string>, terms: readonly string[]) => held(claim, terms) >= Math.min(2, claim.size);

/**
 * Whether `phrase`, what an act is on, is the claim's object rather than a sibling of it: when
 * the object's last word is there and one of the object's other words is missing, the word
 * before it must be one of the object's own ("classification problems" for "triangle
 * classification problems", not "similarity ratio problems").
 */
function sameObject(object: readonly string[], phrase: string): boolean {
  if (object.length < 2) return true;
  const sequence = sequenceOf(phrase);
  const head = object[object.length - 1]!;
  if (!sequence.includes(head) || object.every((t) => sequence.includes(t))) return true;
  return sequence.some((t, i) => t === head && i > 0 && object.includes(sequence[i - 1]!) && sequence[i - 1] !== head);
}

/** Whether nothing that names a thing follows a verb: "the two-factor authentication we set up on April 20". */
const nothingNamed = (phrase: string) => termsOf(phrase.replace(PAST_TIMES, " ")).length === 0;

/** A word with its punctuation stripped. */
const bareWord = (word: string) => word.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}’']+$/gu, "");

/**
 * What an act is on: the noun phrase after the verb (past a particle, a gerund and one
 * preposition: "set up my API key", "started reading Elbow Room", "worked on the slide") up to a
 * preposition, conjunction, relative, time or participle, plus the one phrase after it that
 * still describes it ("route with Flask", "audiobook of The Poppy War"). `head` is the phrase's last
 * term, `titled` whether it holds a quoted title, which names its thing itself.
 */
function actObject(after: string): { text: string; head: string | undefined; titled: boolean } {
  const words = after.trim().split(/\s+/).filter(Boolean).slice(0, 40);
  let i = 0;
  while (i < words.length && /^(?:up|out|off|down|over|through)$/iu.test(bareWord(words[i]!))) i++;
  if (i + 1 < words.length && /\p{L}{3,}ing$/iu.test(bareWord(words[i]!))) i++;
  if (i + 1 < words.length && OBJECT_LEAD.test(bareWord(words[i]!))) i++;
  const phrase = (from: number): [string[], number] => {
    const kept: string[] = [];
    let j = from;
    for (; j < words.length; j++) {
      const word = words[j]!;
      if (ACT_OBJECT_STOP.test(bareWord(word))) break;
      kept.push(word);
      if (/[,;:.!?)]$/u.test(word)) return [kept, words.length];
    }
    return [kept, j];
  };
  let [noun, stop] = phrase(i);
  // "30% of my editing tasks": a quantity's object is the phrase after "of".
  if (termsOf(noun.join(" ").replace(/\d\S*/gu, "")).length === 0 && /^of$/iu.test(words[stop] ?? ""))
    [noun, stop] = phrase(stop + 1);
  const describing = OBJECT_PP.test(words[stop] ?? "") ? phrase(stop + 1)[0] : [];
  const nounText = noun.join(" ").replace(/[_`]/gu, " ");
  return {
    text: `${nounText} ${describing.join(" ")}`,
    head: sequenceOf(nounText).filter(Boolean).pop(),
    titled: /["“‘]/u.test(nounText),
  };
}

type Alt = NeverClaim["alts"][number];
type ActObject = { text: string; head: string | undefined; titled: boolean };

/**
 * Whether an act on `object` is an act on the alternative's thing: it names it, its head is one
 * of its terms (or a title), and it is not a sibling object. For an adjunct ("never deployed on a
 * Friday"), the rest of the clause after the verb (`rest`) need only name it.
 */
function isTheThing(alt: Alt, object: ActObject, rest: string): boolean {
  if (alt.adjunct) return names(alt.terms, termsOf(rest));
  const terms = termsOf(object.text);
  return (
    names(alt.terms, terms) &&
    (object.titled || (object.head !== undefined && alt.terms.has(object.head))) &&
    sameObject(alt.object, object.text)
  );
}

/** How far back from an event's subject its clause is read, so a long clause stays linear. */
const LEAD_WINDOW = 200;
/** The most first-person events one clause is read for. */
const EVENTS_MAX = 64;

/**
 * Whether `clause` says the speaker did something that makes `claim` false: "I" or "we" as the
 * subject of a past verb that contradicts the claim's verb (CONTRADICTING_ACTS), acting on the
 * claim's thing (actObject). A plan or wish ("I want to", "I'll"), a habit ("I avoid"), someone
 * else's act ("my advisor recommended"), "I used to", an unreal, supposed, asked, hedged or
 * reported past ("I wish I'd used", "suppose I used", "had I used", "maybe I used", "she told me
 * I used") and a different act on the same thing ("I installed it", "I read a review of it")
 * say nothing happened that the claim denies.
 */
function contradictedIn(clause: string, claim: NeverClaim): boolean {
  const pastTime = PAST_TIME.test(clause);
  let events = 0;
  for (const match of clause.matchAll(EVENT)) {
    // A clause of more first-person events than any message holds is read no further: no note, never a slow read.
    if (++events > EVENTS_MAX) return false;
    const verb = match[2]!;
    const end = match.index + match[0].length;
    const lead = unlabelled(clause.slice(Math.max(0, match.index - LEAD_WINDOW), match.index));
    if (
      !isPast(verb, match[1] !== undefined || pastTime) ||
      UNREAL.test(lead) ||
      INVERTED.test(lead) ||
      REPORTED.test(lead) ||
      lead.includes(":")
    )
      continue;
    const act = verbKey(verb);
    const rest = clause.slice(end, end + 300);
    if (act === "us" && /^\s+to\b/iu.test(rest)) continue;
    // "Michael and I met": the subject's other half counts toward the thing, when it is a name, not a clause.
    const pair = /^\s*((?:[\p{L}’'.-]+\s+){0,2}[\p{L}’'.-]+)\s+and\s+$/u.exec(lead)?.[1] ?? "";
    const conjoined = pair.split(/\s+/).some((w) => isPast(w, false)) ? "" : pair;
    // "was"/"were"/"been" as a helper ("I was planning a trip to Japan") is not being there.
    const there =
      act !== BE ||
      (verb.toLowerCase() === "been" ? BEEN_PLACE : PLACE).test(rest) ||
      (claim.beWord !== "" && new RegExp(`^\\s+${claim.beWord.replace(/[^\p{L}]/gu, "")}\\b`, "iu").test(rest));
    // When nothing named follows ("the two-factor authentication we set up"), the act is on the words before its subject.
    const object: ActObject = nothingNamed(rest)
      ? { text: lead, head: sequenceOf(lead).filter(Boolean).pop(), titled: false }
      : actObject(rest);
    // "Priya and I met": a co-subject that names the whole thing is what the act was with.
    const withThing = (alt: Alt) => conjoined !== "" && held(alt.terms, termsOf(conjoined)) === alt.terms.size;
    if (
      there &&
      claim.alts.some((alt) => contradicts(alt.verb, act) && (withThing(alt) || isTheThing(alt, object, rest)))
    )
      return true;
    // The same subject's next past verbs: "I downloaded Zotero and tagged forty sources with it".
    for (const [, next] of rest.matchAll(/\band\s+(?:then\s+)?([\p{L}’']+)/giu)) {
      const nextAct = verbKey(next!);
      if (nextAct === BE || !isPast(next!, pastTime)) continue;
      if (claim.alts.some((alt) => contradicts(alt.verb, nextAct) && isTheThing(alt, actObject(rest), rest)))
        return true;
    }
  }
  return false;
}

/** Whether a question asks about the claim's thing: it holds most of its terms, and both when it has two. */
const asksAbout = (claim: ReadonlySet<string>, asked: readonly string[]) =>
  held(claim, asked) >= Math.min(claim.size, Math.floor(claim.size / 2) + 1);

/**
 * The first-person clause of `text`, outside its own "never" claims, that names the claim's
 * thing with the most of its terms (the first of equals), or null when none does. A sentence
 * that is a question with a tag ("I used Zotero, didn't I?"), a hedge ("..., I think") or a report
 * ("..., says Sam") holds none, nor does a clause asked ("I used Zotero?") or one after a clause
 * that introduces someone's words ("My sister said,", "According to Sam,").
 */
function mentionIn(text: string, claim: NeverClaim): string | null {
  let best: string | null = null;
  let most = 0;
  for (const sentence of withoutClaims(withoutQuotedSpeech(text)).split(SENTENCE_END)) {
    const clauses = sentence.split(QUOTE_BREAK);
    const tagged =
      clauses.length > 1 &&
      clauses.some((c, k) => k > 0 && c.trim().split(/\s+/).length <= 4 && HEDGE_CLAUSE.test(c.trim()));
    if (tagged) continue;
    clauses.forEach((clause, k) => {
      const earlier = clauses.slice(Math.max(0, k - 2), k);
      if (earlier.some((c) => REPORTED.test(unlabelled(c)) || INTRODUCES_SPEECH.test(unlabelled(c)))) return;
      if (
        NEGATED.test(clause) ||
        FIRST_TIME.test(clause) ||
        /\?\s*$/u.test(clause) ||
        QUESTION_START.test(unlabelled(clause))
      )
        return;
      if (!contradictedIn(clause, claim)) return;
      const terms = termsOf(clause);
      if (held(claim.terms, terms) > most) [best, most] = [clause, held(claim.terms, terms)];
    });
  }
  return best;
}

/**
 * The served "never" claims about `query` that other served lines mention, in the order their
 * lines were served, at most CLAIMS_MAX, each thing once however many lines repeat its claim.
 */
export function neverClaimConflicts(page: readonly { fact: string }[], query: string): NeverClaimConflict[] {
  const asked = termsOf(query);
  const conflicts: NeverClaimConflict[] = [];
  const checked = new Set<string>();
  page.forEach((fact, i) => {
    for (const claim of neverClaimsIn(fact.fact)) {
      const thing = `${claim.verb}:${[...claim.terms].sort().join(" ")}`;
      if (
        conflicts.length >= CLAIMS_MAX ||
        checked.size >= CLAIMS_CHECKED_MAX ||
        checked.has(thing) ||
        !asksAbout(claim.terms, asked)
      )
        continue;
      checked.add(thing);
      const mentions = page
        .flatMap((other, j) => (j === i ? [] : [mentionIn(other.fact, claim)]))
        .filter((m): m is string => m !== null);
      if (mentions.length === 0) continue;
      // The mention naming the most of the thing, the first served of equals.
      const example = mentions.reduce((best, m) =>
        held(claim.terms, termsOf(m)) > held(claim.terms, termsOf(best)) ? m : best,
      );
      conflicts.push({ claim: quoted(claim.text), mentions: mentions.length, example: quoted(example) });
    }
  });
  return conflicts;
}
