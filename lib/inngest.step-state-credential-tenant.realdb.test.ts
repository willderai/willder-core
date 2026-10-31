// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// The listing step's credential loader stays tenant-scoped, and the PostHog
// branch keeps its credential out of step state too.
//
// `loadScopedSourceCredential` is the only loader that returns the sealed
// `encryptedTokens`. It must refuse a caller from another org exactly as
// `loadScopedSource` does, and it must still carry `meta`, which PostHog needs for
// its project id and host. The GitHub-only suite next to this file covers
// neither: dropping the org from this loader's `where`, or `meta` from its
// `select`, leaves that suite green.
//
// Set QA_DATABASE_URL to an ISOLATED test database. Never the sandbox's inherited
// DATABASE_URL, which points at live Neon. Skips cleanly without it.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";
import { deleteOrgsWithRetry } from "@/lib/org-cleanup.testsupport";

const API_KEY = "phx_step_state_tenant";

const posthogCalls: Array<{ projectId: string; insightId: string; apiKey: string; host: string }> = [];

vi.mock("@/services/memory/store", () => {
  let nextId = 0;
  return {
    memory: { ingest: async () => ({ episodeId: `episode-${++nextId}` }) },
    graphitiStore: {
      removeGroupFacts: async () => ({ removedCount: 0 }),
      removeEpisode: async () => ({ removed: true }),
      dedupeNodes: async () => 0,
    },
  };
});
vi.mock("@/services/guardrails", () => ({
  checkEpisodeCap: async () => undefined,
  recordEpisode: async () => undefined,
}));
vi.mock("@/services/connectors/posthog", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/connectors/posthog")>();
  return {
    ...actual,
    fetchInsightSnapshot: async (projectId: string, insightId: string, apiKey: string, host: string) => {
      posthogCalls.push({ projectId, insightId, apiKey, host });
      return [{ id: `insight-${insightId}`, text: "Weekly signups: 42", checksum: "p1" }];
    },
  };
});

const QA_URL = process.env.QA_DATABASE_URL;

const ORG_A = "org-qa-credential-tenant-a";
const ORG_B = "org-qa-credential-tenant-b";
const SOURCE_A = "src-qa-credential-tenant-a";
const SOURCE_B = "src-qa-credential-tenant-b";
const SCOPE_A = "org_qa.credential_tenant_a";
const SCOPE_B = "org_qa.credential_tenant_b";

type StepCtx = {
  event: { data: unknown };
  step: { run: <T>(name: string, fn: () => Promise<T> | T) => Promise<T> };
};

describe.skipIf(!QA_URL)("connector sync credential loader", () => {
  let db: PrismaClient;
  let handler: (ctx: StepCtx) => Promise<Record<string, unknown>>;
  let loadScopedSourceCredential: (typeof import("@/lib/inngest/connector-sync"))["loadScopedSourceCredential"];
  let sealedA: string;
  let sealedB: string;

  beforeAll(async () => {
    // Before the imports, so the `@/lib/db` singleton is built against the QA database.
    process.env.DATABASE_URL = QA_URL;
    vi.stubEnv("APP_ENCRYPTION_KEY", "0".repeat(64));
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });
    const inngestModule = await import("@/lib/inngest");
    handler = (inngestModule.sourceSync as unknown as { fn: typeof handler }).fn;
    ({ loadScopedSourceCredential } = await import("@/lib/inngest/connector-sync"));
    const { sealSecret } = await import("@/lib/crypto");
    sealedA = sealSecret({ apiKey: API_KEY });
    sealedB = sealSecret({ token: "github_pat_other_tenant" });
  });

  const cleanup = async () => {
    await db.changeEvent.deleteMany({ where: { orgId: { in: [ORG_A, ORG_B] } } });
    await deleteOrgsWithRetry(db, { where: { id: { in: [ORG_A, ORG_B] } } });
  };

  afterAll(async () => {
    await cleanup();
    await db.$disconnect();
  });

  beforeEach(async () => {
    posthogCalls.length = 0;
    await cleanup();
    await db.org.create({ data: { id: ORG_A, name: ORG_A } });
    await db.org.create({ data: { id: ORG_B, name: ORG_B } });
    await db.scope.create({ data: { orgId: ORG_A, path: SCOPE_A, name: "growth" } });
    await db.scope.create({ data: { orgId: ORG_B, path: SCOPE_B, name: "pricing" } });
    await db.source.create({
      data: {
        id: SOURCE_A,
        orgId: ORG_A,
        type: "posthog",
        externalId: "123:456",
        name: "Weekly signups",
        scopePath: SCOPE_A,
        encryptedTokens: sealedA,
        meta: { projectId: "123", host: "https://eu.posthog.com" },
      },
    });
    await db.source.create({
      data: {
        id: SOURCE_B,
        orgId: ORG_B,
        type: "github",
        externalId: "acme/pricing",
        name: "acme/pricing",
        scopePath: SCOPE_B,
        encryptedTokens: sealedB,
      },
    });
  });

  it("returns each org its own credential and refuses the other org's caller", async () => {
    await expect(loadScopedSourceCredential(SOURCE_A, ORG_A)).resolves.toMatchObject({
      id: SOURCE_A,
      encryptedTokens: sealedA,
    });
    await expect(loadScopedSourceCredential(SOURCE_B, ORG_B)).resolves.toMatchObject({
      id: SOURCE_B,
      encryptedTokens: sealedB,
    });

    await expect(loadScopedSourceCredential(SOURCE_A, ORG_B)).rejects.toThrow();
    await expect(loadScopedSourceCredential(SOURCE_B, ORG_A)).rejects.toThrow();
  });

  it("syncs a PostHog source with its stored key and host, and persists no ciphertext in step state", async () => {
    const persisted = new Map<string, unknown>();
    const result = await handler({
      event: { data: { sourceId: SOURCE_A, orgId: ORG_A } },
      step: {
        run: async (name, fn) => {
          const out = await fn();
          persisted.set(name, out);
          return out;
        },
      },
    });

    expect(result).toMatchObject({ synced: 1, failed: 0, disconnected: false });
    expect(posthogCalls).toEqual([
      { projectId: "123", insightId: "456", apiKey: API_KEY, host: "https://eu.posthog.com" },
    ]);
    expect(persisted.get("load-source")).not.toHaveProperty("encryptedTokens");
    expect(JSON.stringify([...persisted])).not.toContain(sealedA);
  });
});
