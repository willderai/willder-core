// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test Postgres;
// without it every test in this file is skipped, not failed.
//
// Task-start sources and conflicts on the cases task-start-sources.realdb.test.ts
// leaves out: a source in another org under the same scope
// path, a lost-conflict version whose source the reader cannot see (the version line and the
// ask line), two people in conflict, and a conflict where one version names an erased person.
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const QA_URL = process.env.QA_DATABASE_URL;
if (QA_URL) process.env.DATABASE_URL = QA_URL;

const ORG = "orgSourcesQa";
const OTHER_ORG = "orgSourcesQaOther";
const ROOT = "org_sources_qa";
const SCOPE = `${ROOT}.eng`;
const PRIVATE = `${ROOT}.eng_private`;
const ERASED = "Zara Quill";

describe.skipIf(!QA_URL)("task-start sources and conflicts: access cases (QA)", () => {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  let db: any;
  const blocks: Record<string, string> = {};
  const before = Date.UTC(2026, 9, 15, 10);
  let seq = 0;

  async function cleanup(): Promise<void> {
    for (const org of [ORG, OTHER_ORG]) {
      await db.$executeRaw`DELETE FROM memory_chunks WHERE "orgId" = ${org}`;
      await db.factEdge.deleteMany({ where: { orgId: org } });
      await db.changeEvent.deleteMany({ where: { orgId: org } });
      await db.source.deleteMany({ where: { orgId: org } });
      await db.erasureSuppression.deleteMany({ where: { orgId: org } });
      await db.org.deleteMany({ where: { id: org } });
    }
  }

  async function version(
    task: string,
    id: string,
    entityName: string,
    content: string,
    writer: { actorType: string; actorId: string | null; sourceId?: string; actorName?: string },
  ): Promise<void> {
    const createdAt = new Date(before + ++seq * 60_000);
    await db.$executeRaw`
      INSERT INTO memory_chunks ("id","orgId","content","source","actorType","actorId","actorName","entityName","scopePath","sourceId","factVersion","role","createdAt")
      VALUES (${id}, ${ORG}, ${content}, 'mcp', ${writer.actorType}, ${writer.actorId}, ${writer.actorName ?? null}, ${entityName}, ${SCOPE}, ${writer.sourceId ?? null}, true, 'decision', ${createdAt})`;
    await db.changeEvent.create({
      data: {
        orgId: ORG,
        seq: BigInt(seq),
        scopePath: SCOPE,
        recordType: "fact",
        recordId: id,
        op: "create",
        actorId: writer.actorId ?? "unknown",
        actorType: writer.actorType === "human" ? "human" : "agent",
        summary: entityName,
        task,
        createdAt,
      },
    });
  }

  async function lostTo(winnerId: string, loserId: string, entityName: string): Promise<void> {
    const createdAt = new Date(before + ++seq * 60_000);
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
        summary: `superseded by ${winnerId}: ${entityName}`,
        createdAt,
      },
    });
  }

  beforeAll(async () => {
    ({ db } = await import("@/lib/db"));
    await cleanup();
    await db.org.create({ data: { id: ORG, name: ORG } });
    await db.org.create({ data: { id: OTHER_ORG, name: OTHER_ORG } });
    const source = (orgId: string, id: string, type: string, scopePath: string, name: string) =>
      db.source.create({ data: { id, orgId, type, externalId: id, name, scopePath, updatedAt: new Date(before) } });
    // Another org's source, stored under the very scope path the reader reads in its own org.
    await source(OTHER_ORG, "src-qa-other-org", "slack", SCOPE, "Other org channel");
    await source(ORG, "src-qa-hidden", "figma", PRIVATE, "Secret redesign");

    // A: a version whose sourceId names another org's source.
    await version("QA-A", "a-cross", "Launch", "Launch is in May.", {
      actorType: "extraction",
      actorId: "slack-sync:src-qa-other-org",
      sourceId: "src-qa-other-org",
    });

    // B: an agent's version won; the version that lost came from a source the reader cannot see.
    await version("QA-B", "b-win", "Vendor", "Vendor is Stripe.", { actorType: "agent", actorId: "builder" });
    await version("QA-B", "b-lost", "Vendor", "Vendor is Adyen.", {
      actorType: "extraction",
      actorId: "figma-sync:src-qa-hidden",
      sourceId: "src-qa-hidden",
    });
    await lostTo("b-win", "b-lost", "Vendor");
    // B2: the same, but the losing version's source no longer exists.
    await version("QA-B2", "b2-win", "Vendor", "Vendor is Stripe.", { actorType: "agent", actorId: "builder" });
    await version("QA-B2", "b2-lost", "Vendor", "Vendor is Adyen.", {
      actorType: "extraction",
      actorId: "figma-sync:src-qa-gone",
      sourceId: "src-qa-gone",
    });
    await lostTo("b2-win", "b2-lost", "Vendor");

    // C: two people disagree; neither is named, by name or by user id.
    await version("QA-C", "c-1", "Freeze", "Freeze starts Monday.", {
      actorType: "human",
      actorId: "user_qaFirstSecret",
      actorName: "Alice Example",
    });
    await version("QA-C", "c-2", "Freeze", "Freeze starts Wednesday.", {
      actorType: "human",
      actorId: "user_qaSecondSecret",
      actorName: "Bob Example",
    });
    await lostTo("c-1", "c-2", "Freeze");

    // D: the version that won names a person erased later; the version that lost is left alone.
    await version("QA-D", "d-win", "Billing owner", `${ERASED} owns billing.`, {
      actorType: "agent",
      actorId: "builder",
    });
    await version("QA-D", "d-lost", "Billing owner", "The payments team owns billing.", {
      actorType: "agent",
      actorId: "reviewer",
    });
    await lostTo("d-win", "d-lost", "Billing owner");
    const { recordSuppressions } = await import("@/services/memory/erasure-suppression");
    await recordSuppressions(db, ORG, "qa-erasure", { emails: [], names: [ERASED.toLowerCase()], contactIds: [] });

    const { readServableTaskStart } = await import("@/services/memory/task-start");
    const { renderTaskStartBlock } = await import("./task-start-notice");
    const { markWritesAgainst } = await import("@/services/memory/superseded-facts");
    const ctx = { orgId: ORG, actor: { type: "agent", id: "reader" }, origin: "mcp" };
    const render = ({ context, task, notes, winners }: any) =>
      renderTaskStartBlock({ ...context, ...task, notes, writes: markWritesAgainst(context.writes, winners) }, 2000);
    for (const task of ["QA-A", "QA-B", "QA-B2", "QA-C", "QA-D"]) {
      const read = await readServableTaskStart(ctx as any, SCOPE, task, task, (r: any) => render(r).shownFactIds);
      blocks[task] = render(read).text ?? "";
    }
  }, 60_000);

  afterAll(async () => {
    if (QA_URL === undefined) return;
    await cleanup();
  });

  const lineOf = (task: string, id: string) => blocks[task]!.split("\n").find((line) => line.includes(`[fact ${id}]`));
  const askOf = (task: string) => blocks[task]!.split("\n").find((line) => line.startsWith("Conflicting versions of"));

  it("never names another org's source, even under the reader's own scope path", () => {
    expect(lineOf("QA-A", "a-cross")!.endsWith(" — connector, 10-15")).toBe(true);
    expect(blocks["QA-A"]).not.toMatch(/slack|Other org channel/);
  });

  it("names a lost version's hidden source as 'connector' on its line and in the ask line, exactly as an absent one", () => {
    expect(askOf("QA-B")).toBeDefined();
    expect(askOf("QA-B")).toMatch(/ connector, 10-15/);
    expect(lineOf("QA-B", "b-lost")!.endsWith(" — connector, 10-15")).toBe(true);
    expect(blocks["QA-B"]).not.toMatch(/figma|Secret redesign|src-qa-hidden|eng_private/);
    const shape = (task: string) =>
      blocks[task]!.replace(/\b(b2?)-(win|lost)\b/g, "$2").replace(/\[fact [^\]]+\]/g, "[fact]");
    expect(shape("QA-B")).toBe(shape("QA-B2"));
  });

  it("names two people in conflict only as 'person', never by name or user id", () => {
    expect(askOf("QA-C")).toBe(
      'Conflicting versions of "Freeze" from person, 10-15 and person, 10-15: ask the person which holds before acting on either.',
    );
    expect(blocks["QA-C"]).not.toMatch(/user_qa|Alice|Bob/);
  });

  it("drops a conflict whose winning version names an erased person, never serving the lost version alone", () => {
    expect(blocks["QA-D"]).not.toContain(ERASED);
    expect(blocks["QA-D"]).not.toContain("Conflicting versions of");
    expect(lineOf("QA-D", "d-lost")).toBeUndefined();
  });
});
