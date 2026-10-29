// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// The entity resolver never turns a person's text into less than they wrote.
//
// It rewrites a person's write before it is stored: deterministic alias substitution,
// then a model pass for pronouns. Its output is what gets stored, so an empty, blank or
// cut-short output would store a person's write empty or as a fragment. The model's
// reply used to be kept whenever it was not null (`?? text` falls back on null only),
// and an entity with a blank name replaced every one of its aliases with nothing.
//
// Real: Postgres and the entities the resolver loads from it (users, the alias registry).
// Double: the model, whose reply each test sets.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";

type Reply = { choices: { message: { content: string | null }; finish_reason: string | null }[] };
const model = vi.hoisted(() => ({ reply: null as unknown as Reply, calls: 0 }));

vi.mock("@/lib/llm", () => ({
  LLM_MODEL_EXTRACT: "test-model",
  LLM_MODEL_ORCHESTRATOR: "test-model",
  createLLMClient: () => ({
    chat: {
      completions: {
        create: async () => {
          model.calls += 1;
          return model.reply;
        },
      },
    },
  }),
}));

const QA_URL = process.env.QA_DATABASE_URL;
const ORG = "resolverreply";
const USER = "u-resolverreply";
/** Has a pronoun reference ("her manager"), so the model pass runs. */
const TEXT = "Dana said her manager approved the renewal.";
const REWRITTEN = "Dana said Sam Lee approved the renewal.";

function reply(content: string | null, finishReason: string | null = "stop"): Reply {
  return { choices: [{ message: { content }, finish_reason: finishReason }] };
}

describe.skipIf(!QA_URL)("the entity resolver never stores less than the person wrote", () => {
  let db: PrismaClient;
  let resolveEntities: (typeof import("@/services/resolver"))["resolveEntities"];

  async function wipe(): Promise<void> {
    await db.entityAlias.deleteMany({ where: { orgId: ORG } });
    await db.user.deleteMany({ where: { id: USER } });
    await db.org.deleteMany({ where: { id: ORG } });
  }

  beforeAll(async () => {
    if (QA_URL === process.env.DATABASE_URL) throw new Error("QA_DATABASE_URL must not be DATABASE_URL");
    process.env.DATABASE_URL = QA_URL;
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL! }) });
    ({ resolveEntities } = await import("@/services/resolver"));
  }, 60_000);

  afterAll(async () => {
    if (db) {
      await wipe();
      await db.$disconnect();
    }
    vi.unstubAllEnvs();
  });

  beforeEach(async () => {
    vi.stubEnv("OPENAI_API_KEY", "test-key");
    model.calls = 0;
    await wipe();
    await db.org.create({ data: { id: ORG, name: "Resolver Reply Co" } });
  });

  const resolve = (text: string) => resolveEntities(ORG, USER, text, { llm: true, actorName: "Dana" });

  it("keeps a reply the model finished", async () => {
    model.reply = reply(`  ${REWRITTEN}\n`);
    expect((await resolve(TEXT)).resolvedText).toBe(REWRITTEN);
    expect(model.calls).toBe(1);
  });

  it.each([
    ["an empty reply", reply("")],
    ["a whitespace reply", reply(" \n\t ")],
    ["a reply with no content", reply(null)],
    ["no reply at all", { choices: [] }],
  ])("falls back to the text as written on %s", async (_name, r) => {
    model.reply = r as Reply;
    const result = await resolve(TEXT);
    expect(result.resolvedText).toBe(TEXT);
    expect(result.changed).toBe(false);
    expect(model.calls).toBe(1);
  });

  it.each([
    ["the token limit", "length"],
    ["a content filter", "content_filter"],
    ["no finish reason", null],
  ])("falls back to the text as written on a reply cut short by %s", async (_name, finishReason) => {
    model.reply = reply("Dana said Sam Lee", finishReason);
    expect((await resolve(TEXT)).resolvedText).toBe(TEXT);
  });

  it("an alias-registry entity with a blank name leaves its aliases as written", async () => {
    await db.entityAlias.create({
      data: { orgId: ORG, entityType: "account", entityId: "acct-blank", canonicalName: "   ", aliases: ["Acme"] },
    });
    // No pronoun reference, so only the deterministic pass runs.
    const result = await resolve("Acme");
    expect(result.resolvedText).toBe("Acme");
    expect(result.resolutions).toEqual([]);
    expect(model.calls).toBe(0);
  });

  it("a user with a blank name leaves their email as written", async () => {
    await db.user.create({
      data: {
        id: USER,
        orgId: ORG,
        email: "dana@resolverreply.test",
        name: " ",
        role: "member",
        clerkId: `clerk-${USER}`,
      },
    });
    const result = await resolve("dana@resolverreply.test");
    expect(result.resolvedText).toBe("dana@resolverreply.test");
    expect(result.resolutions).toEqual([]);
  });

  it("an entity with a name still replaces its alias", async () => {
    await db.entityAlias.create({
      data: {
        orgId: ORG,
        entityType: "account",
        entityId: "acct-named",
        canonicalName: "Acme Corporation",
        aliases: ["Acme Co"],
      },
    });
    expect((await resolve("Acme Co renewed.")).resolvedText).toBe("Acme Corporation renewed.");
  });
});
