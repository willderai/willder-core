import { beforeEach, describe, expect, it, vi } from "vitest";

// Every contact route asks check() before it reads or writes Contact rows.
//
// requireAccessContext() alone is not enough:
// Tenant scoping keeps one org out of another's data; it does not decide whether
// THIS member may read THIS org's contacts, so any member could read any
// contact's name, title, email and account by id, create contacts, or read the
// org's contact volume off the nav badge.
//
// This is the half that runs everywhere, including CI, where no database is
// provisioned. It pins the wiring: that each handler asks check() at all, that
// it asks with the permission the handler intends, and — the part that matters —
// that a denial reaches no Contact query, so a refused caller cannot tell a real
// contact id from an invented one. contact-read-gate-live-sql.test.ts
// is the companion that proves, against real grants and real ltree, who that
// check() actually admits and refuses.
//
// Together they are the guard-removal differential: delete a gate and the denial
// case below fails here with no database, while the live-SQL file shows what the
// missing gate would hand a real unauthorized caller.

vi.mock("@/lib/access-context", () => ({ requireAccessContext: vi.fn() }));
vi.mock("@/services/access", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/access")>();
  return { ...actual, check: vi.fn() };
});
vi.mock("@/lib/db", () => ({
  db: {
    agent: { findFirst: vi.fn() },
    agentRun: { create: vi.fn(), update: vi.fn(), count: vi.fn() },
    contact: { findFirst: vi.fn(), findMany: vi.fn(), create: vi.fn(), count: vi.fn() },
    account: { findFirst: vi.fn(), create: vi.fn(), update: vi.fn() },
    memoryChunk: { count: vi.fn() },
    // The badge's scoped counts: readableScopePaths() reads grants, and the two
    // scope-filtered counts are raw SQL (services/agents/run-visibility.ts).
    grant: { findMany: vi.fn() },
    $queryRaw: vi.fn(),
  },
}));
vi.mock("@/lib/copy-agent", () => ({ provisionCopyAgentCapability: vi.fn() }));
vi.mock("@/services/agents/runner", () => ({ runCopyAgent: vi.fn() }));
vi.mock("@/services/memory", () => ({ memory: { ingest: vi.fn(async () => undefined) } }));
vi.mock("@/lib/inngest", () => ({ ingestMemory: vi.fn() }));

import { requireAccessContext } from "@/lib/access-context";
import { check } from "@/services/access";
import { db } from "@/lib/db";
import { ingestMemory } from "@/lib/inngest";

import { POST as agentRunPOST } from "./agents/[id]/run/route";
import { GET as contactsGET, POST as contactsPOST } from "./contacts/route";
import { POST as fromResearchPOST } from "./contacts/from-research/route";
import { GET as badgesGET } from "./nav/badges/route";

const ORG = "org_1";
const rc = {
  org: { id: ORG, name: "Acme" },
  user: { id: "user_42", role: "member" },
  ctx: { orgId: ORG, actor: { type: "human", id: "user_42", role: "member" } },
};

const allow = () => vi.mocked(check).mockResolvedValue({ allowed: true, reason: "ok" } as never);
const deny = (reason = "no grant") => vi.mocked(check).mockResolvedValue({ allowed: false, reason } as never);

const post = (body: unknown, url = "http://t") =>
  new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
const params = <T extends Record<string, string>>(p: T) => ({ params: Promise.resolve(p) });

/** The SSE routes do their real work inside the stream's start(), so a denial
 *  must be visible on the response itself — draining proves the body is empty
 *  of contact data either way. */
const drain = async (res: Response) => {
  if (!res.body) return "";
  return new Response(res.body).text();
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireAccessContext).mockResolvedValue(rc as never);
  vi.mocked(db.agent.findFirst).mockResolvedValue({ id: "agent_1", role: "research", settings: {} } as never);
  vi.mocked(db.agentRun.create).mockResolvedValue({ id: "run_1" } as never);
  vi.mocked(db.contact.findFirst).mockResolvedValue({
    id: "contact_1",
    name: "Jane Doe",
    title: "VP Eng",
    email: "jane@acme.com",
    account: { name: "Acme", domain: "acme.com" },
  } as never);
  vi.mocked(db.contact.findMany).mockResolvedValue([] as never);
  vi.mocked(db.contact.create).mockResolvedValue({ id: "contact_new" } as never);
  vi.mocked(db.contact.count).mockResolvedValue(7 as never);
  vi.mocked(db.account.findFirst).mockResolvedValue(null as never);
  vi.mocked(db.account.create).mockResolvedValue({ id: "acct_1" } as never);
  vi.mocked(db.account.update).mockResolvedValue({ id: "acct_1" } as never);
  vi.mocked(db.agentRun.count).mockResolvedValue(0 as never);
  vi.mocked(db.memoryChunk.count).mockResolvedValue(0 as never);
  vi.mocked(db.grant.findMany).mockResolvedValue([] as never);
  vi.mocked(db.$queryRaw).mockResolvedValue([{ n: 0 }] as never);
});

describe("POST /api/agents/:id/run — the contact PII leak review ranked first", () => {
  const run = () => agentRunPOST(post({ contactId: "contact_1" }), params({ id: "agent_1" }));

  it("asks check() for memory.read on this agent run before reading the contact", async () => {
    allow();
    await drain(await run());
    expect(check).toHaveBeenCalledWith(rc.ctx, { action: "memory.read", target: "agent:run:agent_1" });
  });

  it("403s on a denial and never reads the contact, so the id's existence stays hidden", async () => {
    deny("no read grant for user_42");
    const res = await run();
    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toEqual({ error: "no read grant for user_42" });
    expect(db.contact.findFirst).not.toHaveBeenCalled();
    expect(db.agentRun.create).not.toHaveBeenCalled();
  });
});

describe("/api/contacts", () => {
  it("GET asks check() for memory.read on the contact list", async () => {
    allow();
    await contactsGET(new Request("http://t/api/contacts"));
    expect(check).toHaveBeenCalledWith(rc.ctx, { action: "memory.read", target: "contacts:list" });
  });

  it("GET 403s on a denial and returns no contacts at all", async () => {
    deny("no read grant");
    const res = await contactsGET(new Request("http://t/api/contacts"));
    expect(res.status).toBe(403);
    await expect(res.json()).resolves.not.toHaveProperty("contacts");
    expect(db.contact.findMany).not.toHaveBeenCalled();
  });

  // POST also writes Contact
  // rows behind requireAccessContext() alone, which is the same defect and the
  // same criterion ("no route reachable without check() can read or write
  // Contact rows"). Gating GET while leaving POST open would have left the file
  // half-closed.
  it("POST asks check() for memory.write before creating a contact", async () => {
    allow();
    await contactsPOST(post({ name: "New Person" }));
    expect(check).toHaveBeenCalledWith(rc.ctx, { action: "memory.write", target: "contacts:create" });
  });

  it("POST 403s on a denial and writes nothing", async () => {
    deny();
    const res = await contactsPOST(post({ name: "New Person" }));
    expect(res.status).toBe(403);
    expect(db.contact.create).not.toHaveBeenCalled();
  });
});

describe("POST /api/contacts/from-research", () => {
  const body = { contact: { name: "Jane Doe" }, account: { name: "Acme" }, findings: ["ships weekly"] };

  it("asks check() for memory.write before persisting research output", async () => {
    allow();
    await fromResearchPOST(post(body));
    expect(check).toHaveBeenCalledWith(rc.ctx, {
      action: "memory.write",
      target: "contacts:from-research",
    });
  });

  // A NUL in a finding made ingestMemory throw after the account and contact rows were
  // written: a 500 naming nothing, and a half-saved import. Refused before any write.
  it.each([
    ["findings[1]", { ...body, findings: ["ships weekly", "hiring\u0000 SREs"] }],
    ["contact.name", { ...body, contact: { name: "Jane\u0000 Doe" } }],
    ["account.description", { ...body, account: { name: "Acme", description: "B2B\u0000 payments" } }],
  ])("400 naming the fix when %s holds a NUL, and nothing is written", async (field, nulBody) => {
    allow();
    const res = await fromResearchPOST(post(nulBody));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe(
      `${field} contains a NUL (\\u0000) character, which cannot be stored. Remove it and retry.`,
    );
    expect(db.account.create).not.toHaveBeenCalled();
    expect(db.contact.create).not.toHaveBeenCalled();
    expect(ingestMemory).not.toHaveBeenCalled();
  });

  it("403s on a denial and creates neither the contact nor the account", async () => {
    deny();
    const res = await fromResearchPOST(post(body));
    expect(res.status).toBe(403);
    expect(db.contact.create).not.toHaveBeenCalled();
    expect(db.account.create).not.toHaveBeenCalled();
  });
});

describe("GET /api/nav/badges — the contact volume leak", () => {
  const badges = (qs = "?since=2026-09-01T00:00:00.000Z") => badgesGET(new Request(`http://t/api/nav/badges${qs}`));

  it("asks check() for memory.read before counting contacts", async () => {
    allow();
    await badges();
    expect(check).toHaveBeenCalledWith(rc.ctx, { action: "memory.read", target: "nav:badges:contacts" });
  });

  it("reports the real count to a caller the gate admits", async () => {
    allow();
    await expect((await badges()).json()).resolves.toMatchObject({ newContacts: 7 });
  });

  // A denial reports 0 rather than 403: the other badges are not contact
  // data. 0 is indistinguishable from a quiet period, which is the point — the
  // refused caller learns nothing about how many contacts the org has.
  it("reports 0 to a refused caller and never runs the count", async () => {
    deny();
    const res = await badges();
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ newContacts: 0 });
    expect(db.contact.count).not.toHaveBeenCalled();
  });

  // The badge is polled every 30s per signed-in user and check() writes one
  // audit row per call, so the gate is asked only when the count would really
  // run. Without a `since` cursor the route returns 0 without touching Contact.
  it("asks nothing at all when there is no `since` cursor, since no contact is read", async () => {
    allow();
    await badges("");
    expect(check).not.toHaveBeenCalled();
    expect(db.contact.count).not.toHaveBeenCalled();
  });
});
