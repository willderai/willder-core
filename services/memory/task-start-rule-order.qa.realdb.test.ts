// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test Postgres;
// without it every test in this file is skipped, not failed.
//
// The task-start rule order (services/memory/rule-order.ts), against a real
// database, on what the block a session is given actually serves:
// - The newest tier holds NEWEST_RULES_FIRST of the scope's rules the block can serve. A rule
//   the task itself recorded is served under "Decisions on this task" and left out of the
//   scope's rules, so it must not take one of those places.
// - A rule the task names by subject or id is read however old it is, but only within the
//   org and the scope the reader may read: naming a rule in a sibling scope or another org
//   serves nothing of it.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";
// The leaf module, not the `@/services/access` barrel: the barrel builds the `@/lib/db`
// singleton at import time, before beforeAll points DATABASE_URL at the test database.
import { hashCapabilityToken } from "@/services/access/capabilities";
import type { AccessContext } from "@/services/access";
import { TASK_START_HEADINGS, TASK_START_PREMISE_CHECK } from "@/mcp/task-start-headings";

const QA_URL = process.env.QA_DATABASE_URL;

const ORG = "qa_taskStartRuleOrderQa";
const OTHER_ORG = "qa_taskStartRuleOrderQaOther";
const SCOPE = `org_${ORG}.team`;
const SIBLING_SCOPE = `org_${ORG}.other`;
const OTHER_ORG_SCOPE = `org_${OTHER_ORG}.team`;
const READER = "agent-reader";
const TASK = "importer-retries";

describe.skipIf(!QA_URL)("task-start rule order, against a real database", () => {
  let db: PrismaClient;
  let readTaskStartUnchecked: (typeof import("./task-start"))["readTaskStartUnchecked"];
  let taskStartNotice: (typeof import("@/mcp/task-start-notice"))["taskStartNotice"];
  let NEWEST_RULES_FIRST: number;
  let session = 0;

  async function cleanup(): Promise<void> {
    for (const orgId of [ORG, OTHER_ORG]) {
      await db.taskStartDelivery.deleteMany({ where: { orgId } });
      await db.changeEvent.deleteMany({ where: { orgId } });
      await db.convention.deleteMany({ where: { orgId } });
      await db.auditLog.deleteMany({ where: { orgId } });
      await db.capability.deleteMany({ where: { orgId } });
      await db.org.deleteMany({ where: { id: orgId } });
    }
  }

  /** Records `rules` in `scopePath`, the first the oldest, a minute apart, ending an hour ago. */
  async function recordRules(
    rules: { subject: string; text: string }[],
    orgId = ORG,
    scopePath = SCOPE,
  ): Promise<void> {
    const end = Date.now() - 60 * 60 * 1000;
    await db.convention.createMany({
      data: rules.map((rule, i) => ({
        orgId,
        scopePath,
        // Conventions: a rule in force whoever recorded it, so the scope's rules section serves them all.
        kind: "convention" as const,
        subject: rule.subject,
        text: rule.text,
        actorId: "agent-author",
        createdAt: new Date(end - (rules.length - i) * 60_000),
      })),
    });
  }

  /** `count` rules no task names, each its own, about office matters. */
  const officeRules = (count: number, from = 0) =>
    Array.from({ length: count }, (_, i) => ({
      subject: `Office note ${from + i}`,
      text: `Bring a charger on day ${from + i}.`,
    }));

  /** A decision the task's earlier session recorded, as convention_record stores it, newer than every seeded rule. */
  async function taskDecision(subject: string, text: string, minutesAgo: number): Promise<void> {
    const createdAt = new Date(Date.now() - minutesAgo * 60_000);
    const decision = await db.convention.create({
      data: { orgId: ORG, scopePath: SCOPE, kind: "decision", subject, text, actorId: "agent-author", createdAt },
    });
    await db.changeEvent.create({
      data: {
        orgId: ORG,
        seq: BigInt(minutesAgo),
        scopePath: SCOPE,
        recordType: "convention",
        recordId: decision.id,
        op: "create",
        actorId: "agent-author",
        actorType: "agent",
        origin: "mcp",
        summary: subject,
        task: TASK,
        createdAt,
      },
    });
  }

  async function reader(): Promise<AccessContext> {
    const token = `wcap_test_${Math.random().toString(36).slice(2)}`;
    await db.capability.create({
      data: {
        orgId: ORG,
        agentId: READER,
        tokenHash: hashCapabilityToken(token),
        scopePath: SCOPE,
        permission: "read",
        expiresAt: new Date(Date.now() + 3_600_000),
      },
    });
    return { orgId: ORG, actor: { type: "agent", id: READER, capabilityToken: token }, origin: "mcp" };
  }

  /** The block's lines under `heading`, up to the next line that is not a record line. */
  function section(block: string, heading: string): string[] {
    const lines = block.split("\n");
    const start = lines.indexOf(heading);
    if (start === -1) return [];
    const out: string[] = [];
    // The leads' premise check follows their heading; it is not an item.
    for (const line of lines.slice(start + 1).filter((line) => line !== TASK_START_PREMISE_CHECK)) {
      if (!line.startsWith("- ")) break;
      out.push(line);
    }
    return out;
  }

  /** The subject a rule line names: `- [<kind> <id>] <subject>: <passage>`, after a status label when it has one. */
  const subjectOf = (line: string) => line.replace(/^- \[[^\]]+\] (?:\[[^\]]+\] )?/, "").split(":")[0];

  beforeAll(async () => {
    if (QA_URL === process.env.DATABASE_URL) throw new Error("QA_DATABASE_URL must not be DATABASE_URL");
    process.env.DATABASE_URL = QA_URL;
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL! }) });
    ({ readTaskStartUnchecked } = await import("./task-start"));
    ({ NEWEST_RULES_FIRST } = await import("./rule-order"));
    ({ taskStartNotice } = await import("@/mcp/task-start-notice"));
  });

  beforeEach(async () => {
    await cleanup();
    await db.org.create({ data: { id: ORG, name: ORG } });
    await db.org.create({ data: { id: OTHER_ORG, name: OTHER_ORG } });
  });

  afterAll(async () => {
    if (!db) return;
    await cleanup();
    await db.$disconnect();
  });

  it("serves the scope's newest rules first even when the task's own decisions are newer still", async () => {
    const relevant = { subject: "Importer retries", text: "The importer retries a failed page three times." };
    await recordRules([relevant, ...officeRules(10)]);
    // The task's earlier session recorded two decisions; they are the scope's newest rules, and
    // an agent recorded them, so the block serves them as leads, not among the scope's rules.
    await taskDecision("Importer approach", "Keep one cursor per source.", 20);
    await taskDecision("Importer paging", "Page size stays at one hundred.", 10);

    const block = await taskStartNotice(await reader(), {
      scopePath: SCOPE,
      sessionKey: `s-${++session}`,
      taskText: "Fix the importer retries for a failed page",
      taskKey: TASK,
    });
    expect(block).not.toBeNull();
    expect(section(block!, TASK_START_HEADINGS.leads).map(subjectOf)).toEqual(["Importer paging", "Importer approach"]);

    const rules = section(block!, TASK_START_HEADINGS.rules).map(subjectOf);
    // The newest tier is the NEWEST_RULES_FIRST newest rules this section serves, then relevance.
    const newestOffice = officeRules(10)
      .map((r) => r.subject)
      .reverse()
      .slice(0, NEWEST_RULES_FIRST);
    expect(rules.slice(0, NEWEST_RULES_FIRST)).toEqual(newestOffice);
    expect(rules[NEWEST_RULES_FIRST]).toBe("Importer retries");
  });

  it("serves nothing of a rule the task names that sits in a sibling scope or another org", async () => {
    await recordRules([{ subject: "release-gate-20260901", text: "Sibling scope gate text." }], ORG, SIBLING_SCOPE);
    await recordRules([{ subject: "release-gate-20260901", text: "Other org gate text." }], OTHER_ORG, OTHER_ORG_SCOPE);
    await recordRules(officeRules(105));
    const sibling = (await db.convention.findFirst({ where: { orgId: ORG, scopePath: SIBLING_SCOPE } }))!;
    const foreign = (await db.convention.findFirst({ where: { orgId: OTHER_ORG } }))!;
    const taskText = `Ship the importer, per release-gate-20260901, rule ${sibling.id} and rule ${foreign.id}`;

    const read = await readTaskStartUnchecked(await reader(), SCOPE, taskText, "");
    const ids = read.context.rules.map((rule) => rule.id);
    expect(ids).not.toContain(sibling.id);
    expect(ids).not.toContain(foreign.id);
    expect(read.context.rules.every((rule) => rule.subject.startsWith("Office note"))).toBe(true);
    // The pool is still full: naming rules the reader cannot read takes no place from the newest.
    expect(ids).toHaveLength(100);

    const block = await taskStartNotice(await reader(), { scopePath: SCOPE, sessionKey: `s-${++session}`, taskText });
    expect(block).not.toContain("gate text");
    expect(block).not.toContain(sibling.id);
    expect(block).not.toContain(foreign.id);
  });
});
