// upsertContact's contact-match query must never hand the caller's email to
// Postgres as a LIKE pattern.
//
// `upsertContact` must match an existing contact case-insensitively, the way
// `searchContacts` one function above does, or an agent can fork a second,
// unsuppressed row for an opted-out person. The tempting spelling is wrong:
//     { email: { equals: email, mode: "insensitive" } }
// Prisma 7.8 compiles `equals` + `mode: "insensitive"` to
//     "email" ILIKE $2
// with the caller's email passed as the parameter, UNESCAPED (the control,
// plain `equals`, emits `"email" = $2` and is otherwise byte-identical). So
// every Postgres LIKE metacharacter inside a caller-supplied email address is
// live:
//
//   `_` — a single-character wildcard. `jane_doe@acme.com` (an entirely
//         ordinary address) matches a DIFFERENT person's stored
//         `janeXdoe@acme.com`.
//   `%` — any run of characters. `email: "%"` matches the org's contacts
//         indiscriminately and findFirst takes an arbitrary one.
//
// `email` has no format validation anywhere on this path: the MCP schema is
// `z.string().optional()` (mcp/tools.ts) and the service only calls `.trim()`.
//
// WHY THIS IS A WRITE-PATH LEAK, not a search nit. When the wildcard matches
// the wrong row, upsertContact takes the `existing` branch and `updateMany`
// overwrites that row's name/email/title/description/type with the incoming
// contact's data. If the row it clobbered was a suppressed one, that person's
// address is gone from the database entirely, so nothing matches them any
// more and the next upsert creates a fresh, sendable row — the suppression
// bypass, reached by a new route. The revision precondition does not save it:
// `revision` starts at 0 and increments, so a caller passing a legitimate
// baseRevision read from its own contact_search collides with the wrong row's
// revision routinely, not exceptionally.
//
// The same class exists on the scope path: services/access/scope-containment.ts's
// `escapeLikePrefix`, and services/memory/scale-and-concurrency.eval.test.ts
// is a whole suite built on `_` being a LIKE wildcard. This is that bug, one
// table over.
//
// WHY THE OTHER TESTS CANNOT SEE IT: agent-contacts.suppression.test.ts and
// agent-contacts.test.ts both `vi.mock("@/lib/db")`, so they observe the
// ARGUMENTS handed to Prisma and never the SQL those arguments compile to.
// `mode: "insensitive"` reads correct there and passes. This file mocks one
// layer lower — at the driver adapter — and lets the real `upsertContact`
// drive the real Prisma query builder, which is the only thing that can
// observe the emitted pattern.
//
// NOT A TAUTOLOGY: the CONTROL test below sends an email with no LIKE
// metacharacter in it through the identical path and asserts it passes. A
// detector that always failed would fail that too. No database is contacted;
// the adapter returns empty result sets, so this runs in ordinary CI.
import { beforeEach, describe, expect, it, vi } from "vitest";

const { captured, recordingAdapter } = vi.hoisted(() => {
  const captured: { sql: string; args: unknown[] }[] = [];
  const emptyResult = { columnNames: [], columnTypes: [], rows: [] };
  const queryable = {
    provider: "postgres",
    adapterName: "@prisma/adapter-pg",
    queryRaw: async (q: { sql: string; args: unknown[] }) => {
      captured.push({ sql: q.sql, args: q.args ?? [] });
      return emptyResult;
    },
    executeRaw: async (q: { sql: string; args: unknown[] }) => {
      captured.push({ sql: q.sql, args: q.args ?? [] });
      return 0;
    },
  };
  const tx = {
    ...queryable,
    options: { usePhantomQuery: false },
    commit: async () => {},
    rollback: async () => {},
  };
  const connected = {
    ...queryable,
    // Prisma 7.8 calls startTransaction on the connected adapter itself.
    startTransaction: async () => tx,
    transactionContext: async () => ({ ...queryable, startTransaction: async () => tx }),
    dispose: async () => {},
  };
  const recordingAdapter = {
    provider: "postgres",
    adapterName: "@prisma/adapter-pg",
    connect: async () => connected,
  };
  return { captured, recordingAdapter };
});

vi.mock("@/services/access", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/access")>();
  return { ...actual, check: vi.fn().mockResolvedValue({ allowed: true, auditLogId: "audit_test" }) };
});
vi.mock("@/lib/db", async () => {
  const { PrismaClient } = await import("@/lib/generated/prisma/client");
  return { db: new PrismaClient({ adapter: recordingAdapter as never }) };
});

import { upsertContact } from "./agent-contacts";

const ctx = {
  orgId: "org_test",
  actorId: "agent_test",
  actorType: "agent" as const,
  capabilityToken: "tok_test",
};

/** The statement that decides which existing contact this upsert will write
 *  to — the only emitted SELECT against "contacts" that filters on email. */
function contactMatchQuery() {
  return captured.find((q) => /FROM "public"\."contacts"/.test(q.sql) && /"email"/.test(q.sql));
}

async function runUpsert(email: string) {
  captured.length = 0;
  try {
    await upsertContact(ctx as never, {
      idempotencyKey: `idem-${Math.random()}`,
      name: "Incoming Person",
      email,
    });
  } catch {
    // The adapter returns empty result sets, so the write half of the
    // transaction cannot complete. Irrelevant here: the match query is
    // emitted first and is already captured.
  }
}

describe("upsertContact's contact-match query must not treat a caller's email as a LIKE pattern", () => {
  beforeEach(() => {
    captured.length = 0;
    vi.clearAllMocks();
  });

  it("an ordinary address containing an underscore is matched literally, not as a wildcard", async () => {
    await runUpsert("jane_doe@acme.com");
    const q = contactMatchQuery();
    expect(q, "no contact-match query was emitted").toBeDefined();

    // Either the comparison is not a LIKE at all (`=`, or LOWER(..)=LOWER(..)),
    // or the pattern parameter has its metacharacters escaped. What must never
    // happen is an ILIKE fed the caller's raw address.
    const usesLikeOperator = /I?LIKE/i.test(q!.sql);
    const rawEmailIsThePattern = (q!.args as unknown[]).includes("jane_doe@acme.com");

    expect(
      usesLikeOperator && rawEmailIsThePattern,
      `upsertContact matches contacts with a LIKE pattern built from the caller's unescaped email.\n` +
        `  SQL:  ${q!.sql}\n  ARGS: ${JSON.stringify(q!.args)}\n` +
        `  So 'jane_doe@acme.com' also matches a different person's 'janeXdoe@acme.com', ` +
        `and upsertContact overwrites that row instead of creating the intended contact.`,
    ).toBe(false);
  });

  it("'%' as an email does not become a match-anything pattern", async () => {
    await runUpsert("%");
    const q = contactMatchQuery();
    expect(q, "no contact-match query was emitted").toBeDefined();

    const usesLikeOperator = /I?LIKE/i.test(q!.sql);
    const rawPercentIsThePattern = (q!.args as unknown[]).includes("%");

    expect(
      usesLikeOperator && rawPercentIsThePattern,
      `upsertContact sends '%' straight through as a LIKE pattern (SQL: ${q!.sql}), ` +
        `so it matches the org's contacts indiscriminately and findFirst writes to an arbitrary one. ` +
        `email has no format validation on this path (mcp/tools.ts: z.string().optional()).`,
    ).toBe(false);
  });

  it("CONTROL: an address with no LIKE metacharacter still emits a real, org-scoped match query", async () => {
    await runUpsert("plainjane@acme.com");
    const q = contactMatchQuery();

    // Proves the detector is looking at a real query and discriminates on the
    // metacharacter, rather than failing every input unconditionally.
    expect(q, "no contact-match query was emitted").toBeDefined();
    expect(q!.args).toContain("org_test");
    expect(q!.args).toContain("plainjane@acme.com");
    const usesLikeOperator = /I?LIKE/i.test(q!.sql);
    const metacharacterInPattern = /[%_]/.test("plainjane@acme.com");
    expect(usesLikeOperator && metacharacterInPattern).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The case-insensitivity guard has to live at the SQL layer too.
//
// `upsertContact` matching an existing contact with a case-SENSITIVE `=`
// while `searchContacts` matches case-insensitively lets an agent that
// searched for "jane@acme.com" (finding the opted-out row stored as
// "Jane@Acme.com") and then upserted it fork a second, fresh, sendable row
// for the same person. The match is raw SQL: LOWER("email") = LOWER($2).
//
// A mocked-db test cannot protect that property: reverting the emitted SQL to
// a case-sensitive `"email" = $2` leaves every test that touches upsertContact
// through `vi.mock("@/lib/db")` green. agent-contacts.suppression.test.ts's
// fake for `db.$queryRaw` routes on the SQL naming "contacts" and then applies
// its OWN `.toLowerCase() === .toLowerCase()` comparison, so it reports a
// case-insensitive match no matter what the emitted SQL actually compares.
// Its sibling `matches()` fake for the Prisma-argument path IS honest — it
// reads the caller's `mode: "insensitive"` flag off the arguments — but a raw
// query carries its semantics in SQL text the fake never reads.
//
// So the guard lives at the layer that can observe the statement, which is
// this file. Kept deliberately loose about HOW the fold is done (LOWER or
// UPPER on both sides, or an escaped case-insensitive LIKE): the property is
// that the two sides are folded the same way, not that the implementation
// picks LOWER.
//
// LIMIT: the SQL semantics themselves (LOWER()-equality folds case; `_` is a
// LIKE wildcard) are standard Postgres and are not re-verified live here.
describe("upsertContact's contact-match query must compare email case-insensitively", () => {
  beforeEach(() => {
    captured.length = 0;
    vi.clearAllMocks();
  });

  it("folds case on both sides of the email comparison, so a stored 'Jane@Acme.com' is still matched", async () => {
    await runUpsert("jane@acme.com");
    const q = contactMatchQuery();
    expect(q, "no contact-match query was emitted").toBeDefined();

    // Any comparison that applies the SAME case-folding function to the column
    // and to the bound parameter, or an escaped case-insensitive LIKE.
    const foldedBothSides =
      /(LOWER|UPPER)\s*\(\s*"?email"?\s*\)\s*=\s*(LOWER|UPPER)\s*\(\s*\$\d+\s*\)/i.test(q!.sql) ||
      /"?email"?\s+ILIKE\s+\$\d+/i.test(q!.sql);

    expect(
      foldedBothSides,
      `upsertContact's contact-match query does not compare email case-insensitively.\n` +
        `  SQL:  ${q!.sql}\n  ARGS: ${JSON.stringify(q!.args)}\n` +
        `  searchContacts matches case-insensitively, so an ` +
        `agent that finds a suppressed "Jane@Acme.com" and upserts "jane@acme.com" misses it ` +
        `and forks a second, unsuppressed, sendable row for the same person.`,
    ).toBe(true);
  });

  it("binds the address as a parameter, never inlined into the statement text", async () => {
    await runUpsert("jane@acme.com");
    const q = contactMatchQuery();
    expect(q, "no contact-match query was emitted").toBeDefined();

    // Guards the other way out of the case-fold assertion above: switching to
    // $queryRawUnsafe with the address concatenated in would satisfy a naive
    // reading of it and reopen injection on a write path.
    expect(q!.args, "the caller's email is not a bound parameter").toContain("jane@acme.com");
    expect(
      q!.sql.includes("jane@acme.com"),
      `the caller's email is inlined into the SQL text instead of bound:\n  SQL: ${q!.sql}`,
    ).toBe(false);
  });

  it("CONTROL: the same query is still tenant-scoped to ctx.orgId", async () => {
    await runUpsert("jane@acme.com");
    const q = contactMatchQuery();

    // Proves the two assertions above are reading a real, complete match query
    // rather than whatever statement happens to mention "contacts" first.
    expect(q, "no contact-match query was emitted").toBeDefined();
    expect(q!.sql).toMatch(/"orgId"\s*=\s*\$\d+/i);
    expect(q!.args).toContain("org_test");
  });
});
