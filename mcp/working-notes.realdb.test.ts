// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// Working notes between agents, against a real database.
//
// The flow they exist for: two agents work in one scope, one of them says what it is
// doing right now, and the other learns it on its next tool call instead of after the
// first one has finished. Everything below runs for real: an MCP client and server over
// an in-memory transport, the real tool registrations, check(), the ltree filter, the
// change feed and the task-start block. Expiry is simulated by moving a stored note's
// expiry into the past; no clock is faked.
//
// Set QA_DATABASE_URL to an ISOLATED test database, never the inherited
// DATABASE_URL, which may point at a live database. Skips cleanly without it.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { PrismaClient } from "@/lib/generated/prisma/client";
// The leaf module, not the `@/services/access` barrel: the barrel builds the
// `@/lib/db` singleton at import time, before beforeAll points DATABASE_URL at
// the QA database.
import { hashCapabilityToken } from "@/services/access/capabilities";

// Lets one test make the notice's own read of working notes fail, to prove the tool
// result it rides on is still delivered. Every other test runs the real function.
const noticeRead = vi.hoisted(() => ({ fail: false }));
vi.mock("@/services/memory/working-notes", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/memory/working-notes")>();
  return {
    ...actual,
    liveNoteIds: async (...args: Parameters<typeof actual.liveNoteIds>) => {
      if (noticeRead.fail) throw new Error("working_notes unreachable");
      return actual.liveNoteIds(...args);
    },
  };
});

const QA_URL = process.env.QA_DATABASE_URL;

const ORG = "org-qa-working-notes";
const CREW = "org_1.crew";
// Siblings under one parent: a token on one cannot read the other.
const PLATFORM = "org_1.platform";
const PLATFORM_PRIVATE = "org_1.platform_private";

const NORTH = "builder-north";
const SOUTH = "builder-south";
const REVIEWER = "reviewer-east";

const TASK = "followup: ingest retry writes a duplicate version";

interface ToolResult {
  content: { type: string; text: string }[];
  isError?: boolean;
}

describe.skipIf(!QA_URL)("working notes between agents, against a real database", () => {
  let db: PrismaClient;
  let registerWillderTools: (typeof import("./tools"))["registerWillderTools"];
  let hookNotice: (typeof import("@/app/api/changes/notice/route"))["GET"];

  const openClients: Client[] = [];

  async function mintCapability(agentId: string, scopePath: string, permission: "read" | "write"): Promise<string> {
    const token = `wcap_test_${Math.random().toString(36).slice(2)}`;
    await db.capability.create({
      data: {
        orgId: ORG,
        agentId,
        tokenHash: hashCapabilityToken(token),
        scopePath,
        permission,
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    });
    return token;
  }

  /** A connected MCP client acting as `agentId` with `permission` on `scopePath`. */
  async function connectAs(
    agentId: string,
    scopePath: string,
    permission: "read" | "write" = "write",
  ): Promise<Client> {
    const token = await mintCapability(agentId, scopePath, permission);
    const server = new McpServer({ name: "willder-test", version: "0.0.0" });
    registerWillderTools(
      server,
      { orgId: ORG, actor: { type: "agent", id: agentId, capabilityToken: token }, origin: "mcp" },
      { orgId: ORG, agentId, scopePath },
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: "test-client", version: "0.0.0" });
    await client.connect(clientTransport);
    openClients.push(client);
    return client;
  }

  async function note(client: Client, args: Record<string, unknown>, session = "work"): Promise<ToolResult> {
    return (await client.callTool({
      name: "memory_note",
      arguments: args,
      _meta: { "willder/session": session },
    })) as ToolResult;
  }

  /** A tool call that does unrelated work, in the agent's ongoing session. */
  async function unrelatedCall(client: Client, session = "work", task?: string): Promise<ToolResult> {
    const _meta: Record<string, string> = { "willder/session": session };
    if (task !== undefined) _meta["willder/task"] = task;
    return (await client.callTool({
      name: "get_my_brief",
      arguments: { briefId: "no-such-brief" },
      _meta,
    })) as ToolResult;
  }

  /** Everything a result carried besides the tool's own answer. */
  const piggyback = (result: ToolResult): string =>
    result.content
      .slice(1)
      .map((c) => c.text)
      .join("\n\n");

  /** The one note `agentId` has stored, read back from the table. */
  async function storedNote(agentId: string) {
    const rows = await db.workingNote.findMany({ where: { orgId: ORG, agentId } });
    expect(rows).toHaveLength(1);
    return rows[0]!;
  }

  beforeAll(async () => {
    process.env.DATABASE_URL = QA_URL;
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });
    ({ registerWillderTools } = await import("./tools"));
    ({ GET: hookNotice } = await import("@/app/api/changes/notice/route"));
  });

  afterAll(async () => {
    await db.$disconnect();
  });

  beforeEach(async () => {
    noticeRead.fail = false;
    await Promise.all(openClients.splice(0).map((client) => client.close()));
    await db.auditLog.deleteMany({ where: { orgId: ORG } });
    await db.changeEvent.deleteMany({ where: { orgId: ORG } });
    await db.agentCursor.deleteMany({ where: { orgId: ORG } });
    await db.taskStartDelivery.deleteMany({ where: { orgId: ORG } });
    await db.workingNote.deleteMany({ where: { orgId: ORG } });
    await db.sessionScopeRead.deleteMany({ where: { orgId: ORG } });
    await db.capability.deleteMany({ where: { orgId: ORG } });
    await db.org.upsert({ where: { id: ORG }, update: {}, create: { id: ORG, name: ORG } });
  });

  it("tells a busy agent about another agent's claim on its next tool call", async () => {
    const north = await connectAs(NORTH, CREW);
    const south = await connectAs(SOUTH, CREW);
    await unrelatedCall(south); // south is mid-run: its session's first call is behind it

    const posted = await note(north, { kind: "claim", task: TASK, body: "fixing the retry dedupe on the ingest path" });
    expect(posted.isError).toBeFalsy();
    const { id } = await storedNote(NORTH);

    const next = await unrelatedCall(south);

    expect(next.content[0]!.text).toBe("Brief no-such-brief not found.");
    expect(piggyback(next)).toMatch(
      new RegExp(
        `^Changed in your scope since your last call:\\n- create note ${id} by ${NORTH}: claim on ${TASK} until \\d{4}-\\d\\d-\\d\\dT\\d\\d:\\d\\dZ: fixing the retry dedupe on the ingest path$`,
      ),
    );
  });

  it("tells an agent busy in files and shell about the claim through the client hook", async () => {
    const north = await connectAs(NORTH, CREW);
    const southToken = await mintCapability(SOUTH, CREW, "read");
    await note(north, { kind: "claim", task: TASK, body: "fixing the retry dedupe" });
    const { id } = await storedNote(NORTH);

    const response = await hookNotice(
      new Request("https://willder.test/api/changes/notice", { headers: { authorization: `Bearer ${southToken}` } }),
    );

    const { notice } = (await response.json()) as { notice: string | null };
    expect(notice).toContain(`- create note ${id} by ${NORTH}: claim on ${TASK} until `);
  });

  it("names the earlier claim when a second agent claims the same task minutes later, and keeps both", async () => {
    // The shape of a real collision: two builders were each dispatched to the same
    // task, the second a few minutes after the first had started.
    const north = await connectAs(NORTH, CREW);
    const south = await connectAs(SOUTH, CREW);
    await note(north, { kind: "claim", task: TASK, body: "on it: reproducing the duplicate write first" });
    const first = await storedNote(NORTH);
    const claimedAt = new Date(Date.now() - 4 * 60 * 1000);
    await db.workingNote.update({ where: { id: first.id }, data: { createdAt: claimedAt } });

    const second = await note(south, { kind: "claim", task: TASK, body: "taking the task" });

    expect(second.isError).toBeFalsy();
    const reply = second.content[0]!.text;
    expect(reply).toContain("Detected 1 earlier live claim on this task by another agent.");
    expect(reply).toContain("Both claims are stored; nothing was resolved.");
    expect(reply).toContain(
      `- ${NORTH} claimed it at ${claimedAt.toISOString().slice(0, 19)}Z (note ${first.id}, live until ${first.expiresAt.toISOString().slice(0, 19)}Z): on it: reproducing the duplicate write first`,
    );
    expect(reply).not.toMatch(/resolved (the|this) (conflict|collision)|winner/i);
    expect(await db.workingNote.count({ where: { orgId: ORG, kind: "claim" } })).toBe(2);
  });

  it("tells exactly one of two agents claiming the same task at the same moment about the other", async () => {
    const north = await connectAs(NORTH, CREW);
    const south = await connectAs(SOUTH, CREW);

    const replies = await Promise.all([
      note(north, { kind: "claim", task: TASK, body: "north takes it" }),
      note(south, { kind: "claim", task: TASK, body: "south takes it" }),
    ]);

    const told = replies.filter((reply) => reply.content[0]!.text.includes("Detected 1 earlier live claim"));
    expect(told).toHaveLength(1);
  });

  it("keeps one live note when the same agent posts the same claim twice at once", async () => {
    // A client retrying a call it thinks timed out sends the same post again while the
    // first is still running.
    const north = await connectAs(NORTH, CREW);

    await Promise.all([
      note(north, { kind: "claim", task: TASK, body: "first try" }),
      note(north, { kind: "claim", task: TASK, body: "retried" }),
    ]);

    expect(await db.workingNote.count({ where: { orgId: ORG, agentId: NORTH } })).toBe(1);
  });

  it("does not report the agent's own renewed claim as a collision, and keeps one live note", async () => {
    const north = await connectAs(NORTH, CREW);
    await note(north, { kind: "claim", task: TASK, body: "first pass", expiresInMinutes: 5 });
    const before = await storedNote(NORTH);

    const renewed = await note(north, { kind: "claim", task: TASK, body: "still on it", expiresInMinutes: 60 });

    expect(renewed.content[0]!.text).toMatch(/^Renewed claim /);
    expect(renewed.content[0]!.text).not.toContain("Detected");
    const after = await storedNote(NORTH);
    expect(after.id).toBe(before.id);
    expect(after.body).toBe("still on it");
    expect(after.expiresAt.getTime()).toBeGreaterThan(before.expiresAt.getTime() + 50 * 60 * 1000);
  });

  it("lets an agent release and renew the same note at once without a storage error", { timeout: 60_000 }, async () => {
    const north = await connectAs(NORTH, CREW);
    const results: ToolResult[] = [];
    for (let round = 0; round < 40; round++) {
      await note(north, { kind: "claim", task: TASK, body: `round ${round}` });
      results.push(
        ...(await Promise.all([
          note(north, { action: "release", kind: "claim", task: TASK }),
          note(north, { kind: "claim", task: TASK, body: `renewed ${round}` }),
        ])),
      );
    }

    expect(results.filter((result) => result.isError).map((result) => result.content[0]!.text)).toEqual([]);
  });

  describe("while another write holds the org's change-feed lock", () => {
    // The namespaces services/memory/change-events.ts and services/memory/working-notes.ts
    // pass as the first key of their advisory locks.
    const ORG_FEED_LOCK = 8_241_001;
    const AGENT_NOTES_LOCK = 8_241_004;

    /** Hold the org's change-feed lock, as any governed write does, until the returned function runs. */
    async function holdOrgFeedLock(): Promise<() => Promise<void>> {
      let release!: () => void;
      const released = new Promise<void>((resolve) => (release = resolve));
      let locked!: () => void;
      const isLocked = new Promise<void>((resolve) => (locked = resolve));
      const holder = db.$transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT true AS locked FROM pg_advisory_xact_lock(${ORG_FEED_LOCK}::int4, hashtext(${ORG})::int4)`;
          locked();
          await released;
        },
        { timeout: 30_000 },
      );
      await isLocked;
      return async () => {
        release();
        await holder;
      };
    }

    /** The backends waiting on a note or feed lock, once there are `count` of them. */
    async function waitersOnce(count: number): Promise<{ pid: number; namespace: number }[]> {
      const deadline = Date.now() + 10_000;
      for (;;) {
        const waiting = await db.$queryRaw<{ pid: number; namespace: number }[]>`
          SELECT pid, classid::int AS namespace FROM pg_locks
          WHERE locktype = 'advisory' AND NOT granted AND classid::int IN (${ORG_FEED_LOCK}, ${AGENT_NOTES_LOCK})
            AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
        `;
        if (waiting.length >= count) return waiting;
        if (Date.now() > deadline) throw new Error(`expected ${count} lock waiters, saw ${JSON.stringify(waiting)}`);
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }

    it("writes the note's own row before it waits for the org lock, so other writers wait only for its event", async () => {
      const south = await connectAs(SOUTH, CREW);
      const release = await holdOrgFeedLock();

      const posting = note(south, { kind: "status", task: TASK, body: "running the suite" });
      const [waiter] = await waitersOnce(1);
      const [{ rowLocks }] = await db.$queryRaw<[{ rowLocks: number }]>`
        SELECT count(*)::int AS "rowLocks" FROM pg_locks l JOIN pg_class c ON c.oid = l.relation
        WHERE l.pid = ${waiter!.pid} AND l.granted AND l.mode = 'RowExclusiveLock' AND c.relname = 'working_notes'
      `;
      await release();

      expect(waiter!.namespace).toBe(ORG_FEED_LOCK);
      expect(rowLocks).toBe(1);
      expect((await posting).isError).toBeFalsy();
    });

    it("still keeps one live note when the same agent's two posts both arrive while it is held", async () => {
      const north = await connectAs(NORTH, CREW);
      const release = await holdOrgFeedLock();

      const posting = Promise.all([
        note(north, { kind: "claim", task: TASK, body: "first try" }),
        note(north, { kind: "claim", task: TASK, body: "retried" }),
      ]);
      await waitersOnce(2);
      await release();

      expect((await posting).filter((reply) => reply.isError)).toEqual([]);
      expect(await db.workingNote.count({ where: { orgId: ORG, agentId: NORTH } })).toBe(1);
    });

    it("tells exactly one of two agents whose claims both wait on it about the other", async () => {
      const north = await connectAs(NORTH, CREW);
      const south = await connectAs(SOUTH, CREW);
      const release = await holdOrgFeedLock();

      // Both claims have written their rows and wait to record their events, so the claim
      // read is the only thing left that can see the other one.
      const claiming = Promise.all([
        note(north, { kind: "claim", task: TASK, body: "north takes it" }),
        note(south, { kind: "claim", task: TASK, body: "south takes it" }),
      ]);
      await waitersOnce(2);
      await release();

      const told = (await claiming).filter((reply) => reply.content[0]!.text.includes("Detected 1 earlier live claim"));
      expect(told).toHaveLength(1);
    });

    it("never lets a renewal racing a release land on the released note, so the agent keeps a live note", async () => {
      const north = await connectAs(NORTH, CREW);
      await note(north, { kind: "claim", task: TASK, body: "first" });
      const release = await holdOrgFeedLock();

      // The release has ended its note and waits for the org lock to record that; the
      // renewal arrives while the release is still uncommitted.
      const releasing = note(north, { action: "release", kind: "claim", task: TASK });
      await waitersOnce(1);
      const renewing = note(north, { kind: "claim", task: TASK, body: "back on it" });
      await new Promise((resolve) => setTimeout(resolve, 200));
      await release();

      expect([await releasing, await renewing].filter((reply) => reply.isError)).toEqual([]);
      const live = await db.workingNote.count({
        where: { orgId: ORG, agentId: NORTH, releasedAt: null, expiresAt: { gt: new Date() } },
      });
      expect(live).toBe(1);
    });
  });

  it("names a readable earlier claim even when more unreadable ones are older", async () => {
    const reader = await connectAs(SOUTH, PLATFORM);
    for (let i = 0; i < 6; i++) {
      await note(await connectAs(`hidden-${i}`, PLATFORM_PRIVATE), { kind: "claim", task: TASK, body: `hidden ${i}` });
    }
    await note(await connectAs(NORTH, PLATFORM), { kind: "claim", task: TASK, body: "visible claim" });

    const reply = (await note(reader, { kind: "claim", task: TASK, body: "mine" })).content[0]!.text;

    expect(reply).toContain("Detected 1 earlier live claim");
    expect(reply).toContain(`- ${NORTH} claimed it at`);
    expect(reply).not.toContain("hidden");
  });

  it("does not call a claim made after the agent's own claim earlier when the agent renews", async () => {
    const north = await connectAs(NORTH, CREW);
    const south = await connectAs(SOUTH, CREW);
    await note(north, { kind: "claim", task: TASK, body: "first" });
    await note(south, { kind: "claim", task: TASK, body: "second" });

    const renewed = await note(north, { kind: "claim", task: TASK, body: "still first" });

    expect(renewed.content[0]!.text).toMatch(/^Renewed claim /);
    expect(renewed.content[0]!.text).not.toContain("Detected");
  });

  it("never shows an expired note, on the next call, at task start, or as a collision", async () => {
    const north = await connectAs(NORTH, CREW);
    const south = await connectAs(SOUTH, CREW);
    await unrelatedCall(south);
    await note(north, { kind: "claim", task: TASK, body: "abandoned run" });
    const stale = await storedNote(NORTH);
    await db.workingNote.update({ where: { id: stale.id }, data: { expiresAt: new Date(Date.now() - 1000) } });

    const next = await unrelatedCall(south);
    const newSession = await unrelatedCall(south, "next-session", TASK);
    const claim = await note(south, { kind: "claim", task: TASK, body: "taking it over" }, "next-session");

    expect(piggyback(next)).not.toContain("abandoned run");
    expect(piggyback(newSession)).not.toContain("abandoned run");
    expect(claim.content[0]!.text).not.toContain("Detected");
    // Kept, not purged: retention is a separate decision.
    expect(await db.workingNote.count({ where: { id: stale.id } })).toBe(1);
  });

  it("never shows a released note as live, and a later claim on its task is not a collision", async () => {
    const north = await connectAs(NORTH, CREW);
    const south = await connectAs(SOUTH, CREW);
    await unrelatedCall(south);
    await note(north, { kind: "claim", task: TASK, body: "done in ten minutes" });
    const released = await note(north, { action: "release", kind: "claim", task: TASK });
    const { id, releasedAt } = await storedNote(NORTH);

    const next = await unrelatedCall(south);
    const newSession = await unrelatedCall(south, "next-session", TASK);
    const claim = await note(south, { kind: "claim", task: TASK, body: "next one" }, "next-session");

    expect(released.content[0]!.text).toBe(`Released claim ${id} on "${TASK}".`);
    expect(releasedAt).not.toBeNull();
    expect(piggyback(next)).not.toContain(`create note ${id}`);
    expect(piggyback(next)).toContain(`- delete note ${id} by ${NORTH}: released claim on ${TASK}`);
    expect(piggyback(newSession)).not.toContain("done in ten minutes");
    expect(claim.content[0]!.text).not.toContain("Detected");
  });

  it("never shows or counts a note in a scope the reader cannot read", async () => {
    const hidden = await connectAs(NORTH, PLATFORM_PRIVATE);
    const reader = await connectAs(SOUTH, PLATFORM);
    await unrelatedCall(reader);
    await note(hidden, { kind: "claim", task: TASK, body: "private platform work" });
    await note(hidden, { kind: "status", task: "private rollout", body: "half done" });

    const next = await unrelatedCall(reader);
    const newSession = await unrelatedCall(reader, "next-session", TASK);
    const claim = await note(reader, { kind: "claim", task: TASK, body: "platform side" }, "next-session");

    for (const result of [next, newSession, claim]) {
      const text = result.content.map((c) => c.text).join("\n");
      expect(text).not.toContain("private");
      expect(text).not.toContain(NORTH);
      expect(text).not.toContain("Detected");
    }
  });

  it("counts only the notes in the reader's scope when it says how many are live", async () => {
    const hidden = await connectAs(NORTH, PLATFORM_PRIVATE);
    const neighbour = await connectAs(REVIEWER, PLATFORM);
    const reader = await connectAs(SOUTH, PLATFORM, "read");
    for (const task of ["private one", "private two", "private three"]) {
      await note(hidden, { kind: "status", task, body: "hidden work" });
    }
    await note(neighbour, { kind: "status", task: "platform rollout", body: "halfway" });

    const block = piggyback(await unrelatedCall(reader, "fresh")).split("\n\nChanged in your scope")[0]!;

    expect(block.split("\n")[2]).toMatch(
      /^Also live in this scope, on other tasks: reviewer-east on "platform rollout" \[status \w+\]\.$/,
    );
  });

  it("refuses a post into a scope the caller cannot write, names the fix, and stores nothing", async () => {
    const readOnly = await connectAs(REVIEWER, CREW, "read");
    const elsewhere = await connectAs(NORTH, PLATFORM);

    const fromReadOnly = await note(readOnly, { kind: "status", task: TASK, body: "reviewing" });
    const outsideScope = await note(elsewhere, { kind: "claim", task: TASK, body: "x", scopePath: CREW });

    for (const refused of [fromReadOnly, outsideScope]) {
      expect(refused.isError).toBe(true);
      expect(refused.content[0]!.text).toMatch(
        /^Access denied: no valid capability for agent [\w-]+ granting write on the target scope — ask an org admin to issue this agent a capability granting write on the scope you need/,
      );
    }
    expect(await db.workingNote.count({ where: { orgId: ORG } })).toBe(0);
    expect(await db.changeEvent.count({ where: { orgId: ORG, recordType: "note" } })).toBe(0);
  });

  it("serves the notes live in the scope to a task that starts after they were posted", async () => {
    const north = await connectAs(NORTH, CREW);
    const reviewer = await connectAs(REVIEWER, CREW, "read");
    await note(north, { kind: "claim", task: TASK, body: "fixing the retry dedupe" });
    await note(north, { kind: "question", task: "release window", body: "is Thursday still the cut?" });
    const notes = await db.workingNote.findMany({ where: { orgId: ORG }, orderBy: { createdAt: "asc" } });
    // The reviewer has already read the feed past both posts, so only the task-start
    // block can tell it they are live.
    const latest = await db.changeEvent.aggregate({ where: { orgId: ORG }, _max: { seq: true } });
    await db.agentCursor.create({ data: { orgId: ORG, agentId: REVIEWER, lastSeq: latest._max.seq! } });

    const first = await unrelatedCall(reviewer, "review-run", TASK);

    const block = piggyback(first);
    expect(block).toMatch(/^Before you start/);
    const lines = block.split("\n");
    // The note on the task this session names comes first, whole; the note on another task is
    // named on one line among what is related, so it never takes a record line.
    expect(lines.slice(1, 3)).toEqual([
      "Live now:",
      expect.stringMatching(
        new RegExp(`^- \\[claim ${notes[0]!.id}\\] ${NORTH} on "${TASK}", live until \\S+Z: fixing the retry dedupe$`),
      ),
    ]);
    expect(lines).toContain(
      `Also live in this scope, on other tasks: ${NORTH} on "release window" [question ${notes[1]!.id}].`,
    );
    expect(block).not.toContain("is Thursday still the cut");
    expect(block).not.toContain("Changed in your scope");
  });

  it("says how many notes are live when the task-start block shows only some of them", async () => {
    const north = await connectAs(NORTH, CREW);
    const reviewer = await connectAs(REVIEWER, CREW, "read");
    for (const task of ["one", "two", "three", "four"])
      await note(north, { kind: "status", task, body: `${task} in progress` });

    const block = piggyback(await unrelatedCall(reviewer, "review-run")).split("\n\nChanged in your scope")[0]!;

    expect(block.split("\n")[2]).toMatch(
      new RegExp(
        `^Also live in this scope, on other tasks: ${NORTH} on "four" \\[status \\w+\\]; ${NORTH} on "three" \\[status \\w+\\]; ${NORTH} on "two" \\[status \\w+\\]; 1 more\\.$`,
      ),
    );
    expect(block).not.toContain("one in progress");
  });

  it("still delivers the tool's result and every change when the notice cannot check which notes are live", async () => {
    const north = await connectAs(NORTH, CREW);
    const south = await connectAs(SOUTH, CREW);
    await unrelatedCall(south);
    await note(north, { kind: "claim", task: TASK, body: "fixing the retry dedupe" });
    const { id } = await storedNote(NORTH);
    noticeRead.fail = true;

    const next = await unrelatedCall(south);

    expect(next.isError).toBeFalsy();
    expect(next.content[0]!.text).toBe("Brief no-such-brief not found.");
    // The feed already moved this agent's cursor past the claim, so a notice that dropped
    // it here would never show it at all.
    expect(piggyback(next)).toContain(`- create note ${id} by ${NORTH}: claim on ${TASK}`);
  });

  describe("input the tool refuses, each naming the fix", () => {
    it("refuses a body over 280 characters", async () => {
      const north = await connectAs(NORTH, CREW);
      const result = await note(north, { kind: "status", task: TASK, body: "é".repeat(281) });
      expect(result.isError).toBe(true);
      expect(result.content[0]!.text).toBe(
        "invalid_input: body is 281 characters; a working note holds at most 280. Shorten it, or keep the detail as a fact with memory_ingest.",
      );
    });

    it("refuses an expiry longer than four hours", async () => {
      const north = await connectAs(NORTH, CREW);
      const result = await note(north, { kind: "status", task: TASK, body: "x", expiresInMinutes: 241 });
      expect(result.isError).toBe(true);
      expect(await db.workingNote.count({ where: { orgId: ORG } })).toBe(0);
    });

    it("refuses a post that names no task, when the session names none either", async () => {
      const north = await connectAs(NORTH, CREW);
      const result = await note(north, { kind: "status", body: "x" });
      expect(result.isError).toBe(true);
      expect(result.content[0]!.text).toBe(
        'invalid_input: name what the note is about: pass task, or name the session\'s task in _meta["willder/task"].',
      );
    });

    it("takes the task from the session when the call names none", async () => {
      const north = await connectAs(NORTH, CREW);
      const result = (await north.callTool({
        name: "memory_note",
        arguments: { kind: "intent", body: "trying the advisory-lock approach" },
        _meta: { "willder/session": "s", "willder/task": TASK },
      })) as ToolResult;
      expect(result.isError).toBeFalsy();
      expect((await storedNote(NORTH)).task).toBe(TASK);
    });

    it("takes a session task as long as a session may name, and ranks it first however its spaces run", async () => {
      const north = await connectAs(NORTH, CREW);
      const reviewer = await connectAs(REVIEWER, CREW, "read");
      const longTask = `followup:  ${"retry dedupe ".repeat(30)}`.trim();
      await note(north, { kind: "status", task: "something else", body: "other work" });
      const posted = (await north.callTool({
        name: "memory_note",
        arguments: { kind: "claim", body: "on it" },
        _meta: { "willder/session": "s", "willder/task": longTask },
      })) as ToolResult;
      await note(north, { kind: "status", task: "newest unrelated", body: "more other work" });

      const block = piggyback(await unrelatedCall(reviewer, "review", longTask));

      expect(posted.isError).toBeFalsy();
      expect(block.split("\n")[2]).toMatch(/^- \[claim \w+\] builder-north on "followup: retry dedupe/);
    });

    it("refuses a post with no body", async () => {
      const north = await connectAs(NORTH, CREW);
      const result = await note(north, { kind: "claim", task: TASK });
      expect(result.isError).toBe(true);
      expect(result.content[0]!.text).toBe("invalid_input: a post needs a body: one line saying what you are doing.");
    });
  });
});
