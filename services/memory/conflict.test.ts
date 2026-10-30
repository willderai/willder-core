// The winner rule itself, and what one resolution writes.
//
// `resolveFactContention`'s substance is a decision and two writes: which version of a
// fact is current, a `supersedes` edge recording that, and a `supersede` change event
// the losing writer can actually see. A transaction double pins all three.
//
// What it cannot show is Postgres serializing two real transactions behind the per-org
// advisory lock. That is the same claim `change-events.realdb.test.ts` already makes
// for the lock itself, which this path takes by calling `recordChangeEvent`.
import { describe, expect, it, vi } from "vitest";
import { Prisma } from "@/lib/generated/prisma/client";
import { insertedChangeEvents } from "./change-events.testsupport";
import { CONTENTION_WINDOW_MS, resolveFactContention, supersessionsAmong } from "./conflict";

const ORG = "org-cuid-1";
const SCOPE = "org_org-cuid-1.race";

// Stored in clock order unless a test says otherwise: `storedOrder` follows `msOffset`.
const version = (
  id: string,
  msOffset: number,
  actorId: string | null,
  actorType = "agent",
  supersededBy: string | null = null,
) => ({
  id,
  createdAt: new Date(1_000_000 + msOffset),
  storedOrder: 100 + msOffset,
  actorId,
  actorType,
  supersededBy,
});

/**
 * A transaction double answering the contention query with `rows`. The first
 * `edgesWritten` edge inserts write a row; any after that find it already recorded.
 */
function fakeTransaction(rows: ReturnType<typeof version>[], edgesWritten = rows.length - 1) {
  const events: { data: Record<string, unknown> }[] = [];
  let unwritten = edgesWritten;
  const createMany = vi.fn(async (args: { data: unknown[] }) => {
    const count = Math.min(args.data.length, Math.max(unwritten, 0));
    unwritten -= count;
    return { count };
  });
  const create = vi.fn(async (args: { data: Record<string, unknown> }) => {
    events.push(args);
    return { id: `event-${events.length}` };
  });
  const $queryRaw = vi.fn(async (query: Prisma.Sql | TemplateStringsArray, ...values: unknown[]) => {
    // The one INSERT recordChangeEvent sends comes through as a tagged template; the
    // contention query comes through as a Prisma.Sql.
    const written = insertedChangeEvents(query, values);
    if (written) {
      return written.map((data) => {
        events.push({ data: data as unknown as Record<string, unknown> });
        return { id: `event-${events.length}`, seq: BigInt(events.length) };
      });
    }
    return rows;
  });
  return {
    events,
    createMany,
    tx: { $queryRaw, factEdge: { createMany }, changeEvent: { create } } as never,
  };
}

const input = {
  orgId: ORG,
  versionId: "version-b",
  entityName: "Launch date",
  storedScopePath: SCOPE,
  eventScopePath: SCOPE,
  origin: "mcp" as const,
};

/** Each supersession as "winner>loser", for comparing outcomes at a glance. */
const pairs = (versions: ReturnType<typeof version>[]) =>
  supersessionsAmong(versions).map(({ winner, loser }) => `${winner.id}>${loser.id}`);

describe("the winner rule", () => {
  it("picks the version the server stored first", () => {
    expect(pairs([version("b", 1, null), version("a", 0, null)])).toEqual(["a>b"]);
  });

  // Two versions in one millisecond: the one stored first wins, whichever id sorts first
  // and in whatever order the rows arrive.
  it("picks the version stored first when both were stored in the same millisecond, whatever their ids", () => {
    const first = (id: string) => ({ ...version(id, 0, null), storedOrder: 7 });
    const second = (id: string) => ({ ...version(id, 0, null), storedOrder: 8 });
    expect(pairs([second("aa"), first("zz")])).toEqual(["zz>aa"]);
    expect(pairs([first("zz"), second("aa")])).toEqual(["zz>aa"]);
    expect(pairs([second("zz"), first("aa")])).toEqual(["aa>zz"]);
  });

  it("never lets a version that already lost win against a later one", () => {
    expect(pairs([version("a", 0, "agent-a"), version("x", 1, "agent-x"), version("b", 2, "agent-a")])).toEqual([
      "a>x",
    ]);
  });

  it("calls a conflict only within one second, the contention window", () => {
    expect(CONTENTION_WINDOW_MS).toBe(1000);
  });
});

describe("resolveFactContention", () => {
  it("leaves an ingest that named no entity alone: there is no contention key", async () => {
    const { tx, createMany } = fakeTransaction([]);

    expect(await resolveFactContention(tx, { ...input, entityName: undefined })).toBeNull();
    expect(createMany).not.toHaveBeenCalled();
  });

  it("records nothing when this version is the only one in the window", async () => {
    const { tx, createMany, events } = fakeTransaction([version("version-b", 0, "agent-b")], 0);

    const outcome = await resolveFactContention(tx, input);

    expect(outcome).toEqual({ winnerId: "version-b", supersededIds: [] });
    expect(createMany).not.toHaveBeenCalled();
    expect(events).toHaveLength(0);
  });

  it("records a supersedes edge from the winner to every later version", async () => {
    const { tx, createMany } = fakeTransaction([
      version("version-a", 0, "agent-a"),
      version("version-b", 1, "agent-b"),
    ]);

    const outcome = await resolveFactContention(tx, input);

    expect(outcome).toEqual({ winnerId: "version-a", supersededIds: ["version-b"] });
    expect(createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          orgId: ORG,
          fromId: "version-a",
          toId: "version-b",
          kind: "supersedes",
          scopePath: SCOPE,
          actorId: "agent-a",
        }),
      ],
      skipDuplicates: true,
    });
  });

  it("announces the supersession as the WINNER's writer, so the loser's notice shows it", async () => {
    const { tx, events } = fakeTransaction([version("version-a", 0, "agent-a"), version("version-b", 1, "agent-b")]);

    await resolveFactContention(tx, input);

    expect(events).toHaveLength(1);
    expect(events[0].data).toMatchObject({
      orgId: ORG,
      recordType: "fact",
      recordId: "version-b",
      op: "supersede",
      actorId: "agent-a",
    });
    expect(events[0].data.summary).toContain("superseded by version-a");
  });

  it("announces only the supersessions this call recorded", async () => {
    // Another announcement already recorded version-x over version-a; version-b is new.
    const { tx, createMany, events } = fakeTransaction([
      version("version-x", 0, "agent-x"),
      version("version-a", 1, "agent-a"),
      version("version-b", 2, "agent-a"),
    ]);
    createMany.mockImplementation(async ({ data }) => ({
      count: (data[0] as { toId: string }).toId === "version-b" ? 1 : 0,
    }));

    await resolveFactContention(tx, input);

    expect(events.map((event) => event.data.recordId)).toEqual(["version-b"]);
  });

  it("records the winner's own actor type on the edge and the event", async () => {
    const { tx, createMany, events } = fakeTransaction([
      version("version-a", 0, "user-1", "human"),
      version("version-b", 1, "agent-b"),
    ]);

    await resolveFactContention(tx, input);

    expect(createMany).toHaveBeenCalledWith({
      data: [expect.objectContaining({ fromId: "version-a", actorType: "human", actorId: "user-1" })],
      skipDuplicates: true,
    });
    expect(events[0]!.data).toMatchObject({ actorType: "human", actorId: "user-1" });
  });

  it("says nothing twice: a replay that wrote no edge announces nothing", async () => {
    const { tx, events } = fakeTransaction([version("version-a", 0, "agent-a"), version("version-b", 1, "agent-b")], 0);

    await resolveFactContention(tx, input);

    expect(events).toHaveLength(0);
  });

  it("decides nothing again for a version an earlier announcement already superseded, and names its winner", async () => {
    // Without this, the superseded version, stored first, would be recorded as the winner
    // over a later version that is still current.
    const { tx, createMany, events } = fakeTransaction([
      version("version-b", 0, "agent-b", "agent", "version-a"),
      version("version-c", 300, "agent-c"),
    ]);

    expect(await resolveFactContention(tx, input)).toEqual({ winnerId: "version-a", supersededIds: [] });
    expect(createMany).not.toHaveBeenCalled();
    expect(events).toHaveLength(0);
  });
});

describe("one writer's own versions never contend", () => {
  it("leaves two versions from one writer both current", async () => {
    const { tx, createMany, events } = fakeTransaction(
      [version("version-a", 0, "agent-a"), version("version-b", 1, "agent-a")],
      0,
    );

    const outcome = await resolveFactContention(tx, input);

    expect(outcome).toEqual({ winnerId: "version-b", supersededIds: [] });
    expect(createMany).not.toHaveBeenCalled();
    expect(events).toHaveLength(0);
  });

  it("still supersedes another writer's version that lands between two of them", async () => {
    const { tx, createMany } = fakeTransaction(
      [version("version-a", 0, "agent-a"), version("version-x", 1, "agent-x"), version("version-b", 2, "agent-a")],
      1,
    );

    const outcome = await resolveFactContention(tx, input);

    expect(outcome).toEqual({ winnerId: "version-b", supersededIds: ["version-x"] });
    expect(createMany).toHaveBeenCalledWith({
      data: [expect.objectContaining({ fromId: "version-a", toId: "version-x", actorId: "agent-a" })],
      skipDuplicates: true,
    });
  });

  it("still lets another writer's earlier version supersede every later version of one writer", async () => {
    const { tx, createMany } = fakeTransaction(
      [version("version-x", 0, "agent-x"), version("version-a", 1, "agent-a"), version("version-b", 2, "agent-a")],
      2,
    );

    const outcome = await resolveFactContention(tx, input);

    expect(outcome).toEqual({ winnerId: "version-x", supersededIds: ["version-a", "version-b"] });
    expect(createMany).toHaveBeenCalledWith({
      data: [expect.objectContaining({ fromId: "version-x", toId: "version-a" })],
      skipDuplicates: true,
    });
    expect(createMany).toHaveBeenCalledWith({
      data: [expect.objectContaining({ fromId: "version-x", toId: "version-b" })],
      skipDuplicates: true,
    });
  });

  it.each([
    ["no recorded writer", null],
    ["a blank writer id", " "],
  ])("treats two versions with %s as two writers, so they still contend", async (_label, actorId) => {
    const { tx } = fakeTransaction([version("version-a", 0, actorId), version("version-b", 1, actorId)]);

    expect(await resolveFactContention(tx, input)).toEqual({ winnerId: "version-a", supersededIds: ["version-b"] });
  });

  it("treats one id written as a person and as an agent as two writers", async () => {
    const { tx } = fakeTransaction([
      version("version-a", 0, "id-1", "human"),
      version("version-b", 1, "id-1", "agent"),
    ]);

    expect(await resolveFactContention(tx, input)).toEqual({ winnerId: "version-a", supersededIds: ["version-b"] });
  });
});

describe("a version written after its writer read another never competes with it", () => {
  /** `row`, read whole by the writers of `laterVersions` before they stored them. */
  const read = (row: ReturnType<typeof version>, ...laterVersions: string[]) => ({
    ...row,
    readBeforeStoring: laterVersions,
  });

  it("leaves both current when the later writer had read the earlier version", () => {
    expect(supersessionsAmong([read(version("v-o", 0, "agent-o"), "v-b"), version("v-b", 1, "agent-b")])).toEqual([]);
  });

  it("does not let a third writer's version make the earlier one win over it", () => {
    const supersessions = supersessionsAmong([
      read(version("v-o", 0, "agent-o"), "v-b"),
      version("v-b", 1, "agent-b"),
      version("v-c", 2, "agent-c"),
    ]);

    expect(supersessions.map(({ winner, loser }) => `${winner.id}>${loser.id}`)).toEqual(["v-o>v-c"]);
  });
});

describe("contention is judged over each write's flight, from received to stored; the winner by stored order", () => {
  /** `row`, its write received `msOffset` ms from the same origin as `version`'s clock. */
  const received = (row: ReturnType<typeof version>, msOffset: number) => ({
    ...row,
    receivedAt: new Date(1_000_000 + msOffset),
  });

  it("still calls a conflict when one write was stored more than the window after the other, but received with it", () => {
    // Received 10 ms apart; the slower one's embedding took 2.2 s, the faster one's 0.7 s.
    const fast = received(version("fast", 700, "agent-fast"), 10);
    const slow = received(version("slow", 2_200, "agent-slow"), 0);

    expect(pairs([slow, fast])).toEqual(["fast>slow"]);
  });

  it("keeps the version stored first as the winner, even when the other write was received first", () => {
    const storedFirst = received(version("stored-first", 400, "agent-a"), 300);
    const receivedFirst = received(version("received-first", 1_500, "agent-b"), 0);

    expect(pairs([receivedFirst, storedFirst])).toEqual(["stored-first>received-first"]);
  });

  it("holds apart two versions received more than the window from each other, even inside one window query", () => {
    // `late` was received within the window of both; `early` and `middle` more than a window apart.
    const early = received(version("early", 500, "agent-a"), 0);
    const middle = received(version("middle", 2_000, "agent-b"), 1_800);
    const late = received(version("late", 3_000, "agent-c"), 900);

    // `middle`, announced current when it was stored, is not retired by `early` through `late`.
    expect(pairs([early, middle, late])).toEqual(["early>late"]);
  });

  it("calls a conflict when a write is received while a slow one is in flight and stored before it", () => {
    // The slow write was received first, more than the window before the other; it was still
    // being embedded when the other was received and stored, so the two overlapped.
    const slow = received(version("slow", 2_400, "agent-a"), 0);
    const fast = received(version("fast", 1_600, "agent-b"), 1_300);

    expect(pairs([slow, fast])).toEqual(["fast>slow"]);
  });

  it("treats a write received exactly one window after the other was stored as concurrent, and a millisecond later as not", () => {
    const a = received(version("a", 0, "agent-a"), 0);
    expect(pairs([a, received(version("b", CONTENTION_WINDOW_MS, "agent-b"), CONTENTION_WINDOW_MS)])).toEqual(["a>b"]);
    expect(pairs([a, received(version("b", CONTENTION_WINDOW_MS + 1, "agent-b"), CONTENTION_WINDOW_MS + 1)])).toEqual(
      [],
    );
  });
});
