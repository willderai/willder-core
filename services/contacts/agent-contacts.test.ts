import { beforeEach, describe, expect, it, vi } from "vitest";

// Same mocking convention as services/memory/fact-provenance.test.ts: check()
// (called from requireContactAccess) hits db.$queryRaw (capability lookup) +
// db.auditLog.create; contact/idempotency-key state lives on db.contact /
// db.contactIdempotencyKey. db.$transaction just invokes its callback with
// the same mocked client, so tx.contact.* and db.contact.* are one mock.
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
import { ingestMemory } from "@/lib/inngest";
import { searchContacts, getContact, upsertContact, ContactUpsertError } from "./agent-contacts";
import { AccessDeniedError, type AccessContext } from "@/services/access";

const ORG = "org_1";

const agentCtx = (): AccessContext => ({
  orgId: ORG,
  actor: { type: "agent", id: "agent_shin", capabilityToken: "wcap_test" },
  origin: "mcp",
});

/** A live, owned capability row covering `scopePath` with `permission` — the
 * shape check()'s evaluate() reads off db.$queryRaw for an agent actor
 * (services/access/check.ts, capabilityQuery). Matches check.test.ts's own
 * `rows()` convention. */
const capabilityRow = (permission: "read" | "write" | "admin", agentId = "agent_shin") => [
  { permission, createdBy: "user_1", agentId },
];
const noCapability = () => [];

function baseContact(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "contact_1",
    orgId: ORG,
    accountId: null,
    name: "Jane Prospect",
    email: "jane@acme.com",
    title: "VP Sales",
    type: "prospect",
    description: null,
    socialLinks: {},
    status: "active",
    entityId: null,
    enrichStatus: null,
    revision: 0,
    suppressed: false,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(db.auditLog.create).mockResolvedValue({ id: "audit_test_id" } as never);
  // Default: run the transaction callback against the same mocked client.
  vi.mocked(db.$transaction).mockImplementation(async (fn) => fn(db as never));
  // A real accepted write marks its ledger row ingested once the graph sync
  // lands. Default success so tests that don't care about this marking don't
  // have to know it happens.
  vi.mocked(db.contactIdempotencyKey.update).mockResolvedValue({} as never);
  // Default to "claim won" / "release succeeded" so tests that don't exercise
  // the repair path don't have to know the delivery claim exists.
  vi.mocked(db.contactIdempotencyKey.updateMany).mockResolvedValue({ count: 1 } as never);
});

describe("searchContacts / getContact — access gate", () => {
  it("returns matches for a capability whose scope covers org root (happy path search)", async () => {
    vi.mocked(db.$queryRaw).mockResolvedValueOnce(capabilityRow("read") as never);
    vi.mocked(db.contact.findMany).mockResolvedValue([baseContact()] as never);

    const results = await searchContacts(agentCtx(), { query: "jane" });

    expect(results).toEqual([
      expect.objectContaining({ id: "contact_1", name: "Jane Prospect", suppressed: false, revision: 0 }),
    ]);
    expect(db.contact.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ orgId: ORG }) }),
    );
  });

  it("fetches a single contact by id, tenant-scoped (happy path read)", async () => {
    vi.mocked(db.$queryRaw).mockResolvedValueOnce(capabilityRow("read") as never);
    vi.mocked(db.contact.findFirst).mockResolvedValue(baseContact() as never);

    const result = await getContact(agentCtx(), "contact_1");

    expect(result?.id).toBe("contact_1");
    expect(db.contact.findFirst).toHaveBeenCalledWith({ where: { id: "contact_1", orgId: ORG } });
  });

  it("returns null for a contact belonging to another tenant, indistinguishable from not-found", async () => {
    vi.mocked(db.$queryRaw).mockResolvedValueOnce(capabilityRow("read") as never);
    vi.mocked(db.contact.findFirst).mockResolvedValue(null as never);

    const result = await getContact(agentCtx(), "contact_other_org");
    expect(result).toBeNull();
  });

  // The real leak-scenario test the standing access-control rule requires: a
  // capability token whose scope does NOT cover the org root must be denied
  // outright, never allowed to search/read contacts at all.
  it("denies search for a capability scoped to a narrower, non-org-root scope (out-of-scope tenant denial)", async () => {
    vi.mocked(db.$queryRaw).mockResolvedValueOnce(noCapability() as never);

    await expect(searchContacts(agentCtx(), { query: "jane" })).rejects.toThrow(AccessDeniedError);
    expect(db.contact.findMany).not.toHaveBeenCalled();
  });

  it("denies read for an out-of-scope capability, same as search", async () => {
    vi.mocked(db.$queryRaw).mockResolvedValueOnce(noCapability() as never);

    await expect(getContact(agentCtx(), "contact_1")).rejects.toThrow(AccessDeniedError);
    expect(db.contact.findFirst).not.toHaveBeenCalled();
  });

  it("still surfaces a suppressed contact in search results, flagged, not hidden", async () => {
    vi.mocked(db.$queryRaw).mockResolvedValueOnce(capabilityRow("read") as never);
    vi.mocked(db.contact.findMany).mockResolvedValue([baseContact({ suppressed: true })] as never);

    const results = await searchContacts(agentCtx(), { query: "jane" });
    expect(results[0].suppressed).toBe(true);
  });
});

describe("upsertContact", () => {
  it("creates a new contact when no existing match (happy path upsert, create)", async () => {
    vi.mocked(db.$queryRaw).mockResolvedValueOnce(capabilityRow("write") as never);
    vi.mocked(db.contactIdempotencyKey.findUnique).mockResolvedValue(null as never);
    // The LOWER()-equality email-match lookup (raw SQL, not contact.findFirst
    // — see agent-contacts.ts) finds no row.
    vi.mocked(db.$queryRaw).mockResolvedValueOnce([] as never);
    const created = baseContact({ id: "contact_new", revision: 0 });
    vi.mocked(db.contact.create).mockResolvedValue(created as never);
    vi.mocked(db.contactIdempotencyKey.create).mockResolvedValue({} as never);

    const result = await upsertContact(agentCtx(), {
      idempotencyKey: "key-1",
      name: "Jane Prospect",
      email: "jane@acme.com",
    });

    expect(result.action).toBe("created");
    expect(result.contact.id).toBe("contact_new");
    expect(db.contact.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ orgId: ORG, name: "Jane Prospect", email: "jane@acme.com" }),
      }),
    );
    // suppressed is never explicitly written on create.
    const createData = vi.mocked(db.contact.create).mock.calls[0][0].data as Record<string, unknown>;
    expect(createData).not.toHaveProperty("suppressed");
  });

  it("updates an existing contact when baseRevision matches (happy path upsert, update)", async () => {
    vi.mocked(db.$queryRaw).mockResolvedValueOnce(capabilityRow("write") as never);
    vi.mocked(db.contactIdempotencyKey.findUnique).mockResolvedValue(null as never);
    const existing = baseContact({ revision: 3 });
    vi.mocked(db.contact.findFirst).mockResolvedValue(existing as never);
    vi.mocked(db.contact.updateMany).mockResolvedValue({ count: 1 } as never);
    vi.mocked(db.contact.findUniqueOrThrow).mockResolvedValue(
      baseContact({ revision: 4, title: "SVP Sales" }) as never,
    );
    vi.mocked(db.contactIdempotencyKey.create).mockResolvedValue({} as never);

    const result = await upsertContact(agentCtx(), {
      idempotencyKey: "key-2",
      contactId: "contact_1",
      baseRevision: 3,
      title: "SVP Sales",
    });

    expect(result.action).toBe("updated");
    expect(result.contact.revision).toBe(4);
    expect(db.contact.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "contact_1", orgId: ORG, revision: 3 } }),
    );
  });

  it("denies upsert for a capability whose scope does not cover org root (out-of-scope tenant denial)", async () => {
    vi.mocked(db.$queryRaw).mockResolvedValueOnce(noCapability() as never);

    await expect(
      upsertContact(agentCtx(), { idempotencyKey: "key-3", name: "Jane", email: "jane@acme.com" }),
    ).rejects.toThrow(AccessDeniedError);
    expect(db.contactIdempotencyKey.findUnique).not.toHaveBeenCalled();
    expect(db.contact.create).not.toHaveBeenCalled();
  });

  // Core requirement: a contact already suppressed must stay suppressed no
  // matter what this surface writes, and the write it issues must never even
  // attempt to touch the field.
  it("never clears suppressed on an existing suppressed contact, and never writes the field at all", async () => {
    vi.mocked(db.$queryRaw).mockResolvedValueOnce(capabilityRow("write") as never);
    vi.mocked(db.contactIdempotencyKey.findUnique).mockResolvedValue(null as never);
    const suppressedExisting = baseContact({ suppressed: true, revision: 1 });
    vi.mocked(db.contact.findFirst).mockResolvedValue(suppressedExisting as never);
    vi.mocked(db.contact.updateMany).mockResolvedValue({ count: 1 } as never);
    vi.mocked(db.contact.findUniqueOrThrow).mockResolvedValue(
      baseContact({ suppressed: true, revision: 2, title: "New Title" }) as never,
    );
    vi.mocked(db.contactIdempotencyKey.create).mockResolvedValue({} as never);

    const result = await upsertContact(agentCtx(), {
      idempotencyKey: "key-4",
      contactId: "contact_1",
      baseRevision: 1,
      title: "New Title",
    });

    expect(result.contact.suppressed).toBe(true);
    const updateData = vi.mocked(db.contact.updateMany).mock.calls[0][0].data as Record<string, unknown>;
    expect(updateData).not.toHaveProperty("suppressed");
  });

  it("rejects a stale baseRevision (optimistic concurrency) without applying any write", async () => {
    vi.mocked(db.$queryRaw).mockResolvedValueOnce(capabilityRow("write") as never);
    vi.mocked(db.contactIdempotencyKey.findUnique).mockResolvedValue(null as never);
    vi.mocked(db.contact.findFirst).mockResolvedValue(baseContact({ revision: 5 }) as never);
    // The WHERE clause names revision:3 but the row is actually at 5 — a real
    // DB would match 0 rows, exactly what updateMany({count:0}) simulates.
    vi.mocked(db.contact.updateMany).mockResolvedValue({ count: 0 } as never);

    await expect(
      upsertContact(agentCtx(), {
        idempotencyKey: "key-5",
        contactId: "contact_1",
        baseRevision: 3,
        title: "Stale Write",
      }),
    ).rejects.toMatchObject({ code: "stale_revision" });

    expect(db.contactIdempotencyKey.create).not.toHaveBeenCalled();
    expect(db.contact.findUniqueOrThrow).not.toHaveBeenCalled();
  });

  it("requires baseRevision when updating an existing contact", async () => {
    vi.mocked(db.$queryRaw).mockResolvedValueOnce(capabilityRow("write") as never);
    vi.mocked(db.contactIdempotencyKey.findUnique).mockResolvedValue(null as never);
    vi.mocked(db.contact.findFirst).mockResolvedValue(baseContact() as never);

    await expect(
      upsertContact(agentCtx(), { idempotencyKey: "key-6", contactId: "contact_1", title: "No revision given" }),
    ).rejects.toMatchObject({ code: "revision_required" });
    expect(db.contact.updateMany).not.toHaveBeenCalled();
  });

  // Core requirement: a safe retry (same idempotencyKey, same request) must
  // never re-apply the write — it must return the original outcome verbatim.
  it("replays the original result for a repeated idempotencyKey, without writing again", async () => {
    // Recompute the exact fingerprint the implementation would have stored,
    // by first letting a real (non-idempotent) call establish it — simpler
    // and more honest than duplicating requestFingerprint's hashing here: run
    // the same input through once "for real" to capture its hash, then feed
    // that same hash back as the stored row for the replay case.
    const input = { idempotencyKey: "key-7", name: "Jane Prospect", email: "jane@acme.com" };
    // First call: establishes the real fingerprint by actually creating.
    vi.mocked(db.$queryRaw).mockResolvedValueOnce(capabilityRow("write") as never);
    vi.mocked(db.contactIdempotencyKey.findUnique).mockResolvedValueOnce(null as never);
    // The LOWER()-equality email-match lookup (raw SQL) finds no row.
    vi.mocked(db.$queryRaw).mockResolvedValueOnce([] as never);
    vi.mocked(db.contact.create).mockResolvedValue(baseContact({ id: "contact_1" }) as never);
    let storedHash = "";
    vi.mocked(db.contactIdempotencyKey.create).mockImplementation((async (args: unknown) => {
      storedHash = (args as { data: { requestHash: string } }).data.requestHash;
      return {};
    }) as never);
    const first = await upsertContact(agentCtx(), input);
    expect(first.action).toBe("created");
    expect(db.contact.create).toHaveBeenCalledTimes(1);

    // Second call: idempotencyKey now resolves to the stored row up front —
    // must short-circuit before touching contact.create/updateMany again.
    vi.clearAllMocks();
    vi.mocked(db.$transaction).mockImplementation(async (fn) => fn(db as never));
    vi.mocked(db.$queryRaw).mockResolvedValueOnce(capabilityRow("write") as never);
    // A snapshot deliberately DIFFERENT from the live row (title changed,
    // revision bumped) — proves replay returns the frozen recorded outcome,
    // not whatever the row looks like now. If this ever reads live data
    // instead, this test would fail on the title/revision assertions below
    // even though contact.findFirst is also asserted uncalled.
    vi.mocked(db.contactIdempotencyKey.findUnique).mockResolvedValue({
      orgId: ORG,
      key: "key-7",
      requestHash: storedHash,
      contactId: "contact_1",
      resultAction: "created",
      resultRevision: 0,
      resultSnapshot: {
        id: "contact_1",
        name: "Jane Prospect",
        email: "jane@acme.com",
        title: "VP Sales",
        type: "prospect",
        status: "active",
        suppressed: false,
        revision: 0,
      },
      createdAt: new Date(),
      // Already synced by the original call — this test is about
      // replay-uses-snapshot, not ingestion repair; a null here would make
      // the replay re-attempt the sync and break the "nor does a replay
      // re-sync the graph" assertion below for the wrong reason.
      ingestedAt: new Date(),
    } as never);
    // A later, unrelated edit changed the live row — must not leak into the replay.
    vi.mocked(db.contact.findFirst).mockResolvedValue(
      baseContact({ id: "contact_1", title: "Someone Else's Later Edit", revision: 9 }) as never,
    );

    const second = await upsertContact(agentCtx(), input);

    expect(second).toEqual({
      action: "created",
      contact: expect.objectContaining({ id: "contact_1", title: "VP Sales", revision: 0 }),
    });
    expect(db.contact.create).not.toHaveBeenCalled();
    expect(db.contact.updateMany).not.toHaveBeenCalled();
    // Replay never needs the live row at all — a hard-deleted contact
    // must still replay cleanly.
    expect(db.contact.findFirst).not.toHaveBeenCalled();
    // Nor does a replay re-sync the memory graph — only the original real
    // write does that.
    expect(ingestMemory).not.toHaveBeenCalled();
    // The replay path doesn't even need the write-permission gate re-derived
    // from a fresh capability lookup to differ — but it must still have
    // checked access before returning (never skip the gate for a cached hit).
    expect(db.$queryRaw).toHaveBeenCalled();
  });

  it("rejects the same idempotencyKey reused for a genuinely different request (not a safe retry)", async () => {
    vi.mocked(db.$queryRaw).mockResolvedValueOnce(capabilityRow("write") as never);
    vi.mocked(db.contactIdempotencyKey.findUnique).mockResolvedValue({
      orgId: ORG,
      key: "key-8",
      requestHash: "hash-of-a-different-request",
      contactId: "contact_1",
      resultAction: "created",
      resultRevision: 0,
      createdAt: new Date(),
    } as never);

    await expect(
      upsertContact(agentCtx(), { idempotencyKey: "key-8", name: "Someone Else", email: "someone@acme.com" }),
    ).rejects.toMatchObject({ code: "idempotency_conflict" });
    expect(db.contact.create).not.toHaveBeenCalled();
  });

  it("requires idempotencyKey", async () => {
    vi.mocked(db.$queryRaw).mockResolvedValueOnce(capabilityRow("write") as never);
    await expect(upsertContact(agentCtx(), { idempotencyKey: "  ", name: "Jane" } as never)).rejects.toMatchObject({
      code: "invalid_input",
    });
  });

  it("rejects an id that doesn't exist in this tenant rather than silently creating one", async () => {
    vi.mocked(db.$queryRaw).mockResolvedValueOnce(capabilityRow("write") as never);
    vi.mocked(db.contactIdempotencyKey.findUnique).mockResolvedValue(null as never);
    vi.mocked(db.contact.findFirst).mockResolvedValue(null as never);

    await expect(
      upsertContact(agentCtx(), { idempotencyKey: "key-9", contactId: "does_not_exist", baseRevision: 0 }),
    ).rejects.toMatchObject({ code: "not_found" });
    expect(db.contact.create).not.toHaveBeenCalled();
  });

  // The MCP tool's zod schema is not the only gate on this field: this
  // surface's own function validates it too, so a non-MCP caller cannot
  // bypass the vocabulary.
  it("rejects a type outside CONTACT_TYPES", async () => {
    vi.mocked(db.$queryRaw).mockResolvedValueOnce(capabilityRow("write") as never);

    await expect(
      upsertContact(agentCtx(), { idempotencyKey: "key-11", name: "Jane", type: "not_a_real_type" as never }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    // Fails before ever touching the idempotency ledger or the DB.
    expect(db.contactIdempotencyKey.findUnique).not.toHaveBeenCalled();
    expect(db.contact.create).not.toHaveBeenCalled();
  });

  it("accepts every CONTACT_TYPES value", async () => {
    vi.mocked(db.$queryRaw).mockResolvedValue(capabilityRow("write") as never);
    vi.mocked(db.contactIdempotencyKey.findUnique).mockResolvedValue(null as never);
    vi.mocked(db.contact.create).mockImplementation((async (args: { data: Record<string, unknown> }) =>
      baseContact({ id: "contact_type_test", type: args.data.type })) as never);
    vi.mocked(db.contactIdempotencyKey.create).mockResolvedValue({} as never);

    for (const type of ["prospect", "customer", "investor", "partner", "advisor", "vendor", "team", "other"] as const) {
      await expect(
        upsertContact(agentCtx(), { idempotencyKey: `key-type-${type}`, name: "Jane", type }),
      ).resolves.toMatchObject({ action: "created" });
    }
  });

  // Two concurrent retries under the SAME idempotencyKey must not leave the
  // loser seeing a raw stale_revision error instead of the winner's recorded
  // outcome: no data is lost or duplicated, so the loser replays.
  it("replays the winner's recorded result for a concurrent retry that loses the revision race under the same idempotencyKey", async () => {
    const input = { idempotencyKey: "key-10", contactId: "contact_1", baseRevision: 5, title: "Concurrent Retry" };

    // Establish the real fingerprint + recorded snapshot via a normal,
    // successful update — the "winner" of the race.
    vi.mocked(db.$queryRaw).mockResolvedValueOnce(capabilityRow("write") as never);
    vi.mocked(db.contactIdempotencyKey.findUnique).mockResolvedValueOnce(null as never);
    vi.mocked(db.contact.findFirst).mockResolvedValue(baseContact({ revision: 5 }) as never);
    vi.mocked(db.contact.updateMany).mockResolvedValue({ count: 1 } as never);
    vi.mocked(db.contact.findUniqueOrThrow).mockResolvedValue(
      baseContact({ revision: 6, title: "Concurrent Retry" }) as never,
    );
    let storedHash = "";
    let storedSnapshot: unknown = null;
    vi.mocked(db.contactIdempotencyKey.create).mockImplementation((async (args: unknown) => {
      const data = (args as { data: { requestHash: string; resultSnapshot: unknown } }).data;
      storedHash = data.requestHash;
      storedSnapshot = data.resultSnapshot;
      return {};
    }) as never);
    const winner = await upsertContact(agentCtx(), input);
    expect(winner.action).toBe("updated");

    // The "loser": checked the ledger before the transaction (same as the
    // winner) and found nothing yet, but by the time its own updateMany ran,
    // the winner had already advanced revision 5 -> 6, so its WHERE
    // revision:5 legitimately matches 0 rows — and by then the winner's
    // transaction has committed, so the key IS recorded when re-checked.
    vi.clearAllMocks();
    vi.mocked(db.$transaction).mockImplementation(async (fn) => fn(db as never));
    vi.mocked(db.$queryRaw).mockResolvedValueOnce(capabilityRow("write") as never);
    vi.mocked(db.contactIdempotencyKey.findUnique)
      .mockResolvedValueOnce(null as never)
      .mockResolvedValueOnce({
        orgId: ORG,
        key: "key-10",
        requestHash: storedHash,
        contactId: "contact_1",
        resultAction: "updated",
        resultRevision: 6,
        resultSnapshot: storedSnapshot,
        createdAt: new Date(),
        // The winner's own real call already synced this above — reflect
        // that here so the loser's replay doesn't re-attempt an ingestion
        // that genuinely already succeeded (this test is about the race
        // replay, not ingestion repair).
        ingestedAt: new Date(),
      } as never);
    vi.mocked(db.contact.findFirst).mockResolvedValue(baseContact({ revision: 5 }) as never);
    vi.mocked(db.contact.updateMany).mockResolvedValue({ count: 0 } as never);

    const loser = await upsertContact(agentCtx(), input);

    expect(loser).toEqual(winner);
    expect(db.contact.create).not.toHaveBeenCalled();
    expect(db.contactIdempotencyKey.create).not.toHaveBeenCalled();
  });

  // CONTROL for the test above: a stale_revision from a genuinely different
  // idempotencyKey (no matching ledger row at all) must still propagate as a
  // real error, not get silently swallowed into a replay of someone else's
  // result.
  it("still rejects a genuinely stale baseRevision when no idempotency key was ever recorded", async () => {
    vi.mocked(db.$queryRaw).mockResolvedValueOnce(capabilityRow("write") as never);
    vi.mocked(db.contactIdempotencyKey.findUnique).mockResolvedValue(null as never);
    vi.mocked(db.contact.findFirst).mockResolvedValue(baseContact({ revision: 5 }) as never);
    vi.mocked(db.contact.updateMany).mockResolvedValue({ count: 0 } as never);

    await expect(
      upsertContact(agentCtx(), {
        idempotencyKey: "key-12",
        contactId: "contact_1",
        baseRevision: 3,
        title: "Really Stale",
      }),
    ).rejects.toMatchObject({ code: "stale_revision" });
  });
});

describe("ContactUpsertError", () => {
  it("carries a stable machine-readable code", () => {
    const e = new ContactUpsertError("stale_revision", "test");
    expect(e.code).toBe("stale_revision");
    expect(e.name).toBe("ContactUpsertError");
  });
});
