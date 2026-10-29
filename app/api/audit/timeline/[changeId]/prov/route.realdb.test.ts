// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test Postgres,
// and PROV_PYTHON names a Python with scripts/prov/requirements.txt installed; CI sets both.
//
// GET /api/audit/timeline/:changeId/prov against a real Postgres, with the shipping check()
// evaluator; only the Clerk session is stubbed. For a connector sync's write and an agent's
// direct write, the document passes the PROV validator (W3C PROV-JSON schema plus the `prov`
// package), and the four answers the validator reads back out of it equal the ones the API
// gives on its existing endpoints:
//   author    GET /api/audit/timeline/:changeId (writer, authorizedById, authorizationKind)
//             and GET /api/audit?ids= (who the authorizing row's actor is)
//   source    GET /api/audit/timeline/:changeId (source)
//   readers   GET /api/audit/timeline (the sightings of this write)
//   replaced  GET /api/audit/timeline/:changeId (replacesIds, replacedById)
//
// The same holds for every change in a small team's history, written by the product's own
// producers rather than inserted rows: check() decides every write, read and source connect
// (so each refusal is a real deny of a real grant or token), each write is announced the
// way the request path announces it (so a conflict is settled by the shipping winner rule),
// and connector syncs record their items the way the sync jobs do.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";
import type { AccessContext } from "@/services/access";
import { PROV_PYTHON, validateProv } from "@/services/audit/prov-validator.testsupport";

const QA_URL = process.env.QA_DATABASE_URL;
const RUN = randomUUID().slice(0, 8);
const ORG = `prov${RUN}`;
const ROOT = `org_${ORG}`;
const CREW = `${ROOT}.crew_1c5b79`;
const SIBLING = `${ROOT}.crewX1c5b79`;
const ADMIN = `u-prov-admin-${RUN}`;
const MEMBER = `u-prov-member-${RUN}`;
const SOURCE = `src_${RUN}`;
const SYNC_ACTOR = `github-sync:${SOURCE}`;
const SYNC_WRITE = randomUUID();
const AGENT_WRITE = randomUUID();
const CONNECT_ROW = `audit-connect-${RUN}`;
const AGENT_WRITE_ROW = `audit-write-${RUN}`;
const at = (seconds: number) => new Date(Date.UTC(2026, 8, 25, 12, 0, seconds));

// The team history's org: three people, five agents, two connected sources, six scopes.
const TEAM = `provteam${RUN}`;
const TEAM_ROOT = `org_${TEAM}`;
const ENG = `${TEAM_ROOT}.eng`;
const API = `${ENG}.api`;
const WEB = `${ENG}.web`;
const SALES = `${TEAM_ROOT}.sales`;
const EMEA = `${SALES}.emea`;
const OPS = `${TEAM_ROOT}.ops`;
const LEAD = `u-team-lead-${RUN}`;
const SELLER = `u-team-seller-${RUN}`;
const ENGINEER = `u-team-engineer-${RUN}`;
/** The namespace the export's identifiers are minted under. It must never change: consumers
 * join exported documents on the names minted under it. */
const NAMESPACE = "https://willder.ai/ns/prov/";

vi.mock("@/lib/access-context", () => ({ requireAccessContext: vi.fn() }));

describe.skipIf(!QA_URL || !PROV_PYTHON)("PROV-JSON export of a change, real Postgres", () => {
  let db: PrismaClient;
  let PROV: (typeof import("./route"))["GET"];
  let DETAIL: (typeof import("../route"))["GET"];
  let TIMELINE: (typeof import("../../route"))["GET"];
  let AUDIT: (typeof import("../../../route"))["GET"];
  let requireAccessContext: ReturnType<typeof vi.fn>;
  let adminSession: unknown;

  const wipe = async () => {
    const orgId = { in: [ORG, TEAM] };
    await db.auditLog.deleteMany({ where: { orgId } });
    await db.changeEvent.deleteMany({ where: { orgId } });
    await db.factEdge.deleteMany({ where: { orgId } });
    await db.memoryChunk.deleteMany({ where: { orgId } });
    await db.source.deleteMany({ where: { orgId } });
    await db.capability.deleteMany({ where: { orgId } });
    await db.agent.deleteMany({ where: { orgId } });
    await db.grant.deleteMany({ where: { orgId } });
    await db.scope.deleteMany({ where: { orgId } });
    await db.user.deleteMany({ where: { id: { in: [ADMIN, MEMBER, LEAD, SELLER, ENGINEER] } } });
    await db.org.deleteMany({ where: { id: orgId } });
  };

  beforeAll(async () => {
    process.env.DATABASE_URL = QA_URL;
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });
    ({ GET: PROV } = await import("./route"));
    ({ GET: DETAIL } = await import("../route"));
    ({ GET: TIMELINE } = await import("../../route"));
    ({ GET: AUDIT } = await import("../../../route"));
    ({ requireAccessContext } = (await import("@/lib/access-context")) as never as {
      requireAccessContext: ReturnType<typeof vi.fn>;
    });
    await wipe();

    await db.org.create({ data: { id: ORG, name: "PROV QA" } });
    const admin = await db.user.create({
      data: {
        id: ADMIN,
        orgId: ORG,
        email: `${ADMIN}@t.test`,
        role: "admin",
        clerkId: `clerk-${ADMIN}`,
        name: "Ada Admin",
      },
    });
    const root = await db.scope.create({ data: { orgId: ORG, path: ROOT, name: "root" } });
    await db.scope.create({ data: { orgId: ORG, path: CREW, name: "crew" } });
    await db.grant.create({
      data: { orgId: ORG, scopeId: root.id, granteeType: "user", granteeId: ADMIN, permission: "admin" },
    });
    // Reads the whole org, manages nothing: may read memory, may not open the audit page.
    await db.user.create({
      data: { id: MEMBER, orgId: ORG, email: `${MEMBER}@t.test`, role: "member", clerkId: `clerk-${MEMBER}` },
    });
    await db.grant.create({
      data: { orgId: ORG, scopeId: root.id, granteeType: "user", granteeId: MEMBER, permission: "read" },
    });
    await db.source.create({
      data: { id: SOURCE, orgId: ORG, type: "github", externalId: "acme/api", name: "acme/api", scopePath: CREW },
    });

    // The authorizing rows: the person who connected the source, and the agent's own write.
    await db.auditLog.create({
      data: {
        id: CONNECT_ROW,
        orgId: ORG,
        actorType: "human",
        actorId: ADMIN,
        action: "memory.write",
        target: `${CREW}/sources:connect:${SOURCE}`,
        decision: "allow",
        at: at(-30),
      },
    });
    await db.auditLog.create({
      data: {
        id: AGENT_WRITE_ROW,
        orgId: ORG,
        actorType: "agent",
        actorId: "alpha",
        action: "memory.write",
        target: CREW,
        decision: "allow",
        at: at(9),
      },
    });

    let seq = 0;
    const change = (id: string, actorId: string, recordId: string, seconds: number, authorizedById: string) =>
      db.changeEvent.create({
        data: {
          id,
          orgId: ORG,
          seq: ++seq,
          scopePath: CREW,
          recordType: "fact",
          recordId,
          op: "create",
          actorId,
          summary: `text of ${recordId}`,
          authorizedById,
          createdAt: at(seconds),
        },
      });
    await change(SYNC_WRITE, SYNC_ACTOR, `fact-2-${RUN}`, 0, CONNECT_ROW);
    await change(AGENT_WRITE, "alpha", `fact-9-${RUN}`, 10, AGENT_WRITE_ROW);

    // fact-2 replaced fact-1 and was replaced by fact-3.
    const edge = (fromId: string, toId: string) =>
      db.factEdge.create({
        data: { orgId: ORG, fromId, toId, kind: "supersedes", scopePath: CREW, actorType: "agent", actorId: "alpha" },
      });
    await edge(`fact-2-${RUN}`, `fact-1-${RUN}`);
    await edge(`fact-3-${RUN}`, `fact-2-${RUN}`);

    const read = (actorId: string, target: string, seconds: number, decision: "allow" | "deny" = "allow") =>
      db.auditLog.create({
        data: { orgId: ORG, actorType: "agent", actorId, action: "memory.read", target, decision, at: at(seconds) },
      });
    await read("early", CREW, -5); // before either write: reads neither
    await read("beta", `${CREW}/query:pricing`, 6);
    await read("beta", CREW, 7); // beta's second read: not a first sight
    await read("gamma", ROOT, 13); // an ancestor scope covers this one
    await read("delta", CREW, 14, "deny");
    await read("outsider", SIBLING, 15); // a wildcard sibling covers nothing here

    adminSession = {
      org: await db.org.findUnique({ where: { id: ORG } }),
      user: admin,
      ctx: { orgId: ORG, actor: { type: "human", id: ADMIN, role: "admin" } },
    };
    requireAccessContext.mockResolvedValue(adminSession);
  });

  afterAll(async () => {
    if (!db) return;
    await wipe();
    await db.$disconnect();
  });

  const params = (changeId: string) => ({ params: Promise.resolve({ changeId }) });

  /**
   * Where the API's answers are read from: the Timeline's scope and window, and who
   * connected each source. GET /api/audit names a connect row's actor but not its id, so
   * that one id comes from the history itself.
   */
  interface ApiView {
    scope: string;
    from: Date;
    to: Date;
    connectedBy: Record<string, string>;
  }
  const crewView: ApiView = { scope: CREW, from: at(-60), to: at(120), connectedBy: { [CONNECT_ROW]: ADMIN } };

  type Timeline = {
    lanes: { key: string; actorType: string; actorId: string; name: string }[];
    writes: { id: string; laneKey: string }[];
    sightings: { writeId: string; readId: string; laneKey: string }[];
  };
  async function timelineOf(view: ApiView): Promise<Timeline> {
    const query = `scope=${view.scope}&from=${view.from.toISOString()}&to=${view.to.toISOString()}`;
    return (await (await TIMELINE(new Request(`http://t/api/audit/timeline?${query}`))).json()).timeline;
  }

  /** Code-point order, the order the validator sorts in. */
  const byCodePoint = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

  /** The four answers, read from the API's existing endpoints only. */
  async function apiAnswers(changeId: string, view: ApiView = crewView, timelineRead?: Timeline) {
    const timeline = timelineRead ?? (await timelineOf(view));
    const detail = await (await DETAIL(new Request(`http://t/x?scope=${view.scope}`), params(changeId))).json();
    const row =
      detail.authorizationKind === "connect"
        ? (await (await AUDIT(new Request(`http://t/api/audit?ids=${detail.authorizedById}`))).json()).entries[0]
        : null;
    const lane = (key: string) => timeline.lanes.find((l) => l.key === key)!;
    const asActor = (key: string) => {
      const l = lane(key);
      return { actorType: l.actorType, actorId: l.actorId, name: l.name };
    };
    const writeLane = timeline.writes.find((w) => w.id === changeId)!.laneKey;
    return {
      recordId: detail.recordId,
      changeId,
      author: {
        writer: { ...asActor(writeLane), name: detail.writer },
        authorizedById: detail.authorizedById,
        authorizationKind: detail.authorizationKind,
        authority: row
          ? { actorType: row.actorType, actorId: view.connectedBy[detail.authorizedById], name: row.actorName }
          : null,
      },
      source: detail.source,
      readers: timeline.sightings
        .filter((s) => s.writeId === changeId)
        .map((s) => ({ readId: s.readId, reader: asActor(s.laneKey) }))
        .sort((a, b) => byCodePoint(a.readId, b.readId)),
      replaced: { replacesIds: [...detail.replacesIds].sort(byCodePoint), replacedById: detail.replacedById },
    };
  }

  /** The route's document for one change; fails the test on anything but a 200. */
  async function exportProv(changeId: string, scope = CREW) {
    const res = await PROV(new Request(`http://t/x?scope=${scope}`), params(changeId));
    expect(res.status, `export of change ${changeId}`).toBe(200);
    return res.json();
  }

  /** The four answers the validator reads back out of `doc`; fails the test if it refuses it. */
  function validated(doc: unknown) {
    const result = validateProv(doc);
    if (!result.ok) throw new Error(`PROV validator refused the document: ${result.error}`);
    return result.answers;
  }

  const provAnswers = async (changeId: string) => validated(await exportProv(changeId));

  it("a connector sync's write: valid PROV, same writer, authority, source, readers and versions", async () => {
    const api = await apiAnswers(SYNC_WRITE);
    // The fixture has something in every answer, so an empty one cannot pass by agreement.
    expect(api.author.authority).toMatchObject({ actorId: ADMIN, name: "Ada Admin" });
    expect(api.source).toEqual({ id: SOURCE, name: "acme/api", type: "github" });
    expect(api.readers.map((r: { reader: { actorId: string } }) => r.reader.actorId).sort()).toEqual(["beta", "gamma"]);
    expect(api.replaced).toEqual({ replacesIds: [`fact-1-${RUN}`], replacedById: `fact-3-${RUN}` });
    expect(await provAnswers(SYNC_WRITE)).toEqual(api);
  });

  it("an agent's direct write: valid PROV, no delegation, no source, only later readers", async () => {
    const api = await apiAnswers(AGENT_WRITE);
    expect(api.author).toMatchObject({ authorizationKind: "direct", authority: null });
    // beta read only before this write, so only gamma's ancestor read sees it.
    expect(api.readers.map((r: { reader: { actorId: string } }) => r.reader.actorId)).toEqual(["gamma"]);
    expect(await provAnswers(AGENT_WRITE)).toEqual(api);
  });

  it("audits the export as a read and 404s a change outside the scope", async () => {
    const before = await db.auditLog.count({ where: { orgId: ORG, actorId: ADMIN, action: "memory.read" } });
    await PROV(new Request(`http://t/x?scope=${CREW}`), params(SYNC_WRITE));
    expect(await db.auditLog.count({ where: { orgId: ORG, actorId: ADMIN, action: "memory.read" } })).toBe(before + 1);
    const outside = await PROV(new Request(`http://t/x?scope=${SIBLING}`), params(SYNC_WRITE));
    expect(outside.status).toBe(404);
  });

  // The export answers more than the detail route (readers and the authority), so it must
  // never be reachable by anyone the detail route refuses. Each refusal is compared with the
  // detail route's own: same status, same body.
  it("refuses exactly whom the detail route refuses, with the same status and body", async () => {
    const member = await db.user.findUniqueOrThrow({ where: { id: MEMBER } });
    const memberSession = {
      org: await db.org.findUnique({ where: { id: ORG } }),
      user: member,
      ctx: { orgId: ORG, actor: { type: "human", id: MEMBER, role: "member" } },
    };
    const cases: [string, unknown, string, string, number][] = [
      ["no session", null, `scope=${CREW}`, SYNC_WRITE, 401],
      ["a member who reads every scope but cannot manage access", memberSession, `scope=${CREW}`, SYNC_WRITE, 403],
      ["a scope in another org", adminSession, "scope=org_someone_else", SYNC_WRITE, 400],
      ["a change id that does not exist", adminSession, `scope=${CREW}`, randomUUID(), 404],
      ["a sibling scope", adminSession, `scope=${SIBLING}`, SYNC_WRITE, 404],
    ];
    try {
      for (const [label, session, query, changeId, status] of cases) {
        requireAccessContext.mockResolvedValue(session);
        const prov = await PROV(new Request(`http://t/x?${query}`), params(changeId));
        const detail = await DETAIL(new Request(`http://t/x?${query}`), params(changeId));
        expect([label, prov.status]).toEqual([label, status]);
        expect([label, await prov.text()]).toEqual([label, await detail.text()]);
        expect(detail.status).toBe(status);
      }
    } finally {
      requireAccessContext.mockResolvedValue(adminSession);
    }
  });

  /**
   * Two weeks of a small team's work, compressed into six rounds and written through the
   * product's own producers. Returns the admin's session, who connected each source, and
   * every piece of fact text written, so a test can prove none of it reaches an export.
   */
  async function recordTeamHistory() {
    const access = await import("@/services/access");
    const { recordIngestApplied } = await import("@/services/memory/fact-change-event");
    const { recordSourceItemChange } = await import("@/services/memory/content-change-event");

    await db.org.create({ data: { id: TEAM, name: "Team history" } });
    const scopeIds: Record<string, string> = {};
    for (const path of [TEAM_ROOT, ENG, API, WEB, SALES, EMEA, OPS]) {
      scopeIds[path] = (await db.scope.create({ data: { orgId: TEAM, path, name: path.split(".").pop()! } })).id;
    }
    const person = async (
      id: string,
      name: string,
      role: "admin" | "member",
      scope: string,
      permission: "admin" | "write" | "read",
    ) => {
      const user = await db.user.create({
        data: { id, orgId: TEAM, email: `${id}@t.test`, role, clerkId: `clerk-${id}`, name },
      });
      await db.grant.create({
        data: { orgId: TEAM, scopeId: scopeIds[scope], granteeType: "user", granteeId: id, permission },
      });
      return { user, ctx: { orgId: TEAM, actor: { type: "human", id, role }, origin: "app" } as AccessContext };
    };
    const lead = await person(LEAD, "Ada Okafor", "admin", TEAM_ROOT, "admin");
    const seller = (await person(SELLER, "Ümit Çelik", "member", SALES, "write")).ctx;
    const engineer = (await person(ENGINEER, "Priya Raman", "member", ENG, "read")).ctx;

    /** An agent holding one token; `name` null is an MCP client with no Agent row. */
    const agent = async (
      key: string,
      name: string | null,
      scope: string,
      permission: "read" | "write",
      expiresInMs = 86_400_000,
    ): Promise<AccessContext> => {
      if (name) await db.agent.create({ data: { orgId: TEAM, agentKey: key, name, role: "custom" } });
      const token = access.generateCapabilityToken();
      await db.capability.create({
        data: {
          orgId: TEAM,
          agentId: key,
          tokenHash: access.hashCapabilityToken(token),
          scopePath: scope,
          permission,
          grantGoverned: false,
          expiresAt: new Date(Date.now() + expiresInMs),
          createdBy: LEAD,
        },
      });
      return { orgId: TEAM, actor: { type: "agent", id: key, capabilityToken: token }, origin: "mcp" };
    };
    const planner = await agent(`planner-${RUN}`, "Sprint planner", ENG, "write");
    const coder = await agent(`coder-${RUN}`, "Codex 東京", API, "write");
    const reviewer = await agent(`reviewer-${RUN}`, "Reviewer", ENG, "read");
    const researcher = await agent(`researcher-${RUN}`, null, SALES, "write");
    const opsBot = await agent(`ops-${RUN}`, "Ops bot", OPS, "read");
    const reviewerExpired = await agent(`reviewer-old-${RUN}`, null, ENG, "read", -60_000);

    const contents: string[] = [];
    let noteNumber = 0;
    /** A write as memory_ingest makes it: check(), the store row, then the announcement. */
    const write = async (ctx: AccessContext, scope: string, entityName = `note ${++noteNumber}`) => {
      const content = `${entityName} from ${ctx.actor.id}: naïve café ✓ ${randomUUID()}`;
      contents.push(content);
      const decision = await access.check(ctx, { action: "memory.write", scope });
      if (!decision.allowed) return;
      const versionId = randomUUID();
      await db.$executeRaw`
        INSERT INTO "memory_chunks" ("id","orgId","content","source","actorType","actorId","entityName","scopePath","createdAt")
        VALUES (${versionId}, ${TEAM}, ${content}, ${ctx.origin}, ${ctx.actor.type}, ${ctx.actor.id}, ${entityName}, ${scope}, ${new Date()})
      `;
      await recordIngestApplied(
        {
          groupId: TEAM,
          content,
          name: entityName,
          actorType: ctx.actor.type,
          actorId: ctx.actor.id,
          origin: ctx.origin,
          scopePath: scope,
          authorizedById: decision.auditLogId,
        },
        versionId,
      );
    };
    const read = (ctx: AccessContext, scope: string, query?: string) =>
      access.check(ctx, { action: "memory.read", scope, ...(query ? { target: `query:${query}` } : {}) });

    /** A source connect as POST /api/sources authorizes it; returns the connected source. */
    const connect = async (ctx: AccessContext, type: "github" | "gdrive", name: string, scope: string) => {
      const decision = await access.check(ctx, { action: "memory.write", scope, target: "sources:connect" });
      if (!decision.allowed) return null;
      return db.source.create({
        data: {
          orgId: TEAM,
          type,
          externalId: name,
          name,
          scopePath: scope,
          connectAuthorizationId: decision.auditLogId,
        },
      });
    };
    const repo = (await connect(lead.ctx, "github", "acme/api", API))!;
    const folder = (await connect(seller, "gdrive", "Verträge EMEA", EMEA))!;
    expect(await connect(engineer, "github", "acme/web", WEB)).toBeNull();

    /** One item a sync recorded; returns its episode id. */
    const syncItem = async (source: typeof repo, op: "create" | "supersede", episodeId: string = randomUUID()) => {
      const title = `${source.name} item ${randomUUID()}`;
      if (op === "create") contents.push(title);
      await db.$transaction((tx) =>
        recordSourceItemChange(tx, {
          orgId: TEAM,
          scopePath: source.scopePath,
          episodeId,
          actorId: `${source.type}-sync:${source.id}`,
          authorizedById: source.connectAuthorizationId,
          ...(op === "create" ? { op, title } : { op }),
        }),
      );
      return episodeId;
    };

    let firstRepoItem = "";
    for (let round = 0; round < 6; round++) {
      await write(coder, API);
      await write(coder, API);
      const item = await syncItem(repo, "create");
      firstRepoItem ||= item;
      await syncItem(repo, "create");
      await write(planner, ENG);
      await write(researcher, EMEA);
      await write(researcher, SALES);
      await syncItem(folder, "create");
      if (round % 2 === 1) await write(seller, SALES);

      // Refusals: writes and reads outside each token's or grant's reach.
      await write(researcher, API);
      await write(reviewer, ENG);
      await read(opsBot, SALES, "pipeline");
      await read(coder, WEB);
      await read(engineer, SALES);
      await read(reviewerExpired, ENG);

      // Ordinary reads, some of a scope above the one written to.
      await read(reviewer, ENG, "what changed");
      await read(coder, API);
      await read(planner, ENG);
      if (round % 2 === 0) await read(planner, API, "release");
      await read(researcher, SALES);
      await read(opsBot, OPS);
      await read(engineer, ENG);
      await read(lead.ctx, TEAM_ROOT);

      // Concurrent writers: the same fact written by three writers inside the contention
      // window, then by an agent and a person; the first stored version wins each.
      if (round === 2) {
        await write(coder, API, "Release date");
        await write(planner, API, "Release date");
        await write(lead.ctx, API, "Release date");
      }
      if (round === 4) {
        await write(researcher, SALES, "Q4 quota");
        await write(seller, SALES, "Q4 quota");
      }
      // An upstream edit: the sync replaces an item it recorded in the first round.
      if (round === 3) {
        await syncItem(repo, "supersede", firstRepoItem);
        await syncItem(repo, "create");
      }
    }

    const org = await db.org.findUniqueOrThrow({ where: { id: TEAM } });
    return {
      adminSession: { org, user: lead.user, ctx: lead.ctx },
      connectedBy: { [repo.connectAuthorizationId!]: LEAD, [folder.connectAuthorizationId!]: SELLER },
      contents,
    };
  }

  // The claim at the volume and shape it is made for: not one hand-picked change, but every
  // change in a team's history, each exported through the route, validated, and compared
  // with what the API answers about it.
  it("every change in a team's history exports as valid PROV that answers what the API answers", async () => {
    const startedAt = new Date(Date.now() - 60_000);
    const history = await recordTeamHistory();
    requireAccessContext.mockResolvedValue(history.adminSession);
    try {
      const view: ApiView = {
        scope: TEAM_ROOT,
        from: startedAt,
        to: new Date(Date.now() + 60_000),
        connectedBy: history.connectedBy,
      };
      const timeline = await timelineOf(view);
      const changes = await db.changeEvent.findMany({
        where: { orgId: TEAM },
        orderBy: { seq: "asc" },
        select: { id: true },
      });
      const exported: { text: string; answers: Awaited<ReturnType<typeof apiAnswers>> }[] = [];
      for (const { id } of changes) {
        const doc = await exportProv(id, TEAM_ROOT);
        expect(doc.prefix, `namespace of change ${id}`).toEqual({ willder: NAMESPACE });
        const answers = await apiAnswers(id, view, timeline);
        expect(validated(doc), `change ${id}`).toEqual(answers);
        exported.push({ text: JSON.stringify(doc), answers });
      }

      // The history has every shape the export must carry, so no answer passes by being
      // empty on both sides: people, agents and both syncs as writers; both people who
      // connected a source as authorities; a winner that replaced two versions and the
      // versions it replaced; changes nobody read and changes several agents read.
      expect(exported.length).toBeGreaterThanOrEqual(60);
      const writerTypes = new Set(exported.map((e) => e.answers.author.writer.actorType));
      expect([...writerTypes].sort()).toEqual(["agent", "extraction", "human"]);
      const authorities = new Set(exported.map((e) => e.answers.author.authority?.actorId).filter(Boolean));
      expect([...authorities].sort()).toEqual([LEAD, SELLER].sort());
      const sources = new Set(exported.map((e) => e.answers.source?.name).filter(Boolean));
      expect([...sources].sort()).toEqual(["Verträge EMEA", "acme/api"]);
      expect(exported.some((e) => e.answers.replaced.replacesIds.length === 2)).toBe(true);
      expect(exported.filter((e) => e.answers.replaced.replacedById !== null).length).toBeGreaterThanOrEqual(3);
      expect(exported.some((e) => e.answers.readers.length === 0)).toBe(true);
      expect(exported.some((e) => e.answers.readers.length >= 3)).toBe(true);

      // A refusal is never a read: no denied row is anyone's reader, though the history
      // holds refused writes, reads and a refused connect.
      const denied = new Set(
        (await db.auditLog.findMany({ where: { orgId: TEAM, decision: "deny" }, select: { id: true } })).map(
          (r) => r.id,
        ),
      );
      expect(denied.size).toBeGreaterThanOrEqual(30);
      const readIds = exported.flatMap((e) => e.answers.readers.map((r: { readId: string }) => r.readId));
      expect(readIds.filter((id) => denied.has(id))).toEqual([]);

      // Ids, names, scopes and times only: no fact or item text reaches any document.
      for (const content of history.contents) {
        expect(exported.filter((e) => e.text.includes(content)).length, content).toBe(0);
      }
    } finally {
      requireAccessContext.mockResolvedValue(adminSession);
    }
  }, 120_000);
});
