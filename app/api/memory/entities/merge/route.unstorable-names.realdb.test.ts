// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// POST /api/memory/entities/merge records `merge:<fromName>` in the alias registry
// after the transfer. A name that registry cannot store (a NUL, half of a surrogate
// pair, a fromName past the entity id's 1000-byte cap less the 6-byte `merge:`
// prefix) used to reach Postgres only then, so the merge answered 500 after the
// graph transfer and its audit rows were already written. Each is now answered 400
// naming the field before anything is read or written.
//
// Real: the route, check() and its grants and audit rows, and the alias registry.
// Mocked: the session and the graph store's HTTP boundary (which name lives where,
// and the transfer itself, counted as calls).
//
// Set QA_DATABASE_URL to an ISOLATED test database. Never a live one.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@/lib/generated/prisma/client";

const QA_URL = process.env.QA_DATABASE_URL;
const IMPORT_TIMEOUT_MS = 60_000;

const ORG = "org-merge-unstorable";
const ROOT = `org_${ORG}`;
const ADMIN = "u-merge-unstorable-admin";

vi.mock("@/lib/access-context", () => ({ requireAccessContext: vi.fn() }));
vi.mock("@/services/memory/store", () => ({
  memory: { transferEntity: vi.fn(async () => ({ transferred: 2 })) },
  graphitiStore: { groupsHoldingEntity: vi.fn(async () => ["org_org-merge-unstorable"]) },
}));

describe.skipIf(!QA_URL)(
  "entity merge refuses names the alias registry cannot store, before any write (real Postgres)",
  () => {
    let db: PrismaClient;
    let merge: typeof import("./route");
    let transferEntity: ReturnType<typeof vi.fn>;

    async function reset() {
      await db.auditLog.deleteMany({ where: { orgId: ORG } });
      await db.entityAlias.deleteMany({ where: { orgId: ORG } });
      await db.grant.deleteMany({ where: { orgId: ORG } });
      await db.scope.deleteMany({ where: { orgId: ORG } });
      await db.user.deleteMany({ where: { orgId: ORG } });
      await db.org.deleteMany({ where: { id: ORG } });
    }

    const post = async (body: unknown) => {
      const res = await merge.POST(
        new Request("http://localhost/api/memory/entities/merge", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
      );
      return { status: res.status, body: await res.json() };
    };
    const counts = async () => ({
      auditRows: await db.auditLog.count({ where: { orgId: ORG } }),
      aliases: await db.entityAlias.count({ where: { orgId: ORG } }),
      transfers: transferEntity.mock.calls.length,
    });

    beforeAll(async () => {
      process.env.DATABASE_URL = QA_URL;
      ({ db } = await import("@/lib/db"));
      const { requireAccessContext } = (await import("@/lib/access-context")) as unknown as {
        requireAccessContext: ReturnType<typeof vi.fn>;
      };
      ({
        memory: { transferEntity },
      } = (await import("@/services/memory/store")) as unknown as {
        memory: { transferEntity: ReturnType<typeof vi.fn> };
      });
      merge = await import("./route");

      await reset();
      const org = await db.org.create({ data: { id: ORG, clerkOrgId: `clerk_${ORG}`, name: ORG } });
      const user = await db.user.create({
        data: {
          id: ADMIN,
          orgId: ORG,
          clerkId: `clerk_${ADMIN}`,
          email: `${ADMIN}@example.test`,
          name: ADMIN,
          role: "admin",
        },
      });
      const root = await db.scope.create({ data: { orgId: ORG, path: ROOT, name: "root" } });
      await db.grant.create({
        data: { orgId: ORG, scopeId: root.id, granteeType: "user", granteeId: ADMIN, permission: "admin" },
      });
      requireAccessContext.mockResolvedValue({
        org,
        user,
        ctx: { orgId: ORG, actor: { type: "human" as const, id: ADMIN, role: "admin" }, origin: "app" as const },
      });
    }, IMPORT_TIMEOUT_MS);

    beforeEach(async () => {
      await db.auditLog.deleteMany({ where: { orgId: ORG } });
      await db.entityAlias.deleteMany({ where: { orgId: ORG } });
      transferEntity.mockClear();
    });

    afterAll(async () => {
      if (db) await reset();
    });

    const nul = (field: string) =>
      `${field} contains a NUL (\\u0000) character, which cannot be stored. Remove it and retry.`;
    const halfPair = (field: string) =>
      `${field} contains half of a surrogate pair, which cannot be stored. Remove it and retry.`;
    const tooLong = "fromName exceeds 994 UTF-8 bytes. Shorten it and retry.";

    it.each([
      [
        "a fromName of 1000 CJK characters (3000 bytes)",
        { fromName: "界".repeat(1000), toName: "Marcus Chen" },
        tooLong,
      ],
      ["a fromName one byte past the cap", { fromName: "a".repeat(995), toName: "Marcus Chen" }, tooLong],
      ["a NUL in fromName", { fromName: "Mar\u0000cus", toName: "Marcus Chen" }, nul("fromName")],
      ["a lone surrogate in fromName", { fromName: "Mar\ud800cus", toName: "Marcus Chen" }, halfPair("fromName")],
      ["a NUL in toName", { fromName: "Marcus", toName: "Marcus\u0000Chen" }, nul("toName")],
      ["a lone surrogate in toName", { fromName: "Marcus", toName: "Marcus \udc00" }, halfPair("toName")],
      ["a number for fromName", { fromName: 42, toName: "Marcus Chen" }, "fromName must be a string, not a number"],
    ])("answers %s with 400 naming the field, and transfers and records nothing", async (_what, body, error) => {
      const before = await counts();

      expect(await post(body)).toEqual({ status: 400, body: { error } });
      expect(await counts()).toEqual(before);
      expect(before).toEqual({ auditRows: 0, aliases: 0, transfers: 0 });
    });

    it("refuses, writing nothing, a merge alias the registry cannot store even when a caller skips the route's check", async () => {
      const { recordMergeAlias } = await import("@/services/memory/entity-aliases");

      await expect(recordMergeAlias(ORG, "界".repeat(1000), "Marcus Chen", ADMIN)).rejects.toThrow(tooLong);
      expect(await db.entityAlias.count({ where: { orgId: ORG } })).toBe(0);
    });

    it("merges a fromName exactly at the cap and a plain one, recording each alias", async () => {
      const atCap = "a".repeat(994);

      expect(await post({ fromName: atCap, toName: "Marcus Chen" })).toEqual({
        status: 200,
        body: { transferred: 2, fromName: atCap, toName: "Marcus Chen" },
      });
      expect(await post({ fromName: "Marcus", toName: "Marcus Chen" })).toEqual({
        status: 200,
        body: { transferred: 2, fromName: "Marcus", toName: "Marcus Chen" },
      });
      expect(transferEntity).toHaveBeenCalledTimes(2);
      const stored = await db.entityAlias.findMany({
        where: { orgId: ORG },
        select: { entityId: true, entityType: true, canonicalName: true, aliases: true, createdBy: true },
      });
      expect(stored.sort((a, b) => a.entityId.length - b.entityId.length)).toEqual([
        {
          entityId: "merge:Marcus",
          entityType: "user",
          canonicalName: "Marcus Chen",
          aliases: ["Marcus"],
          createdBy: ADMIN,
        },
        {
          entityId: `merge:${atCap}`,
          entityType: "user",
          canonicalName: "Marcus Chen",
          aliases: [atCap],
          createdBy: ADMIN,
        },
      ]);
    });
  },
);
