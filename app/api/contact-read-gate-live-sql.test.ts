import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import { seedMember } from "@/services/access/member.testsupport";

// The contact routes' check() gate against real Postgres grants.
//
// Why this file exists: contact-read-gate.test.ts pins that each handler asks
// check() and refuses on a denial, but its check() is a mock, so it can only
// show what the fixture is told to return. It cannot show WHO that question
// actually admits. check()'s answer comes from a real
// `granted_path::ltree @> target::ltree` containment query against real grant
// rows, so only real grants, real ltree and the real check() can prove that an
// org-wide writer is genuinely let in and that a read-only member, a scope
// admin, a member with no grant and a caller from another tenant are genuinely
// refused — the cross-tenant and lower-privilege-same-tenant legs this item
// was opened to close.
//
// Every gate here asks about the org root: check() with no `scope` defaults
// there (services/access/check.ts), and grants match ancestor-or-self, so the
// org root is the STRICTEST question available — a grant on a child scope is
// not an ancestor of the root and does not pass. That is deliberate for
// handlers that read or write any contact in the org regardless of scope, and
// the cases below lock it in rather than assume it. Contact has no scopePath
// column to ask a narrower question about.
//
// Set QA_DATABASE_URL to an ISOLATED test database. It is assigned to
// DATABASE_URL below because lib/db.ts reads that at import time -- never point
// this at the sandbox's inherited DATABASE_URL, which is live Neon (item
// routine-sandbox-prod-db-url). Skips cleanly when unset.
const QA_URL = process.env.QA_DATABASE_URL;
if (QA_URL) process.env.DATABASE_URL = QA_URL;

vi.mock("@/lib/access-context", () => ({ requireAccessContext: vi.fn() }));
vi.mock("@/lib/copy-agent", () => ({ provisionCopyAgentCapability: vi.fn() }));
vi.mock("@/services/agents/runner", () => ({
  runCopyAgent: vi.fn(async () => ({ subject: "s", body: "b" })),
}));
vi.mock("@/services/memory", () => ({ memory: { ingest: vi.fn(async () => undefined) } }));
vi.mock("@/lib/inngest", () => ({ ingestMemory: vi.fn(async () => undefined) }));

const ORG = "orgContactGate";
const OTHER_ORG = "orgContactGateOther";
const ROOT = `org_${ORG}`;
const SCOPE_A = `${ROOT}.team_a`;
const OTHER_ROOT = `org_${OTHER_ORG}`;

const AGENT = "agentContactGate";
const CONTACT = "contactContactGate";

describe.skipIf(!QA_URL)("contacts-check-gate-remaining-routes-20260922: real SQL, real Postgres", () => {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  let db: any, requireAccessContext: any;
  let agentRunPOST: any;
  let contactsGET: any, contactsPOST: any, fromResearchPOST: any;
  let badgesGET: any;

  /** A human actor with no org-wide role, so every decision comes from grants. */
  const as = (userId: string, orgId = ORG) => {
    vi.mocked(requireAccessContext).mockResolvedValue({
      org: { id: orgId, name: orgId },
      user: { id: userId, role: "member" },
      ctx: { orgId, actor: { type: "human", id: userId, role: "member" } },
    } as never);
  };

  /** Grant `userId`, a member of `orgId`, `permission` on a scope. */
  const grant = async (id: string, scopeId: string, userId: string, permission: string, orgId = ORG) => {
    await seedMember(db, { orgId, userId });
    return db.$executeRawUnsafe(
      `INSERT INTO "grants" ("id","orgId","scopeId","granteeType","granteeId","permission")
       VALUES ($1,$2,$3,'user',$4,$5)`,
      id,
      orgId,
      scopeId,
      userId,
      permission,
    );
  };

  const json = (body: unknown, method = "POST") =>
    new Request("http://t", { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const params = <T extends Record<string, string>>(p: T) => ({ params: Promise.resolve(p) });
  const drain = async (res: Response) => (res.body ? new Response(res.body).text() : "");

  /**
   * Every gated entry point, as `() => Promise<Response>`, so each case can run
   * the whole set against one actor instead of repeating six call shapes. The
   * badge is not here: it answers 200 with a zeroed count rather than 403, and
   * has its own cases at the bottom.
   */
  const CALLS: Record<string, () => Promise<Response>> = {
    "agents/:id/run": () => agentRunPOST(json({ contactId: CONTACT }), params({ id: AGENT })),
    "contacts GET": () => contactsGET(new Request("http://t/api/contacts")),
    "contacts POST": () => contactsPOST(json({ name: "New Person" })),
    "contacts/from-research": () => fromResearchPOST(json({ contact: { name: "Jane" }, findings: [] })),
  };

  /** The read-only entry points: a `read` grant is enough for these. */
  const READ_CALLS = ["agents/:id/run", "contacts GET"];
  const WRITE_CALLS = Object.keys(CALLS).filter((k) => !READ_CALLS.includes(k));

  beforeAll(async () => {
    ({ db } = await import("@/lib/db"));
    ({ requireAccessContext } = await import("@/lib/access-context"));
    ({ POST: agentRunPOST } = await import("./agents/[id]/run/route"));
    ({ GET: contactsGET, POST: contactsPOST } = await import("./contacts/route"));
    ({ POST: fromResearchPOST } = await import("./contacts/from-research/route"));
    ({ GET: badgesGET } = await import("./nav/badges/route"));

    for (const org of [ORG, OTHER_ORG]) {
      await db.$executeRawUnsafe(
        `INSERT INTO "orgs" ("id","name","updatedAt") VALUES ($1,$2,NOW())
         ON CONFLICT ("id") DO NOTHING`,
        org,
        org,
      );
    }
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    for (const table of ["audit_log", "grants", "agent_runs", "agents", "contacts", "scopes"]) {
      await db.$executeRawUnsafe(`DELETE FROM "${table}" WHERE "orgId" = ANY($1)`, [ORG, OTHER_ORG]);
    }

    const scopes: [string, string, string][] = [
      ["sc_cg_root", ORG, ROOT],
      ["sc_cg_a", ORG, SCOPE_A],
      ["sc_cg_other_root", OTHER_ORG, OTHER_ROOT],
    ];
    for (const [id, orgId, path] of scopes) {
      await db.$executeRawUnsafe(
        `INSERT INTO "scopes" ("id","orgId","path","name") VALUES ($1,$2,$3,$4)`,
        id,
        orgId,
        path,
        id,
      );
    }

    await db.$executeRawUnsafe(
      `INSERT INTO "agents" ("id","orgId","agentKey","name","role","updatedAt")
       VALUES ($1,$2,'research-agent','Research','research',NOW())`,
      AGENT,
      ORG,
    );
    await db.$executeRawUnsafe(
      `INSERT INTO "contacts" ("id","orgId","name","title","email","updatedAt")
       VALUES ($1,$2,'Jane Doe','VP Eng','jane@acme.com',NOW())`,
      CONTACT,
      ORG,
    );
  });

  afterAll(async () => {
    await db?.$disconnect?.();
  });

  /** Run one entry point as `userId` and report its status. */
  const statusOf = async (name: string, userId: string, orgId = ORG) => {
    as(userId, orgId);
    const res = await CALLS[name]();
    await drain(res);
    return res.status;
  };

  describe("callers the gate must refuse", () => {
    // Each of these is a 403 only because the gate is there. Delete the check()
    // and its 403 from a handler and that handler answers normally -- which is
    // exactly the exposure this file measures: the contact's name, title, email
    // and account, or the org's whole contact list, to a caller with no grant.

    it.each(Object.keys(CALLS))("refuses %s for a member with no grant at all", async (name) => {
      expect(await statusOf(name, "user_nobody")).toBe(403);
    });

    // The lower-privilege-same-tenant leg. This user is a real member of this
    // org and really does hold a grant -- one level down the scope tree. It is
    // not an ancestor of the org root, so it buys nothing at these entry points.
    it.each(Object.keys(CALLS))("refuses %s for an admin of a child scope only", async (name) => {
      await grant("g_cg_scope_admin", "sc_cg_a", "user_a_admin", "admin");
      expect(await statusOf(name, "user_a_admin")).toBe(403);
    });

    // The other lower-privilege leg: a real org-root grant, but only `read`,
    // against the handlers that change Contact rows or enrolment.
    it.each(WRITE_CALLS)("refuses %s for a member granted only read at the org root", async (name) => {
      await grant("g_cg_reader", "sc_cg_root", "user_reader", "read");
      expect(await statusOf(name, "user_reader")).toBe(403);
    });

    // The cross-tenant leg. This user really does hold an org-root admin grant
    // -- in their OWN org. Grants are org-scoped, so it buys them nothing here,
    // and without the gate they would reach the other tenant's contacts.
    it.each(Object.keys(CALLS))("refuses %s for a caller whose only grant is in a different org", async (name) => {
      await grant("g_cg_foreign", "sc_cg_root", "user_foreign", "admin");
      expect(await statusOf(name, "user_foreign", OTHER_ORG)).toBe(403);
    });
  });

  describe("callers the gate must admit", () => {
    // Asserting real success, not merely "not 403": a handler that 500s past
    // the gate would satisfy a not-403 assertion while proving nothing.
    const OK = [200, 201];

    it.each(READ_CALLS)("admits %s for a member the org root grants read to", async (name) => {
      await grant("g_cg_root_reader", "sc_cg_root", "user_root_reader", "read");
      expect(OK).toContain(await statusOf(name, "user_root_reader"));
    });

    it.each(Object.keys(CALLS))("admits %s for a member the org root grants admin to", async (name) => {
      await grant("g_cg_root_admin", "sc_cg_root", "user_root_admin", "admin");
      expect(OK).toContain(await statusOf(name, "user_root_admin"));
    });

    it("gives an admitted reader the contact list, and only this tenant's", async () => {
      await grant("g_cg_root_reader", "sc_cg_root", "user_root_reader", "read");
      as("user_root_reader");
      const body = await (await contactsGET(new Request("http://t/api/contacts"))).json();
      expect(body.contacts.map((c: any) => c.id)).toEqual([CONTACT]);
    });
  });

  describe("GET /api/nav/badges — a refused caller learns no contact volume", () => {
    const badges = async (userId: string, orgId = ORG) => {
      as(userId, orgId);
      const res = await badgesGET(new Request("http://t/api/nav/badges?since=2000-01-01T00:00:00.000Z"));
      expect(res.status).toBe(200);
      return res.json();
    };

    it("reports the real count to a member the org root grants read to", async () => {
      await grant("g_cg_badge_reader", "sc_cg_root", "user_badge_reader", "read");
      await expect(badges("user_badge_reader")).resolves.toMatchObject({ newContacts: 1 });
    });

    it("reports 0 to a member with no grant, though the org has contacts", async () => {
      await expect(badges("user_nobody")).resolves.toMatchObject({ newContacts: 0 });
    });

    it("reports 0 to an admin of a child scope, whose grant does not cover the root", async () => {
      await grant("g_cg_badge_scope", "sc_cg_a", "user_a_admin", "admin");
      await expect(badges("user_a_admin")).resolves.toMatchObject({ newContacts: 0 });
    });

    it("reports 0 across the tenant boundary, though the grant is real in its own org", async () => {
      await grant("g_cg_badge_foreign", "sc_cg_root", "user_foreign", "admin");
      await expect(badges("user_foreign", OTHER_ORG)).resolves.toMatchObject({ newContacts: 0 });
    });
  });
  // Each gate sits AHEAD of the lookup it
  // protects, so a refused caller cannot tell a real contactId from an invented
  // one. Nothing above pinned that, and it is the property that makes the 403 a
  // real denial rather than an existence oracle.
  describe("a refused caller gets no existence oracle", () => {
    it("answers a real and an invented contactId identically", async () => {
      as("user_nobody");
      const real = await agentRunPOST(json({ contactId: CONTACT }), params({ id: AGENT }));
      const invented = await agentRunPOST(json({ contactId: "no-such-contact" }), params({ id: AGENT }));
      expect(real.status).toBe(403);
      expect(invented.status).toBe(403);
      expect(await real.text()).toBe(await invented.text());
    });

    it("still gives an ADMITTED caller a real 404 for an invented contactId", async () => {
      await grant("g_cg_oracle", "sc_cg_root", "user_oracle", "admin");
      as("user_oracle");
      const res = await agentRunPOST(json({ contactId: "no-such-contact" }), params({ id: AGENT }));
      await drain(res);
      expect(res.status).toBe(404);
    });
  });
});
