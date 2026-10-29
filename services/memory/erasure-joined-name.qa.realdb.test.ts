// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test Postgres.
//
// Erasure finds a name written without spaces.
// What the agreement table (erasure-rule-agreement.realdb.test.ts) does not cover:
//  - Over-erasure of other people: names that differ from the erased person only by a
//    hyphen the text already carries ("(Dana-Whitfield, 2019)" in prose, an author's double
//    surname; "anne-marie-laval-cv.pdf" when Marie Laval is erased). The standing rule
//    is that over-erasure is worse than under-erasure, and one matching passage deletes a
//    whole uploaded file.
//  - Agreement between Postgres and the digest rule on many seeds, over both a chunk's text
//    and the entity it is filed under, with a wider vocabulary than the rule's own fuzz.
//  - Other people whose compound given name or double surname is written as a lower-case
//    slug ("anne-marie laval joined the call" when an Anne Marie is erased). A lower-case
//    slug of hers is spelled exactly like these, so it cannot be told from them.
//  - Her name before an em dash used as punctuation ("Dana Whitfield\u2014she signed"), which
//    is erased.
//  - A line break or a tab where her own name has a hyphen parts two people ("Anne\tMarie
//    Dupont" in a roster when Anne-Marie Dupont is erased), so it is kept.
//  - A lower-case slug the joined search finds, for a name recorded before "text_name" (kind
//    "name"), stays kept.
//  - Where her name has a space, a tab or a line break still joins her words in Postgres and
//    the graph; the digest rule must agree for a name whose "joined_name" holds no hyphen
//    ("D. Whitfield", "Rob Cole Jr.").
import { createHash } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";
import type { AccessContext } from "@/services/access";
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
const ORG = "qa_joined_name_org";
const ROOT = `org_${ORG}`;
const ADMIN = "qa_joined_name_admin";
const DIMENSIONS = 384;
const NEUTRAL = "Pricing";
const RECORD = "Notes.";

const PEOPLE = [
  { id: "dana", name: "Dana Whitfield", email: "dana_w@acme.example" },
  { id: "marie", name: "Marie Laval", email: "ml@acme.example" },
  { id: "pierre", name: "Pierre Dupont", email: "pd@acme.example" },
  { id: "al", name: "Al Li", email: "al@acme.example" },
  { id: "ed", name: "Ed Ward", email: "ed@acme.example" },
  { id: "mark", name: "Mark Read", email: "mread@acme.example" },
  { id: "rory", name: "Rory McDonald", email: "rory@acme.example" },
  { id: "anne", name: "Anne-Marie Dupont", email: "amd@acme.example" },
];

type Verdict = "erased" | "kept";
interface Probe {
  label: string;
  name: string;
  content: string;
}

/**
 * Other people, written with a hyphen that joins them to a further word or as a double surname
 * in running text. Each must be kept.
 */
const OTHER_PEOPLE: Probe[] = [
  { label: "slug: a different person's double surname", name: NEUTRAL, content: "dana-whitfield-barnes.pdf" },
  {
    label: "slug: a hyphenated given name ending in hers (Marie Laval erased)",
    name: NEUTRAL,
    content: "anne-marie-laval.pdf",
  },
  {
    label: "slug: a compound given name ending in his (Pierre Dupont erased)",
    name: NEUTRAL,
    content: "jean-pierre-dupont-cv.pdf",
  },
  { label: "slug: the other person's address", name: NEUTRAL, content: "Reply to anne-marie-laval@other.example" },
  {
    label: "slug: a double surname in a URL path",
    name: NEUTRAL,
    content: "https://people.example/staff/dana-whitfield-barnes",
  },
  {
    label: "prose: an author's double surname in a citation",
    name: NEUTRAL,
    content: "As argued before (Dana-Whitfield, 2019), the effect holds.",
  },
  {
    label: "prose: a double surname opening the text",
    name: NEUTRAL,
    content: "Dana-Whitfield (2019) found the opposite.",
  },
  {
    label: "prose: a double surname in a numbered reference",
    name: NEUTRAL,
    content: "[3] Dana-Whitfield, A. Pricing at scale. 2019.",
  },
  {
    label: "prose: a double surname as a bullet",
    name: NEUTRAL,
    content: "- Dana-Whitfield, A. (2019) Pricing at scale",
  },
  { label: "prose: a double surname in quotes", name: NEUTRAL, content: 'The "Dana-Whitfield" model was adopted.' },
  {
    label: "prose: a double surname after a line break",
    name: NEUTRAL,
    content: "Authors:\nDana-Whitfield, A.; Cole, B.",
  },
  { label: "prose: a double surname after a title", name: NEUTRAL, content: "Prof. Dana-Whitfield replied." },
  { label: "prose: a double surname after a given name", name: NEUTRAL, content: "Ana Dana-Whitfield replied." },
  { label: "record: another person's double surname, slug", name: "dana-whitfield-barnes", content: RECORD },
  { label: "record: another person's compound given name", name: "anne-marie-laval", content: RECORD },
];

/** Her name written without spaces, where nothing joins it to another word: each must still be erased. */
const HERS: Probe[] = [
  { label: "hers: underscores", name: NEUTRAL, content: "Dana_Whitfield_offer.pdf" },
  { label: "hers: camel case", name: NEUTRAL, content: "DanaWhitfield offer.pdf" },
  { label: "hers: a link's %20", name: NEUTRAL, content: "https://drive.example/Dana%20Whitfield%20offer.pdf" },
  { label: "hers: his name, underscores", name: NEUTRAL, content: "pierre_dupont_offer.pdf" },
];

// Not asserted either way: "dana-whitfield.pdf", "dana-whitfield_offer.pdf" and a login
// "dana-whitfield" as a record name. They read as hers, but a lower-case slug is
// also how another person's compound given name or double surname is written (OTHER_PEOPLE_AS_SLUG
// below), and the slug alone cannot tell them apart.

/** The people OTHER_PEOPLE_AS_SLUG erases: names that are also a compound given name or a double surname. */
const SLUG_PEOPLE = [
  { id: "annemarie", name: "Anne Marie", email: "annemarie@acme.example" },
  { id: "jeanpierre", name: "Jean Pierre", email: "jeanpierre@acme.example" },
  { id: "maryann", name: "Mary Ann", email: "maryann@acme.example" },
  { id: "dana", name: "Dana Whitfield", email: "dana_w@acme.example" },
];

/**
 * Other people, written as a lower-case slug: a compound given name (Anne-Marie Laval,
 * Jean-Pierre Dupont, Mary-Ann Smith) or a double surname (A. Dana-Whitfield) in lower-case text,
 * a file name and a handle. Each must be kept.
 */
const OTHER_PEOPLE_AS_SLUG: Probe[] = [
  {
    label: "slug: Anne-Marie Laval's full name in lower-case chat",
    name: NEUTRAL,
    content: "anne-marie laval joined the call",
  },
  {
    label: "slug: Anne-Marie Laval in a lower-case list",
    name: NEUTRAL,
    content: "attendees: anne-marie laval, bo wu",
  },
  {
    label: "slug: Anne-Marie Laval's CV (one passage deletes the upload)",
    name: NEUTRAL,
    content: "anne-marie_laval_cv.pdf",
  },
  { label: "slug: Anne-Marie Laval's handle", name: NEUTRAL, content: "<@anne-marie.laval> can you check" },
  { label: "slug: Anne-Marie by her given name", name: NEUTRAL, content: "anne-marie said the deck is fine" },
  { label: "slug: a record filed under Anne-Marie's handle", name: "anne-marie", content: RECORD },
  {
    label: "slug: Jean-Pierre Dupont's full name in lower-case chat",
    name: NEUTRAL,
    content: "jean-pierre dupont joined the call",
  },
  { label: "slug: Jean-Pierre as a commit author", name: NEUTRAL, content: "Author: jean-pierre <jp@other.example>" },
  { label: "slug: a record filed under Jean-Pierre's handle", name: "jean-pierre", content: RECORD },
  { label: "slug: Mary-Ann Smith in lower-case chat", name: NEUTRAL, content: "mary-ann smith joined" },
  {
    label: "slug: a double surname in a lower-case reference",
    name: NEUTRAL,
    content: "[3] dana-whitfield, a. pricing at scale",
  },
  { label: "slug: a double surname in a lower-case citation", name: NEUTRAL, content: "(dana-whitfield 2019)" },
  { label: "slug: a double surname, surname first", name: NEUTRAL, content: "dana-whitfield, ana replied" },
];

/** Her name next to an em dash used as punctuation, as US style writes it: each is erased. */
const HERS_BY_EM_DASH: Probe[] = [
  { label: "em dash: after her name", name: NEUTRAL, content: "I met Dana Whitfield\u2014she signed the lease." },
  { label: "em dash: around her name", name: NEUTRAL, content: "Our CFO\u2014Dana Whitfield\u2014signed the lease." },
  { label: "em dash: a sign-off after a word", name: NEUTRAL, content: "Great quarter, thanks\u2014Dana Whitfield" },
];

// Not asserted either way: "dana-whitfield-offer.pdf" and "offer-dana-whitfield.pdf" are
// spelled exactly as "dana-whitfield-barnes.pdf" and "anne-marie-laval.pdf" are, so keeping the
// second pair misses the first unless the rule finds another signal. "markRead" for an erased
// Mark Read, and "jean_pierre_dupont" for Pierre Dupont, are the spaced rule's existing
// common-word and longer-name trade ("Mark read the doc", "Jean Pierre Dupont"), not new here.

describe.skipIf(!QA_URL)("joined-name erasure: other people stay, and both engines agree on many seeds", () => {
  let db: PrismaClient;
  let erasePerson: (typeof import("./person-erasure"))["erasePerson"];
  let loadErasedContentFilter: (typeof import("./erasure-suppression"))["loadErasedContentFilter"];
  const admin: AccessContext = { orgId: ORG, actor: { type: "human", id: ADMIN, role: "admin" }, origin: "app" };
  const written = new Date(Date.now() - 24 * 3600 * 1000);
  const vector = `[${[1, ...Array(DIMENSIONS - 1).fill(0)].join(",")}]`;

  async function wipe() {
    await db.$executeRaw`DELETE FROM memory_chunks WHERE "orgId" = ${ORG}`;
    await db.erasureSuppression.deleteMany({ where: { orgId: ORG } });
    await db.contact.deleteMany({ where: { orgId: ORG } });
    await db.auditLog.deleteMany({ where: { orgId: ORG } });
    await db.grant.deleteMany({ where: { orgId: ORG } });
    await db.scope.deleteMany({ where: { orgId: ORG } });
    await db.user.deleteMany({ where: { orgId: ORG } });
  }

  /** Writes each probe as a chunk, erases every person, and returns both engines' verdicts. */
  async function judge(probes: Probe[], people: typeof PEOPLE = PEOPLE) {
    for (const [i, p] of probes.entries()) {
      await db.$executeRaw`
        INSERT INTO memory_chunks ("id","orgId","content","source","actorType","entityName","scopePath","embedding","createdAt")
        VALUES (${`p-${i}`}, ${ORG}, ${p.content}, 'mcp', 'agent', ${p.name}, ${ROOT}, ${vector}::vector, ${written})
      `;
    }
    for (const person of people) await db.contact.create({ data: { ...person, orgId: ORG } });
    for (const person of people) await erasePerson(admin, { contactId: person.id });
    const left = new Set(
      (await db.memoryChunk.findMany({ where: { orgId: ORG }, select: { id: true } })).map((c) => c.id),
    );
    const erased = await loadErasedContentFilter(ORG);
    return probes.map((p, i) => ({
      ...p,
      postgres: (left.has(`p-${i}`) ? "kept" : "erased") as Verdict,
      digest: (erased(p.content, written, p.name) ? "erased" : "kept") as Verdict,
    }));
  }

  beforeAll(async () => {
    process.env.DATABASE_URL = QA_URL;
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });
    ({ erasePerson } = await import("./person-erasure"));
    ({ loadErasedContentFilter } = await import("./erasure-suppression"));
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
      data: {
        id: ADMIN,
        orgId: ORG,
        email: "admin@joined-name.test",
        role: "admin",
        clerkId: "clerk-joined-name-admin",
      },
    });
    await db.grant.create({
      data: { orgId: ORG, scopeId: root.id, granteeType: "user", granteeId: ADMIN, permission: "admin" },
    });
  });

  it("keeps other people whose names a hyphen joins to hers, in both engines", async () => {
    const verdicts = await judge(OTHER_PEOPLE);
    expect(verdicts.filter((v) => v.postgres !== "kept" || v.digest !== "kept").map((v) => v.label)).toEqual([]);
  });

  it("still erases her name written without spaces where nothing joins it to another word", async () => {
    const verdicts = await judge(HERS);
    expect(verdicts.filter((v) => v.postgres !== "erased" || v.digest !== "erased").map((v) => v.label)).toEqual([]);
  });

  it("keeps other people whose compound given name or double surname is written as a lower-case slug", async () => {
    const verdicts = await judge(OTHER_PEOPLE_AS_SLUG, SLUG_PEOPLE);
    expect(verdicts.filter((v) => v.postgres !== "kept" || v.digest !== "kept").map((v) => v.label)).toEqual([]);
  });

  it("still erases her name next to an em dash used as punctuation", async () => {
    const verdicts = await judge(HERS_BY_EM_DASH);
    expect(verdicts.filter((v) => v.postgres !== "erased" || v.digest !== "erased").map((v) => v.label)).toEqual([]);
  });

  it("keeps two people a line break or a tab parts, where her own name has a hyphen", async () => {
    // Her own hyphen may be written as a space ("Anne Marie Dupont signed" is hers). A line break or a tab there is how two entries are written, not her name: a
    // roster row or a one-per-line list where "Anne" and "Marie Dupont" (or "Lee" and "Ann
    // Park") are two people. Each is kept, since one matching passage deletes a whole upload.
    const people = [
      { id: "amd", name: "Anne-Marie Dupont", email: "amd@acme.example" },
      { id: "lap", name: "Lee\u2011Ann Park", email: "lap@acme.example" },
    ];
    const verdicts = await judge(
      [
        { label: "a tab-separated roster row", name: NEUTRAL, content: "Mentor\tMentee\nAnne\tMarie Dupont\nBo\tWu" },
        { label: "a one-per-line attendee list", name: NEUTRAL, content: "Present:\nAnne\nMarie Dupont\nBo Wu" },
        { label: "a tab between two cells", name: NEUTRAL, content: "Lee\tAnn Park" },
        { label: "a Windows line break in a list", name: NEUTRAL, content: "Present:\r\nLee\r\nAnn Park" },
      ],
      people,
    );
    expect(verdicts.filter((v) => v.postgres !== "kept" || v.digest !== "kept").map((v) => v.label)).toEqual([]);
  });

  it("finds her name parted by a tab or a line break where it has a space, in the digest rule as in Postgres, for a name with a dot", async () => {
    // Where her own name has a space, any whitespace still joins her words, as in the spaced
    // rule: Postgres and the graph erase "D\nWhitfield.pdf" when D. Whitfield is erased. Her
    // "joined_name" digests ("d whitfield") hold no "\n" key when her name has no hyphen, and
    // her "text_name" ("d. whitfield") keeps the dot, so the digest rule would keep a restored
    // copy Postgres erased.
    const people = [
      { id: "dw", name: "D. Whitfield", email: "dw@acme.example" },
      { id: "rc", name: "Rob Cole Jr.", email: "rc@acme.example" },
    ];
    const verdicts = await judge(
      [
        { label: "a line break between an initial and a surname", name: NEUTRAL, content: "D\nWhitfield.pdf" },
        { label: "a tab-separated list", name: NEUTRAL, content: "notes:\tD\tWhitfield\t" },
        { label: "a line break before a suffix", name: NEUTRAL, content: "Rob Cole\r\nJr" },
        { label: "a line break after a given name", name: NEUTRAL, content: "Rob\nCole Jr.pdf" },
        { label: "joined by an underscore, as before", name: NEUTRAL, content: "D_Whitfield.pdf" },
      ],
      people,
    );
    expect(verdicts.filter((v) => v.postgres !== "erased" || v.digest !== "erased").map((v) => v.label)).toEqual([]);
  });

  it("keeps another person's lower-case slug for a name recorded before text names", async () => {
    // A row as an erasure recorded it before "text_name": letters and digits only, so the
    // spaced search reads "anne-marie" as Anne Marie by design. A slug the joined search
    // finds, after a "%20" or before a camel-case step, is still another person's name and is
    // kept: here Anne-Marie Laval's and Dana-Whitfield's. Hashing those stretches
    // anyway (their key "anne-marie" reads as "anne marie" once only letters are kept)
    // erases them.
    const legacy = (value: string) => ({
      orgId: ORG,
      kind: "name",
      digest: createHash("sha256").update(`${ORG}\0name\0${value}`).digest("hex"),
      wordCount: 2,
      requestId: "legacy-request",
    });
    await listAsTheApp(db, { data: [legacy("anne marie"), legacy("dana whitfield")] });
    const erased = await loadErasedContentFilter(ORG);
    const verdicts = Object.fromEntries(
      [
        "https://drive.example/shared%20anne-marie%20laval%20cv.pdf",
        "anne-marieLaval_cv.pdf",
        "notes%20dana-whitfield%20lab.pdf",
        "dana-whitfieldBarnes.pdf",
      ].map((text) => [text, erased(text, written)]),
    );
    expect(verdicts).toEqual({
      "https://drive.example/shared%20anne-marie%20laval%20cv.pdf": false,
      "anne-marieLaval_cv.pdf": false,
      "notes%20dana-whitfield%20lab.pdf": false,
      "dana-whitfieldBarnes.pdf": false,
    });
    // The rule such a row was recorded under still holds.
    expect(erased("Anne-Marie signed the order.", written)).toBe(true);
  });

  it("agrees between Postgres and the digest rule on many seeds, in text and in a record's name", async () => {
    const seeds = [1, 2, 3, 5, 8, 13, 21, 34, 55, 89, 144, 233];
    const words = [
      "dana",
      "Dana",
      "DANA",
      "whitfield",
      "Whitfield",
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
      "Mc",
      "donald",
      "Donald",
      "Al",
      "al",
      "li",
      "Li",
      "Lin",
      "Ed",
      "ward",
      "Ward",
      "Edward",
      "mark",
      "Mark",
      "read",
      "Read",
      "markRead",
      "Marie",
      "marie",
      "laval",
      "Laval",
      "anne",
      "Anne",
      "jean",
      "Jean",
      "pierre",
      "Pierre",
      "dupont",
      "Dupont",
      "Barnes",
      "barnes",
      "Mrs.",
      "Prof.",
      "M.",
      "approved",
      "led",
      "cv",
      "CV",
      "Ｄａｎａ",
      "Whitﬁeld",
      "O’",
      "é",
      "€",
      "x2",
    ];
    const marks = [
      "_",
      ".",
      "-",
      "--",
      " ",
      "",
      "",
      "",
      "/",
      "'",
      " - ",
      ", ",
      "_-",
      " ",
      "%20",
      "‐",
      "‑",
      "\u0001",
      " _",
      "(",
      ")",
      "\n",
      ": ",
      "[1] ",
      "–",
      "+",
      "@",
      "­",
      "​",
      "%2D",
      "~",
    ];
    const pairs = [
      ["Dana", "Whitfield"],
      ["dana", "whitfield"],
      ["DANA", "WHITFIELD"],
      ["Rory", "McDonald"],
      ["Al", "Li"],
      ["Ed", "Ward"],
      ["Mark", "Read"],
      ["mark", "read"],
      ["Anne", "Marie"],
      ["Marie", "Laval"],
      ["Pierre", "Dupont"],
      ["Jean", "Pierre"],
      ["Whitfield", "Barnes"],
      ["Ana", "Dana"],
      ["Anne-Marie", "Dupont"],
      ["anne", "marie"],
    ];
    const allDisagreements: unknown[] = [];
    let erasedTotal = 0;
    let keptTotal = 0;
    for (const seed of seeds) {
      let state = seed >>> 0;
      const next = (n: number) => {
        state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
        return Math.floor((state / 2 ** 32) * n);
      };
      const word = () => {
        if (next(2) === 0) return words[next(words.length)]!;
        const [given, surname] = pairs[next(pairs.length)]!;
        return `${given}${marks[next(marks.length)]}${surname}`;
      };
      const phrase = () => {
        const length = 1 + next(4);
        return Array.from({ length }, (_, i) => (i === 0 ? "" : marks[next(marks.length)]) + word()).join("");
      };
      // Half the rows vary the text, half the entity the chunk is filed under.
      const probes: Probe[] = [];
      const seen = new Set<string>();
      for (let i = 0; i < 500; i++) {
        const p =
          next(2) === 0
            ? { label: "text", name: NEUTRAL, content: phrase() }
            : { label: "record", name: phrase(), content: RECORD };
        const key = `${p.name}\u0000${p.content}`;
        if (!seen.has(key)) {
          seen.add(key);
          probes.push(p);
        }
      }
      await wipe();
      await db.org.upsert({ where: { id: ORG }, update: {}, create: { id: ORG, name: ORG } });
      const root = await db.scope.create({ data: { orgId: ORG, path: ROOT, name: "root" } });
      await db.user.create({
        data: {
          id: ADMIN,
          orgId: ORG,
          email: "admin@joined-name.test",
          role: "admin",
          clerkId: "clerk-joined-name-admin",
        },
      });
      await db.grant.create({
        data: { orgId: ORG, scopeId: root.id, granteeType: "user", granteeId: ADMIN, permission: "admin" },
      });
      const verdicts = await judge(probes);
      erasedTotal += verdicts.filter((v) => v.postgres === "erased").length;
      keptTotal += verdicts.filter((v) => v.postgres === "kept").length;
      allDisagreements.push(...verdicts.filter((v) => v.postgres !== v.digest).map((v) => ({ seed, ...v })));
    }
    expect(erasedTotal).toBeGreaterThan(100);
    expect(keptTotal).toBeGreaterThan(100);
    expect(allDisagreements).toEqual([]);
  }, 600_000);
});
