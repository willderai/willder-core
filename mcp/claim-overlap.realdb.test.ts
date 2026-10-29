// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// Claim overlap against a real database: two agents whose claims on different tasks edit the
// same file are told of each other (services/memory/claim-overlap.ts). The later poster in its
// reply, the other on its next tool call, and nobody who cannot read both claims. Everything
// runs for real: MCP clients and servers over an in-memory transport, check(), the GIN `&&`
// query, the change feed and its scope filter. Expiry is simulated by moving a stored claim's
// expiry into the past; no clock is faked.
//
// Set QA_DATABASE_URL to an ISOLATED test database, never the inherited DATABASE_URL.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { PrismaClient } from "@/lib/generated/prisma/client";
// The leaf module, not the `@/services/access` barrel: the barrel builds the `@/lib/db`
// singleton at import time, before beforeAll points DATABASE_URL at the QA database.
import { hashCapabilityToken } from "@/services/access/capabilities";

const QA_URL = process.env.QA_DATABASE_URL;

const ORG = "org-qa-claim-overlap";
const OTHER_ORG = "org-qa-claim-overlap-other";
const TEAM = "org_1.team";
const TEAM_SUB = "org_1.team.web";
const TEAM_API = "org_1.team.api";
// Siblings under one parent: a token on one cannot read the other.
const PLATFORM = "org_1.platform";
const PLATFORM_PRIVATE = "org_1.platform_private";

const NORTH = "builder-north";
const SOUTH = "builder-south";
const WATCHER = "watcher-west";

const SESSIONS = "file:acme/app/lib/sessions.ts";
const ROUTES = "file:acme/app/app/api/routes.ts";
const README = "file:acme/app/README.md";

interface ToolResult {
  content: { type: string; text: string }[];
  isError?: boolean;
}

describe.skipIf(!QA_URL)("claim overlap between agents, against a real database", () => {
  let db: PrismaClient;
  let registerWillderTools: (typeof import("./tools"))["registerWillderTools"];
  const openClients: Client[] = [];

  async function connectAs(agentId: string, scopePath: string, orgId = ORG): Promise<Client> {
    const token = `wcap_test_${Math.random().toString(36).slice(2)}`;
    await db.capability.create({
      data: {
        orgId,
        agentId,
        tokenHash: hashCapabilityToken(token),
        scopePath,
        permission: "write",
        expiresAt: new Date(Date.now() + 3600_000),
      },
    });
    const server = new McpServer({ name: "willder-test", version: "0.0.0" });
    registerWillderTools(
      server,
      { orgId, actor: { type: "agent", id: agentId, capabilityToken: token }, origin: "mcp" },
      { orgId, agentId, scopePath },
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: "test-client", version: "0.0.0" });
    await client.connect(clientTransport);
    openClients.push(client);
    return client;
  }

  const call = async (client: Client, name: string, args: Record<string, unknown>, meta: Record<string, string> = {}) =>
    (await client.callTool({ name, arguments: args, _meta: { "willder/session": "work", ...meta } })) as ToolResult;
  const claim = (client: Client, task: string, touches?: string[], extra: Record<string, unknown> = {}) =>
    call(client, "memory_note", {
      kind: "claim",
      task,
      body: `working on ${task}`,
      ...(touches ? { touches } : {}),
      ...extra,
    });
  /** A call that does unrelated work in the agent's ongoing session; returns what rode on it. */
  const nextNotice = async (client: Client) =>
    (await call(client, "get_my_brief", { briefId: "no-such-brief" })).content
      .slice(1)
      .map((c) => c.text)
      .join("\n");
  const noteId = async (agentId: string, task: string) =>
    (await db.workingNote.findFirstOrThrow({ where: { orgId: ORG, agentId, task }, select: { id: true } })).id;
  const overlapEvents = (orgId = ORG) =>
    db.changeEvent.findMany({ where: { orgId, recordType: "claim_overlap" }, orderBy: { seq: "asc" } });
  const setFlag = (on: boolean, orgId = ORG) =>
    db.org.update({ where: { id: orgId }, data: { settings: on ? { claimOverlap: true } : {} } });

  beforeAll(async () => {
    process.env.DATABASE_URL = QA_URL;
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });
    ({ registerWillderTools } = await import("./tools"));
  });

  afterAll(async () => {
    await Promise.all(openClients.splice(0).map((client) => client.close()));
    await db.$disconnect();
  });

  beforeEach(async () => {
    await Promise.all(openClients.splice(0).map((client) => client.close()));
    for (const orgId of [ORG, OTHER_ORG]) {
      await db.auditLog.deleteMany({ where: { orgId } });
      await db.changeEvent.deleteMany({ where: { orgId } });
      await db.agentCursor.deleteMany({ where: { orgId } });
      await db.taskStartDelivery.deleteMany({ where: { orgId } });
      await db.workingNote.deleteMany({ where: { orgId } });
      await db.sessionScopeRead.deleteMany({ where: { orgId } });
      await db.capability.deleteMany({ where: { orgId } });
      await db.org.upsert({
        where: { id: orgId },
        update: { settings: { claimOverlap: true } },
        create: { id: orgId, name: orgId, settings: { claimOverlap: true } },
      });
    }
  });

  it("tells the later claimant in its reply and the earlier one on its next call, naming the other claim and the shared file", async () => {
    const north = await connectAs(NORTH, TEAM);
    const south = await connectAs(SOUTH, TEAM);
    await claim(north, "fix the session expiry", [SESSIONS, README]);
    await nextNotice(north); // north is mid-run: its own post is behind its cursor
    await nextNotice(south); // south has heard of north's claim already; only the reply shows it again
    await db.sessionScopeRead.deleteMany({ where: { orgId: ORG, agentId: SOUTH } });
    const northClaim = await noteId(NORTH, "fix the session expiry");

    const reply = (await claim(south, "add the routes audit", [ROUTES, SESSIONS])).content[0]!.text;
    const southClaim = await noteId(SOUTH, "add the routes audit");

    expect(reply).toContain(
      "Overlapping files detected with 1 other live claim on other work. Each claim is stored; nothing was resolved.",
    );
    expect(reply).toMatch(
      new RegExp(
        `^- ${NORTH}'s claim ${northClaim} on "fix the session expiry", claimed \\d+ min ago \\(live until \\S+\\): 1 shared file: ${SESSIONS}$`,
        "m",
      ),
    );
    expect(reply).not.toContain(README);
    // The reply showed north's claim, so south's session has read its scope.
    expect(await db.sessionScopeRead.count({ where: { orgId: ORG, agentId: SOUTH, scopePath: TEAM } })).toBe(1);
    expect(await nextNotice(north)).toContain(
      `- create claim_overlap ${southClaim} by ${SOUTH}: overlap detected, not resolved: claim ${northClaim} by ${NORTH}, claimed `,
    );
  });

  it("tells exactly one of two agents adding the same file at the same moment, and the other on its next call", async () => {
    const north = await connectAs(NORTH, TEAM);
    const south = await connectAs(SOUTH, TEAM);
    await Promise.all([nextNotice(north), nextNotice(south)]);

    const replies = await Promise.all([claim(north, "task north", [SESSIONS]), claim(south, "task south", [SESSIONS])]);
    const told = replies.map((r) => r.content[0]!.text.includes("Overlapping files detected"));

    expect(told.filter(Boolean)).toHaveLength(1);
    const earlier = told[0] ? south : north;
    expect(await nextNotice(earlier)).toContain("- create claim_overlap ");
    expect(await overlapEvents()).toHaveLength(1);
  });

  it.each([
    ["disjoint", async (north: Client) => void (await claim(north, "task north", [README]))],
    [
      "released",
      async (north: Client) => {
        await claim(north, "task north", [SESSIONS]);
        await call(north, "memory_note", { kind: "claim", task: "task north", action: "release" });
      },
    ],
    [
      "lapsed",
      async (north: Client) => {
        await claim(north, "task north", [SESSIONS]);
        await db.workingNote.updateMany({
          where: { orgId: ORG, agentId: NORTH },
          data: { expiresAt: new Date(Date.now() - 1000) },
        });
      },
    ],
    [
      "on the same task, which is a collision instead",
      async (north: Client) => void (await claim(north, "task south", [SESSIONS])),
    ],
  ])("reports no overlap with a %s claim", async (_case, before) => {
    const north = await connectAs(NORTH, TEAM);
    const south = await connectAs(SOUTH, TEAM);
    await before(north);

    const reply = (await claim(south, "task south", [SESSIONS])).content[0]!.text;

    expect(reply).not.toContain("Overlapping files detected");
    expect(await overlapEvents()).toHaveLength(0);
  });

  it("shows the poster nothing across tenants or from a scope it cannot read, and files that event only under the common parent", async () => {
    await claim(await connectAs(NORTH, TEAM, OTHER_ORG), "other tenant", [SESSIONS]);
    await claim(await connectAs(NORTH, PLATFORM_PRIVATE), "private work", [SESSIONS]);

    const reply = (await claim(await connectAs(SOUTH, PLATFORM), "platform work", [SESSIONS])).content[0]!.text;

    expect(reply).not.toContain("Overlapping files detected");
    expect(reply).not.toContain("private work");
    expect(await overlapEvents(OTHER_ORG)).toHaveLength(0);
    expect((await overlapEvents()).map((e) => e.scopePath)).toEqual(["org_1"]);
  });

  it("files the overlap where only readers of both claims see it", async () => {
    // north claims in the parent scope; south, whose token covers the parent, claims in the child.
    const north = await connectAs(NORTH, TEAM);
    const south = await connectAs(SOUTH, TEAM);
    const watcher = await connectAs(WATCHER, TEAM_SUB); // reads the child, not north's parent scope
    await nextNotice(watcher);
    await claim(north, "parent work", [SESSIONS]);

    await claim(south, "child work", [SESSIONS], { scopePath: TEAM_SUB });

    const [event] = await overlapEvents();
    expect(event!.scopePath).toBe(TEAM);
    const watcherSaw = await nextNotice(watcher);
    expect(watcherSaw).toContain(`by ${SOUTH}: claim on child work`); // the child's own claim, as before
    expect(watcherSaw).not.toContain("claim_overlap");
    expect(await nextNotice(north)).toContain("- create claim_overlap ");
    // Each side has now been shown the other's claim, so each session has read its scope.
    const readBy = async (agentId: string) =>
      (
        await db.sessionScopeRead.findMany({
          where: { orgId: ORG, agentId },
          select: { scopePath: true },
          orderBy: { scopePath: "asc" },
        })
      ).map((r) => r.scopePath);
    expect(await readBy(NORTH)).toEqual([TEAM, TEAM_SUB]);
    expect(await readBy(SOUTH)).toEqual([TEAM]);
  });

  it("stops showing an overlap once the claim that made it is released, and shows the release", async () => {
    const north = await connectAs(NORTH, TEAM);
    const south = await connectAs(SOUTH, TEAM);
    await claim(north, "task north", [SESSIONS]);
    await nextNotice(north);
    await claim(south, "task south", [SESSIONS]);
    await call(south, "memory_note", { kind: "claim", task: "task south", action: "release" });

    const seen = await nextNotice(north);

    expect(seen).toContain(`by ${SOUTH}: released claim on task south`);
    expect(seen).not.toContain("claim_overlap");
  });

  it("tells the earlier claimant, who reads both claims, even when the later poster cannot read the earlier one", async () => {
    const north = await connectAs(NORTH, TEAM);
    const south = await connectAs(SOUTH, TEAM_API); // reads only its own child scope
    await nextNotice(north);
    await claim(north, "web work", [SESSIONS], { scopePath: TEAM_SUB });

    const reply = (await claim(south, "api work", [SESSIONS])).content[0]!.text;

    expect(reply).not.toContain("Overlapping files detected");
    expect(reply).not.toContain("web work");
    // Decided with can() first, so the unreadable claim costs the poster no audited denial either.
    expect(await db.auditLog.count({ where: { orgId: ORG, actorId: SOUTH, decision: "deny" } })).toBe(0);
    expect((await overlapEvents()).map((e) => e.scopePath)).toEqual([TEAM]);
    expect(await nextNotice(north)).toContain("- create claim_overlap ");
  });

  it("tells every other claimant sharing the file, and lists five in the reply with how many more", async () => {
    for (let i = 0; i < 6; i++) await claim(await connectAs(`builder-${i}`, TEAM), `task ${i}`, [SESSIONS]);

    const reply = (await claim(await connectAs(SOUTH, TEAM), "task south", [SESSIONS])).content[0]!.text;

    const southClaim = await noteId(SOUTH, "task south");
    expect((await overlapEvents()).filter((e) => e.recordId === southClaim)).toHaveLength(6);
    expect(reply).toContain("Overlapping files detected with 6 other live claims on other work.");
    expect(reply.match(/^- builder-\d's claim /gm)).toHaveLength(5);
    expect(reply).toContain("- and 1 more claims not listed; each was told of this overlap.");
  });

  it.each([
    ["an empty list", async () => undefined, [] as string[], /^invalid_input: touches is empty/],
    [
      "a claim its agent released",
      async (c: Client) => {
        await claim(c, "hook task", [SESSIONS]);
        await call(c, "memory_note", { kind: "claim", task: "hook task", action: "release" });
      },
      [SESSIONS],
      /^claim_released: /,
    ],
  ])("makes no claim from touches alone for %s", async (_case, before, touches, refusal) => {
    const north = await connectAs(NORTH, TEAM);
    await before(north);

    const reply = await call(
      north,
      "memory_note",
      { kind: "claim", task: "hook task", touches },
      { "willder/capture": "touches" },
    );

    expect(reply.content[0]!.text).toMatch(refusal);
    expect(await db.workingNote.count({ where: { orgId: ORG, releasedAt: null, expiresAt: { gt: new Date() } } })).toBe(
      0,
    );
  });

  it("reports a shared file once per pair: a renewal reports only the files it adds", async () => {
    const north = await connectAs(NORTH, TEAM);
    const south = await connectAs(SOUTH, TEAM);
    await claim(north, "task north", [SESSIONS]);
    await claim(south, "task south", [SESSIONS]);

    const unchanged = (await claim(south, "task south", [SESSIONS, README])).content[0]!.text;
    const added = (await claim(north, "task north", [SESSIONS, README])).content[0]!.text;

    expect(unchanged).not.toContain("Overlapping files detected");
    expect(added).toMatch(new RegExp(`1 shared file: ${README}$`, "m"));
    expect((await overlapEvents()).map((e) => e.summary)).toEqual([
      expect.stringMatching(new RegExp(`shares 1 file: ${SESSIONS}; this claim is on "task south"$`)),
      expect.stringMatching(new RegExp(`shares 1 file: ${README}; this claim is on "task north"$`)),
    ]);
  });

  it("keeps touches out entirely while the org has claim overlap off", async () => {
    await setFlag(false);
    const north = await connectAs(NORTH, TEAM);
    const south = await connectAs(SOUTH, TEAM);
    await claim(north, "task north", [SESSIONS]);

    const reply = (await claim(south, "task south", [SESSIONS])).content[0]!.text;
    const touchesOnly = await call(
      south,
      "memory_note",
      { kind: "claim", task: "hook task", touches: [SESSIONS] },
      { "willder/capture": "touches" },
    );

    expect(reply).toContain("Touches were not recorded: claim overlap is off for this org.");
    expect(reply).not.toContain("Overlapping files detected");
    expect(touchesOnly.isError).toBe(true);
    expect(touchesOnly.content[0]!.text).toMatch(/^claim_overlap_off: /);
    expect(
      await db.workingNote.findMany({
        where: { orgId: ORG },
        select: { task: true, touches: true },
        orderBy: { task: "asc" },
      }),
    ).toEqual([
      { task: "task north", touches: [] },
      { task: "task south", touches: [] },
    ]);
    expect(await overlapEvents()).toHaveLength(0);
  });

  it("makes a claim from touches alone, and a later touches-only post keeps its body and longer life and adds no note event", async () => {
    const south = await connectAs(SOUTH, TEAM);
    const hook = (touches: string[]) =>
      call(south, "memory_note", { kind: "claim", task: "hook task", touches }, { "willder/capture": "touches" });

    await hook([SESSIONS]);
    const made = await db.workingNote.findFirstOrThrow({ where: { orgId: ORG, agentId: SOUTH } });
    await claim(south, "hook task", undefined, { body: "the agent's own line", expiresInMinutes: 240 });
    const before = await db.workingNote.findUniqueOrThrow({ where: { id: made.id } });
    const events = await db.changeEvent.count({ where: { orgId: ORG, recordType: "note" } });

    await hook([SESSIONS, README]);

    const after = await db.workingNote.findUniqueOrThrow({ where: { id: made.id } });
    expect(made.body).toBe("Editing files for this task; the list is recorded from its edits.");
    expect(after.body).toBe("the agent's own line");
    expect(after.touches).toEqual([README, SESSIONS]);
    expect(after.expiresAt.getTime()).toBe(before.expiresAt.getTime());
    expect(await db.changeEvent.count({ where: { orgId: ORG, recordType: "note" } })).toBe(events);
    expect(await db.workingNote.count({ where: { orgId: ORG } })).toBe(1);
  });

  it("keeps a touch that may hold a secret or an address out, and says how many", async () => {
    const south = await connectAs(SOUTH, TEAM);
    const reply = (await claim(south, "task south", [SESSIONS, "file:acme/app/notes/ana@example.com.md"])).content[0]!
      .text;

    expect(reply).toContain("1 of the touches was not recorded: it may hold a secret or an email address.");
    expect(reply).not.toContain("ana@example.com");
    expect((await db.workingNote.findFirstOrThrow({ where: { orgId: ORG, agentId: SOUTH } })).touches).toEqual([
      SESSIONS,
    ]);
  });

  it("leaves out only a touch that is not a file node, and refuses touches on a note that is not a claim", async () => {
    const south = await connectAs(SOUTH, TEAM);
    const traversal = (await claim(south, "task south", [SESSIONS, "file:acme/app/../secrets.env"])).content[0]!.text;
    const status = await call(south, "memory_note", {
      kind: "status",
      task: "task status",
      body: "halfway",
      touches: [SESSIONS],
    });

    expect(traversal).toContain(
      '1 of the touches was not recorded: it is not "file:<repo>/<path>" from the repository root.',
    );
    expect((await db.workingNote.findFirstOrThrow({ where: { orgId: ORG, task: "task south" } })).touches).toEqual([
      SESSIONS,
    ]);
    expect(status.content[0]!.text).toMatch(/^invalid_input: touches belong to a claim, not a status/);
    expect(await db.workingNote.count({ where: { orgId: ORG, kind: "status" } })).toBe(0);
  });

  it("adds a touches-only post's files to the claim, so two sends at once both stay", async () => {
    const north = await connectAs(NORTH, TEAM);
    const hook = (touches: string[]) =>
      call(north, "memory_note", { kind: "claim", task: "hook task", touches }, { "willder/capture": "touches" });
    await hook([README]);

    await Promise.all([hook([SESSIONS]), hook([ROUTES])]);

    expect(await db.workingNote.findMany({ where: { orgId: ORG, agentId: NORTH }, select: { touches: true } })).toEqual(
      [{ touches: [ROUTES, README, SESSIONS].sort() }],
    );
  });

  it.each([
    ["renews the agent's live claim made in a narrower scope, rather than adding a second", false, 1],
    ["never re-claims a task whose claim the agent released in a narrower scope", true, 0],
  ])("touches alone %s", async (_case, released, live) => {
    const north = await connectAs(NORTH, TEAM);
    await claim(north, "WEB-412", undefined, { scopePath: TEAM_SUB });
    if (released)
      await call(north, "memory_note", { kind: "claim", task: "WEB-412", scopePath: TEAM_SUB, action: "release" });

    const reply = await call(
      north,
      "memory_note",
      { kind: "claim", task: "WEB-412", touches: [SESSIONS] },
      { "willder/capture": "touches" },
    );

    const notes = await db.workingNote.findMany({
      where: { orgId: ORG, agentId: NORTH, releasedAt: null },
      select: { scopePath: true, touches: true },
    });
    expect(notes).toHaveLength(live);
    if (live) expect(notes).toEqual([{ scopePath: TEAM_SUB, touches: [SESSIONS] }]);
    else expect(reply.content[0]!.text).toMatch(/^claim_released: /);
    expect(await db.workingNote.count({ where: { orgId: ORG, agentId: NORTH } })).toBe(1);
  });

  it("lists a readable overlapping claim however many claims the poster cannot read come before it", async () => {
    const earlier = new Date(Date.now() - 10 * 60_000);
    await db.workingNote.createMany({
      data: Array.from({ length: 60 }, (_, i) => ({
        orgId: ORG,
        scopePath: PLATFORM_PRIVATE,
        agentId: `hidden-${i}`,
        task: `private task ${i}`,
        kind: "claim" as const,
        body: "private",
        touches: [SESSIONS],
        createdAt: earlier,
        expiresAt: new Date(Date.now() + 3600_000),
      })),
    });
    const readable = await connectAs("builder-readable", PLATFORM);
    await claim(readable, "readable task", [SESSIONS]);
    const readableClaim = await noteId("builder-readable", "readable task");
    await nextNotice(readable);

    const reply = (await claim(await connectAs(SOUTH, PLATFORM), "poster task", [SESSIONS])).content[0]!.text;

    expect(reply).toContain("Overlapping files detected with 1 other live claim on other work.");
    expect(reply).toContain(`claim ${readableClaim} on "readable task"`);
    expect(await nextNotice(readable)).toContain("- create claim_overlap ");
  });
});
