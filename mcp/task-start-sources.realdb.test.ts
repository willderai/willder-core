// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test Postgres;
// without it every test in this file is skipped, not failed.
//
// Source attribution against the real read (services/memory/task-start.ts) and render
// (mcp/task-start-notice.ts): every line the task-start block serves names who wrote it, a
// source the reader cannot see is named exactly as one that no longer exists, and a task's
// conflicting versions of one fact are served together under the line that asks the person.
//
// The rows are written directly, as the change feed and the fact path store them, so each case
// is exact: a version that lost a conflict (a `supersedes` edge and a "superseded by" event),
// one a based update replaced (an edge and a "replaced by" event), and connector rows whose
// source sits in the reader's scope, in a private sibling scope, or nowhere.
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const QA_URL = process.env.QA_DATABASE_URL;
if (QA_URL) process.env.DATABASE_URL = QA_URL;

const ORG = "orgSourcesConflict";
const ROOT = "org_sources_conflict";
const SCOPE = `${ROOT}.eng`;
const PRIVATE = `${ROOT}.eng_private`;
const TASK = "PAY-120";
const TASK_CROWDED = "PAY-121";
const TASK_PARTNERS = "PAY-122";

describe.skipIf(!QA_URL)(
  "the task-start block names its sources and asks about conflicts, against a real database",
  () => {
    /* eslint-disable @typescript-eslint/no-explicit-any */
    let db: any;
    let block: string;
    let crowdedIds: string[];
    let partnerIds: string[];
    const base = Date.UTC(2026, 9, 15, 10);
    let seq = 0;

    async function cleanup(): Promise<void> {
      await db.$executeRaw`DELETE FROM memory_chunks WHERE "orgId" = ${ORG}`;
      await db.factEdge.deleteMany({ where: { orgId: ORG } });
      await db.changeEvent.deleteMany({ where: { orgId: ORG } });
      await db.source.deleteMany({ where: { orgId: ORG } });
      await db.org.deleteMany({ where: { id: ORG } });
    }

    /** A fact version stored in `scopePath`, and its create event recorded for the task. */
    async function version(
      id: string,
      entityName: string,
      content: string,
      writer: { actorType: string; actorId: string | null; sourceId?: string },
      scopePath = SCOPE,
      { task = TASK }: { task?: string } = {},
    ): Promise<void> {
      const createdAt = new Date(base + ++seq * 60_000);
      await db.$executeRaw`
      INSERT INTO memory_chunks ("id","orgId","content","source","actorType","actorId","entityName","scopePath","sourceId","factVersion","role","createdAt")
      VALUES (${id}, ${ORG}, ${content}, 'mcp', ${writer.actorType}, ${writer.actorId}, ${entityName}, ${scopePath}, ${writer.sourceId ?? null}, true, 'decision', ${createdAt})`;
      await db.changeEvent.create({
        data: {
          orgId: ORG,
          seq: BigInt(seq),
          scopePath,
          recordType: "fact",
          recordId: id,
          op: "create",
          actorId: writer.actorId ?? "unknown",
          actorType: writer.actorType,
          summary: entityName,
          task,
          createdAt,
        },
      });
    }

    /** `winnerId` retires `loserId`, as conflict.ts records it: an edge and a supersede event saying how. */
    async function retire(
      winnerId: string,
      loserId: string,
      how: "superseded" | "replaced",
      entityName: string,
    ): Promise<void> {
      const createdAt = new Date(base + ++seq * 60_000);
      await db.factEdge.create({
        data: {
          orgId: ORG,
          fromId: winnerId,
          toId: loserId,
          kind: "supersedes",
          scopePath: SCOPE,
          actorType: "agent",
          actorId: "qa",
          createdAt,
        },
      });
      await db.changeEvent.create({
        data: {
          orgId: ORG,
          seq: BigInt(seq),
          scopePath: SCOPE,
          recordType: "fact",
          recordId: loserId,
          op: "supersede",
          actorId: "qa",
          actorType: "agent",
          summary: `${how} by ${winnerId}: ${entityName}`,
          createdAt,
        },
      });
    }

    beforeAll(async () => {
      ({ db } = await import("@/lib/db"));
      await cleanup();
      await db.org.create({ data: { id: ORG, name: ORG } });
      const source = (id: string, scopePath: string, name: string) =>
        db.source.create({
          data: { id, orgId: ORG, type: "gdrive", externalId: id, name, scopePath, updatedAt: new Date(base) },
        });
      await source("src-visible", SCOPE, "Eng folder");
      await source("src-hidden", PRIVATE, "Acquisition talks");

      await version("f-agent", "Retry policy", "Retry at most 5 times.", { actorType: "agent", actorId: "builder" });
      await version("f-person", "Freeze", "No deploys on Friday.", {
        actorType: "human",
        actorId: "user_2abcSecretId",
      });
      await version("f-visible", "Export", "The export runs nightly.", {
        actorType: "extraction",
        actorId: "gdrive-sync:src-visible",
        sourceId: "src-visible",
      });
      await version("f-hidden", "Budget", "The budget doubles in Q3.", {
        actorType: "extraction",
        actorId: "gdrive-sync:src-hidden",
        sourceId: "src-hidden",
      });
      await version("f-absent", "Headcount", "Headcount stays flat.", {
        actorType: "extraction",
        actorId: "gdrive-sync:src-gone",
        sourceId: "src-gone",
      });

      // Two writers on one fact: the winner rule kept the first and retired the second.
      await version("f-price-a", "Acme pricing", "Acme pays $10 a seat.", { actorType: "agent", actorId: "builder" });
      await version("f-price-b", "Acme pricing", "Acme pays $12 a seat.", { actorType: "agent", actorId: "reviewer" });
      await retire("f-price-a", "f-price-b", "superseded", "Acme pricing");
      // A based update replaced its base: an intended update, not a conflict.
      await version("f-owner-old", "Rollout owner", "Agent A owns the rollout.", {
        actorType: "agent",
        actorId: "builder",
      });
      await version("f-owner-new", "Rollout owner", "The payments on-call owns the rollout.", {
        actorType: "agent",
        actorId: "reviewer",
      });
      await retire("f-owner-new", "f-owner-old", "replaced", "Rollout owner");
      // The same name in a scope the reader cannot read is another fact, and never read.
      await version(
        "f-retry-private",
        "Retry policy",
        "Never retry.",
        { actorType: "agent", actorId: "reviewer" },
        PRIVATE,
      );

      // A second task: its winner stored first, 19 newer facts, then a retired copy of the winner,
      // newest of all. A retired version never takes one of the 20 places a current fact needs.
      const crowdedTask = { task: TASK_CROWDED };
      await version(
        "w-crowd",
        "Crowd pricing",
        "Acme pays $10 a seat.",
        { actorType: "agent", actorId: "builder" },
        SCOPE,
        crowdedTask,
      );
      for (let i = 0; i < 19; i++)
        await version(
          `c-${i}`,
          `Topic ${i}`,
          `Note ${i}.`,
          { actorType: "agent", actorId: "builder" },
          SCOPE,
          crowdedTask,
        );
      await version(
        "l-crowd",
        "Crowd pricing",
        "acme pays $10 a seat",
        { actorType: "agent", actorId: "reviewer" },
        SCOPE,
        crowdedTask,
      );
      await retire("w-crowd", "l-crowd", "superseded", "Crowd pricing");

      // A third task: twelve older versions of one fact and three of another, all past the 20 places.
      // The partners read past the limit are counted per fact, so the second fact's set is whole too.
      const partnersTask = { task: TASK_PARTNERS };
      for (let i = 0; i < 12; i++)
        await version(
          `x-old-${i}`,
          "Busy fact",
          `Busy version ${i}.`,
          { actorType: "agent", actorId: `writer-x${i}` },
          SCOPE,
          partnersTask,
        );
      for (let i = 0; i < 3; i++)
        await version(
          `y-old-${i}`,
          "Quiet fact",
          `Quiet version ${i}.`,
          { actorType: "agent", actorId: `writer-y${i}` },
          SCOPE,
          partnersTask,
        );
      await version(
        "y-new",
        "Quiet fact",
        "Quiet version now.",
        { actorType: "agent", actorId: "builder" },
        SCOPE,
        partnersTask,
      );
      await version(
        "x-new",
        "Busy fact",
        "Busy version now.",
        { actorType: "agent", actorId: "builder" },
        SCOPE,
        partnersTask,
      );
      for (let i = 0; i < 18; i++)
        await version(
          `p-${i}`,
          `Other ${i}`,
          `Other ${i}.`,
          { actorType: "agent", actorId: "builder" },
          SCOPE,
          partnersTask,
        );

      const { readServableTaskStart } = await import("@/services/memory/task-start");
      const { renderTaskStartBlock } = await import("./task-start-notice");
      const { markWritesAgainst } = await import("@/services/memory/superseded-facts");
      const ctx = { orgId: ORG, actor: { type: "agent", id: "reader" }, origin: "mcp" };
      const render = ({ context, task, notes, winners }: any) =>
        renderTaskStartBlock({ ...context, ...task, notes, writes: markWritesAgainst(context.writes, winners) }, 2000);
      const read = await readServableTaskStart(ctx as any, SCOPE, TASK, TASK, (r: any) => render(r).shownFactIds);
      block = render(read).text!;
      const crowded = await readServableTaskStart(
        ctx as any,
        SCOPE,
        TASK_CROWDED,
        TASK_CROWDED,
        (r: any) => render(r).shownFactIds,
      );
      crowdedIds = crowded.task.facts.map((fact: { id: string }) => fact.id);
      const partners = await readServableTaskStart(
        ctx as any,
        SCOPE,
        TASK_PARTNERS,
        TASK_PARTNERS,
        (r: any) => render(r).shownFactIds,
      );
      partnerIds = partners.task.facts.map((fact: { id: string }) => fact.id);
    }, 60_000);

    afterAll(async () => {
      if (QA_URL === undefined) return;
      await cleanup();
    });

    const lineOf = (id: string) => block.split("\n").find((line) => line.includes(`[fact ${id}]`));

    it.each([
      ["an agent by the id it writes under", "f-agent", " — builder, 10-15"],
      ["a person as a person, never by name or id", "f-person", " — person, 10-15"],
      ["a connected source in the reader's scope by its type", "f-visible", " — gdrive, 10-15"],
    ])("names %s", (_who, id, source) => {
      expect(lineOf(id)!.endsWith(source)).toBe(true);
    });

    it("names a source in a scope the reader cannot read exactly as one that no longer exists", () => {
      const shape = (id: string) =>
        lineOf(id)!
          .replace(/\[fact \S+\]/, "[fact]")
          .replace(/^- \[[^\]]*\] /, "")
          .split(" [fact]")[1];
      expect(shape("f-hidden")).toBe(" Budget — connector, 10-15");
      expect(shape("f-absent")).toBe(" Headcount — connector, 10-15");
      expect(block).not.toMatch(/Acquisition talks|src-hidden|src-gone|eng_private|user_2abcSecretId/);
    });

    it("serves both versions of a fact two writers conflicted on, under the line that asks, naming neither as the one that holds", () => {
      const lines = block.split("\n");
      const ask = lines.findIndex((line) => line.startsWith('Conflicting versions of "Acme pricing"'));
      expect(lines[ask]).toMatch(
        /^Conflicting versions of "Acme pricing" from (builder|reviewer), 10-15 and (?!\1)(builder|reviewer), 10-15: ask the person which holds before acting on either\.$/,
      );
      expect(
        lines
          .slice(ask + 1, ask + 3)
          .map((line) => line.match(/\[fact (\S+)\]/)?.[1])
          .sort(),
      ).toEqual(["f-price-a", "f-price-b"]);
      expect(block).not.toMatch(/superseded|resolved/i);
    });

    it("serves only the replacement of a version a based update replaced, with no conflict line", () => {
      expect(lineOf("f-owner-new")).toBeDefined();
      expect(lineOf("f-owner-old")).toBeUndefined();
      expect(block).not.toContain('Conflicting versions of "Rollout owner"');
    });

    it("lets no retired version take a place a current fact needs", () => {
      expect(crowdedIds).toContain("w-crowd");
      expect(crowdedIds).not.toContain("l-crowd");
      expect(crowdedIds).toHaveLength(20);
    });

    it("reads each picked fact's other versions on their own count, so a busy fact never takes a quiet one's", () => {
      expect(partnerIds.filter((id) => id.startsWith("y-old-")).sort()).toEqual(["y-old-0", "y-old-1", "y-old-2"]);
      expect(partnerIds.filter((id) => id.startsWith("x-old-"))).toHaveLength(10);
    });

    it("never reads a version in a scope the reader cannot see, nor flags a conflict with one", () => {
      expect(lineOf("f-retry-private")).toBeUndefined();
      expect(block).not.toContain("Never retry.");
      expect(block).not.toContain('Conflicting versions of "Retry policy"');
    });
  },
);
