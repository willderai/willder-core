// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// A Slack, Figma or PostHog sync that fails, against a real database.
//
// The claim under test: when the provider answers a sync with an error that is not
// lost access, the source is marked `error` with a line naming the fix in
// `Source.meta.error`, and nothing the provider sent, a token included, is stored
// on the row. The error rethrown to Inngest still carries the provider's answer, so
// retries and the run history keep it.
//
// The real connectors build the errors (only `fetch` is a double, and its every
// answer carries a token-shaped string), and the real `sourceSync` job writes the
// `Source` row in Postgres. lib/inngest/sync-failure-message.test.ts holds every
// status and code; this file proves the job stores what the mapper says.
//
// Set QA_DATABASE_URL to an ISOLATED test database, never the inherited DATABASE_URL.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";
import { deleteOrgsWithRetry } from "@/lib/org-cleanup.testsupport";

// The mock flags are read when the connectors are imported; the real branches are the ones under test.
vi.hoisted(() => {
  vi.stubEnv("SLACK_MOCK", "false");
  vi.stubEnv("FIGMA_MOCK", "false");
});
vi.mock("@/services/memory/store", () => ({
  memory: { ingest: async () => ({ episodeId: "episode" }) },
  graphitiStore: {
    removeGroupFacts: async () => ({ removedCount: 0 }),
    removeEpisode: async () => ({ removed: false }),
    dedupeNodes: async () => 0,
  },
}));
vi.mock("@/services/guardrails", () => ({
  checkEpisodeCap: async () => undefined,
  recordEpisode: async () => undefined,
}));
/** The stored credential each source opens to. Its value must not reach the row either. */
const STORED_TOKEN = "stored-credential-QAxyz0123456789";
vi.mock("@/lib/crypto", () => ({ unsealSecret: () => ({ token: STORED_TOKEN, apiKey: STORED_TOKEN }) }));

const QA_URL = process.env.QA_DATABASE_URL;

const ORG = "org-qa-connector-failure-copy";
const SCOPE = "org_qa.design";

/** Token-shaped strings a provider can echo back in its answer. */
const PLANTED = {
  slack: "xox" + "b-9900112233-4455667788-PlantedSlackAbCdEf",
  figma: "figd_PlantedFigmaToken0123456789AbCdEfGhIj",
  posthog: "phx_" + "PlantedPostHogKey0123456789AbCdEfGhIjKl",
};

type StepCtx = {
  event: { data: unknown };
  step: { run: <T>(name: string, fn: () => Promise<T> | T) => Promise<T> };
};

describe.skipIf(!QA_URL)(
  "a Slack, Figma or PostHog sync the provider fails stores the fix, never the provider's answer",
  () => {
    let db: PrismaClient;
    let inngestModule: typeof import("./inngest");

    beforeAll(async () => {
      process.env.DATABASE_URL = QA_URL;
      db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });
      inngestModule = await import("./inngest");
    });

    afterAll(async () => {
      vi.unstubAllGlobals();
      await db.changeEvent.deleteMany({ where: { orgId: ORG } });
      await deleteOrgsWithRetry(db, { where: { id: ORG } });
      await db.$disconnect();
    });

    beforeEach(async () => {
      await db.org.upsert({ where: { id: ORG }, update: {}, create: { id: ORG, name: ORG } });
      await db.source.deleteMany({ where: { orgId: ORG } });
    });

    const runSync = (sourceId: string) => {
      const ctx: StepCtx = {
        event: { data: { sourceId, orgId: ORG } },
        step: { run: async (_name, fn) => fn() },
      };
      return (inngestModule.sourceSync as unknown as { fn: (ctx: StepCtx) => Promise<Record<string, unknown>> }).fn(
        ctx,
      );
    };

    it.each([
      {
        type: "slack" as const,
        externalId: "C0QA",
        meta: {},
        answer: () => Response.json({ ok: false, error: "invalid_auth", warning: PLANTED.slack }),
        raw: /invalid_auth/,
        line: "Slack rejected this channel's token. It may have been revoked or expired. Create a new token and reconnect the channel.",
      },
      {
        type: "slack" as const,
        externalId: "C0QA",
        meta: {},
        answer: () => new Response("", { status: 502, statusText: `Bad Gateway ${PLANTED.slack}` }),
        raw: /502 Bad Gateway/,
        line: "Slack had an error on its side during this sync. Sync again in a few minutes.",
      },
      {
        type: "figma" as const,
        externalId: "FILEQA",
        meta: {},
        answer: () => Response.json({ status: 403, err: `Invalid token ${PLANTED.figma}` }, { status: 403 }),
        raw: /403 .*Invalid token/,
        line: "Figma refused this file's token. It may have expired, or lost access to the file. Check that its account can still open the file, then reconnect the file with a new token.",
      },
      {
        type: "posthog" as const,
        externalId: "1:42",
        meta: { projectId: "1", host: "https://us.posthog.com" },
        answer: () => Response.json({ detail: `Invalid personal API key ${PLANTED.posthog}` }, { status: 401 }),
        raw: /401 .*Invalid personal API key/,
        line: "PostHog rejected this insight's API key. It may have expired or been revoked. Create a new personal API key that can read insights and reconnect the insight.",
      },
    ])(
      "$type: a provider error ($raw) stores the fix on the row and nothing the provider sent",
      async ({ type, externalId, meta, answer, raw, line }) => {
        const id = `src-qa-failure-copy-${type}`;
        await db.source.create({
          data: {
            id,
            orgId: ORG,
            type,
            externalId,
            name: `${type} source`,
            scopePath: SCOPE,
            encryptedTokens: "sealed",
            meta,
          },
        });
        vi.stubGlobal("fetch", async () => answer());

        // The provider's own answer still reaches Inngest, so a retry and the run history see it.
        await expect(runSync(id)).rejects.toThrow(raw);

        const row = await db.source.findUniqueOrThrow({ where: { id } });
        expect(row.status).toBe("error");
        expect((row.meta as { error: string }).error).toBe(line);
        const stored = JSON.stringify(row);
        expect(stored).not.toContain(PLANTED[type]);
        expect(stored).not.toContain(STORED_TOKEN);
        expect(stored).not.toMatch(raw);
      },
    );
  },
);
