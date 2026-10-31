// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// The second half of refuses-non-string-body-fields: routes whose body carries strings
// inside an object (`target.baseUrl`, `contact.name`), arrays of strings (`aliases`,
// `findings`, `target.allowedHosts`) and plain objects (`socialLinks`). A field of the
// wrong JSON type used to throw on `.trim()` or `.map()` as a 500 that named nothing, or
// was stored as sent. Each is now a 400 naming the field, the array index or the parent
// object that had the wrong type, before check() runs, so no audit row and no record is
// left behind.
//
// Real: Postgres, the route handlers, check() and its audit write, the contact, account,
// org role and alias writes. Faked: the Clerk session and the ingest queue.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";
import { deleteOrgsWithRetry } from "@/lib/org-cleanup.testsupport";

const QA_URL = process.env.QA_DATABASE_URL;
const ORG = "nestedbodytypes";
const ROOT = `org_${ORG}`;
const ADMIN = "u-nestedbodytypes-admin";

vi.mock("@/lib/access-context", () => ({ requireAccessContext: vi.fn() }));
vi.mock("@/lib/inngest", () => ({ ingestMemory: vi.fn(async () => ({ readableNow: false })) }));

type Handler = (req: Request) => Promise<Response>;

/** One refused body and the exact refusal it must get. */
type Case = { body: Record<string, unknown>; error: string };

const NOT_A_STRING: [string, unknown][] = [
  ["a number", 0],
  ["a boolean", false],
  ["an array", ["x"]],
  ["an object", { x: "y" }],
];
const NOT_AN_OBJECT: [string, unknown][] = [
  ["a number", 0],
  ["a string", "x"],
  ["a boolean", true],
  ["an array", [{ x: "y" }]],
];
const NOT_AN_ARRAY: [string, unknown][] = [
  ["a number", 0],
  ["a string", "x"],
  ["a boolean", false],
  ["an object", { 0: "x" }],
];
const NOT_A_STRING_ELEMENT: [string, unknown][] = [...NOT_A_STRING, ["null", null]];

/** `{ a: { b: value } }` for the path "a.b". */
function nest(path: string, value: unknown): Record<string, unknown> {
  return path.split(".").reduceRight<unknown>((inner, key) => ({ [key]: inner }), value) as Record<string, unknown>;
}

/** Every wrong-typed body for one field path, written independently of bodyTypeRefusal:
 * a parent that is not an object, then the field itself as each wrong type. */
function casesFor(field: string): Case[] {
  const cases: Case[] = [];
  const kind = field.endsWith("[]") ? "array" : field.endsWith("{}") ? "object" : "string";
  const path = kind === "string" ? field : field.slice(0, -2);
  const segments = path.split(".");
  for (let i = 1; i < segments.length; i++) {
    const parent = segments.slice(0, i).join(".");
    for (const [name, value] of NOT_AN_OBJECT) {
      cases.push({ body: nest(parent, value), error: `${parent} must be an object, not ${name}` });
    }
  }
  if (kind === "string") {
    for (const [name, value] of NOT_A_STRING) {
      cases.push({ body: nest(path, value), error: `${path} must be a string, not ${name}` });
    }
  } else if (kind === "object") {
    for (const [name, value] of NOT_AN_OBJECT) {
      cases.push({ body: nest(path, value), error: `${path} must be an object, not ${name}` });
    }
  } else {
    for (const [name, value] of NOT_AN_ARRAY) {
      cases.push({ body: nest(path, value), error: `${path} must be an array, not ${name}` });
    }
    for (const [name, value] of NOT_A_STRING_ELEMENT) {
      cases.push({ body: nest(path, ["fine", value]), error: `${path}[1] must be a string, not ${name}` });
    }
  }
  return cases;
}

function send(body: unknown, method = "POST") {
  return new Request("http://t/api", {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe.skipIf(!QA_URL)(
  "routes refuse a nested, array or object body field of the wrong type by name, real Postgres",
  () => {
    let db: PrismaClient;
    let ingestMemory: (typeof import("@/lib/inngest"))["ingestMemory"];
    let routes: { name: string; fields: string[]; handle: Handler }[];

    const tenantRows = async () => ({
      audit: await db.auditLog.count({ where: { orgId: ORG } }),
      contacts: await db.contact.count({ where: { orgId: ORG } }),
      accounts: await db.account.count({ where: { orgId: ORG } }),
      runs: await db.agentRun.count({ where: { orgId: ORG } }),
      orgRoles: await db.orgRole.count({ where: { orgId: ORG } }),
      aliases: await db.entityAlias.count({ where: { orgId: ORG } }),
      preferences: await db.orgPreference.count({ where: { orgId: ORG } }),
    });

    async function clearTenant() {
      await db.auditLog.deleteMany({ where: { orgId: ORG } });
      await db.orgRole.deleteMany({ where: { orgId: ORG } });
      await db.entityAlias.deleteMany({ where: { orgId: ORG } });
      await db.contact.deleteMany({ where: { orgId: ORG } });
      await db.account.deleteMany({ where: { orgId: ORG } });
      await db.orgPreference.deleteMany({ where: { orgId: ORG } });
      await db.orgMembership.deleteMany({ where: { orgId: ORG } });
      await db.grant.deleteMany({ where: { orgId: ORG } });
      await db.scope.deleteMany({ where: { orgId: ORG } });
      await db.user.deleteMany({ where: { orgId: ORG } });
      await deleteOrgsWithRetry(db, { where: { id: ORG } });
    }

    beforeAll(async () => {
      if (QA_URL === process.env.DATABASE_URL) throw new Error("QA_DATABASE_URL must not be DATABASE_URL");
      process.env.DATABASE_URL = QA_URL;
      // Both manager routes answer 404 while their flag is off, before reading the body.
      vi.stubEnv("QA_MANAGER", "true");
      vi.stubEnv("ARCH_MANAGER", "true");
      db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL! }) });
      ({ ingestMemory } = await import("@/lib/inngest"));
      const { requireAccessContext } = await import("@/lib/access-context");
      // The fields the routes read; the full Clerk-backed org and user rows are not needed.
      vi.mocked(requireAccessContext).mockResolvedValue({
        org: { id: ORG, name: "Nested body types" },
        user: { id: ADMIN, name: ADMIN, email: `${ADMIN}@nestedbodytypes.test`, role: "admin" },
        ctx: { orgId: ORG, actor: { type: "human", id: ADMIN, role: "admin" }, origin: "app" },
      } as Awaited<ReturnType<typeof requireAccessContext>>);

      const params = { params: Promise.resolve({ id: "does-not-matter" }) };
      const withParams =
        (handler: (r: Request, p: typeof params) => Promise<Response>): Handler =>
        (r) =>
          handler(r, params);
      const target = ["target.baseUrl", "target.openApiUrl", "target.authHeader", "target.allowedHosts[]"];
      const company = ["name", "domain", "status", "description", "industry", "socialLinks{}"];
      routes = [
        {
          name: "POST /api/agents/:id/run-interactive",
          fields: [...target, "focus", "mode"],
          handle: withParams((await import("./agents/[id]/run-interactive/route")).POST),
        },
        {
          name: "POST /api/agents/:id/run-manager",
          fields: [...target, "focus", "mode", "stoppingMode"],
          handle: withParams((await import("./agents/[id]/run-manager/route")).POST),
        },
        {
          name: "POST /api/agents/:id/qa",
          fields: [...target, "focus", "mode"],
          handle: withParams((await import("./agents/[id]/qa/route")).POST),
        },
        {
          name: "POST /api/agents/:id/prospect",
          fields: ["query"],
          handle: withParams((await import("./agents/[id]/prospect/route")).POST),
        },
        {
          name: "POST /api/agents/:id/plan-manager",
          fields: ["prompt", "context", "attachmentIds[]"],
          handle: withParams((await import("./agents/[id]/plan-manager/route")).POST),
        },
        {
          name: "POST /api/agents/:id/plan-interactive",
          fields: ["prompt", "context", "attachmentIds[]"],
          handle: withParams((await import("./agents/[id]/plan-interactive/route")).POST),
        },
        {
          name: "POST /api/contacts",
          fields: ["name", "email", "title", "type", "description", "accountId", "status", "socialLinks{}"],
          handle: (await import("./contacts/route")).POST,
        },
        {
          name: "POST /api/contacts/from-research",
          fields: [
            "contact.name",
            "contact.title",
            "contact.email",
            "contact.linkedin",
            "account.name",
            "account.domain",
            "account.industry",
            "account.description",
            "findings[]",
          ],
          handle: (await import("./contacts/from-research/route")).POST,
        },
        { name: "POST /api/accounts", fields: company, handle: (await import("./accounts/route")).POST },
        {
          name: "PATCH /api/accounts/:id",
          fields: company,
          handle: withParams((await import("./accounts/[id]/route")).PATCH),
        },
        {
          name: "POST /api/settings/org-roles",
          fields: ["role", "userId", "aliases[]"],
          handle: (await import("./settings/org-roles/route")).POST,
        },
        {
          name: "POST /api/settings/aliases",
          fields: ["entityId", "entityType", "canonicalName", "aliases[]"],
          handle: (await import("./settings/aliases/route")).POST,
        },
        {
          name: "POST /api/onboarding",
          fields: ["companyDescription", "icp", "valueProp", "tone", "domain"],
          handle: (await import("./onboarding/route")).POST,
        },
      ];

      await clearTenant();
      await db.org.create({ data: { id: ORG, name: "Nested body types" } });
      await db.user.create({
        data: {
          id: ADMIN,
          orgId: ORG,
          email: `${ADMIN}@nestedbodytypes.test`,
          role: "admin",
          clerkId: `clerk-${ADMIN}`,
        },
      });
      const root = await db.scope.create({ data: { orgId: ORG, path: ROOT, name: ROOT } });
      await db.grant.create({
        data: { orgId: ORG, scopeId: root.id, granteeType: "user", granteeId: ADMIN, permission: "admin" },
      });
    }, 60_000);

    afterAll(async () => {
      await clearTenant();
      await db.$disconnect();
    });

    beforeEach(async () => {
      vi.mocked(ingestMemory).mockClear();
      await db.auditLog.deleteMany({ where: { orgId: ORG } });
    });

    it("every field of the wrong type is a 400 naming it; nothing is checked, audited or written", async () => {
      const before = await tenantRows();
      let sent = 0;
      for (const route of routes) {
        for (const field of route.fields) {
          for (const { body, error } of casesFor(field)) {
            const res = await route.handle(send(body, route.name.split(" ")[0]));
            const got = { route: route.name, body, status: res.status, error: (await res.json()).error };

            expect(got).toEqual({ route: route.name, body, status: 400, error });
            sent += 1;
          }
        }
      }
      // 13 routes, 67 field paths; pinned so a dropped route or field cannot pass silently.
      expect(sent).toBe(388);
      expect(await tenantRows()).toEqual(before);
      expect(before.audit).toBe(0);
      expect(ingestMemory).not.toHaveBeenCalled();
    });

    it.each([
      ["null", null],
      ["a string", "eng"],
      ["an array", [{ name: "eng" }]],
    ])(
      "a body that is %s, not a JSON object, is a 400 naming that on every route; no audit row",
      async (kind, body) => {
        for (const route of routes) {
          const res = await route.handle(send(body, route.name.split(" ")[0]));

          expect({ route: route.name, status: res.status, error: (await res.json()).error }).toEqual({
            route: route.name,
            status: 400,
            error: `request body must be a JSON object, not ${kind}`,
          });
        }
        expect((await tenantRows()).audit).toBe(0);
      },
    );

    it("a body that is not JSON at all is a 400 on every route, not a 500", async () => {
      for (const route of routes) {
        const req = new Request("http://t/api", { method: route.name.split(" ")[0], body: "{not json" });
        const res = await route.handle(req);

        expect({ route: route.name, status: res.status }).toEqual({ route: route.name, status: 400 });
      }
      expect((await tenantRows()).audit).toBe(0);
    });

    it("an account name sent as null is refused, since an account cannot lose its name", async () => {
      const patch = routes.find((r) => r.name === "PATCH /api/accounts/:id")!;
      const res = await patch.handle(send({ name: null }, "PATCH"));

      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe("name must be a string, not null");
      expect((await tenantRows()).audit).toBe(0);
    });

    it("nested strings and string findings are still accepted: research becomes a contact, an account and two ingests", async () => {
      const fromResearch = routes.find((r) => r.name === "POST /api/contacts/from-research")!;
      const res = await fromResearch.handle(
        send({
          contact: { name: " Ada Lovelace ", title: "CTO" },
          account: { name: "Analytical Engines", domain: "engines.test" },
          findings: ["Ships the difference engine", "", "Hiring"],
        }),
      );

      expect(res.status).toBe(201);
      const { contactId, accountId } = await res.json();
      const contact = await db.contact.findUniqueOrThrow({ where: { id: contactId } });
      expect(contact).toMatchObject({ orgId: ORG, name: "Ada Lovelace", title: "CTO", accountId });
      expect(vi.mocked(ingestMemory).mock.calls.map(([input]) => input.content)).toEqual([
        "Ships the difference engine",
        "Hiring",
      ]);
    });

    it("string arrays are still accepted: an org role with no aliases, and an alias list, are saved trimmed", async () => {
      const orgRoles = routes.find((r) => r.name === "POST /api/settings/org-roles")!;
      const role = await orgRoles.handle(send({ role: " CTO ", userId: ADMIN, aliases: null }));
      expect(role.status).toBe(201);
      expect((await role.json()).role).toMatchObject({ role: "CTO", aliases: [] });

      const aliasRoute = routes.find((r) => r.name === "POST /api/settings/aliases")!;
      const alias = await aliasRoute.handle(
        send({ entityId: ADMIN, entityType: "user", canonicalName: "Admin", aliases: [" boss ", "", "admin"] }),
      );
      expect(alias.status).toBe(201);
      expect((await alias.json()).alias).toMatchObject({ entityId: ADMIN, aliases: ["boss", "admin"] });
    });
  },
);
