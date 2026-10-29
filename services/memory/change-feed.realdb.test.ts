// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// The read boundary, against a real database.
//
// `readChanges` decides what one agent may see of its org's change feed. Every
// interesting way that can be wrong — a sibling scope whose name shares a prefix,
// another tenant using the identical scope strings, a capability revoked after the
// events were written — is invisible to a mocked `$queryRaw`, which returns
// whatever the test told it to and so can only ever confirm the test's own
// assumptions. Here `check()` and the ltree containment both run for real, against
// real rows, and the assertions turn on which events came back.
//
// Set QA_DATABASE_URL to an ISOLATED test database. Never the sandbox's inherited
// DATABASE_URL, which points at live Neon. Skips cleanly without it.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import pg from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";
// Imported from the leaf module, not the `@/services/access` barrel: the barrel
// re-exports check.ts, which builds the `@/lib/db` singleton at import time —
// before beforeAll can point DATABASE_URL at the QA database. This sandbox's
// DATABASE_URL is live Neon, so a static barrel import here would aim the whole
// file at production and only the absence of Postgres egress would stop it.
// `capabilities.ts` imports node:crypto and nothing else; the type import below
// is erased at compile time.
import { hashCapabilityToken } from "@/services/access/capabilities";
import type { AccessContext } from "@/services/access";

const QA_URL = process.env.QA_DATABASE_URL;

const ORG = "org-qa-change-feed";
const OTHER_ORG = "org-qa-change-feed-other";

// Both orgs use the identical scope strings, so only the tenant filter separates
// their events. `sales_eu` is a sibling of `sales`, not a descendant: `_` is a
// legal ltree label character and a LIKE-based containment that forgets to escape
// it matches `sales` against `sales_eu` as a wildcard.
const SALES = "org_1.sales";
const SALES_EU = "org_1.sales.eu";
const SALES_SIBLING = "org_1.sales_eu";
const ENGINEERING = "org_1.engineering";

const SALES_AGENT = "agent-sales";

/** `$queryRaw`, stripped of its overloads so a test can wrap it. */
type RawQuery = (...args: unknown[]) => Promise<unknown>;

/**
 * True for the one statement `readChanges` reads its resume point, the org's horizon and its
 * page with, matched on the `horizonSeq` alias that only that statement uses. Nothing else
 * about the statement is asserted here: the test below cares only about when it runs.
 */
const isPageQuery = (first: unknown): boolean => Array.isArray(first) && first.join("").includes('AS "horizonSeq"');

/** The SQL text of a statement as pg.Client#query receives it: a string, or a config object. */
const statementText = (first: unknown): string =>
  typeof first === "string"
    ? first
    : typeof first === "object" && first !== null && "text" in first
      ? String((first as { text: unknown }).text)
      : "";

describe.skipIf(!QA_URL)("readChanges against a real database", () => {
  let db: PrismaClient;
  /** The singleton `readChanges` itself queries through, for the interleaving test. */
  let appDb: { $queryRaw: RawQuery };
  let readChanges: (typeof import("./change-feed"))["readChanges"];
  let countWaitingChanges: (typeof import("./change-feed"))["countWaitingChanges"];
  let factNamesOf: (typeof import("./change-feed"))["factNamesOf"];
  let UnknownChangeCursorError: (typeof import("./change-feed"))["UnknownChangeCursorError"];
  let AccessDeniedError: (typeof import("@/services/access"))["AccessDeniedError"];
  let recordChangeEvent: (typeof import("./change-events"))["recordChangeEvent"];

  let salesToken = "";

  /** An agent context authenticating with `token`. */
  const asAgent = (token: string, agentId = SALES_AGENT, orgId = ORG): AccessContext => ({
    orgId,
    actor: { type: "agent", id: agentId, capabilityToken: token },
    origin: "mcp",
  });

  /** Mint a capability for `agentId` on `scopePath` and return its raw token. */
  async function mintCapability(opts: {
    orgId?: string;
    agentId?: string;
    scopePath: string;
    expiresAt?: Date;
    revokedAt?: Date | null;
  }): Promise<string> {
    const token = `wcap_test_${Math.random().toString(36).slice(2)}`;
    await db.capability.create({
      data: {
        orgId: opts.orgId ?? ORG,
        agentId: opts.agentId ?? SALES_AGENT,
        tokenHash: hashCapabilityToken(token),
        scopePath: opts.scopePath,
        permission: "read",
        expiresAt: opts.expiresAt ?? new Date(Date.now() + 60 * 60 * 1000),
        revokedAt: opts.revokedAt ?? null,
      },
    });
    return token;
  }

  /** Write one event and return its id (the public cursor) and seq (internal). */
  function writeEvent(scopePath: string, recordId: string, orgId = ORG): Promise<{ id: string; seq: bigint }> {
    return db.$transaction(async (tx) =>
      recordChangeEvent(tx, {
        orgId,
        scopePath,
        recordType: "fact",
        recordId,
        op: "create",
        actorId: "writer-agent",
        actorType: "agent",
        origin: "mcp",
        title: `change to ${recordId}`,
      }),
    );
  }

  /** The seq this agent's stored cursor sits at, or undefined if it has none. */
  async function storedCursor(agentId = SALES_AGENT): Promise<bigint | undefined> {
    const row = await db.agentCursor.findUnique({
      where: { orgId_agentId: { orgId: ORG, agentId } },
      select: { lastSeq: true },
    });
    return row?.lastSeq;
  }

  const recordIds = (page: { changes: { recordId: string }[] }) => page.changes.map((c) => c.recordId);

  beforeAll(async () => {
    process.env.DATABASE_URL = QA_URL;
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });
    ({ readChanges, countWaitingChanges, factNamesOf, UnknownChangeCursorError } = await import("./change-feed"));
    ({ AccessDeniedError } = await import("@/services/access"));
    ({ recordChangeEvent } = await import("./change-events"));
    // The same module-level client change-feed.ts holds, narrowed to the one method
    // the interleaving test wraps. Imported after DATABASE_URL is set, for the same
    // reason as the two above.
    appDb = (await import("@/lib/db")).db as unknown as { $queryRaw: RawQuery };
  });

  afterAll(async () => {
    await db.$disconnect();
  });

  beforeEach(async () => {
    for (const orgId of [ORG, OTHER_ORG]) {
      await db.auditLog.deleteMany({ where: { orgId } });
      await db.changeEvent.deleteMany({ where: { orgId } });
      await db.agentCursor.deleteMany({ where: { orgId } });
      await db.memoryChunk.deleteMany({ where: { orgId } });
      await db.capability.deleteMany({ where: { orgId } });
      await db.org.upsert({ where: { id: orgId }, update: {}, create: { id: orgId, name: orgId } });
    }
    salesToken = await mintCapability({ scopePath: SALES });
  });

  it("returns only events inside the capability's scope", async () => {
    await writeEvent(SALES, "in-scope");
    await writeEvent(ENGINEERING, "other-department");

    const page = await readChanges(asAgent(salesToken), SALES);

    expect(recordIds(page)).toEqual(["in-scope"]);
  });

  it("includes descendants of the capability's scope", async () => {
    await writeEvent(SALES_EU, "below");

    expect(recordIds(await readChanges(asAgent(salesToken), SALES))).toEqual(["below"]);
  });

  it("does not leak a sibling scope whose name shares the prefix", async () => {
    await writeEvent(SALES_SIBLING, "not-mine");

    expect(recordIds(await readChanges(asAgent(salesToken), SALES))).toEqual([]);
  });

  it("does not return another tenant's events under the identical scope string", async () => {
    await writeEvent(SALES, "theirs", OTHER_ORG);

    expect(recordIds(await readChanges(asAgent(salesToken), SALES))).toEqual([]);
  });

  it("denies a revoked capability, including for events written while it was live", async () => {
    await writeEvent(SALES, "written-while-live");
    expect(recordIds(await readChanges(asAgent(salesToken), SALES))).toEqual(["written-while-live"]);

    await db.capability.updateMany({
      where: { tokenHash: hashCapabilityToken(salesToken) },
      data: { revokedAt: new Date() },
    });

    await expect(readChanges(asAgent(salesToken), SALES)).rejects.toThrow(/AccessDenied|no |denied/i);
  });

  it("denies an expired capability", async () => {
    const expired = await mintCapability({
      agentId: "agent-expired",
      scopePath: SALES,
      expiresAt: new Date(Date.now() - 1000),
    });
    await writeEvent(SALES, "unreachable");

    await expect(readChanges(asAgent(expired, "agent-expired"), SALES)).rejects.toThrow();
  });

  it("denies a scope the capability does not cover, without saying what is there", async () => {
    await writeEvent(ENGINEERING, "secret");

    await expect(readChanges(asAgent(salesToken), ENGINEERING)).rejects.toThrow();
  });

  it("serves each event once, then only what is newer", async () => {
    await writeEvent(SALES, "first");
    expect(recordIds(await readChanges(asAgent(salesToken), SALES))).toEqual(["first"]);

    expect(recordIds(await readChanges(asAgent(salesToken), SALES))).toEqual([]);

    await writeEvent(SALES, "second");
    expect(recordIds(await readChanges(asAgent(salesToken), SALES))).toEqual(["second"]);
  });

  it("moves past events it filtered out, so an unreadable burst is not rescanned", async () => {
    await writeEvent(ENGINEERING, "noise-1");
    await writeEvent(ENGINEERING, "noise-2");
    const last = await writeEvent(ENGINEERING, "noise-3");

    await readChanges(asAgent(salesToken), SALES);

    expect(await storedCursor()).toBe(last.seq);
  });

  it("stops the cursor at the last event it served when a page fills", async () => {
    const written = [await writeEvent(SALES, "a"), await writeEvent(SALES, "b"), await writeEvent(SALES, "c")];

    const page = await readChanges(asAgent(salesToken), SALES, { limit: 2 });

    expect(recordIds(page)).toEqual(["a", "b"]);
    expect(page.hasMore).toBe(true);
    expect(await storedCursor()).toBe(written[1].seq);
    expect(recordIds(await readChanges(asAgent(salesToken), SALES))).toEqual(["c"]);
  });

  it("does not claim more changes wait when the page ends exactly on the last one", async () => {
    await writeEvent(SALES, "a");
    await writeEvent(SALES, "b");

    const page = await readChanges(asAgent(salesToken), SALES, { limit: 2 });

    expect(recordIds(page)).toEqual(["a", "b"]);
    // A full page is not evidence of a next one. `hasMore` drives the MCP tool's
    // "(more changes waiting — call again)" line, so inferring it from the page
    // length sends the agent back for nothing.
    expect(page.hasMore).toBe(false);
    expect(recordIds(await readChanges(asAgent(salesToken), SALES))).toEqual([]);
  });

  it("treats a page size below one as one, rather than a page that never advances", async () => {
    await writeEvent(SALES, "a");
    await writeEvent(SALES, "b");

    // Unreachable from the MCP tool and the route, which both reject it — but a
    // page of 0 returns nothing while still reporting more waiting, so a library
    // caller looping on `hasMore` would never leave the loop.
    const page = await readChanges(asAgent(salesToken), SALES, { limit: 0 });

    expect(recordIds(page)).toEqual(["a"]);
    expect(page.hasMore).toBe(true);
  });

  it("serves only the run `take` chooses and leaves the rest unread", async () => {
    const written = [await writeEvent(SALES, "a"), await writeEvent(SALES, "b"), await writeEvent(SALES, "c")];

    const page = await readChanges(asAgent(salesToken), SALES, { take: async () => 2 });

    expect(recordIds(page)).toEqual(["a", "b"]);
    expect(page.hasMore).toBe(true);
    expect(await storedCursor()).toBe(written[1].seq);
    expect(recordIds(await readChanges(asAgent(salesToken), SALES))).toEqual(["c"]);
  });

  it("serves one change when `take` asks for none, so a read that finds something moves forward", async () => {
    await writeEvent(SALES, "a");
    await writeEvent(SALES, "b");

    const page = await readChanges(asAgent(salesToken), SALES, { take: () => 0 });

    expect(recordIds(page)).toEqual(["a"]);
    expect(page.hasMore).toBe(true);
  });

  it("refuses a `take` that is not a whole number, without moving the cursor", async () => {
    await writeEvent(SALES, "a");

    await expect(readChanges(asAgent(salesToken), SALES, { take: () => Number.NaN })).rejects.toThrow(/take/);

    expect(await storedCursor()).toBeUndefined();
    expect(recordIds(await readChanges(asAgent(salesToken), SALES))).toEqual(["a"]);
  });

  it("counts as waiting only other actors' changes past the cursor inside the scope", async () => {
    await writeEvent(SALES, "seen");
    await readChanges(asAgent(salesToken), SALES);
    await writeEvent(SALES, "waiting-1");
    await writeEvent(`${SALES}.deals`, "waiting-2");
    await writeEvent(ENGINEERING, "elsewhere");
    await db.$transaction((tx) =>
      recordChangeEvent(tx, {
        orgId: ORG,
        scopePath: SALES,
        recordType: "fact",
        recordId: "own",
        op: "create",
        actorId: SALES_AGENT,
        actorType: "agent",
        origin: "mcp",
        title: "the reader's own write",
      }),
    );

    expect(await countWaitingChanges(asAgent(salesToken), SALES)).toBe(2);
  });

  it("names a fact version only when it is stored inside the scope being read", async () => {
    for (const [id, scopePath, name] of [
      ["version-in-sales", SALES, "Acme renewal"],
      ["version-in-engineering", ENGINEERING, "Build pipeline"],
    ]) {
      await db.$executeRaw`
        INSERT INTO "memory_chunks" ("id","orgId","content","source","actorType","actorId","entityName","scopePath")
        VALUES (${id}, ${ORG}, 'text', 'mcp', 'agent', 'writer-agent', ${name}, ${scopePath})
      `;
    }

    const names = await factNamesOf(ORG, SALES, ["version-in-sales", "version-in-engineering"]);

    expect([...names]).toEqual([["version-in-sales", "Acme renewal"]]);
  });

  it("replays from an explicit `after`, overriding the stored cursor", async () => {
    const first = await writeEvent(SALES, "first");
    await writeEvent(SALES, "second");
    await readChanges(asAgent(salesToken), SALES);

    const replay = await readChanges(asAgent(salesToken), SALES, { after: first.id });

    expect(recordIds(replay)).toEqual(["second"]);
  });

  it("refuses an `after` naming a change in a scope the caller cannot read", async () => {
    const hidden = await writeEvent(ENGINEERING, "not-mine");

    await expect(readChanges(asAgent(salesToken), SALES, { after: hidden.id })).rejects.toThrow(
      UnknownChangeCursorError,
    );
  });

  it("answers an unreadable scope identically whether or not the cursor exists", async () => {
    // The test that pins `check()` ahead of the cursor. Every other `after` case
    // here asks for a scope the caller CAN read, where the containment excludes a
    // foreign change id either way — so all of them stay green with the check moved
    // below `resolveCursor`, and the ordering is left resting on nothing. Here the
    // requested scope is itself unreadable, so a cursor resolved first would answer
    // "that change exists" (unknown cursor, 400 on the route) or "it does not"
    // (denied, 403) off the same request, which is the existence oracle this file's
    // whole design is against.
    const real = await writeEvent(ENGINEERING, "secret");

    const withRealId = await readChanges(asAgent(salesToken), ENGINEERING, { after: real.id }).catch((e) => e);
    const withFakeId = await readChanges(asAgent(salesToken), ENGINEERING, {
      after: "11111111-2222-4333-8444-555555555555",
    }).catch((e) => e);

    expect(withRealId.name).toBe(withFakeId.name);
    expect(withRealId).toBeInstanceOf(AccessDeniedError);
  });

  it("refuses another tenant's change id, and an unissued one, identically", async () => {
    const theirs = await writeEvent(SALES, "theirs", OTHER_ORG);

    const foreign = await readChanges(asAgent(salesToken), SALES, { after: theirs.id }).catch((e) => e);
    const unissued = await readChanges(asAgent(salesToken), SALES, {
      after: "11111111-2222-4333-8444-555555555555",
    }).catch((e) => e);

    expect(foreign).toBeInstanceOf(UnknownChangeCursorError);
    expect(unissued).toBeInstanceOf(UnknownChangeCursorError);
    expect(foreign.message).toBe(unissued.message);
  });

  it("never moves the stored cursor backward when a caller replays an older page", async () => {
    const written = [];
    for (const recordId of ["a", "b", "c"]) written.push(await writeEvent(SALES, recordId));
    await readChanges(asAgent(salesToken), SALES);
    expect(await storedCursor()).toBe(written[2]!.seq);

    // A full page, so the cursor this read would write is "b" — behind where the
    // agent has already been served. GREATEST in advanceCursor is what keeps it.
    await readChanges(asAgent(salesToken), SALES, { after: written[0]!.id, limit: 1 });

    expect(await storedCursor()).toBe(written[2]!.seq);
    expect(recordIds(await readChanges(asAgent(salesToken), SALES))).toEqual([]);
  });

  it("does not reveal how many writes happened in scopes the caller cannot read", async () => {
    await writeEvent(SALES, "before");
    for (const n of [1, 2, 3, 4, 5]) await writeEvent(ENGINEERING, `hidden-${n}`);
    await writeEvent(SALES, "after");

    const page = await readChanges(asAgent(salesToken), SALES);

    expect(recordIds(page)).toEqual(["before", "after"]);
    // The defect this closes: with `seq` on the returned change, these two events
    // came back as 1 and 7, so subtracting them counted the five events in between
    // that this capability cannot read, bracketed by their own timestamps.
    //
    // Pinned as the whole field set rather than "no `seq`", so any new field on this
    // boundary — including a renamed counter — has to be looked at deliberately.
    for (const change of page.changes) {
      expect(Object.keys(change).sort()).toEqual([
        "actorId",
        "createdAt",
        "id",
        "op",
        "recordId",
        "recordType",
        "scopePath",
        "summary",
        "supersededById",
      ]);
    }
  });

  it("serves a change that commits just after the page is read once, on the next read, never twice and never skipped", async () => {
    // `readChanges` reads its resume point, the org's horizon and its page in one statement,
    // so they share one snapshot, and then moves the cursor. A write committing between that
    // statement and the cursor move is past both the page and the horizon: this read must not
    // serve it, must not move the cursor past it, and the next read must serve it once.
    //
    // The interleaving is forced rather than raced: the write is committed from inside the
    // page statement's call, so it lands after the read and before the cursor moves on every run.
    await writeEvent(SALES, "before-the-read");
    let landedMidRead: Awaited<ReturnType<typeof writeEvent>> | undefined;

    const original = appDb.$queryRaw.bind(appDb);
    appDb.$queryRaw = async (...args: unknown[]) => {
      const rows = await original(...args);
      if (!landedMidRead && isPageQuery(args[0])) landedMidRead = await writeEvent(SALES, "mid-read");
      return rows;
    };
    let page;
    try {
      page = await readChanges(asAgent(salesToken), SALES);
    } finally {
      appDb.$queryRaw = original;
    }

    // Guards the guard: if the page statement's `horizonSeq` alias is ever renamed, the
    // interleave silently stops firing and this becomes a test that cannot fail.
    expect(landedMidRead, "the interleaved write never fired").toBeDefined();
    expect(recordIds(page)).toEqual(["before-the-read"]);
    expect(await storedCursor()).toBeLessThan(landedMidRead!.seq);
    expect(recordIds(await readChanges(asAgent(salesToken), SALES))).toEqual(["mid-read"]);
    expect(recordIds(await readChanges(asAgent(salesToken), SALES))).toEqual([]);
  });

  // Every agent tool call that carries a notice reads one page (mcp/change-notices.ts), so its
  // round trips are paid by every call in the sync path. The resume point, the
  // horizon and the page were three statements; they are one. Counted on the wire, so a read
  // added through any Prisma API counts.
  it.each([
    ["the agent's own cursor", false],
    ["an explicit after", true],
  ])("reads its page from %s in one statement against the feed's tables", async (_, explicit) => {
    await writeEvent(SALES, "first");
    const [first] = (await readChanges(asAgent(salesToken), SALES)).changes;
    await writeEvent(SALES, "second");

    const sent: string[] = [];
    const query = pg.Client.prototype.query;
    pg.Client.prototype.query = function (this: pg.Client, ...args: unknown[]) {
      sent.push(statementText(args[0]));
      return (query as (...a: unknown[]) => unknown).apply(this, args);
    } as typeof pg.Client.prototype.query;
    let page;
    try {
      page = await readChanges(asAgent(salesToken), SALES, explicit ? { after: first!.id } : {});
    } finally {
      pg.Client.prototype.query = query;
    }

    expect(recordIds(page)).toEqual(["second"]);
    const feedReads = sent.filter(
      (sql) => /"change_events"|"agent_cursors"/.test(sql) && !/^\s*INSERT INTO "agent_cursors"/.test(sql),
    );
    // An explicit `after` is resolved against the caller's scope first, one statement of its own.
    expect(feedReads).toHaveLength(explicit ? 2 : 1);
  });

  it("takes its horizon from the reader's own org, so a busier org never moves its cursor past an unserved change", async () => {
    // The horizon moves the cursor when a page leaves nothing readable. Read across every org,
    // another org's higher seqs would carry the cursor past this org's next change, which would
    // then never be served. (Red team on #973: deleting the org filter passed every other test.)
    for (let i = 0; i < 5; i++) await writeEvent(SALES, `other-org-${i}`, OTHER_ORG);
    await writeEvent(SALES, "first");
    expect(recordIds(await readChanges(asAgent(salesToken), SALES))).toEqual(["first"]);
    await writeEvent(SALES, "second");
    expect(recordIds(await readChanges(asAgent(salesToken), SALES))).toEqual(["second"]);
  });

  it("resumes from the cursor in its own org when the same agent id holds one in another org", async () => {
    // The resume point is read inside the page statement; read without its org filter, an
    // agent id that also reads another org would resume from that org's cursor and skip its
    // own changes. (QA on #973: pinned only by QA's own test until folded here.)
    const otherToken = await mintCapability({ orgId: OTHER_ORG, scopePath: SALES });
    for (let i = 0; i < 4; i++) await writeEvent(SALES, `theirs-${i}`, OTHER_ORG);
    expect((await readChanges(asAgent(otherToken, SALES_AGENT, OTHER_ORG), SALES)).changes).toHaveLength(4);
    await writeEvent(SALES, "mine");
    expect(recordIds(await readChanges(asAgent(salesToken), SALES))).toEqual(["mine"]);
  });

  it("keeps each agent's cursor to itself", async () => {
    const otherToken = await mintCapability({ agentId: "agent-second", scopePath: SALES });
    await writeEvent(SALES, "shared");
    await readChanges(asAgent(salesToken), SALES);

    expect(recordIds(await readChanges(asAgent(otherToken, "agent-second"), SALES))).toEqual(["shared"]);
  });

  it("returns events oldest first, in commit order", async () => {
    for (const recordId of ["a", "b", "c", "d"]) await writeEvent(SALES, recordId);

    const page = await readChanges(asAgent(salesToken), SALES);

    expect(recordIds(page)).toEqual(["a", "b", "c", "d"]);
    // Order is the only ordering signal a caller gets, so it carries the whole
    // weight: createdAt must agree with the position in the page.
    const times = page.changes.map((c) => c.createdAt.getTime());
    expect(times).toEqual([...times].sort((x, y) => x - y));
  });
});
