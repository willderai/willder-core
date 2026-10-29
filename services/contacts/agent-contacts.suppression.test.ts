// The suppression-preservation leak scenario.
//
// WHY THIS FILE EXISTS, separate from agent-contacts.test.ts: that suite
// proves `upsertContact` never *writes* the `suppressed` field on a row it
// matched. That is true. But it only covers the path where an existing row
// IS matched. Suppression preservation is a property of the whole surface,
// and the surface has a second path — create — that the other suite never
// points at a suppressed person.
//
// The real suppression signal in this codebase is `Contact.status`
// ("unsubscribed"/"bounced"), enforced in services/guardrails.ts by
// `checkContactGuardrails` and `filterSendableContacts`. BOTH key on the
// contact **id**. So a *second row* for the same human, carrying a new id and
// the schema default `status: active`, is fully sendable no matter what the
// original row says. Suppression is preserved on the row and defeated on the
// person.
//
// The reachable way to produce that second row: `upsertContact` matching an
// existing contact with
//     tx.contact.findFirst({ where: { orgId, email } })
// which is an exact SQL `=`, while `searchContacts` one function above matches
// with `mode: "insensitive"`. In Postgres:
//     SELECT ('Jane@Acme.com' = 'jane@acme.com')      -> false
//     SELECT ('Jane@Acme.com' ILIKE 'jane@acme.com')  -> true
//     contacts.email is `text` (NOT citext)
//     the only (orgId,email) index is a NON-UNIQUE btree — nothing in the
//     database will reject the duplicate either
// So the natural agent workflow — search for "jane@acme.com", see the match
// flagged, then upsert the address it typed — would silently fork a brand-new
// unsuppressed contact for a person who opted out.
//
// NOT A TAUTOLOGY: the fake below is a tiny query engine that implements
// Postgres matching semantics honestly — exact comparison for an equality
// filter, case-insensitive for a `mode:"insensitive"` contains filter. It
// does NOT hardcode "return null for this call." Which branch production code
// lands on is decided entirely by which filter production code asks for. The
// CONTROL test proves the fake can and does match when asked correctly, so a
// pass is reachable.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({
  db: {
    $queryRaw: vi.fn(),
    $transaction: vi.fn(),
    auditLog: { create: vi.fn().mockResolvedValue({ id: "audit_test_id" }) },
    contact: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
      findUnique: vi.fn(),
      findUniqueOrThrow: vi.fn(),
      create: vi.fn(),
      updateMany: vi.fn(),
    },
    contactIdempotencyKey: {
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
  },
}));

vi.mock("@/lib/inngest", () => ({ ingestMemory: vi.fn().mockResolvedValue(undefined) }));

import { db } from "@/lib/db";
import { upsertContact } from "./agent-contacts";
import type { AccessContext } from "@/services/access";

const ORG = "org_1";

const agentCtx = (): AccessContext => ({
  orgId: ORG,
  actor: { type: "agent", id: "agent_shin", capabilityToken: "wcap_test" },
  origin: "mcp",
});

type Row = Record<string, unknown>;

/** In-memory `contacts` table wired to the Prisma mocks, implementing the
 * matching semantics Postgres actually has (verified live, see header). */
function installContactTable(rows: Row[]) {
  let nextId = 1;

  // `=` on text: exact, case-sensitive. `contains` + mode:"insensitive": ILIKE.
  const matches = (row: Row, where: Record<string, unknown> | undefined): boolean => {
    if (!where) return true;
    return Object.entries(where).every(([field, cond]) => {
      if (cond && typeof cond === "object" && "contains" in (cond as Row)) {
        const c = cond as { contains: string; mode?: string };
        const v = row[field];
        if (typeof v !== "string") return false;
        return c.mode === "insensitive" ? v.toLowerCase().includes(c.contains.toLowerCase()) : v.includes(c.contains);
      }
      // `{ equals, mode }` — supported so this fake models a case-insensitive
      // match as faithfully as a case-sensitive one. Without this the test
      // could never go green and would be worthless.
      if (cond && typeof cond === "object" && "equals" in (cond as Row)) {
        const c = cond as { equals: unknown; mode?: string };
        const v = row[field];
        if (c.mode === "insensitive" && typeof v === "string" && typeof c.equals === "string") {
          return v.toLowerCase() === c.equals.toLowerCase();
        }
        return v === c.equals;
      }
      return row[field] === cond;
    });
  };

  vi.mocked(db.contact.findFirst).mockImplementation((async (args: { where?: Record<string, unknown> }) => {
    const where = args?.where ?? {};
    const { OR, ...rest } = where as { OR?: Record<string, unknown>[] };
    return rows.find((r) => matches(r, rest) && (!OR || OR.some((o) => matches(r, o)))) ?? null;
  }) as never);

  vi.mocked(db.contact.findUnique).mockImplementation((async (args: { where: Record<string, unknown> }) => {
    return rows.find((r) => matches(r, args.where)) ?? null;
  }) as never);

  // upsertContact does the case-insensitive email match as a raw
  // LOWER(email) = LOWER($1) query (agent-contacts.ts), not
  // contact.findFirst — this fake's `db.$queryRaw` must also honor it,
  // discriminating it from the unrelated capability-check raw query by
  // which table its SQL names. Real LOWER() comparison, not a hardcoded
  // hit, so this stays honest the same way `matches()` above is.
  vi.mocked(db.$queryRaw).mockImplementation((async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = Array.isArray(strings) ? strings.join(" ") : String(strings);
    if (/"contacts"/.test(sql)) {
      const [orgId, email] = values as [unknown, unknown];
      const match = rows.find(
        (r) =>
          r.orgId === orgId &&
          typeof r.email === "string" &&
          typeof email === "string" &&
          (r.email as string).toLowerCase() === email.toLowerCase(),
      );
      return match ? [{ id: match.id }] : [];
    }
    return [{ permission: "write", createdBy: "user_1", agentId: "agent_shin" }];
  }) as never);

  vi.mocked(db.contact.create).mockImplementation((async (args: { data: Row }) => {
    // Schema defaults for anything the caller did not set — this is the whole
    // point: `status` defaults to `active` and `suppressed` to `false`.
    const created: Row = {
      id: `contact_created_${nextId++}`,
      status: "active",
      suppressed: false,
      revision: 0,
      accountId: null,
      entityId: null,
      enrichStatus: null,
      socialLinks: {},
      createdAt: new Date(),
      updatedAt: new Date(),
      ...args.data,
    };
    rows.push(created);
    return created;
  }) as never);

  vi.mocked(db.contact.updateMany).mockImplementation((async (args: { where: Row; data: Row }) => {
    const target = rows.find((r) => matches(r, args.where as Record<string, unknown>));
    if (!target) return { count: 0 };
    for (const [k, v] of Object.entries(args.data)) {
      if (v === undefined) continue;
      if (v && typeof v === "object" && "increment" in (v as Row)) {
        target[k] = (target[k] as number) + (v as { increment: number }).increment;
      } else {
        target[k] = v;
      }
    }
    return { count: 1 };
  }) as never);

  vi.mocked(db.contact.findUniqueOrThrow).mockImplementation((async (args: { where: Row }) => {
    const found = rows.find((r) => matches(r, args.where as Record<string, unknown>));
    if (!found) throw new Error("not found");
    return found;
  }) as never);

  return rows;
}

/** The person who opted out. `status: "unsubscribed"` is what guardrails.ts
 * actually enforces on; `suppressed: true` is the agent surface's column. */
const optedOutContact = (): Row => ({
  id: "contact_optout",
  orgId: ORG,
  name: "Jane Prospect",
  email: "Jane@Acme.com", // stored with capitals, as a real CRM import would
  title: "VP Sales",
  type: "prospect",
  description: null,
  status: "unsubscribed",
  suppressed: true,
  revision: 0,
  accountId: null,
  entityId: null,
  enrichStatus: null,
  socialLinks: {},
  createdAt: new Date(),
  updatedAt: new Date(),
});

/** How many rows in this org belong to the same human, compared the way a
 * human (and `searchContacts`) compares email addresses. */
const rowsForPerson = (rows: Row[], email: string) =>
  rows.filter((r) => r.orgId === ORG && typeof r.email === "string" && r.email.toLowerCase() === email.toLowerCase());

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(db.auditLog.create).mockResolvedValue({ id: "audit_test_id" } as never);
  vi.mocked(db.$transaction).mockImplementation((async (fn: (c: unknown) => unknown) => fn(db)) as never);
  // A live capability with write permission covering org root — the caller is
  // fully authorized. This leak is NOT an access-control failure; it is a
  // correctly-authorized caller getting a result that defeats an opt-out.
  vi.mocked(db.$queryRaw).mockResolvedValue([
    { permission: "write", createdBy: "user_1", agentId: "agent_shin" },
  ] as never);
  vi.mocked(db.contactIdempotencyKey.findUnique).mockResolvedValue(null as never);
  vi.mocked(db.contactIdempotencyKey.create).mockResolvedValue({} as never);
  vi.mocked(db.contactIdempotencyKey.update).mockResolvedValue({} as never);
  // Default to "claim won" / "release succeeded" — this file's fresh-write
  // paths take the claim-at-create branch, not the repair branch, but still
  // call releaseDeliveryClaim if ingestContactWrite ever throws.
  vi.mocked(db.contactIdempotencyKey.updateMany).mockResolvedValue({ count: 1 } as never);
});

describe("suppression preservation across the create path", () => {
  it("does not fork a second, sendable contact when the address differs only by case from an opted-out one", async () => {
    const rows = installContactTable([optedOutContact()]);

    // The agent types the address in lowercase — the same way `contact_search`
    // would have found the opted-out row, since that search is case-insensitive.
    //
    // Deliberately tolerant about HOW this call ends. A correct fix may either
    // resolve the existing row (and then legitimately reject the write for a
    // missing `baseRevision`, which is the surface's own optimistic-concurrency
    // rule doing its job) or refuse the ambiguous write outright. Both are
    // fine. What must NOT happen is a silent second row. Asserting a specific
    // return value here would pin one implementation and, worse, would make
    // this test fail against a genuinely correct one.
    await upsertContact(agentCtx(), {
      idempotencyKey: "dup-key-1",
      name: "Jane Prospect",
      email: "jane@acme.com",
    }).catch(() => undefined);

    const person = rowsForPerson(rows, "jane@acme.com");

    // THE INVARIANT: one human, one row. Whichever way this gets fixed
    // (normalise email on write, match case-insensitively, or reject the
    // ambiguous write outright), a second row must not appear.
    expect(person).toHaveLength(1);

    // And the row that represents this person must still be un-sendable:
    // services/guardrails.ts keys on `status`, so a duplicate defaulting to
    // "active" is what actually re-opens outreach.
    expect(person.every((r) => r.status === "unsubscribed")).toBe(true);
    expect(person.every((r) => r.suppressed === true)).toBe(true);
  });

  // Deliberately NOT asserted here: a name-only upsert (no email) also creates
  // a fresh `active` row next to an opted-out person of the same name. That
  // is not a fair case — two real people can share a name, so deduplicating
  // on name alone would be wrong, and there is no unambiguous behavior to
  // hold the implementation to.
  // The case above is different in kind: `searchContacts` and `upsertContact`
  // in this same module disagree about whether two spellings are the same
  // address, and that disagreement is what forks the row.

  // ── CONTROL: proves the fake is not rigged to always produce a duplicate ──
  it("CONTROL: an exactly-matching address updates the existing row instead of duplicating it", async () => {
    const rows = installContactTable([optedOutContact()]);

    const result = await upsertContact(agentCtx(), {
      idempotencyKey: "dup-key-3",
      email: "Jane@Acme.com", // exact case — what production code matches on today
      baseRevision: 0,
      title: "SVP Sales",
    });

    expect(result.action).toBe("updated");
    expect(rowsForPerson(rows, "jane@acme.com")).toHaveLength(1);
    // Suppression genuinely IS preserved on this path — the existing suite's
    // finding, independently reproduced here.
    expect(rows[0].suppressed).toBe(true);
    expect(rows[0].status).toBe("unsubscribed");
  });
});
