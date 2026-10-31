// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// One table of cases, judged by both of erasure's rules, so a drift between them shows.
//
// A person is erased by two implementations of one rule. The erasure itself
// (services/memory/person-erasure.ts) holds the person's name and address in plain text
// and matches them with regular expressions. After a backup restore, the suppression list
// (services/memory/erasure-suppression.ts) holds only digests of them, so the read filter
// and the re-apply match by hashing candidate words. Each case below is a chunk or a
// contact. For a chunk, the erasure's verdict is whether the erasure deleted it, the
// digest rule's is whether the filter would hide it as an old copy. For a contact, the
// erasure's verdict is whether the erasure deleted it, the digest rule's is whether
// `reapplyErasures` deletes its restored copy. They must agree on every row. The rows of
// services/memory/name-fold-spellings.json and services/memory/name-run-together-forms.json,
// which the graph is held to as well (memory-service/tests/test_person_erasure_integration.py),
// are among them.
//
// Real: Postgres, the erasure's DELETE, the suppression list it records and the filter
// built from it. Stand-in: the graph store, a spy (its own rule is proven on Neo4j in
// memory-service/tests/test_person_erasure_integration.py).
import { createHash } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";
import type { AccessContext } from "@/services/access";
import { Prisma } from "@/lib/generated/prisma/client";
import { CAMEL_LOWER, CAMEL_UPPER, foldName, NAME_LETTER, NAME_SPACE } from "./person-name-characters";
import spellings from "./name-fold-spellings.json";
import runTogether from "./name-run-together-forms.json";
import newerLetters from "./name-fold-newer-letters.json";
import { listAsTheApp } from "@/services/memory/erasure-suppression.testsupport";

vi.mock("./store", () => ({
  memory: {},
  graphitiStore: {
    planPersonErasure: async () => [],
    erasePerson: vi.fn(async () => ({ episodes: 0, nodes: 0, edges: 0, summaries: 0, episodeIds: [] })),
    removeChunkFacts: async () => undefined,
  },
}));

const QA_URL = process.env.QA_DATABASE_URL;

const ORG = "qa_erasure_rule_agreement";
const ROOT = `org_${ORG}`;
const ADMIN = "qa_erasure_rule_agreement_admin";
const DIMENSIONS = 384;

/** The people erased, as contacts. */
const PEOPLE = [
  { id: "al", name: "Al Li", email: "al@acme.example" },
  { id: "dana", name: "Dana Whitfield", email: "dana_w@acme.example", entityId: "entity-dana" },
  { id: "ann", name: "Ann Li", email: "ann.li@acme.example" },
  { id: "dan", name: "Dan", email: "dan@acme.com" },
  { id: "zoe", name: "Zo\u00eb Ferrand", email: "zoe@acme.example" },
  // A contact whose name was stored with its accent as a combining mark.
  { id: "renee", name: "Rene\u0301e Duval", email: "renee@acme.example" },
  { id: "ana", name: "Ana Mar\u00eda Ruiz", email: "amr@acme.example" },
  { id: "ali", name: "Ali Kim", email: "ali.kim@acme.example" },
  { id: "nikos", name: "\u039d\u03af\u03ba\u03bf\u03c2 \u03a0\u03b1\u03c0\u03ac\u03c2", email: "nikos@acme.example" },
  // Four characters once composed: too short to erase by as text, found by address only.
  { id: "alu", name: "Al U\u0308", email: "alu@acme.example" },
  // Names whose own words hold a capital, a hyphen or an apostrophe, for the joined spellings.
  { id: "rory", name: "Rory McDonald", email: "rory@acme.example" },
  { id: "anne", name: "Anne-Marie Dupont", email: "amd@acme.example" },
  { id: "siobhan", name: "Siobhan O'Brien", email: "sob@acme.example" },
  // Whose name run together is a common word ("willpower"): erased with him, by choice.
  { id: "will", name: "Will Power", email: "will.power@acme.example" },
  // Whose name ends another's hyphenated given name ("Anne-Marie Laval").
  { id: "marie", name: "Marie Laval", email: "ml@acme.example" },
  // Whose given names others join by a hyphen ("Jean-Pierre Dupont"), and whose words start
  // with capitals outside ASCII, Latin-1, Greek and Cyrillic.
  { id: "jpd", name: "Jean Pierre Dupont", email: "jpd@acme.example" },
  { id: "mihai", name: "Mihai \u0218tefan", email: "ms@acme.example" },
  { id: "jan", name: "Jan \u0141ukasz", email: "jl@acme.example" },
  // Whose own name holds a non-breaking hyphen, which a file name writes as "-".
  { id: "zoeann", name: "Zoe\u2011Ann Kim", email: "zak@acme.example" },
  // The people of the shared spelling table, and of the shared run-together table.
  ...spellings.people,
  ...runTogether.people,
];

type Verdict = "erased" | "kept";

interface Case {
  /** What the case is, as a reader would put it. */
  label: string;
  /** The entity the chunk is filed under: a record's name. */
  name: string;
  content: string;
  /** What the erasure decides, and the digest rule too. */
  expected: Verdict;
}

const RECORD = "Notes.";
const NEUTRAL = "Pricing";

/** #515's cases, QA's bystander suite (person-erasure.bystanders.realdb.qa.test.ts), and the restore cases. */
const CASES: Case[] = [
  // Text: over-erasure, never the person's.
  {
    label: "text: another name containing hers",
    name: NEUTRAL,
    content: "Sal Lin asked for the annual plan.",
    expected: "kept",
  },
  {
    label: "text: an address on a longer domain",
    name: NEUTRAL,
    content: "Sent to al@acme.example.org for review.",
    expected: "kept",
  },
  {
    label: "text: an address ending the same way",
    name: NEUTRAL,
    content: "jordan@acme.com asked for the invoice.",
    expected: "kept",
  },
  { label: "text: a lookalike address", name: NEUTRAL, content: "danaxw@acme.example wrote in.", expected: "kept" },
  {
    label: "text: a name continued by a non-ASCII letter",
    name: NEUTRAL,
    content: "Al Liú signed the order.",
    expected: "kept",
  },
  {
    label: "text: a hyphenated surname",
    name: NEUTRAL,
    content: "Dana Whitfield-Barnes runs procurement.",
    expected: "kept",
  },
  {
    label: "text: a hyphenated surname that ends in hers",
    name: NEUTRAL,
    content: "Ana Dana-Whitfield runs procurement.",
    expected: "kept",
  },
  {
    label: "text: a surname continued by a double hyphen",
    name: NEUTRAL,
    content: "Dana Whitfield--Barnes runs procurement.",
    expected: "kept",
  },
  {
    label: "text: a hyphenated given name ending in hers",
    name: NEUTRAL,
    content: "Mary-Dana Whitfield runs procurement.",
    expected: "kept",
  },
  {
    label: "text: a given name joined to hers by a double hyphen",
    name: NEUTRAL,
    content: "Mary--Dana Whitfield runs procurement.",
    expected: "kept",
  },
  {
    label: "text: a surname continued by a non-breaking hyphen",
    name: NEUTRAL,
    content: "Dana Whitfield\u2011Barnes runs procurement.",
    expected: "kept",
  },
  {
    label: "text: a surname continued by a Unicode hyphen",
    name: NEUTRAL,
    content: "Dana Whitfield\u2010Barnes runs procurement.",
    expected: "kept",
  },
  {
    label: "text: a given name joined to hers by a Unicode hyphen",
    name: NEUTRAL,
    content: "Mary\u2010Dana Whitfield runs procurement.",
    expected: "kept",
  },
  {
    label: "text: a hyphenated surname starting with a modifier word",
    name: NEUTRAL,
    content: "Dana Whitfield-Ledbetter runs procurement.",
    expected: "kept",
  },
  {
    label: "text: a name continued by a combining accent (NFD)",
    name: NEUTRAL,
    content: "Al Li\u0301 signed the order.",
    expected: "kept",
  },
  {
    label: "text: her words joined by a slash",
    name: NEUTRAL,
    content: "The Dana/Whitfield account renewed.",
    expected: "kept",
  },
  {
    label: "text: her words split by a line separator",
    name: NEUTRAL,
    content: "Met Dana\u2028Whitfield today.",
    expected: "kept",
  },
  // Over-erasure accepted: her name as ASCII spells it is hers (asciiSpelling), so another
  // "Zoe Ferrand" is erased with her.
  {
    label: "text: the accent left off, her ASCII spelling",
    name: NEUTRAL,
    content: "Zoe Ferrand signed the order.",
    expected: "erased",
  },
  {
    label: "text: a longer name, decomposed (NFD)",
    name: NEUTRAL,
    content: "Zoe\u0308l Ferrand signed the order.",
    expected: "kept",
  },
  {
    label: "text: surname first, a longer given name",
    name: NEUTRAL,
    content: "Whitfield, Danae owns the renewal.",
    expected: "kept",
  },
  {
    label: "text: surname first, a hyphenated given name",
    name: NEUTRAL,
    content: "Whitfield, Dana-Marie owns the renewal.",
    expected: "kept",
  },
  {
    label: "text: surname first, a hyphenated surname",
    name: NEUTRAL,
    content: "Barnes-Whitfield, Dana owns the renewal.",
    expected: "kept",
  },
  {
    label: "text: surname first, a longer surname",
    name: NEUTRAL,
    content: "Lin, Al signed the order.",
    expected: "kept",
  },
  {
    label: "text: surname first, joined by a slash",
    name: NEUTRAL,
    content: "The Whitfield/Dana account renewed.",
    expected: "kept",
  },
  {
    label: "text: surname first, split by a line separator",
    name: NEUTRAL,
    content: "Whitfield,\u2028Dana owns the renewal.",
    expected: "kept",
  },
  // Read surname first, a list of people or one name running into another names her.
  {
    label: "text: a list, one surname and the next given name",
    name: NEUTRAL,
    content: "Attendees: Wei Li, Ann Chen, Bo Wu.",
    expected: "kept",
  },
  {
    label: "text: a cc line, one surname and the next given name",
    name: NEUTRAL,
    content: "Cc: Tom Whitfield, Dana Cole",
    expected: "kept",
  },
  {
    label: "text: a list with short surnames",
    name: NEUTRAL,
    content: "Present: Mei Li, Al Tan, Jo Wu.",
    expected: "kept",
  },
  { label: "text: a list, Kim then Ali", name: NEUTRAL, content: "Owners: Jo Kim, Ali Park.", expected: "kept" },
  {
    label: "text: her words reversed inside another name",
    name: NEUTRAL,
    content: "Li Ann Tan signed the order.",
    expected: "kept",
  },
  {
    label: "text: her words reversed, no comma",
    name: NEUTRAL,
    content: "Whitfield Dana owns the renewal.",
    expected: "kept",
  },
  {
    label: "text: a three-word name, surname first",
    name: NEUTRAL,
    content: "Ruiz, Ana Mar\u00eda signed the order.",
    expected: "kept",
  },
  // An under-erasure both rules accept: text is never read surname first, because the
  // lists above would be erased with it. A record's whole name still is (below).
  {
    label: "text: her name surname first, missed by both",
    name: NEUTRAL,
    content: "Whitfield, Dana owns the renewal.",
    expected: "kept",
  },
  {
    label: "text: her name surname first in a list, missed by both",
    name: NEUTRAL,
    content: "Li, Ann; Bo Wu",
    expected: "kept",
  },
  // Under-erasure both rules share: "al \u00fc" is four characters once composed, under
  // the five a name needs to be erased by as text.
  {
    label: "text: a name too short once composed, missed by both",
    name: NEUTRAL,
    content: "Al \u00dc signed the order.",
    expected: "kept",
  },
  // Text: under-erasure, always the person's.
  { label: "text: sentence-final address", name: NEUTRAL, content: "Write to al@acme.example.", expected: "erased" },
  { label: "text: possessive", name: NEUTRAL, content: "Al Li's team wants SSO.", expected: "erased" },
  { label: "text: upper case", name: NEUTRAL, content: "CALL AL LI TOMORROW.", expected: "erased" },
  {
    label: "text: lower case, sentence end",
    name: NEUTRAL,
    content: "The renewal owner is al li.",
    expected: "erased",
  },
  { label: "text: mail header", name: NEUTRAL, content: "From: Al Li <al@acme.example>", expected: "erased" },
  {
    label: "text: mailto in any case",
    name: NEUTRAL,
    content: "Write to mailto:AL@ACME.EXAMPLE, today.",
    expected: "erased",
  },
  { label: "text: split across lines", name: NEUTRAL, content: "Owner:\nAl\nLi", expected: "erased" },
  { label: "text: double space", name: NEUTRAL, content: "Met Dana  Whitfield today.", expected: "erased" },
  { label: "text: NBSP", name: NEUTRAL, content: "Met Dana Whitfield today.", expected: "erased" },
  {
    label: "text: inside a longer phrase",
    name: NEUTRAL,
    content: "Dana Whitfield joined the board.",
    expected: "erased",
  },
  {
    label: "text: a modifier after a hyphen",
    name: NEUTRAL,
    content: "The Dana Whitfield-approved budget renewed.",
    expected: "erased",
  },
  {
    label: "text: a modifier after a non-breaking hyphen",
    name: NEUTRAL,
    content: "The Dana Whitfield\u2011approved budget renewed.",
    expected: "erased",
  },
  {
    label: "text: a modifier after a double hyphen, upper case",
    name: NEUTRAL,
    content: "A DANA WHITFIELD--LED TEAM.",
    expected: "erased",
  },
  { label: "text: a bullet dash", name: NEUTRAL, content: "Owners:\n-Dana Whitfield\n-Bo Wu", expected: "erased" },
  { label: "text: a dash with no word after it", name: NEUTRAL, content: "Ask Al Li- or Bo Wu.", expected: "erased" },
  // The person "Zoë Ferrand" is recorded composed (NFC); text and names may spell the "ë"
  // either way, and both rules compose them before they compare.
  {
    label: "text: an accented name, composed (NFC)",
    name: NEUTRAL,
    content: "Zo\u00eb Ferrand signed the order.",
    expected: "erased",
  },
  {
    label: "text: an accented name, decomposed (NFD)",
    name: NEUTRAL,
    content: "Zoe\u0308 Ferrand signed the order.",
    expected: "erased",
  },
  {
    label: "text: an accented name, decomposed, upper case",
    name: NEUTRAL,
    content: "ZOE\u0308 FERRAND SIGNED.",
    expected: "erased",
  },
  {
    label: "text: a name stored decomposed, written composed",
    name: NEUTRAL,
    content: "Ren\u00e9e Duval signed the order.",
    expected: "erased",
  },
  // A name written without spaces, as file names, slugs and addresses write it: her words
  // joined by "_", ".", "-" or a camel-case step (services/memory/person-name-characters.ts,
  // joinedNamePattern).
  { label: "joined: underscores", name: NEUTRAL, content: "Dana_Whitfield_offer.pdf", expected: "erased" },
  { label: "joined: full stops", name: NEUTRAL, content: "Dana.Whitfield.offer.pdf", expected: "erased" },
  {
    label: "joined: hyphens, lower case, missed by both",
    name: NEUTRAL,
    content: "dana-whitfield.pdf",
    expected: "kept",
  },
  {
    label: "joined: hyphens, lower case, then _, missed by both",
    name: NEUTRAL,
    content: "dana-whitfield_offer.pdf",
    expected: "kept",
  },
  {
    label: "joined: hyphens, lower case, then a modifier word, missed by both",
    name: NEUTRAL,
    content: "dana-whitfield-approved.pdf",
    expected: "kept",
  },
  { label: "joined: camel case, then a space", name: NEUTRAL, content: "DanaWhitfield offer.pdf", expected: "erased" },
  { label: "joined: camel case, run on", name: NEUTRAL, content: "DanaWhitfieldOffer.pdf", expected: "erased" },
  { label: "joined: camel case, then a digit", name: NEUTRAL, content: "DanaWhitfield2026.pdf", expected: "erased" },
  {
    label: "joined: a digit right after her surname",
    name: NEUTRAL,
    content: "dana_whitfield2.pdf",
    expected: "erased",
  },
  { label: "joined: upper case snake", name: NEUTRAL, content: "DANA_WHITFIELD_OFFER.PDF", expected: "erased" },
  { label: "joined: a run of mixed marks", name: NEUTRAL, content: "dana_-.whitfield.pdf", expected: "erased" },
  {
    label: "joined: hyphens, a bullet dash before, missed by both",
    name: NEUTRAL,
    content: "-dana-whitfield.pdf",
    expected: "kept",
  },
  {
    label: "joined: hyphens after a colon, missed by both",
    name: NEUTRAL,
    content: "Re: dana-whitfield",
    expected: "kept",
  },
  {
    label: "joined: in a path, missed by both",
    name: NEUTRAL,
    content: "https://drive.example/Shared/dana-whitfield/offer",
    expected: "kept",
  },
  {
    label: "joined: an address's local part",
    name: NEUTRAL,
    content: "Write to dana.whitfield@other.example today.",
    expected: "erased",
  },
  { label: "joined: possessive", name: NEUTRAL, content: "Dana_Whitfield's notes.txt", expected: "erased" },
  { label: "joined: a short name", name: NEUTRAL, content: "Al_Li_review.docx", expected: "erased" },
  {
    label: "joined: a three-word name, underscores",
    name: NEUTRAL,
    content: "ana_mar\u00eda_ruiz.docx",
    expected: "erased",
  },
  {
    label: "joined: a three-word name, camel case",
    name: NEUTRAL,
    content: "AnaMar\u00edaRuiz.docx",
    expected: "erased",
  },
  {
    label: "joined: an accented name, composed (NFC)",
    name: NEUTRAL,
    content: "Zo\u00eb_Ferrand.pdf",
    expected: "erased",
  },
  {
    label: "joined: an accented name, decomposed (NFD)",
    name: NEUTRAL,
    content: "Zoe\u0308_Ferrand.pdf",
    expected: "erased",
  },
  {
    label: "joined: an accented name in camel case",
    name: NEUTRAL,
    content: "Zo\u00ebFerrand.pdf",
    expected: "erased",
  },
  {
    label: "joined: a Greek name in camel case",
    name: NEUTRAL,
    content: "\u039d\u03af\u03ba\u03bf\u03c2\u03a0\u03b1\u03c0\u03ac\u03c2.pdf",
    expected: "erased",
  },
  {
    label: "joined: a surname holding a capital, underscores",
    name: NEUTRAL,
    content: "rory_mcdonald.pdf",
    expected: "erased",
  },
  {
    label: "joined: a surname holding a capital, full stops",
    name: NEUTRAL,
    content: "Rory.McDonald.pdf",
    expected: "erased",
  },
  {
    label: "joined: a hyphenated given name, underscores",
    name: NEUTRAL,
    content: "Anne_Marie_Dupont.pdf",
    expected: "erased",
  },
  {
    label: "joined: a hyphenated given name, hyphens, missed by both",
    name: NEUTRAL,
    content: "anne-marie-dupont.pdf",
    expected: "kept",
  },
  {
    label: "joined: a hyphenated given name, camel case",
    name: NEUTRAL,
    content: "AnneMarieDupont.pdf",
    expected: "erased",
  },
  {
    label: "joined: a hyphenated given name written with spaces",
    name: NEUTRAL,
    content: "Anne Marie Dupont signed the order.",
    expected: "erased",
  },
  // Only an inline space stands for her own hyphen: a tab or a line break parts two entries.
  {
    label: "joined: a tab where her name has a hyphen",
    name: NEUTRAL,
    content: "Mentor\tMentee\nAnne\tMarie Dupont",
    expected: "kept",
  },
  {
    label: "joined: a line break where her name has a hyphen",
    name: NEUTRAL,
    content: "Present:\nAnne\nMarie Dupont\nBo Wu",
    expected: "kept",
  },
  {
    label: "joined: a line break where her name has a space, then a digit",
    name: NEUTRAL,
    content: "Anne_Marie\nDupont2.pdf",
    expected: "erased",
  },
  {
    label: "joined: a line break between her words, then a digit",
    name: NEUTRAL,
    content: "Dana\nWhitfield2.pdf",
    expected: "erased",
  },
  {
    label: "joined: her given names joined by underscores",
    name: NEUTRAL,
    content: "jean_pierre_dupont.pdf",
    expected: "erased",
  },
  {
    label: "joined: her given names, a lower-case slug, missed by both",
    name: NEUTRAL,
    content: "jean-pierre-dupont.pdf",
    expected: "kept",
  },
  {
    label: "joined: a lower-case slug, a capital outside ASCII, missed by both",
    name: NEUTRAL,
    content: "mihai-\u0219tefan.pdf",
    expected: "kept",
  },
  {
    label: "joined: a modifier word, then a digit, after a spaced name",
    name: NEUTRAL,
    content: "Dana Whitfield-approved2026.pdf",
    expected: "erased",
  },
  {
    label: "joined: a modifier word, then a camel-case step, after a spaced name",
    name: NEUTRAL,
    content: "Dana Whitfield-ledTeam.pdf",
    expected: "erased",
  },
  {
    label: "joined: an apostrophe in the surname",
    name: NEUTRAL,
    content: "Siobhan_O'Brien_cv.pdf",
    expected: "erased",
  },
  {
    label: "joined: an apostrophe in the surname, hyphens, missed by both",
    name: NEUTRAL,
    content: "siobhan-o'brien.pdf",
    expected: "kept",
  },
  {
    label: "joined: a link's %20",
    name: NEUTRAL,
    content: "https://drive.example/Dana%20Whitfield%20offer.pdf",
    expected: "erased",
  },
  {
    label: "joined: a spaced name, then a camel-case step",
    name: NEUTRAL,
    content: "Dana WhitfieldOffer.pdf",
    expected: "erased",
  },
  { label: "joined: a spaced name, then a digit", name: NEUTRAL, content: "Dana Whitfield2.pdf", expected: "erased" },
  {
    label: "joined: a Unicode hyphen, missed by both",
    name: NEUTRAL,
    content: "dana\u2010whitfield.pdf",
    expected: "kept",
  },
  {
    label: "joined: a non-breaking hyphen, then _, missed by both",
    name: NEUTRAL,
    content: "dana\u2011whitfield_offer.pdf",
    expected: "kept",
  },
  {
    label: "joined: a hyphenated given name, capitalised, then _",
    name: NEUTRAL,
    content: "Anne-Marie_Dupont.pdf",
    expected: "erased",
  },
  {
    label: "joined: a capitalised modifier word after a hyphen",
    name: NEUTRAL,
    content: "Dana_Whitfield-Approved_budget.xlsx",
    expected: "erased",
  },
  {
    label: "joined: a modifier word after a hyphen, then a camel-case step",
    name: NEUTRAL,
    content: "DanaWhitfield-ledTeam.pdf",
    expected: "erased",
  },
  {
    label: "joined: a surname starting with a modifier word, camel case",
    name: NEUTRAL,
    content: "DanaWhitfield-Ledbetter.pdf",
    expected: "kept",
  },
  {
    label: "joined: a U+0001 the text held inside camel case",
    name: NEUTRAL,
    content: "Dana\u0001Whitfield.pdf",
    expected: "erased",
  },
  {
    label: "joined: fullwidth letters (NFKC)",
    name: NEUTRAL,
    content: "\uff24\uff41\uff4e\uff41\uff3f\uff37\uff48\uff49\uff54\uff46\uff49\uff45\uff4c\uff44.pdf",
    expected: "erased",
  },
  { label: "joined: a curly apostrophe", name: NEUTRAL, content: "Siobhan_O\u2019Brien.pdf", expected: "erased" },
  {
    label: "joined: a U+0001 the text held before her name",
    name: NEUTRAL,
    content: "\u0001Dana_Whitfield_offer.pdf",
    expected: "erased",
  },
  {
    label: "joined: a modifier word after a hyphen",
    name: NEUTRAL,
    content: "Dana_Whitfield-approved_budget.xlsx",
    expected: "erased",
  },
  {
    label: "text: a ligature (NFKC)",
    name: NEUTRAL,
    content: "Dana Whit\ufb01eld signed the order.",
    expected: "erased",
  },
  {
    label: "text: fullwidth letters with a space (NFKC)",
    name: NEUTRAL,
    content: "\uff24\uff41\uff4e\uff41 \uff37\uff48\uff49\uff54\uff46\uff49\uff45\uff4c\uff44 signed.",
    expected: "erased",
  },
  {
    label: "text: an address in fullwidth letters (NFKC)",
    name: NEUTRAL,
    content: "Write to \uff21\uff2c\uff20\uff41\uff43\uff4d\uff45.example today.",
    expected: "erased",
  },
  {
    label: "text: a curly apostrophe",
    name: NEUTRAL,
    content: "Siobhan O\u2019Brien signed the order.",
    expected: "erased",
  },
  // Her words joined by hyphens alone, in any case, are spelled as another person's double
  // surname or compound given name, and over-erasure is worse than under-erasure (one
  // passage removes a whole upload): kept, so her own slug is missed.
  {
    label: "joined: a slug of a hyphenated surname",
    name: NEUTRAL,
    content: "dana-whitfield-barnes.pdf",
    expected: "kept",
  },
  {
    label: "joined: a slug of a hyphenated given name ending in hers",
    name: NEUTRAL,
    content: "anne-marie-laval.pdf",
    expected: "kept",
  },
  {
    label: "joined: a slug, non-breaking hyphens, a further word",
    name: NEUTRAL,
    content: "dana\u2011whitfield\u2011barnes.pdf",
    expected: "kept",
  },
  {
    label: "joined: a slug, a word and a hyphen before",
    name: NEUTRAL,
    content: "offer-dana-whitfield.pdf",
    expected: "kept",
  },
  {
    label: "joined: a hyphenated surname, a Unicode hyphen, underscores",
    name: NEUTRAL,
    content: "Dana_Whitfield\u2011Barnes_CV.pdf",
    expected: "kept",
  },
  {
    label: "joined: a hyphenated given name ending in hers, a Unicode hyphen",
    name: NEUTRAL,
    content: "Anne\u2010Marie_Laval_CV.pdf",
    expected: "kept",
  },
  {
    label: "joined: a capitalised double surname, a file",
    name: NEUTRAL,
    content: "Dana-Whitfield.pdf",
    expected: "kept",
  },
  {
    label: "joined: a capitalised double surname, a Unicode hyphen",
    name: NEUTRAL,
    content: "Dana\u2010Whitfield.pdf",
    expected: "kept",
  },
  { label: "joined: a double surname in capitals", name: NEUTRAL, content: "DANA-WHITFIELD.PDF", expected: "kept" },
  {
    label: "joined: a double surname, the second word capitalised",
    name: NEUTRAL,
    content: "dana-Whitfield.pdf",
    expected: "kept",
  },
  {
    label: "joined: a double surname in a citation",
    name: NEUTRAL,
    content: "(Dana-Whitfield, 2019)",
    expected: "kept",
  },
  {
    label: "joined: a double surname in a reference list",
    name: NEUTRAL,
    content: "[3] Dana-Whitfield, A. Pricing at scale.",
    expected: "kept",
  },
  {
    label: "joined: a double surname opening a line",
    name: NEUTRAL,
    content: "Authors:\nDana-Whitfield, A.",
    expected: "kept",
  },
  {
    label: "joined: a three-word name, capitalised hyphens alone",
    name: NEUTRAL,
    content: "Anne-Marie-Dupont.pdf",
    expected: "kept",
  },
  { label: "name: a capitalised double surname", name: "Dana-Whitfield", content: RECORD, expected: "kept" },
  // A capital in any script: Latin Extended, Greek Extended.
  {
    label: "joined: a compound given name, a capital outside Latin-1",
    name: NEUTRAL,
    content: "Mihai-\u0218tefan Popescu signed the lease.",
    expected: "kept",
  },
  {
    label: "joined: a double surname in a citation, a capital outside Latin-1",
    name: NEUTRAL,
    content: "(Mihai-\u0218tefan, 2019) found the opposite.",
    expected: "kept",
  },
  {
    label: "joined: a compound given name, a stroked capital",
    name: NEUTRAL,
    content: "Jan-\u0141ukasz Nowak signed.",
    expected: "kept",
  },
  {
    label: "name: a compound given name, a capital outside Latin-1",
    name: "Mihai-\u0218tefan",
    content: RECORD,
    expected: "kept",
  },
  // A hyphen where her own name has a space makes another name.
  {
    label: "joined: a compound given name where hers are two",
    name: NEUTRAL,
    content: "Jean-Pierre Dupont signed.",
    expected: "kept",
  },
  {
    label: "joined: a compound given name where hers are two, a file",
    name: NEUTRAL,
    content: "Jean-Pierre_Dupont_CV.pdf",
    expected: "kept",
  },
  {
    label: "joined: a compound given name where hers are two, lower case",
    name: NEUTRAL,
    content: "jean-pierre_dupont_cv.pdf",
    expected: "kept",
  },
  {
    label: "name: a compound given name where hers are two",
    name: "jean-pierre_dupont",
    content: RECORD,
    expected: "kept",
  },
  {
    label: "joined: her own hyphen written as an ASCII hyphen",
    name: NEUTRAL,
    content: "zoe-ann_kim.pdf",
    expected: "erased",
  },
  {
    label: "joined: an en dash before her name",
    name: NEUTRAL,
    content: "Barnes\u2013Dana_Whitfield.pdf",
    expected: "kept",
  },
  {
    label: "joined: a double surname out of her given name and surname",
    name: NEUTRAL,
    content: "Anne Marie-Dupont signed.",
    expected: "kept",
  },
  {
    label: "joined: a double surname out of her given name and surname, a title",
    name: NEUTRAL,
    content: "Prof. Anne Marie-Dupont replied.",
    expected: "kept",
  },
  // Every dash continues a word, and every compatibility hyphen once folded.
  {
    label: "joined: an en dash after her name",
    name: NEUTRAL,
    content: "Dana_Whitfield\u2013Barnes_CV.pdf",
    expected: "kept",
  },
  // Hyphens alone where her own name has whitespace spell another person's double surname or
  // compound given name ("jean-pierre dupont", "anne-marie_laval_cv.pdf"), so her slug is missed.
  {
    label: "joined: a double hyphen before a capital",
    name: NEUTRAL,
    content: "(Dana--Whitfield, 2019)",
    expected: "kept",
  },
  // An em dash is punctuation, written without spaces in US style: her name beside one is hers.
  {
    label: "text: an em dash after her name",
    name: NEUTRAL,
    content: "I met Dana Whitfield\u2014she signed the lease.",
    expected: "erased",
  },
  {
    label: "text: em dashes around her name",
    name: NEUTRAL,
    content: "Our CFO\u2014Dana Whitfield\u2014signed the lease.",
    expected: "erased",
  },
  {
    label: "text: a horizontal bar after her name",
    name: NEUTRAL,
    content: "Dana Whitfield\u2015the CFO",
    expected: "erased",
  },
  // An en dash continues a word, as in a double surname: between two full names it is missed.
  {
    label: "text: an en dash between her name and another, missed by both",
    name: NEUTRAL,
    content: "the Dana Whitfield\u2013Bo Wu agreement",
    expected: "kept",
  },
  {
    label: "text: an en dash between another name and hers, missed by both",
    name: NEUTRAL,
    content: "the Bo Wu\u2013Dana Whitfield agreement",
    expected: "kept",
  },
  // "%2D" is not decoded: a hyphen written so does not join her name to another word.
  {
    label: "joined: an encoded hyphen after her name, read as hers",
    name: NEUTRAL,
    content: "Dana_Whitfield%2DBarnes.pdf",
    expected: "erased",
  },
  {
    label: "joined: an em dash after her name, punctuation",
    name: NEUTRAL,
    content: "Dana_Whitfield\u2014Barnes.pdf",
    expected: "erased",
  },
  {
    label: "joined: a soft hyphen after her name",
    name: NEUTRAL,
    content: "Dana_Whitfield\u00adBarnes.pdf",
    expected: "kept",
  },
  {
    label: "text: a surname continued by an en dash",
    name: NEUTRAL,
    content: "Dana Whitfield\u2013Barnes runs procurement.",
    expected: "kept",
  },
  {
    label: "text: a given name joined to hers by an en dash",
    name: NEUTRAL,
    content: "Mary\u2013Dana Whitfield runs procurement.",
    expected: "kept",
  },
  {
    label: "text: a surname continued by a fullwidth hyphen",
    name: NEUTRAL,
    content: "Dana Whitfield\uff0dBarnes signed.",
    expected: "kept",
  },
  {
    label: "joined: a fullwidth hyphen after her name",
    name: NEUTRAL,
    content: "Dana_Whitfield\uff0dBarnes_CV.pdf",
    expected: "kept",
  },
  {
    label: "text: a small hyphen-minus before her name",
    name: NEUTRAL,
    content: "Mary\ufe63Dana Whitfield signed.",
    expected: "kept",
  },
  {
    label: "text: a feminine ordinal after her name",
    name: NEUTRAL,
    content: "Dana Whitfield\u00aa signed.",
    expected: "kept",
  },
  {
    label: "text: a masculine ordinal before her name",
    name: NEUTRAL,
    content: "\u00baDana Whitfield signed.",
    expected: "kept",
  },
  // Written without spaces: over-erasure, never the person's.
  {
    label: "joined: a hyphenated surname, underscores",
    name: NEUTRAL,
    content: "Dana_Whitfield-Barnes_CV.pdf",
    expected: "kept",
  },
  {
    label: "joined: a hyphenated surname in an address",
    name: NEUTRAL,
    content: "Write to dana.whitfield-barnes@other.example",
    expected: "kept",
  },
  {
    label: "joined: a hyphenated surname in camel case",
    name: NEUTRAL,
    content: "DanaWhitfield-Barnes.pdf",
    expected: "kept",
  },
  {
    label: "joined: a hyphenated given name ending in hers",
    name: NEUTRAL,
    content: "Anne-Marie_Laval_CV.pdf",
    expected: "kept",
  },
  {
    label: "joined: a hyphenated given name ending in hers, an address",
    name: NEUTRAL,
    content: "Write to anne-marie.laval@other.example",
    expected: "kept",
  },
  {
    label: "joined: a double surname after a given name and _",
    name: NEUTRAL,
    content: "Ana_Dana-Whitfield_CV.pdf",
    expected: "kept",
  },
  {
    label: "joined: a double surname after an initial",
    name: NEUTRAL,
    content: "Ana M. Dana-Whitfield signed the order.",
    expected: "kept",
  },
  {
    label: "joined: a double surname after a title",
    name: NEUTRAL,
    content: "Mrs. Dana-Whitfield signed the order.",
    expected: "kept",
  },
  // A U+0001 the text held is dropped before steps are read, so her words run together.
  { label: "joined: a U+0001 between her words", name: NEUTRAL, content: "dana\u0001whitfield", expected: "erased" },
  {
    label: "joined: a U+0001 the text held, then her name at a camel-case step",
    name: NEUTRAL,
    content: "Offer\u0001Dana_Whitfield.pdf",
    expected: "kept",
  },
  // A currency sign is in the letters' code point range, so it continues a word in every store.
  {
    label: "joined: a currency sign before her name",
    name: NEUTRAL,
    content: "\u20acDana_Whitfield.pdf",
    expected: "kept",
  },
  {
    label: "text: a currency sign after her name",
    name: NEUTRAL,
    content: "Dana Whitfield\u20ac signed.",
    expected: "kept",
  },
  { label: "joined: part of a hyphenated given name", name: NEUTRAL, content: "Marie_Dupont.pdf", expected: "kept" },
  {
    label: "joined: another word starting with her given name",
    name: NEUTRAL,
    content: "Danaher_offer.pdf",
    expected: "kept",
  },
  { label: "joined: a longer given name", name: NEUTRAL, content: "Danaher_Whitfield.pdf", expected: "kept" },
  { label: "joined: another given name", name: NEUTRAL, content: "Diana_Whitfield_offer.pdf", expected: "kept" },
  { label: "joined: a surname one letter off", name: NEUTRAL, content: "Dana_Whitfeld.pdf", expected: "kept" },
  { label: "joined: a longer surname in camel case", name: NEUTRAL, content: "DanaWhitfieldson.pdf", expected: "kept" },
  { label: "joined: a longer surname, short name", name: NEUTRAL, content: "al_lin.pdf", expected: "kept" },
  { label: "joined: a longer given name, short name", name: NEUTRAL, content: "sal_li.pdf", expected: "kept" },
  {
    label: "joined: a double surname after a given name",
    name: NEUTRAL,
    content: "Ana Dana-Whitfield.pdf",
    expected: "kept",
  },
  {
    label: "joined: a double surname after a given name, possessive",
    name: NEUTRAL,
    content: "Ana Dana-Whitfield's file",
    expected: "kept",
  },
  { label: "joined: a slash", name: NEUTRAL, content: "Dana/Whitfield.pdf", expected: "kept" },
  {
    label: "joined: a full stop ending a sentence",
    name: NEUTRAL,
    content: "I called Dana. Whitfield answered.",
    expected: "kept",
  },
  { label: "joined: her given name ending a camel-case word", name: NEUTRAL, content: "JoAnnLi.pdf", expected: "kept" },
  { label: "joined: surname first", name: NEUTRAL, content: "whitfield_dana.pdf", expected: "kept" },
  // Her whole name run together, 6 characters or more, is hers (person-name-characters.ts,
  // concatenatedNames), at the same edges as every joined form.
  { label: "joined: run together in one case", name: NEUTRAL, content: "danawhitfield.pdf", expected: "erased" },
  { label: "joined: run together, upper case", name: NEUTRAL, content: "DANAWHITFIELD offer", expected: "erased" },
  {
    label: "joined: run together, possessive",
    name: NEUTRAL,
    content: "danawhitfield's notes.txt",
    expected: "erased",
  },
  { label: "joined: run together after an apostrophe", name: NEUTRAL, content: "l'danawhitfield", expected: "erased" },
  {
    label: "joined: run together, a modifier after a hyphen",
    name: NEUTRAL,
    content: "danawhitfield-approved.pdf",
    expected: "erased",
  },
  {
    label: "joined: run together, then a camel-case step",
    name: NEUTRAL,
    content: "DanawhitfieldOffer.pdf",
    expected: "erased",
  },
  {
    label: "joined: run together after an encoded space",
    name: NEUTRAL,
    content: "https://drive.example/offer%20danawhitfield.pdf",
    expected: "erased",
  },
  {
    label: "joined: run together, a hyphenated given name",
    name: NEUTRAL,
    content: "annemariedupont.pdf",
    expected: "erased",
  },
  {
    label: "joined: run together, an apostrophe in her name",
    name: NEUTRAL,
    content: "siobhano'brien.pdf",
    expected: "erased",
  },
  {
    label: "joined: run together, her apostrophe left out",
    name: NEUTRAL,
    content: "#siobhanobrien",
    expected: "erased",
  },
  {
    label: "joined: run together, her apostrophe left out, camel case",
    name: NEUTRAL,
    content: "SiobhanOBrien.pdf",
    expected: "erased",
  },
  {
    label: "joined: run together, a capital inside a word, then a digit",
    name: NEUTRAL,
    content: "RoryMcDonald2026.pdf",
    expected: "erased",
  },
  {
    label: "joined: run together, a capital inside a word, then a camel-case word",
    name: NEUTRAL,
    content: "RoryMcDonaldOffer.pdf",
    expected: "erased",
  },
  {
    label: "joined: run together, a capital inside a word, then capitals",
    name: NEUTRAL,
    content: "RoryMcDonaldCV.pdf",
    expected: "erased",
  },
  {
    label: "joined: run together, a capital inside a word, then a modifier and a step",
    name: NEUTRAL,
    content: "RoryMcDonald-ledTeam.pdf",
    expected: "erased",
  },
  // Over-erasure accepted: a common word spelled as her whole name run together.
  {
    label: "joined: run together, a common word spelled as her name",
    name: NEUTRAL,
    content: "It takes willpower.",
    expected: "erased",
  },
  { label: "joined: run together, three words", name: NEUTRAL, content: "jeanpierredupont@", expected: "erased" },
  {
    label: "joined: run together inside a longer word",
    name: NEUTRAL,
    content: "offerdanawhitfield.pdf",
    expected: "kept",
  },
  { label: "joined: run together, a longer surname", name: NEUTRAL, content: "danawhitfieldson.pdf", expected: "kept" },
  {
    label: "joined: run together, a hyphenated surname",
    name: NEUTRAL,
    content: "danawhitfield-barnes.pdf",
    expected: "kept",
  },
  {
    label: "joined: run together, a hyphenated word before",
    name: NEUTRAL,
    content: "offer-danawhitfield.pdf",
    expected: "kept",
  },
  {
    label: "joined: run together after a camel-case step",
    name: NEUTRAL,
    content: "JoDanawhitfield.pdf",
    expected: "kept",
  },
  {
    label: "joined: run together with only part of her name",
    name: NEUTRAL,
    content: "jeanpierre_notes.pdf",
    expected: "kept",
  },
  // Under-erasure both rules accept, each to keep a bystander's name out.
  // Run together under 6 characters: "alli" is Alli, "annli" may be anyone's handle.
  { label: "joined: run together, too short", name: NEUTRAL, content: "annli_notes.pdf", expected: "kept" },
  { label: "joined: run together, another name", name: NEUTRAL, content: "Alli_report.pdf", expected: "kept" },
  // Starting at a camel-case step: "JoAnnLi" would name Ann Li.
  {
    label: "joined: after a camel-case step, missed by both",
    name: NEUTRAL,
    content: "OfferDanaWhitfield.pdf",
    expected: "kept",
  },
  // A camel-case step inside a word of hers breaks the word, as "JoAnn" must, but her words
  // run together are her whole name, steps or none (concatenatedNames).
  {
    label: "joined: camel case, a surname holding a capital",
    name: NEUTRAL,
    content: "RoryMcDonald.pdf",
    expected: "erased",
  },
  {
    label: "joined: hyphens alone after a word and _, missed by both",
    name: NEUTRAL,
    content: "offer_dana-whitfield.pdf",
    expected: "kept",
  },
  // Marks no rule reads as joining a name.
  // A spaced name and a hyphenated word after it reads as a longer surname, as "Dana Whitfield-Barnes".
  {
    label: "joined: a spaced name, then a hyphenated word, missed by both",
    name: NEUTRAL,
    content: "Dana Whitfield-offer.pdf",
    expected: "kept",
  },
  { label: "joined: an en dash, missed by both", name: NEUTRAL, content: "Dana\u2013Whitfield.pdf", expected: "kept" },
  { label: "joined: a plus, missed by both", name: NEUTRAL, content: "?q=Dana+Whitfield", expected: "kept" },
  {
    label: "joined: a date before a camel-case name",
    name: NEUTRAL,
    content: "2026DanaWhitfield.pdf",
    expected: "erased",
  },
  {
    label: "text: a soft hyphen inside a word, missed by both",
    name: NEUTRAL,
    content: "Dana Whit\u00adfield signed.",
    expected: "kept",
  },
  {
    label: "text: a zero-width space, missed by both",
    name: NEUTRAL,
    content: "Dana\u200bWhitfield signed.",
    expected: "kept",
  },
  // Hyphens alone after a word and a space read as a double surname ("Ana Dana-Whitfield").
  {
    label: "joined: hyphens after a word, missed by both",
    name: NEUTRAL,
    content: "Offer for dana-whitfield.pdf",
    expected: "kept",
  },
  // A record's name: over-erasure.
  { label: "name: another name containing hers", name: "Sal Lin", content: RECORD, expected: "kept" },
  { label: "name: a longer name ending in hers", name: "Kristal Lindberg", content: RECORD, expected: "kept" },
  { label: "name: a longer address", name: "hal@acme.example.org", content: RECORD, expected: "kept" },
  { label: "name: a lookalike address", name: "sal@acme.example", content: RECORD, expected: "kept" },
  { label: "name: hers with a first name before it", name: "Mary Ann Li", content: RECORD, expected: "kept" },
  { label: "name: hers with a word after it", name: "Ann Li Wei", content: RECORD, expected: "kept" },
  { label: "name: an entity named after her", name: "Dana Whitfield Foundation", content: RECORD, expected: "kept" },
  { label: "name: a hyphenated surname", name: "Dana Whitfield-Barnes", content: RECORD, expected: "kept" },
  { label: "name: continued by a non-ASCII letter", name: "Al Liú", content: RECORD, expected: "kept" },
  { label: "name: continued by a combining accent (NFD)", name: "Al Li\u0301", content: RECORD, expected: "kept" },
  {
    label: "name: her words split by a line separator",
    name: "Dana\u2028Whitfield",
    content: RECORD,
    expected: "kept",
  },
  {
    label: "name: surname first, split by a line separator",
    name: "Whitfield\u2028Dana",
    content: RECORD,
    expected: "kept",
  },
  {
    label: "name: hers followed by a byte-order mark",
    name: "Dana Whitfield\ufeff",
    content: RECORD,
    expected: "kept",
  },
  { label: "name: an honorific with the surname", name: "Ms. Whitfield", content: RECORD, expected: "kept" },
  { label: "name: the accent left off, her ASCII spelling", name: "Zoe Ferrand", content: RECORD, expected: "erased" },
  {
    label: "name: a hyphenated surname, decomposed (NFD)",
    name: "Zoe\u0308 Ferrand-Roy",
    content: RECORD,
    expected: "kept",
  },
  { label: "name: written without spaces, surname first", name: "whitfield_dana", content: RECORD, expected: "kept" },
  {
    label: "name: an entity named after her, without spaces",
    name: "Dana_Whitfield_Foundation",
    content: RECORD,
    expected: "kept",
  },
  { label: "name: a longer given name, without spaces", name: "Danaher_Whitfield", content: RECORD, expected: "kept" },
  // A record's name: under-erasure.
  { label: "name: hers, underscores", name: "dana_whitfield", content: RECORD, expected: "erased" },
  { label: "name: hers, camel case", name: "DanaWhitfield", content: RECORD, expected: "erased" },
  { label: "name: hers, run together", name: " DANAWHITFIELD ", content: RECORD, expected: "erased" },
  { label: "name: hers, run together, possessive", name: "danawhitfield's", content: RECORD, expected: "kept" },
  {
    label: "name: hers, run together, an encoded space after",
    name: "danawhitfield%20",
    content: RECORD,
    expected: "erased",
  },
  {
    label: "name: hers, run together, encoded spaces around, upper case",
    name: "%20DANAWHITFIELD%20",
    content: RECORD,
    expected: "erased",
  },
  {
    label: "name: hers, run together with an apostrophe, an encoded space after",
    name: "siobhano'brien%20",
    content: RECORD,
    expected: "erased",
  },
  { label: "name: hers, a login, missed by both", name: " dana-whitfield ", content: RECORD, expected: "kept" },
  {
    label: "name: a hyphenated given name, full stops",
    name: "anne.marie.dupont",
    content: RECORD,
    expected: "erased",
  },
  { label: "name: hers", name: "Al Li", content: RECORD, expected: "erased" },
  { label: "name: surname first with a comma", name: "Li, Al", content: RECORD, expected: "erased" },
  { label: "name: surname first", name: "Whitfield Dana", content: RECORD, expected: "erased" },
  { label: "name: double space", name: "Dana  Whitfield", content: RECORD, expected: "erased" },
  { label: "name: tab", name: "Dana\tWhitfield", content: RECORD, expected: "erased" },
  { label: "name: NBSP", name: "Dana Whitfield", content: RECORD, expected: "erased" },
  {
    label: "name: her address, padded, upper case",
    name: " DANA_W@acme.example ",
    content: RECORD,
    expected: "erased",
  },
  { label: "name: an accented name, composed (NFC)", name: "Zo\u00eb Ferrand", content: RECORD, expected: "erased" },
  { label: "name: an accented name, decomposed (NFD)", name: "Zoe\u0308 Ferrand", content: RECORD, expected: "erased" },
  { label: "name: surname first, decomposed (NFD)", name: "Ferrand, Zoe\u0308", content: RECORD, expected: "erased" },
  {
    label: "name: a name stored decomposed, written composed",
    name: "Ren\u00e9e Duval",
    content: RECORD,
    expected: "erased",
  },
  // Case folding beyond ASCII: the Turkish dotted and dotless i, final sigma, sharp s,
  // compatibility forms and combining marks.
  ...spellings.cases.map((c) => ({
    label: `spelling: ${c.label}`,
    name: c.name ?? NEUTRAL,
    content: c.content,
    expected: c.expected as Verdict,
  })),
  ...runTogether.cases.map((c) => ({
    label: `run together: ${c.label}`,
    name: c.name ?? NEUTRAL,
    content: c.content,
    expected: c.expected as Verdict,
  })),
];

interface ContactCase {
  label: string;
  name: string;
  email: string | null;
  entityId?: string;
  expected: Verdict;
}

/** Contacts that exist when the people above are erased, and come back in a restore. */
const CONTACT_CASES: ContactCase[] = [
  { label: "contact: a name containing hers", name: "Mary Ann Li", email: "mary.ann@other.example", expected: "kept" },
  {
    label: "contact: an entity named after her",
    name: "Dana Whitfield Foundation",
    email: "hello@foundation.example",
    expected: "kept",
  },
  {
    label: "contact: a hyphenated surname containing hers",
    name: "Ana Dana-Whitfield",
    email: "ana@other.example",
    expected: "kept",
  },
  {
    label: "contact: her name, another address",
    name: "Dana Whitfield",
    email: "dana@other.example",
    expected: "kept",
  },
  { label: "contact: a one-word name, another address", name: "Dan", email: "dan@other.example", expected: "kept" },
  { label: "contact: her address under another name", name: "A. Li", email: "AL@acme.example", expected: "erased" },
  // Without an address, a contact is hers only if the erasure removed that very row.
  { label: "contact: her name, no address, another row", name: "Ann Li", email: null, expected: "kept" },
  {
    label: "contact: her name decomposed (NFD), no address, another row",
    name: "Zoe\u0308 Ferrand",
    email: null,
    expected: "kept",
  },
  {
    label: "contact: her name, no address, linked to her graph entity",
    name: "Dana Whitfield",
    email: null,
    entityId: "entity-dana",
    expected: "erased",
  },
  {
    label: "contact: another name, no address, linked to her graph entity",
    name: "D. W.",
    email: null,
    entityId: "entity-dana",
    expected: "erased",
  },
];

describe.skipIf(!QA_URL)("erasure's two rules decide every case alike", () => {
  let db: PrismaClient;
  let erasePerson: (typeof import("./person-erasure"))["erasePerson"];
  let foldedText: (typeof import("./person-erasure"))["foldedText"];
  let loadErasedContentFilter: (typeof import("./erasure-suppression"))["loadErasedContentFilter"];
  let reapplyErasures: (typeof import("./erasure-reapply"))["reapplyErasures"];

  const admin: AccessContext = { orgId: ORG, actor: { type: "human", id: ADMIN, role: "admin" }, origin: "app" };
  const written = new Date(Date.now() - 24 * 3600 * 1000);
  const idOf = (i: number) => `case-${String(i).padStart(2, "0")}`;

  async function wipe() {
    await db.$executeRaw`DELETE FROM memory_chunks WHERE "orgId" = ${ORG}`;
    await db.erasureSuppression.deleteMany({ where: { orgId: ORG } });
    await db.contact.deleteMany({ where: { orgId: ORG } });
    await db.auditLog.deleteMany({ where: { orgId: ORG } });
    await db.grant.deleteMany({ where: { orgId: ORG } });
    await db.scope.deleteMany({ where: { orgId: ORG } });
    await db.user.deleteMany({ where: { orgId: ORG } });
  }

  beforeAll(async () => {
    process.env.DATABASE_URL = QA_URL;
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });
    ({ erasePerson, foldedText } = await import("./person-erasure"));
    ({ loadErasedContentFilter } = await import("./erasure-suppression"));
    ({ reapplyErasures } = await import("./erasure-reapply"));
  });

  afterAll(async () => {
    if (!db) return;
    await wipe();
    await db.$disconnect();
  });

  beforeEach(async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await wipe();
    await db.org.upsert({ where: { id: ORG }, update: {}, create: { id: ORG, name: ORG } });
    const root = await db.scope.create({ data: { orgId: ORG, path: ROOT, name: "root" } });
    await db.user.create({
      data: { id: ADMIN, orgId: ORG, email: "admin@agreement.test", role: "admin", clerkId: "clerk-agreement-admin" },
    });
    await db.grant.create({
      data: { orgId: ORG, scopeId: root.id, granteeType: "user", granteeId: ADMIN, permission: "admin" },
    });
  });

  it("gives the erasure's verdict and the digest rule's on each case, as the table expects", async () => {
    const vector = `[${[1, ...Array(DIMENSIONS - 1).fill(0)].join(",")}]`;
    for (const [i, c] of CASES.entries()) {
      await db.$executeRaw`
        INSERT INTO memory_chunks ("id","orgId","content","source","actorType","entityName","scopePath","embedding","createdAt")
        VALUES (${idOf(i)}, ${ORG}, ${c.content}, 'mcp', 'agent', ${c.name}, ${ROOT}, ${vector}::vector, ${written})
      `;
    }
    for (const person of PEOPLE) await db.contact.create({ data: { ...person, orgId: ORG } });

    for (const person of PEOPLE) await erasePerson(admin, { contactId: person.id });
    const left = new Set(
      (await db.memoryChunk.findMany({ where: { orgId: ORG }, select: { id: true } })).map((c) => c.id),
    );
    const erased = await loadErasedContentFilter(ORG);

    const verdicts = CASES.map((c, i) => ({
      case: c.label,
      erasure: (left.has(idOf(i)) ? "kept" : "erased") as Verdict,
      digest: (erased(c.content, written, c.name) ? "erased" : "kept") as Verdict,
    }));
    expect(verdicts).toEqual(CASES.map((c) => ({ case: c.label, erasure: c.expected, digest: c.expected })));
  }, 60_000);

  it("reads 100,000 characters of one word or one mark, in both rules, as naming no one", async () => {
    // A word with no joint in it, and runs of every mark a name is read across: each took
    // 20 to 45 s in the digest rule before its runs started only at a word's first letter.
    // The time budget is in erasure-linear-time.perf.realdb.test.ts, run on a quiet machine;
    // here a regression that slow still runs past the test's timeout.
    const hostile = [
      "a".repeat(100_000),
      `a${"-".repeat(100_000)}`,
      `a${"_".repeat(100_000)}`,
      `a${" ".repeat(100_000)}`,
      "ab".repeat(50_000),
      "1".repeat(100_000),
      "a'".repeat(50_000),
      "aB".repeat(50_000),
    ];
    const vector = `[${[1, ...Array(DIMENSIONS - 1).fill(0)].join(",")}]`;
    for (const [i, text] of hostile.entries()) {
      await db.$executeRaw`
        INSERT INTO memory_chunks ("id","orgId","content","source","actorType","entityName","scopePath","embedding","createdAt")
        VALUES (${idOf(i)}, ${ORG}, ${text}, 'mcp', 'agent', ${NEUTRAL}, ${ROOT}, ${vector}::vector, ${written})
      `;
    }
    for (const person of PEOPLE) await db.contact.create({ data: { ...person, orgId: ORG } });
    for (const person of PEOPLE) await erasePerson(admin, { contactId: person.id });
    expect(await db.memoryChunk.count({ where: { orgId: ORG } })).toBe(hostile.length);
    const erased = await loadErasedContentFilter(ORG);
    expect(hostile.filter((text) => erased(text, written, NEUTRAL)).map((text) => text.slice(0, 3))).toEqual([]);
  }, 60_000);

  it("gives the erasure's verdict and the digest rule's alike on generated file names", async () => {
    // Words of the people above, words near theirs, and the marks between words in names,
    // joined at random, so the two rules meet spellings no table row lists.
    const words = [
      "dana",
      "Dana",
      "DANA",
      "whitfield",
      "Whitfield",
      "WHITFIELD",
      "danaher",
      "Diana",
      "ana",
      "Ana",
      "offer",
      "Offer",
      "pdf",
      "2026",
      "rory",
      "Rory",
      "mc",
      "Mc",
      "donald",
      "Donald",
      "Al",
      "al",
      "li",
      "Li",
      "Lin",
      "Ann",
      "Jo",
      "anne",
      "Marie",
      "dupont",
      "Zo\u00eb",
      "Ferrand",
      "Barnes",
      "Mrs.",
      "M.",
      "Laval",
      "approved",
    ];
    const marks = [
      "_",
      ".",
      "-",
      "--",
      " ",
      "",
      "",
      "/",
      "'",
      " - ",
      ", ",
      "_-",
      "\u00a0",
      "%20",
      "\u2010",
      "\u2011",
      "\u0001",
      " _",
    ];
    let state = 7;
    const next = (n: number) => {
      state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
      return Math.floor((state / 2 ** 32) * n);
    };
    // Half the words are a person's given name and surname, joined by a random mark.
    const pairs = [
      ["Dana", "Whitfield"],
      ["dana", "whitfield"],
      ["Rory", "McDonald"],
      ["Al", "Li"],
      ["Ann", "Li"],
      ["Anne", "Marie"],
      ["Whitfield", "Barnes"],
      ["Marie", "Laval"],
      ["Ana", "Dana"],
      ["Siobhan", "O'Brien"],
    ];
    const word = () => {
      if (next(2) === 0) return words[next(words.length)]!;
      const [given, surname] = pairs[next(pairs.length)]!;
      return `${given}${marks[next(marks.length)]}${surname}`;
    };
    const contents = [
      ...new Set(
        Array.from({ length: 600 }, () => {
          const length = 1 + next(4);
          return Array.from({ length }, (_, i) => (i === 0 ? "" : marks[next(marks.length)]) + word()).join("");
        }),
      ),
    ];
    const vector = `[${[1, ...Array(DIMENSIONS - 1).fill(0)].join(",")}]`;
    for (const [i, content] of contents.entries()) {
      await db.$executeRaw`
        INSERT INTO memory_chunks ("id","orgId","content","source","actorType","entityName","scopePath","embedding","createdAt")
        VALUES (${`generated-${i}`}, ${ORG}, ${content}, 'mcp', 'agent', ${NEUTRAL}, ${ROOT}, ${vector}::vector, ${written})
      `;
    }
    for (const person of PEOPLE) await db.contact.create({ data: { ...person, orgId: ORG } });

    for (const person of PEOPLE) await erasePerson(admin, { contactId: person.id });
    const left = new Set(
      (await db.memoryChunk.findMany({ where: { orgId: ORG }, select: { id: true } })).map((c) => c.id),
    );
    const erased = await loadErasedContentFilter(ORG);

    const disagreements = contents.filter(
      (content, i) => left.has(`generated-${i}`) === erased(content, written, NEUTRAL),
    );
    expect(disagreements).toEqual([]);
    // The generator reaches both verdicts, so agreeing is not agreeing on nothing.
    expect(left.size).toBeGreaterThan(50);
    expect(contents.length - left.size).toBeGreaterThan(50);
  }, 30_000);

  it("gives the erasure's verdict and re-apply's on each contact, as the table expects", async () => {
    const caseId = (i: number) => `contact-case-${i}`;
    for (const person of PEOPLE) await db.contact.create({ data: { ...person, orgId: ORG, createdAt: written } });
    for (const [i, c] of CONTACT_CASES.entries()) {
      await db.contact.create({
        data: { id: caseId(i), orgId: ORG, name: c.name, email: c.email, entityId: c.entityId, createdAt: written },
      });
    }
    const backup = await db.contact.findMany({
      where: { orgId: ORG, id: { startsWith: "contact-case-" } },
      select: { id: true, orgId: true, name: true, email: true, entityId: true, createdAt: true },
    });
    const verdictsNow = async () => {
      const left = new Set(
        (await db.contact.findMany({ where: { orgId: ORG }, select: { id: true } })).map((c) => c.id),
      );
      return CONTACT_CASES.map((_, i) => (left.has(caseId(i)) ? "kept" : "erased") as Verdict);
    };

    for (const person of PEOPLE) await erasePerson(admin, { contactId: person.id });
    const byErasure = await verdictsNow();
    // The restore: every case contact as it stood before, the suppression list kept.
    await db.contact.createMany({ data: backup, skipDuplicates: true });
    await reapplyErasures(admin);
    const byReapply = await verdictsNow();

    expect(CONTACT_CASES.map((c, i) => ({ case: c.label, erasure: byErasure[i], digest: byReapply[i] }))).toEqual(
      CONTACT_CASES.map((c) => ({
        case: c.label,
        erasure: c.expected,
        digest: c.expected,
      })),
    );
  }, 30_000);

  it("reads the name character classes alike in Postgres and in JavaScript", async () => {
    // Every code point of the Basic Multilingual Plane but the surrogates, which Postgres cannot hold alone.
    const codePoints = Array.from({ length: 0xffff }, (_, i) => i + 1).filter((cp) => cp < 0xd800 || cp > 0xdfff);
    for (const characterClass of [NAME_SPACE, NAME_LETTER, CAMEL_LOWER, CAMEL_UPPER]) {
      const inPostgres = await db.$queryRaw<{ cp: number }[]>`
        SELECT i AS cp FROM generate_series(1, 65535) AS i
        WHERE i NOT BETWEEN 55296 AND 57343 AND chr(i) COLLATE "C" ~ ${characterClass}
        ORDER BY i`;
      const inJavaScript = new RegExp(`^${characterClass}$`, "u");
      expect(
        inPostgres.map((r) => r.cp),
        characterClass,
      ).toEqual(codePoints.filter((cp) => inJavaScript.test(String.fromCharCode(cp))));
    }
  });

  // Input collations a column may carry: the database's own, "C" (under which lower() alone
  // changes ASCII letters only) and a Turkish one (under which it lowercases "I" to "\u0131").
  const COLLATIONS = ['"default"', '"C"', '"tr-x-icu"'];

  /** The Unicode version each engine folds by, for a failure message; Postgres reads its own only from 17 on. */
  async function unicodeVersions(): Promise<string> {
    const [{ server }] = await db.$queryRaw<
      { server: number }[]
    >`SELECT current_setting('server_version_num')::int AS server`;
    const [own] =
      server >= 170_000
        ? await db.$queryRaw<
            { tables: string; icu: string | null }[]
          >`SELECT unicode_version() AS tables, icu_unicode_version() AS icu`
        : [{ tables: "unread", icu: "unread" }];
    return `JavaScript Unicode ${process.versions.unicode}; Postgres ${server}, its tables Unicode ${own!.tables}, ICU Unicode ${own!.icu}`;
  }

  it("folds every spelling of the shared table alike in Postgres and in JavaScript, under every collation", async () => {
    const texts = spellings.folds.map((f) => f.text);
    for (const collation of COLLATIONS) {
      const column = Prisma.sql`(t COLLATE ${Prisma.raw(collation)})`;
      const rows = await db.$queryRaw<{ t: string; folded: string }[]>`
        SELECT t, ${foldedText(column)} AS folded FROM unnest(${texts}::text[]) WITH ORDINALITY AS u(t, n) ORDER BY n`;
      expect(
        rows.map((r) => r.folded),
        collation,
      ).toEqual(spellings.folds.map((f) => f.folded));
    }
    expect(texts.map(foldName)).toEqual(spellings.folds.map((f) => f.folded));
  });

  it("folds every character alike in Postgres and in JavaScript, under every collation, whatever Unicode version each knows", async () => {
    // Every code point but the surrogates, which Postgres cannot hold alone, and U+0000. The
    // engines fold by the Unicode versions they ship, which differ: CI's Node knows 17.0 and its
    // Postgres image an older ICU; production lowercases with ICU at 15.1. Letters Unicode
    // assigned after 15.0 are read from name-fold-newer-letters.json by both, so a difference
    // here is a letter newer than that list, or an engine older than its floor.
    const codePoints = Array.from({ length: 0x10ffff }, (_, i) => i + 1).filter((cp) => cp < 0xd800 || cp > 0xdfff);
    const inJavaScript = codePoints.map((cp) => foldName(String.fromCodePoint(cp)));
    const versions = await unicodeVersions();
    for (const collation of COLLATIONS) {
      const column = Prisma.sql`(chr(cp) COLLATE ${Prisma.raw(collation)})`;
      const [result] = await db.$queryRaw<{ compared: number; differing: number[] | null }[]>`
        SELECT count(*)::int AS compared, array_agg(cp ORDER BY cp) FILTER (WHERE ${foldedText(column)} IS DISTINCT FROM js COLLATE "C") AS differing
        FROM unnest(${codePoints}::int[], ${inJavaScript}::text[]) AS u(cp, js)`;
      const differing = (result!.differing ?? []).map((cp) => `U+${cp.toString(16).toUpperCase().padStart(4, "0")}`);
      expect(
        differing,
        `${collation} (${versions}): a letter assigned after Unicode ${newerLetters.through} belongs in name-fold-newer-letters.json`,
      ).toEqual([]);
      expect(result!.compared).toBe(codePoints.length);
    }
  }, 120_000);

  it("erases a name spelled in letters Unicode assigned after 15.0 in both rules, whatever Unicode version each engine knows", async () => {
    // U+A7CE..A7CF (Unicode 17.0) are lowercased by ICU 78 but not by a Node that knows 16.0;
    // U+1C89 (16.0) by Node 20 but not by production's ICU at 15.1; the outlined Latin capitals
    // (16.0) are ASCII letters once compatibility forms are folded, which Postgres 17's own
    // tables (15.1) do not know.
    const outlined = (word: string) =>
      [...word].map((c) => String.fromCodePoint(0x1ccd6 + c.charCodeAt(0) - 65)).join("");
    const people = [
      { id: "newer-dana", name: "Dana Whitfield", email: "dana@newer.example" },
      { id: "newer-pharos", name: "\ua7cfaro \ua7cfeli", email: "pharos@newer.example" },
      { id: "newer-tje", name: "\u1c8aаня \u1c8aоева", email: "tje@newer.example" },
    ];
    const contents = [
      { text: `${outlined("DANA")} ${outlined("WHITFIELD")} signed the order.`, expected: "erased" },
      { text: "\ua7ceARO \ua7ceELI signed the order.", expected: "erased" },
      { text: "\u1c89АНЯ \u1c89ОЕВА signed the order.", expected: "erased" },
      // Another person: the same words with the letter they are lowercase of read otherwise.
      { text: "\ua7cbARO \ua7cbELI signed the order.", expected: "kept" },
      { text: `${outlined("DANA")} ${outlined("WHITFIELDS")} signed the order.`, expected: "kept" },
    ] as const;
    const vector = `[${[1, ...Array(DIMENSIONS - 1).fill(0)].join(",")}]`;
    for (const [i, { text }] of contents.entries()) {
      await db.$executeRaw`
        INSERT INTO memory_chunks ("id","orgId","content","source","actorType","entityName","scopePath","embedding","createdAt")
        VALUES (${idOf(i)}, ${ORG}, ${text}, 'mcp', 'agent', ${NEUTRAL}, ${ROOT}, ${vector}::vector, ${written})
      `;
    }
    for (const person of people) await db.contact.create({ data: { ...person, orgId: ORG } });

    for (const person of people) await erasePerson(admin, { contactId: person.id });
    const left = new Set(
      (await db.memoryChunk.findMany({ where: { orgId: ORG }, select: { id: true } })).map((c) => c.id),
    );
    const erased = await loadErasedContentFilter(ORG);

    const verdicts = contents.map((c, i) => ({
      text: c.text,
      erasure: left.has(idOf(i)) ? "kept" : "erased",
      digest: erased(c.text, written, NEUTRAL) ? "erased" : "kept",
    }));
    expect(verdicts, await unicodeVersions()).toEqual(
      contents.map((c) => ({ text: c.text, erasure: c.expected, digest: c.expected })),
    );
  }, 30_000);

  it("reads a camel-case step at a letter Unicode added after 15.0 alike in both rules", async () => {
    // U+A7F1 (17.0) and the outlined Latin capitals (16.0) are ASCII capitals once compatibility
    // forms are folded, so "Dana\ua7f1mith" is "DanaSmith", a camel-case step. Postgres 18's
    // tables (16.0) do not know U+A7F1, and Postgres 17's (15.1) do not know the outlined ones.
    const outlined = (letter: string) => String.fromCodePoint(0x1ccd6 + letter.charCodeAt(0) - 65);
    const people = [
      { id: "camel-smith", name: "Dana Smith", email: "dana.smith@camel.example" },
      { id: "camel-dana", name: "Dana Whitfield", email: "dana.w@camel.example" },
    ];
    const cases = [
      { name: "Dana\ua7f1mith", content: "Notes.", expected: "erased" },
      { name: NEUTRAL, content: "Met Dana\ua7f1mith%20today.", expected: "erased" },
      { name: `Dana${outlined("W")}hitfield`, content: "Notes.", expected: "erased" },
      { name: NEUTRAL, content: `Met Dana${outlined("W")}hitfield%20today.`, expected: "erased" },
      // Another person: the name continues past hers.
      { name: NEUTRAL, content: `Met Dana${outlined("W")}hitfields today.`, expected: "kept" },
    ] as const;
    const vector = `[${[1, ...Array(DIMENSIONS - 1).fill(0)].join(",")}]`;
    for (const [i, c] of cases.entries()) {
      await db.$executeRaw`
        INSERT INTO memory_chunks ("id","orgId","content","source","actorType","entityName","scopePath","embedding","createdAt")
        VALUES (${idOf(i)}, ${ORG}, ${c.content}, 'mcp', 'agent', ${c.name}, ${ROOT}, ${vector}::vector, ${written})
      `;
    }
    for (const person of people) await db.contact.create({ data: { ...person, orgId: ORG } });

    for (const person of people) await erasePerson(admin, { contactId: person.id });
    const left = new Set(
      (await db.memoryChunk.findMany({ where: { orgId: ORG }, select: { id: true } })).map((c) => c.id),
    );
    const erased = await loadErasedContentFilter(ORG);

    const verdicts = cases.map((c, i) => ({
      case: `${c.name} / ${c.content}`,
      erasure: left.has(idOf(i)) ? "kept" : "erased",
      digest: erased(c.content, written, c.name) ? "erased" : "kept",
    }));
    expect(verdicts, await unicodeVersions()).toEqual(
      cases.map((c) => ({ case: `${c.name} / ${c.content}`, erasure: c.expected, digest: c.expected })),
    );
  }, 30_000);

  it("finds an address holding a letter Unicode added after 15.0 in both rules, in text, as a record name, and on re-apply", async () => {
    // U+A7CE..A7CF are Unicode 17.0: a Node that knows 16.0 does not count them as letters.
    await db.contact.create({
      data: {
        id: "pharos",
        orgId: ORG,
        name: "\ua7cfaro \ua7cfeli",
        email: "\ua7cfaro@newer.example",
        createdAt: written,
      },
    });
    await db.contact.create({
      data: { id: "pharos-capitals", orgId: ORG, name: "P", email: "\ua7ceARO@NEWER.EXAMPLE", createdAt: written },
    });
    const cases = [
      { name: "\ua7ceELI, \ua7ceARO", content: "Notes.", expected: "erased" },
      { name: "\ua7ceARO_\ua7ceELI", content: "Notes.", expected: "erased" },
      { name: " \ua7ceARO@NEWER.EXAMPLE ", content: "Notes.", expected: "erased" },
      { name: NEUTRAL, content: "Write to \ua7ceARO@newer.example today.", expected: "erased" },
      // Another person: U+A7CB lowercases to another letter.
      { name: "\ua7cbELI, \ua7cbARO", content: "Notes.", expected: "kept" },
    ] as const;
    const vector = `[${[1, ...Array(DIMENSIONS - 1).fill(0)].join(",")}]`;
    for (const [i, c] of cases.entries()) {
      await db.$executeRaw`
        INSERT INTO memory_chunks ("id","orgId","content","source","actorType","entityName","scopePath","embedding","createdAt")
        VALUES (${idOf(i)}, ${ORG}, ${c.content}, 'mcp', 'agent', ${c.name}, ${ROOT}, ${vector}::vector, ${written})
      `;
    }

    await erasePerson(admin, { email: "\ua7ceARO@Newer.Example" });
    const contactsLeft = await db.contact.count({ where: { orgId: ORG } });
    const left = new Set(
      (await db.memoryChunk.findMany({ where: { orgId: ORG }, select: { id: true } })).map((c) => c.id),
    );
    const erased = await loadErasedContentFilter(ORG);
    const verdicts = cases.map((c, i) => ({
      case: `${c.name} / ${c.content}`,
      erasure: left.has(idOf(i)) ? "kept" : "erased",
      digest: erased(c.content, written, c.name) ? "erased" : "kept",
    }));
    // A backup restores a copy of the contact, its address cased otherwise.
    await db.contact.create({
      data: { id: "pharos-restored", orgId: ORG, name: "Q", email: " \ua7ceARO@newer.EXAMPLE", createdAt: written },
    });
    await reapplyErasures(admin);

    expect(
      { contactsLeft, verdicts, afterReapply: await db.contact.count({ where: { orgId: ORG } }) },
      await unicodeVersions(),
    ).toEqual({
      contactsLeft: 0,
      verdicts: cases.map((c) => ({ case: `${c.name} / ${c.content}`, erasure: c.expected, digest: c.expected })),
      afterReapply: 0,
    });
  }, 30_000);

  it("finds a contact by its address however either side is cased, whatever the database's collation", async () => {
    // Under "C" a case-insensitive comparison folds ASCII letters only, so "ZO\u00cb" was
    // another address there and the same one under en_US.
    const vector = `[${[1, ...Array(DIMENSIONS - 1).fill(0)].join(",")}]`;
    const contacts = [
      { id: "caps-zoe", name: "Zo\u00eb Capsule", email: "ZO\u00cb.CAPS@ACME.EXAMPLE" },
      { id: "caps-ayse", name: "Ay\u015fe Kaplan", email: "ay\u015fe.ince@acme.example" },
      { id: "caps-bystander", name: "Zoe Capsule", email: "zoe.caps@acme.example" },
    ];
    for (const contact of contacts) await db.contact.create({ data: { ...contact, orgId: ORG } });
    // The bystander is named by address: "Zoe Capsule" is the erased Zo\u00eb's ASCII spelling, so
    // her name is read as Zo\u00eb's (asciiSpelling); her address is her own.
    const texts = [
      "Zo\u00eb Capsule signed the order.",
      "Ay\u015fe Kaplan signed the order.",
      "Write to zoe.caps@acme.example today.",
    ];
    for (const [i, content] of texts.entries()) {
      await db.$executeRaw`
        INSERT INTO memory_chunks ("id","orgId","content","source","actorType","entityName","scopePath","embedding","createdAt")
        VALUES (${idOf(i)}, ${ORG}, ${content}, 'mcp', 'agent', ${NEUTRAL}, ${ROOT}, ${vector}::vector, ${written})
      `;
    }

    await erasePerson(admin, { email: "zo\u00eb.caps@acme.example" });
    await erasePerson(admin, { email: "AY\u015eE.\u0130NCE@ACME.EXAMPLE" });

    const left = (await db.contact.findMany({ where: { orgId: ORG }, select: { id: true } })).map((c) => c.id);
    expect(left).toEqual(["caps-bystander"]);
    const chunks = (await db.memoryChunk.findMany({ where: { orgId: ORG }, select: { id: true } })).map((c) => c.id);
    expect(chunks).toEqual([idOf(2)]);
  });

  it("keeps honouring a name an erasure recorded before the fold read \u0130 as i and \u03c2 as \u03c3", async () => {
    // "text_name" and "record_name" rows as erasures recorded them before: the name lowercased by
    // JavaScript alone, which keeps a final sigma, and turns "\u0130" into "i" and a combining dot.
    const before = (kind: string, value: string, wordCount: number | null) => ({
      orgId: ORG,
      kind,
      digest: createHash("sha256").update(`${ORG}\0${kind}\0${value}`).digest("hex"),
      wordCount,
      requestId: "before-the-fold",
    });
    await listAsTheApp(db, {
      data: [
        before("text_name", "\u03bd\u03af\u03ba\u03bf\u03c2 \u03c0\u03b1\u03c0\u03ac\u03c2", 2),
        before("record_name", "\u03bd\u03af\u03ba\u03bf\u03c2 \u03c0\u03b1\u03c0\u03ac\u03c2", null),
        before("text_name", "al\u0131 k\u0131m", 2),
        before("text_name", "ay\u015fe i\u0307nce", 2),
      ],
    });
    const erased = await loadErasedContentFilter(ORG);

    expect(erased("\u039d\u03af\u03ba\u03bf\u03c2 \u03a0\u03b1\u03c0\u03ac\u03c2 signed the order.", written)).toBe(
      true,
    );
    expect(erased("\u039d\u038a\u039a\u039f\u03a3 \u03a0\u0391\u03a0\u0386\u03a3 signed the order.", written)).toBe(
      true,
    );
    expect(erased(RECORD, written, "\u039d\u03af\u03ba\u03bf\u03c2 \u03a0\u03b1\u03c0\u03ac\u03c2")).toBe(true);
    // Recorded from "AY\u015eE \u0130NCE": text spelling it so was found by that row and still is.
    expect(erased("AY\u015eE \u0130NCE signed the order.", written)).toBe(true);
    expect(erased("Ay\u015fe Ince signed the order.", written)).toBe(false);
    expect(erased("Al\u0131 K\u0131m signed the order.", written)).toBe(true);
    expect(erased("Ali Kim signed the order.", written)).toBe(false);
  });

  it("re-applies an erasure recorded before the fold to a restored contact whose address holds İ or ς", async () => {
    // "email" rows as erasures recorded them before: the address lowercased by JavaScript
    // alone, so "ALİ.KIM@" kept "i" and a combining dot, and a final sigma stayed "ς".
    const before = (kind: string, value: string) => ({
      orgId: ORG,
      kind,
      digest: createHash("sha256").update(`${ORG}\0${kind}\0${value}`).digest("hex"),
      wordCount: null,
      requestId: "before-the-fold",
    });
    await listAsTheApp(db, {
      data: [before("email", "ali̇.kim@acme.example"), before("email", "λάμπρος@acme.example")],
    });
    // The backup comes back with both contacts as they were before they were erased.
    await db.contact.createMany({
      data: [
        { id: "restored-ali", orgId: ORG, name: "Ali Kim", email: "ALİ.KIM@acme.example", createdAt: written },
        {
          id: "restored-giannis",
          orgId: ORG,
          name: "Γιάννης Λάμπρος",
          email: "λάμπρος@acme.example",
          createdAt: written,
        },
        { id: "bystander-ali", orgId: ORG, name: "Alı Kım", email: "alı.kim@acme.example", createdAt: written },
      ],
    });

    await reapplyErasures(admin);

    const left = (await db.contact.findMany({ where: { orgId: ORG }, select: { id: true } })).map((c) => c.id);
    expect(left).toEqual(["bystander-ali"]);
  });

  it("keeps honouring names an erasure recorded before hyphens joined words", async () => {
    // A row as an erasure recorded it before this rule: the name's words split at every
    // hyphen, and no record-name digests.
    const legacy = (value: string, wordCount: number) => ({
      orgId: ORG,
      kind: "name",
      digest: createHash("sha256").update(`${ORG}\0name\0${value}`).digest("hex"),
      wordCount,
      requestId: "legacy-request",
    });
    await listAsTheApp(db, {
      data: [
        legacy("mary jane smith", 3),
        legacy("talvi quenmor", 2),
        legacy("anne marie", 2),
        legacy("zoe ferrand", 2),
      ],
    });
    const erased = await loadErasedContentFilter(ORG);

    expect(erased("Mary-Jane Smith signed the order.", written)).toBe(true);
    // One hyphenated word holds both of a name's words as that rule split them.
    expect(erased("Anne-Marie signed the order.", written)).toBe(true);
    expect(erased("Mary Jane Smith signed the order.", written)).toBe(true);
    expect(erased("Talvi Quenmor-Barnes runs procurement.", written)).toBe(false);
    // Such a row keeps letters only, so an accent typed as a combining mark would drop out
    // of the word: "Zoe" + U+0308 is "Zo\u00eb", not the "Zoe" this row was recorded for.
    expect(erased("Zoe\u0308 Ferrand signed the order.", written)).toBe(false);
    // Rows recorded before record-name digests existed cannot match a record's name alone.
    expect(erased(RECORD, written, "Mary-Jane Smith")).toBe(false);
  });

  it("finds a name written without spaces for an erasure recorded before joined names, when its words hold no hyphen", async () => {
    // Rows as an erasure recorded them before "joined_name": "text_name" only.
    const textName = (value: string, wordCount: number) => ({
      orgId: ORG,
      kind: "text_name",
      digest: createHash("sha256").update(`${ORG}\0text_name\0${value}`).digest("hex"),
      wordCount,
      requestId: "before-joined-names",
    });
    await listAsTheApp(db, { data: [textName("dana whitfield", 2), textName("anne-marie dupont", 2)] });
    const erased = await loadErasedContentFilter(ORG);

    expect(erased("Dana_Whitfield_offer.pdf", written)).toBe(true);
    expect(erased("DanaWhitfield offer.pdf", written)).toBe(true);
    expect(erased("Ana Dana-Whitfield runs procurement.", written)).toBe(false);
    // Such a row holds the hyphen, which a name written without spaces drops.
    expect(erased("anne_marie_dupont.pdf", written)).toBe(false);
    expect(erased("Anne-Marie Dupont signed.", written)).toBe(true);
  });

  it("records a name given decomposed in the form it is matched in, composed", async () => {
    const { recordSuppressions } = await import("./erasure-suppression");
    await recordSuppressions(db, ORG, "decomposed-input", { emails: [], names: ["Rene\u0301e Duval"], contactIds: [] });
    const erased = await loadErasedContentFilter(ORG);

    expect(erased("Ren\u00e9e Duval signed the order.", written)).toBe(true);
    expect(erased(RECORD, written, "Ren\u00e9e Duval")).toBe(true);
  });

  it("keeps honouring a name an erasure recorded decomposed, before names were composed", async () => {
    // A "text_name" row for a contact whose name was stored decomposed (NFD), as erasures
    // recorded it before both rules composed names: the digest of the name as spelled.
    const spelled = "zoe\u0308 ferrand";
    await listAsTheApp(db, {
      data: {
        orgId: ORG,
        kind: "text_name",
        digest: createHash("sha256").update(`${ORG}\0text_name\0${spelled}`).digest("hex"),
        wordCount: 2,
        requestId: "decomposed-request",
      },
    });
    const erased = await loadErasedContentFilter(ORG);

    expect(erased("Zoe\u0308 Ferrand signed the order.", written)).toBe(true);
    expect(erased("Zoe Ferrand signed the order.", written)).toBe(false);
  });
});
