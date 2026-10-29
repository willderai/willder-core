// flattenSql()'s calling convention against the real Prisma client — the one
// seam the rest of the suite structurally cannot see.
//
// Every other test that touches a raw scope query mocks `db.$queryRaw` with a
// bare `vi.fn()` (services/memory/access-leakage-eval.test.ts,
// mcp/scope-guard-ltree-contract.test.ts, services/access/check.test.ts,
// mcp/read-scope-validation.test.ts, and many more). A `vi.fn()` accepts any
// arguments at all, so those tests pin WHAT SQL text and bound values the call
// sites produce, and nothing pins whether the real Prisma client will accept
// the CALLING CONVENTION they hand it. Five production call sites — check.ts's
// evaluate() (both the human-grant and the agent-capability query),
// mcp/tools.ts's draft_list and campaign_list, pgvector-store.ts's retrieve(),
// and the scopes delete route — call `db.$queryRaw(...flattenSql(query))`
// instead of a genuine tagged template. That difference is invisible to a mock
// by construction, which is precisely why it needs a test against the real
// client instead of another one against a mock.
//
// The independent source of truth here is Prisma's own argument validation, run
// for real — not a JS reimplementation of what it checks. Prisma 7's
// `$queryRaw(n, ...i)` admits the call only when `n.raw !== undefined ||
// n.sql !== undefined` and otherwise throws PrismaClientValidationError before
// the query ever reaches the database; a genuine tagged template satisfies that
// via the `raw` property the JS spec puts on every TemplateStringsArray.
//
// The client below is pointed at a deliberately unreachable address, so a call
// that PASSES validation still fails — on the connection, with a different error
// class. That asymmetry is the assertion: PrismaClientValidationError means the
// arguments were rejected outright, anything else means they were accepted and
// the query really was dispatched. No database is required, and none is used.
import { describe, expect, it } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient, Prisma } from "@/lib/generated/prisma/client";
import { flattenSql, scopeContainsSql } from "./scope-containment";

// Never resolves to a real server: port 1 on loopback, no credentials that
// exist. Constructing the client is offline; only an accepted query dials out.
const UNREACHABLE = "postgresql://nobody:nothing@127.0.0.1:1/does_not_exist";

function offlineClient(): PrismaClient {
  return new PrismaClient({
    adapter: new PrismaPg({ connectionString: UNREACHABLE }),
  });
}

/** Run a `$queryRaw` call and report only how Prisma classified it: did the
 *  arguments get past validation, or were they rejected before dispatch? */
async function argumentVerdict(
  call: (client: PrismaClient) => Promise<unknown>,
): Promise<{ rejected: boolean; error: string }> {
  const client = offlineClient();
  try {
    await call(client);
    return { rejected: false, error: "(resolved)" };
  } catch (e) {
    const name = (e as Error)?.constructor?.name ?? "unknown";
    return {
      rejected: name === "PrismaClientValidationError",
      error: `${name}: ${String((e as Error)?.message ?? "").split("\n")[0]}`,
    };
  } finally {
    await client.$disconnect().catch(() => {});
  }
}

// The real predicate, composed into a real outer query exactly
// the way pgvector-store.ts's retrieve() composes it — same helper, same
// mode, same nesting — so this exercises the shipped code path, not a
// look-alike written for the test.
function realScopedQuery(): Prisma.Sql {
  const containment = scopeContainsSql(Prisma.raw('"scopePath"'), "org_1.dealA", {
    relation: "within",
    mode: "text",
  });
  return Prisma.sql`
    SELECT id, content FROM memory_chunks
    WHERE "orgId" = ${"org_1"}
      AND embedding IS NOT NULL
      AND ${containment}
    LIMIT ${10}
  `;
}

describe("flattenSql() must satisfy the real Prisma $queryRaw calling convention", () => {
  it("a plain hand-written tagged template is accepted by the real client (control)", async () => {
    const verdict = await argumentVerdict(
      (client) => client.$queryRaw`SELECT id FROM memory_chunks WHERE "orgId" = ${"org_1"} LIMIT ${10}`,
    );
    // Establishes that "not rejected" is genuinely reachable through this
    // harness — without this control, a passing assertion below could just
    // mean the harness never distinguishes anything.
    expect(verdict.rejected, `control call was rejected: ${verdict.error}`).toBe(false);
  });

  it("db.$queryRaw(...flattenSql(query)) is accepted by the real client, the same as the tagged template it replaced", async () => {
    const query = realScopedQuery();
    const verdict = await argumentVerdict((client) =>
      (client as unknown as { $queryRaw: (...args: unknown[]) => Promise<unknown> }).$queryRaw(...flattenSql(query)),
    );
    // If this fails, the 5 call sites throw PrismaClientValidationError
    // on every single call in production: check()'s grant and capability
    // lookups (the access chokepoint every memory read passes through),
    // draft_list, campaign_list, pgvector retrieve(), and the scope delete
    // guard. pgvector-store.ts's retrieve() additionally swallows it in its
    // bare `catch { return { facts: [] } }`, so that one degrades to "every
    // scoped memory read returns nothing" with no error surfaced anywhere.
    expect(verdict.rejected, `Prisma rejected flattenSql()'s argument shape before dispatch: ${verdict.error}`).toBe(
      false,
    );
  });

  it("flattenSql() preserves the composed SQL text and bound values (the property the mocked-db tests already assert, restated against the real fragment)", () => {
    const query = realScopedQuery();
    const [strings, ...values] = flattenSql(query);

    // Fully flattened: the nested containment fragment is merged into the
    // outer query's own strings/values, not left as an Sql object in values.
    expect(values.some((v) => v instanceof Prisma.Sql)).toBe(false);
    expect(strings.length).toBe(values.length + 1);

    const sql = strings.join("");
    expect(sql).toContain('"scopePath" = ');
    expect(sql).toContain('OR "scopePath" LIKE');
    expect(sql).toContain("ESCAPE");
    expect(sql).not.toContain("IS NULL");
    expect(values).toContain("org_1");
    expect(values).toContain("org_1.dealA");
    // Underscore escaped so `org_1.dealA` cannot LIKE-match `orgX1.dealA.*`.
    expect(values).toContain("org\\_1.dealA.%");
  });
});
