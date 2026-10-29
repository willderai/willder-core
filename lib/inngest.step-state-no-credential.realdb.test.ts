// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// A connector sync never writes the source's sealed credential into Inngest
// step state.
//
// Inngest persists every `step.run` return value and replays it on later
// attempts. `sourceSync`'s `load-source` step returns the `Source` row it
// loaded, so whatever that row carries is stored outside the database. The
// sealed `encryptedTokens` ciphertext has no reader there: only the listing
// step unseals it, and that step returns the listing, not the row.
//
// The real `sourceSync` job runs against Postgres with real sealing (lib/crypto).
// GitHub and Graphiti are doubles. The step runner records every step's return
// value the way Inngest would persist it, and the test searches that record for
// the ciphertext.
//
// Set QA_DATABASE_URL to an ISOLATED test database. Never the sandbox's inherited
// DATABASE_URL, which points at live Neon. Skips cleanly without it.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";

const TOKEN = "github_pat_step_state";

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
vi.mock("@/services/connectors/github", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/connectors/github")>();
  return {
    ...actual,
    listRepositoryItems: async (_repo: string, token: string) => {
      if (token !== TOKEN)
        throw new actual.GitHubConnectorError("GitHub /repos/acme/pricing failed: 401 Bad credentials");
      return { items: [{ id: "README.md", text: "Deploys run from main.", checksum: "r1" }], unreadable: [] };
    },
  };
});

const QA_URL = process.env.QA_DATABASE_URL;

const ORG = "org-qa-step-state-credential";
const OTHER_ORG = "org-qa-step-state-credential-other";
const SOURCE_ID = "src-qa-step-state-credential";
const SCOPE = "org_qa.step_state_credential";

type StepCtx = {
  event: { data: unknown };
  step: { run: <T>(name: string, fn: () => Promise<T> | T) => Promise<T> };
};

describe.skipIf(!QA_URL)("connector sync step state", () => {
  let db: PrismaClient;
  let handler: (ctx: StepCtx) => Promise<Record<string, unknown>>;
  let loadScopedSource: (typeof import("@/lib/inngest/connector-sync"))["loadScopedSource"];
  let sealed: string;

  beforeAll(async () => {
    // Before the imports, so the `@/lib/db` singleton is built against the QA database.
    process.env.DATABASE_URL = QA_URL;
    vi.stubEnv("APP_ENCRYPTION_KEY", "0".repeat(64));
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });
    const inngestModule = await import("@/lib/inngest");
    handler = (inngestModule.sourceSync as unknown as { fn: typeof handler }).fn;
    ({ loadScopedSource } = await import("@/lib/inngest/connector-sync"));
    const { sealSecret } = await import("@/lib/crypto");
    sealed = sealSecret({ token: TOKEN });
  });

  afterAll(async () => {
    await db.changeEvent.deleteMany({ where: { orgId: { in: [ORG, OTHER_ORG] } } });
    await db.org.deleteMany({ where: { id: { in: [ORG, OTHER_ORG] } } });
    await db.$disconnect();
  });

  beforeEach(async () => {
    await db.changeEvent.deleteMany({ where: { orgId: { in: [ORG, OTHER_ORG] } } });
    await db.org.deleteMany({ where: { id: { in: [ORG, OTHER_ORG] } } });
    await db.org.create({ data: { id: ORG, name: ORG } });
    await db.org.create({ data: { id: OTHER_ORG, name: OTHER_ORG } });
    await db.scope.create({ data: { orgId: ORG, path: SCOPE, name: "pricing" } });
    await db.source.create({
      data: {
        id: SOURCE_ID,
        orgId: ORG,
        type: "github",
        externalId: "acme/pricing",
        name: "acme/pricing",
        scopePath: SCOPE,
        encryptedTokens: sealed,
      },
    });
  });

  /** Run the sync once, keeping every step's return value as Inngest would persist it. */
  const runSync = async () => {
    const persisted = new Map<string, unknown>();
    const result = await handler({
      event: { data: { sourceId: SOURCE_ID, orgId: ORG } },
      step: {
        run: async (name, fn) => {
          const out = await fn();
          persisted.set(name, out);
          return out;
        },
      },
    });
    return { result, persisted };
  };

  it("completes the sync without persisting the sealed credential in any step's output", async () => {
    const { result, persisted } = await runSync();

    // Synced, so the listing still read and unsealed the stored credential.
    expect(result).toMatchObject({ synced: 1, failed: 0, disconnected: false });
    expect(persisted.has("load-source")).toBe(true);
    expect(JSON.stringify([...persisted])).not.toContain(sealed);
    expect(persisted.get("load-source")).not.toHaveProperty("encryptedTokens");
  });

  it("loads the source for its own org and refuses another org's caller", async () => {
    await expect(loadScopedSource(SOURCE_ID, ORG)).resolves.toMatchObject({ id: SOURCE_ID, orgId: ORG });
    await expect(loadScopedSource(SOURCE_ID, OTHER_ORG)).rejects.toThrow();
  });
});
