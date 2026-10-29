// The rules path when two writers race to replace the same rule, and the retire path.
//
// The unique index on `supersedesId` picks a winner and tells the loser; the loser's
// version must still be stored, so the id its refusal hands out resolves and nothing is
// lost. A rule must also be retirable, or rules survive a deleted scope with nothing
// serving them.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma } from "@/lib/generated/prisma/client";

const ORG = "org-cuid-rules";
const SCOPE = "org_org-cuid-rules.cfw";

interface ConventionRow {
  id: string;
  orgId: string;
  scopePath: string;
  kind: string;
  subject: string;
  text: string;
  actorId: string;
  supersedesId: string | null;
  supersededById: string | null;
  retiredAt: Date | null;
  retiredBy: string | null;
  createdAt: Date;
}

const store = {
  rules: [] as ConventionRow[],
  edges: [] as Record<string, unknown>[],
  events: [] as Record<string, string>[],
  /** Set to make the next create collide on the unique index, as the loser's does. */
  collideOnSupersedes: false,
  /** Rules the loser's own lookup ran too early to see. That interleaving — SELECT
   * before the winner commits, INSERT after — is what the race actually is. */
  uncommittedIds: [] as string[],
};

vi.mock("@/lib/db", () => {
  const matches = (row: ConventionRow, where: Record<string, unknown>) =>
    Object.entries(where).every(([key, value]) => {
      if (key === "replacedBy") {
        return store.rules.every((other) => other.supersedesId !== row.id || store.uncommittedIds.includes(other.id));
      }
      return row[key as keyof ConventionRow] === value;
    });

  const db = {
    convention: {
      create: vi.fn(async ({ data }: { data: Partial<ConventionRow> }) => {
        if (store.collideOnSupersedes && data.supersedesId) {
          throw new Prisma.PrismaClientKnownRequestError("unique", { code: "P2002", clientVersion: "test" });
        }
        const row: ConventionRow = {
          orgId: ORG,
          scopePath: SCOPE,
          kind: "decision",
          subject: "",
          text: "",
          actorId: "",
          supersedesId: null,
          supersededById: null,
          retiredAt: null,
          retiredBy: null,
          createdAt: new Date(),
          ...data,
          id: `rule-${store.rules.length + 1}`,
        };
        store.rules.push(row);
        return row;
      }),
      // What the erased-version check reads about the rules a lineage names.
      findMany: vi.fn(async ({ where }: { where: { id: { in: string[] } } }) =>
        store.rules.filter((rule) => where.id.in.includes(rule.id)),
      ),
      findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
        const row = store.rules.find((candidate) => matches(candidate, where));
        return row ? { ...row, replacedBy: store.rules.find((r) => r.supersedesId === row.id) ?? null } : null;
      }),
      updateMany: vi.fn(async ({ where, data }: { where: Record<string, unknown>; data: Partial<ConventionRow> }) => {
        const row = store.rules.find((candidate) => matches(candidate, where));
        if (!row) return { count: 0 };
        Object.assign(row, data);
        return { count: 1 };
      }),
    },
    factEdge: {
      createMany: vi.fn(async ({ data }: { data: Record<string, unknown>[] }) => {
        store.edges.push(...data);
        return { count: data.length };
      }),
      findMany: vi.fn(async () => []),
    },
    changeEvent: {
      create: vi.fn(async ({ data }: { data: Record<string, string> }) => {
        store.events.push(data);
        return { id: `event-${store.events.length}` };
      }),
      findMany: vi.fn(async () => []),
      // Who recorded a rule a writer names in `supersedes`: its create event.
      findFirst: vi.fn(
        async ({ where }: { where: Record<string, string> }) =>
          store.events.find((e) => e.recordId === where.recordId && e.op === where.op) ?? null,
      ),
    },
    // No one erased: the erased-content check memory_version makes on a rule's lineage
    // finds nothing to leave out.
    erasureSuppression: { findMany: vi.fn(async () => []) },
    memoryChunk: { findMany: vi.fn(async () => []) },
    // Every writer in this file is an agent: no actor id is a user.
    user: { count: vi.fn(async () => 0) },
    $queryRaw: vi.fn(async (query: Prisma.Sql | TemplateStringsArray) =>
      Array.isArray(query) ? [{ next: BigInt(store.events.length + 1) }] : [],
    ),
    $transaction: vi.fn(),
  };
  db.$transaction.mockImplementation((fn: (tx: typeof db) => unknown) => fn(db));
  return { db };
});

vi.mock("@/services/access", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/access")>();
  const check = vi.fn().mockResolvedValue({ allowed: true });
  // The real record helper, deciding with the stub above.
  return { ...actual, check, authorizeRecord: actual.recordAuthorizer({ check, can: actual.can }) };
});

import { ConventionNotReplaceableError, recordConvention, retireConvention } from "./conventions";
import { readMemoryVersion } from "./versions";
import type { AccessContext } from "@/services/access";

const writer = (id: string) => ({ orgId: ORG, actor: { type: "agent", id } }) as AccessContext;

const replacement = (subject: string, text: string) => ({
  kind: "decision" as const,
  subject,
  text,
  scopePath: SCOPE,
  supersedes: "rule-1",
});

/** The rule both writers race to replace. */
function seedBaseRule(): void {
  store.rules.push({
    id: "rule-1",
    orgId: ORG,
    scopePath: SCOPE,
    kind: "decision",
    subject: "Launch date",
    text: "The launch date is TBD.",
    actorId: "agent-one",
    supersedesId: null,
    supersededById: null,
    retiredAt: null,
    retiredBy: null,
    createdAt: new Date(),
  });
}

beforeEach(() => {
  store.rules = [];
  store.edges = [];
  store.events = [];
  store.collideOnSupersedes = false;
  store.uncommittedIds = [];
});

/**
 * Run the race: one writer's replacement commits, and a second writer that looked the
 * rule up before that lands on the unique index.
 *
 * @returns the winning version's id and the refusal the loser was given.
 */
async function raceToReplace(): Promise<{ winnerId: string; refusal: ConventionNotReplaceableError }> {
  seedBaseRule();
  const winnerId = await recordConvention(writer("agent-one"), replacement("Launch date", "FRIDAY"));
  store.uncommittedIds = [winnerId];
  store.collideOnSupersedes = true;
  const refusal = await recordConvention(writer("agent-two"), replacement("Launch date", "MONDAY")).catch(
    (e: unknown) => e as ConventionNotReplaceableError,
  );
  store.uncommittedIds = [];
  store.collideOnSupersedes = false;
  return { winnerId, refusal: refusal as ConventionNotReplaceableError };
}

describe("two writers race to replace the same rule", () => {
  it("stores the loser's version instead of discarding it, and names it in the refusal", async () => {
    const { winnerId, refusal } = await raceToReplace();

    expect(refusal).toBeInstanceOf(ConventionNotReplaceableError);
    const { storedVersionId, supersededById } = refusal as ConventionNotReplaceableError;
    expect(supersededById).toBe(winnerId);
    expect(storedVersionId).toBeDefined();
    expect(store.rules.find((rule) => rule.id === storedVersionId)).toMatchObject({
      text: "MONDAY",
      supersededById: winnerId,
    });
  });

  it("makes the loser's version readable by the id the refusal gave out", async () => {
    const { winnerId, refusal } = await raceToReplace();

    const version = await readMemoryVersion(writer("agent-two"), refusal.storedVersionId!);

    expect(version).toMatchObject({
      kind: "convention",
      status: "superseded",
      supersededById: winnerId,
      content: "decision: Launch date: MONDAY",
    });
  });

  it("records the winner's supersedes edge over the loser's version", async () => {
    const { winnerId, refusal } = await raceToReplace();

    expect(store.edges).toContainEqual(
      expect.objectContaining({ kind: "supersedes", fromId: winnerId, toId: refusal.storedVersionId }),
    );
  });

  it("announces the loser's version as the winner's writer, so the loser's notice shows it", async () => {
    await raceToReplace();

    const notice = store.events.filter((event) => event.op === "supersede" && event.actorId === "agent-one");
    expect(notice.at(-1)?.summary).toContain("superseded by");
  });

  it("never serves a version that lost the race as a rule to replace", async () => {
    const { refusal } = await raceToReplace();

    await expect(
      recordConvention(writer("agent-one"), {
        ...replacement("Launch date", "LATER"),
        supersedes: refusal.storedVersionId!,
      }),
    ).rejects.toBeInstanceOf(ConventionNotReplaceableError);
  });
});

describe("retiring a rule", () => {
  it("retires it, records who and when, and announces it", async () => {
    seedBaseRule();

    expect(await retireConvention(writer("agent-two"), "rule-1")).toBe(true);
    expect(store.rules[0]).toMatchObject({ retiredBy: "agent-two" });
    expect(store.rules[0].retiredAt).toBeInstanceOf(Date);
    expect(store.events.at(-1)).toMatchObject({ op: "delete", recordId: "rule-1" });
  });

  it("keeps the retired rule readable by id", async () => {
    seedBaseRule();
    await retireConvention(writer("agent-two"), "rule-1");

    expect(await readMemoryVersion(writer("agent-two"), "rule-1")).toMatchObject({ status: "retired" });
  });

  it("will not retire a rule twice, and says so without a second event", async () => {
    seedBaseRule();
    await retireConvention(writer("agent-two"), "rule-1");
    const events = store.events.length;

    expect(await retireConvention(writer("agent-two"), "rule-1")).toBe(false);
    expect(store.events).toHaveLength(events);
  });

  it("reports a rule this org does not have as nothing to retire", async () => {
    expect(await retireConvention(writer("agent-two"), "rule-nowhere")).toBe(false);
  });

  it("refuses a retired rule as something to replace", async () => {
    seedBaseRule();
    await retireConvention(writer("agent-two"), "rule-1");

    await expect(recordConvention(writer("agent-one"), replacement("Launch date", "FRIDAY"))).rejects.toBeInstanceOf(
      ConventionNotReplaceableError,
    );
  });
});
