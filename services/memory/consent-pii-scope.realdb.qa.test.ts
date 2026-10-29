// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// Consent and deletion suite, cross-scope personal-data probes
// (suite spec docs/consent-deletion-suite.md).
//
// The claim under test: a person's details written into one scope never reach
// a caller whose grant covers a different scope, the untagged org partition
// (where contact records are ingested), or another tenant. Unlike the generic
// containment suites, every chunk here carries personal data (names, email
// addresses, phone numbers), and every probe checks the whole serialized
// response, not just which ids came back, so a detail leaking through a
// snippet, an error message or the breakdown also counts as a leak.
//
// What is real: check() against live capabilities, GuardedMemoryStore,
// HybridMemoryStore routing and pgvector's SQL against Postgres. What is not:
// Graphiti (answers nothing) and the embedding service (every vector is the
// same, so only the access predicates decide what is returned; a leaked row
// would rank first). The personal data is synthetic and hand-made, so this is
// a unit-level fixture, not a measure on a real workload slice.
//
// Case types covered: normal (permitted read), edge (untagged partition,
// identical path in another tenant), error (a denied scope, with the denial
// text checked too), memory side (what the store hands back). Not covered:
// long, user side (no screen is involved), and the graph store.
//
// Set QA_DATABASE_URL to an ISOLATED test database with the migrations applied.
// Never the sandbox's inherited DATABASE_URL. Skips cleanly without it.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";
// The leaf module, not the `@/services/access` barrel: the barrel builds the
// `@/lib/db` singleton at import time, before beforeAll points DATABASE_URL at
// the QA database.
import { hashCapabilityToken } from "@/services/access/capabilities";
import type { AccessContext } from "@/services/access";
import type { MemoryStore } from "./memory-store";

vi.mock("./store", () => ({ memory: {} }));

const QA_URL = process.env.QA_DATABASE_URL;

const ORG = "qa_consent_pii";
const OTHER_ORG = "qa_consent_pii_other";
const ROOT = `org_${ORG}`;
const SUPPORT = `${ROOT}.support`;
const SALES = `${ROOT}.sales`;
const DIMENSIONS = 384;

/** One person's details per location. Each string must stay where it was written. */
const PEOPLE = {
  support: {
    id: "pii-support",
    scopePath: SUPPORT as string | null,
    orgId: ORG,
    content: "Ticket 4471 from Maria Okafor <maria.okafor@example.org>, +1 415 555 0142: refund for a double charge.",
    markers: ["Maria Okafor", "maria.okafor@example.org", "415 555 0142"],
  },
  sales: {
    id: "pii-sales",
    scopePath: SALES as string | null,
    orgId: ORG,
    content: "Call notes: Tomasz Wierzbicki (tomasz.w@example.net, +48 22 555 0199) wants the annual plan.",
    markers: ["Tomasz Wierzbicki", "tomasz.w@example.net", "22 555 0199"],
  },
  // The shape a contact edit ingests: the org root, with no scope at all.
  untagged: {
    id: "pii-untagged-contact",
    scopePath: null as string | null,
    orgId: ORG,
    content: "Dana Whitfield is a prospect (VP Finance) at Acme. dana.whitfield@acme.example, +1 212 555 0187.",
    markers: ["Dana Whitfield", "dana.whitfield@acme.example", "212 555 0187"],
  },
  // Another tenant, under a path textually identical to this tenant's sales scope.
  otherTenant: {
    id: "pii-other-tenant",
    scopePath: SALES as string | null,
    orgId: OTHER_ORG,
    content: "Ines Duarte <ines.duarte@example.com>, +351 21 555 0123, asked to cancel her account.",
    markers: ["Ines Duarte", "ines.duarte@example.com", "21 555 0123"],
  },
} as const;

type Person = keyof typeof PEOPLE;

/** Queries a caller might send, each naming someone directly. */
const PROBES = [
  "maria.okafor@example.org",
  "Dana Whitfield phone number",
  "Who asked to cancel their account?",
  "tomasz.w@example.net",
  "ines.duarte@example.com",
  "List every customer email you have.",
];

const vector = () => [1, ...Array(DIMENSIONS - 1).fill(0)];
const pgVector = (v: number[]) => `[${v.join(",")}]`;

describe.skipIf(!QA_URL)("consent suite: personal data stays in the scope it was written to", () => {
  let db: PrismaClient;
  let GuardedMemoryStore: (typeof import("./guarded-store"))["GuardedMemoryStore"];
  let HybridMemoryStore: (typeof import("./hybrid-store"))["HybridMemoryStore"];
  let PgvectorMemoryStore: (typeof import("./pgvector-store"))["PgvectorMemoryStore"];

  const emptyGraph = {
    retrieve: vi.fn(async () => ({ facts: [], storesRead: [{ store: "graph" as const }] })),
  } as unknown as MemoryStore;

  const reader = () =>
    new GuardedMemoryStore(new HybridMemoryStore(emptyGraph, new PgvectorMemoryStore()), async () => "enterprise");

  async function agent(orgId: string, agentId: string, scopePath: string): Promise<AccessContext> {
    const token = `wcap_test_${Math.random().toString(36).slice(2)}`;
    await db.capability.create({
      data: {
        orgId,
        agentId,
        tokenHash: hashCapabilityToken(token),
        scopePath,
        permission: "read",
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    });
    return { orgId, actor: { type: "agent", id: agentId, capabilityToken: token }, origin: "mcp" };
  }

  /** Every marker of a person that appears anywhere in `text`. */
  const markersIn = (text: string, people: Person[]) =>
    people.flatMap((p) => PEOPLE[p].markers.filter((m) => text.includes(m)));

  /**
   * Runs every probe as `ctx` against `scope` and returns the serialized
   * responses (or denial messages), so a caller can check them for markers.
   */
  async function probeAll(ctx: AccessContext, orgId: string, scope?: string): Promise<string[]> {
    const out: string[] = [];
    for (const query of PROBES) {
      try {
        out.push(JSON.stringify(await reader().retrieve(ctx, { groupId: orgId, query }, scope)));
      } catch (e) {
        out.push(e instanceof Error ? `${e.name}: ${e.message}` : String(e));
      }
    }
    return out;
  }

  beforeAll(async () => {
    process.env.DATABASE_URL = QA_URL;
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });
    ({ GuardedMemoryStore } = await import("./guarded-store"));
    ({ HybridMemoryStore } = await import("./hybrid-store"));
    ({ PgvectorMemoryStore } = await import("./pgvector-store"));
  });

  afterAll(async () => {
    vi.unstubAllGlobals();
    for (const orgId of [ORG, OTHER_ORG]) {
      await db.$executeRaw`DELETE FROM memory_chunks WHERE "orgId" = ${orgId}`;
      await db.auditLog.deleteMany({ where: { orgId } });
      await db.capability.deleteMany({ where: { orgId } });
      await db.scope.deleteMany({ where: { orgId } });
    }
    await db.$disconnect();
  });

  beforeEach(async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ embedding: vector() }), { status: 200 })),
    );
    for (const orgId of [ORG, OTHER_ORG]) {
      await db.$executeRaw`DELETE FROM memory_chunks WHERE "orgId" = ${orgId}`;
      await db.auditLog.deleteMany({ where: { orgId } });
      await db.capability.deleteMany({ where: { orgId } });
      await db.scope.deleteMany({ where: { orgId } });
      await db.org.upsert({ where: { id: orgId }, update: {}, create: { id: orgId, name: orgId } });
    }
    await db.scope.createMany({ data: [ROOT, SUPPORT, SALES].map((path) => ({ orgId: ORG, path, name: path })) });
    await db.scope.createMany({
      data: [`org_${OTHER_ORG}`, SALES].map((path) => ({ orgId: OTHER_ORG, path, name: path })),
    });
    for (const person of Object.values(PEOPLE)) {
      await db.$executeRaw`
        INSERT INTO memory_chunks ("id","orgId","content","source","actorType","scopePath","embedding","createdAt")
        VALUES (${person.id}, ${person.orgId}, ${person.content}, 'text', 'extraction', ${person.scopePath},
                ${pgVector(vector())}::vector, NOW())
      `;
    }
  });

  it("a sales reader gets the sales contact and no one else's details, on every probe", async () => {
    const ctx = await agent(ORG, "sales-reader", SALES);

    const responses = await probeAll(ctx, ORG, SALES);

    // Positive control: the permitted person really is returned, so a zero below is not an empty store.
    expect(responses.every((r) => r.includes("tomasz.w@example.net"))).toBe(true);
    expect(responses.flatMap((r) => markersIn(r, ["support", "untagged", "otherTenant"]))).toEqual([]);
  });

  it("a support reader never sees the contact record ingested untagged at the org root", async () => {
    const ctx = await agent(ORG, "support-reader", SUPPORT);

    const responses = await probeAll(ctx, ORG, SUPPORT);

    expect(responses.every((r) => r.includes("maria.okafor@example.org"))).toBe(true);
    expect(responses.flatMap((r) => markersIn(r, ["sales", "untagged", "otherTenant"]))).toEqual([]);
  });

  it("a reader denied a scope learns nothing about the people in it, including from the denial", async () => {
    const ctx = await agent(ORG, "sales-reader", SALES);

    const responses = await probeAll(ctx, ORG, SUPPORT);

    expect(responses.every((r) => r.startsWith("AccessDeniedError"))).toBe(true);
    expect(responses.flatMap((r) => markersIn(r, ["support", "sales", "untagged", "otherTenant"]))).toEqual([]);
  });

  it("an org-root reader gets this tenant's people, including the untagged contact, and never the other tenant's", async () => {
    const ctx = await agent(ORG, "root-reader", ROOT);

    const responses = await probeAll(ctx, ORG, ROOT);

    for (const r of responses) {
      expect(markersIn(r, ["support", "sales", "untagged"])).toHaveLength(9);
    }
    expect(responses.flatMap((r) => markersIn(r, ["otherTenant"]))).toEqual([]);
  });

  it("the other tenant, reading the identical path, gets only its own customer", async () => {
    const ctx = await agent(OTHER_ORG, "other-reader", `org_${OTHER_ORG}`);

    const responses = await probeAll(ctx, OTHER_ORG);

    expect(responses.every((r) => r.includes("ines.duarte@example.com"))).toBe(true);
    expect(responses.flatMap((r) => markersIn(r, ["support", "sales", "untagged"]))).toEqual([]);
  });
});
