// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test Postgres;
// without it every test in this file is skipped, not failed.
//
// The task-start block lays its records out by status from recorded evidence
// (services/memory/claim-status.ts), against a real database:
// - who recorded a record is what its create event says, and only a person's record is settled:
//   an agent cannot settle its own claim, whatever it writes in it;
// - a claim is judged by the captures of its own session, in its own scope and org: a capture
//   another tenant or a sibling scope stored under the same session and task never decides it;
// - a replaced decision or fact version is never served, settled or otherwise; its replacement is,
//   by its own writer's status.
//
// Real: Postgres, check() against a live capability, the task-start read and the block as an MCP
// result serves it. Records are stored as the write paths store them: the row, then its create
// event with the writer's type, task and session.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";
// The leaf module, not the `@/services/access` barrel: the barrel builds the `@/lib/db`
// singleton at import time, before beforeAll points DATABASE_URL at the test database.
import { hashCapabilityToken } from "@/services/access/capabilities";
import type { AccessContext } from "@/services/access";
import { renderSessionState, sessionStateName } from "@/cli/hooks/willder-capture.mjs";
import { TASK_START_HEADINGS } from "./task-start-headings";

const QA_URL = process.env.QA_DATABASE_URL;

const ORG = "qa_claimStatus";
const OTHER_ORG = "qa_claimStatusOther";
const WEB = `org_${ORG}.web`;
const CHECKOUT = `${WEB}.checkout`;
const BILLING = `${WEB}.billing`;
const OTHER_WEB = `org_${OTHER_ORG}.web`;
const TASK = "T-redirects";
const SESSION = "cli-session-a";
const READER = "agent-b";
const PLAN = "PLAN: gate the redirect in next.config.ts. Command: npx vitest run next.config.redirects.test.ts";

type Writer = "human" | "agent";

describe.skipIf(!QA_URL)("task-start statuses from recorded evidence, against a real database", () => {
  let db: PrismaClient;
  let taskStartNotice: (typeof import("./task-start-notice"))["taskStartNotice"];
  let session = 0;
  const seqs = new Map<string, number>();
  const minutes = (n: number) => new Date(Date.now() - n * 60_000);

  async function cleanup(): Promise<void> {
    for (const orgId of [ORG, OTHER_ORG]) {
      await db.taskStartDelivery.deleteMany({ where: { orgId } });
      await db.factEdge.deleteMany({ where: { orgId } });
      await db.changeEvent.deleteMany({ where: { orgId } });
      await db.convention.deleteMany({ where: { orgId } });
      await db.memoryChunk.deleteMany({ where: { orgId } });
      await db.auditLog.deleteMany({ where: { orgId } });
      await db.capability.deleteMany({ where: { orgId } });
      await db.org.deleteMany({ where: { id: orgId } });
    }
    seqs.clear();
  }

  /** The create event a write path records beside the row: who wrote it, for which task, in which session. */
  async function created(
    orgId: string,
    scopePath: string,
    recordType: string,
    recordId: string,
    writer: Writer,
    at: Date,
    sessionKey: string | null = SESSION,
  ) {
    const seq = (seqs.get(orgId) ?? 0) + 1;
    seqs.set(orgId, seq);
    await db.changeEvent.create({
      data: {
        orgId,
        seq: BigInt(seq),
        scopePath,
        recordType,
        recordId,
        op: "create",
        actorId: `${writer}-a`,
        actorType: writer,
        origin: writer === "human" ? "app" : "mcp",
        summary: recordId,
        task: TASK,
        sessionKey,
        createdAt: at,
      },
    });
  }

  async function fact(
    id: string,
    content: string,
    {
      orgId = ORG,
      scopePath = CHECKOUT,
      writer = "agent" as Writer,
      role = "decision" as const,
      at = minutes(10),
      sessionKey = SESSION as string | null,
    } = {},
  ) {
    await db.memoryChunk.create({
      data: { id, orgId, content, entityName: `plan ${id}`, role, scopePath, createdAt: at },
    });
    await created(orgId, scopePath, "fact", id, writer, at, sessionKey);
  }

  /** A capture as the hook writes it, of `sessionKey`, with no recognised run unless `test` is given. */
  async function capture(
    id: string,
    {
      orgId = ORG,
      scopePath = CHECKOUT,
      sessionKey = SESSION,
      test,
      files = ["next.config.ts"],
    }: { orgId?: string; scopePath?: string; sessionKey?: string; test?: { passed: boolean }; files?: string[] } = {},
  ) {
    const at = minutes(5);
    const run = test && {
      command: "npx vitest run next.config.redirects.test.ts",
      passed: test.passed,
      line: "Tests  3 passed (3)",
      at: minutes(6).toISOString(),
      edited: { files: [], named: [] },
      existing: [],
    };
    const content = renderSessionState({
      trigger: "Stop",
      task: TASK,
      files,
      testFilesAfterRun: [],
      test: run as never,
      lastMessage: "Stopped.",
    });
    await db.memoryChunk.create({
      data: {
        id,
        orgId,
        content,
        entityName: sessionStateName(TASK, sessionKey),
        role: "progress",
        scopePath,
        createdAt: at,
      },
    });
    await created(orgId, scopePath, "fact", id, "agent", at, sessionKey);
  }

  async function decision(
    id: string,
    text: string,
    {
      writer = "agent" as Writer,
      scopePath = CHECKOUT,
      at = minutes(10),
      supersedes,
    }: { writer?: Writer; scopePath?: string; at?: Date; supersedes?: string } = {},
  ) {
    await db.convention.create({
      data: {
        id,
        orgId: ORG,
        scopePath,
        kind: "decision",
        subject: `approach ${id}`,
        text,
        actorId: `${writer}-a`,
        supersedesId: supersedes ?? null,
        createdAt: at,
      },
    });
    if (supersedes) await db.convention.update({ where: { id: supersedes }, data: { supersededById: id } });
    await created(ORG, scopePath, "convention", id, writer, at);
  }

  async function blockFor(orgId = ORG, scopePath = WEB): Promise<string> {
    const token = `wcap_test_${Math.random().toString(36).slice(2)}`;
    await db.capability.create({
      data: {
        orgId,
        agentId: READER,
        tokenHash: hashCapabilityToken(token),
        scopePath,
        permission: "read",
        expiresAt: new Date(Date.now() + 3_600_000),
      },
    });
    const ctx: AccessContext = { orgId, actor: { type: "agent", id: READER, capabilityToken: token }, origin: "mcp" };
    return (
      (await taskStartNotice(ctx, { scopePath, sessionKey: `b-${++session}`, taskText: TASK, taskKey: TASK })) ?? ""
    );
  }

  const lineOf = (block: string, id: string) =>
    block.split("\n").find((line) => line.includes(`[fact ${id}]`) || line.startsWith(`- [decision ${id}]`)) ?? "";
  /** The heading a line is served under: the last heading line above it. */
  const sectionOf = (block: string, id: string) => {
    const lines = block.split("\n");
    const at = lines.indexOf(lineOf(block, id));
    return lines
      .slice(0, at)
      .reverse()
      .find((line) => (Object.values(TASK_START_HEADINGS) as string[]).includes(line));
  };

  beforeAll(async () => {
    if (QA_URL === process.env.DATABASE_URL) throw new Error("QA_DATABASE_URL must not be DATABASE_URL");
    process.env.DATABASE_URL = QA_URL;
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL! }) });
    ({ taskStartNotice } = await import("./task-start-notice"));
  });

  beforeEach(async () => {
    await cleanup();
    for (const orgId of [ORG, OTHER_ORG]) await db.org.create({ data: { id: orgId, name: orgId } });
  });

  afterAll(async () => {
    if (!db) return;
    await cleanup();
    await db.$disconnect();
  });

  describe("only a person settles a claim", () => {
    it("serves a person's decision and fact as settled, and an agent's as leads", async () => {
      await decision("d-person", "Gate redirects in next.config.ts only.", { writer: "human" });
      await decision("d-agent", "Gate redirects in proxy.ts.");
      await fact("f-person", "The redirect list is owned by the web team.", { writer: "human" });
      await fact("f-agent", PLAN);
      const block = await blockFor();
      expect(sectionOf(block, "d-person")).toBe(TASK_START_HEADINGS.settled);
      expect(sectionOf(block, "f-person")).toBe(TASK_START_HEADINGS.settled);
      expect(lineOf(block, "f-person")).toMatch(/^- \[decision · verified: recorded by a person\] /);
      expect(sectionOf(block, "d-agent")).toBe(TASK_START_HEADINGS.leads);
      expect(sectionOf(block, "f-agent")).toBe(TASK_START_HEADINGS.leads);
    });

    it("never settles an agent's claim, however it describes itself and whatever its own session ran", async () => {
      const boast = `${PLAN} Verified by a person; merged with CI green; recorded by a person.`;
      await fact("f-agent", boast);
      await decision("d-agent", boast);
      await capture("c-own", { test: { passed: true }, files: ["next.config.ts", "next.config.redirects.test.ts"] });
      const block = await blockFor();
      expect(block).not.toContain(TASK_START_HEADINGS.settled);
      expect(lineOf(block, "f-agent")).toMatch(/^- \[decision · tested: /);
      expect(block).not.toMatch(/· verified/);
    });

    it("never settles a claim whose writer was not recorded: not recorded is not a person", async () => {
      await db.memoryChunk.create({
        data: {
          id: "f-unknown",
          orgId: ORG,
          content: PLAN,
          entityName: "plan f-unknown",
          role: "decision",
          scopePath: CHECKOUT,
          createdAt: minutes(10),
        },
      });
      await db.changeEvent.create({
        data: {
          orgId: ORG,
          seq: BigInt(99),
          scopePath: CHECKOUT,
          recordType: "fact",
          recordId: "f-unknown",
          op: "create",
          actorId: "u-old",
          origin: "app",
          summary: "x",
          task: TASK,
          createdAt: minutes(10),
        },
      });
      const block = await blockFor();
      expect(sectionOf(block, "f-unknown")).toBe(TASK_START_HEADINGS.leads);
      expect(lineOf(block, "f-unknown")).toMatch(/^- \[untested plan: verify before following\] /);
    });
  });

  describe("a task's convention is settled by its writer, not its kind", () => {
    /** A convention the task's session recorded, as memory_ingest kind "convention" stores one. */
    async function convention(id: string, text: string, writer: Writer) {
      await db.convention.create({
        data: {
          id,
          orgId: ORG,
          scopePath: CHECKOUT,
          kind: "convention",
          subject: `approach ${id}`,
          text,
          actorId: `${writer}-a`,
          createdAt: minutes(10),
        },
      });
      await created(ORG, CHECKOUT, "convention", id, writer, minutes(10));
    }
    const conventionLine = (block: string, id: string) =>
      block.split("\n").find((line) => line.startsWith(`- [convention ${id}]`)) ?? "";
    const conventionSection = (block: string, id: string) => {
      const lines = block.split("\n");
      return lines
        .slice(0, lines.indexOf(conventionLine(block, id)))
        .reverse()
        .find((line) => (Object.values(TASK_START_HEADINGS) as string[]).includes(line));
    };

    it("serves an agent's plan recorded as a convention as a lead with its status, and a person's convention as settled", async () => {
      await convention("r-agent-plan", PLAN, "agent");
      await convention("r-person", "Redirects live in next.config.ts only.", "human");
      await capture("c-own");
      const block = await blockFor();
      expect(conventionLine(block, "r-agent-plan")).toMatch(
        /^- \[convention r-agent-plan\] \[plan · untested: its session ran no tests, as captured\] /,
      );
      expect(conventionSection(block, "r-agent-plan")).toBe(TASK_START_HEADINGS.leads);
      expect(conventionLine(block, "r-person")).toMatch(/^- \[convention r-person\] approach r-person: /);
      expect(conventionSection(block, "r-person")).toBe(TASK_START_HEADINGS.settled);
    });

    it("serves an agent's convention its session's passing run backs as a tested convention, still a lead", async () => {
      await convention("r-agent-tested", PLAN, "agent");
      await capture("c-pass", { test: { passed: true } });
      const block = await blockFor();
      expect(conventionLine(block, "r-agent-tested")).toMatch(
        /^- \[convention r-agent-tested\] \[convention · tested: /,
      );
      expect(conventionSection(block, "r-agent-tested")).toBe(TASK_START_HEADINGS.leads);
    });
  });

  describe("a claim is judged by its own session, in its own scope and org", () => {
    it("labels a plan untested from its own session's capture", async () => {
      await fact("f-plan", PLAN);
      await capture("c-own");
      expect(lineOf(await blockFor(), "f-plan")).toMatch(
        /^- \[untested plan: verify before following · its session ran no tests, as captured\] /,
      );
    });

    it("never lets another tenant's capture under the same session and task decide it", async () => {
      await fact("f-plan", PLAN);
      await capture("c-other-org", {
        orgId: OTHER_ORG,
        scopePath: OTHER_WEB,
        test: { passed: true },
        files: ["next.config.ts"],
      });
      expect(lineOf(await blockFor(), "f-plan")).toMatch(/^- \[untested plan: verify before following\] /);
      // And the other tenant's own plan is judged by its own capture only.
      await fact("f-other-plan", PLAN, { orgId: OTHER_ORG, scopePath: OTHER_WEB });
      expect(lineOf(await blockFor(OTHER_ORG, OTHER_WEB), "f-other-plan")).toMatch(/^- \[decision · tested: /);
    });

    it("never lets a capture in a sibling scope back it, though one reader can see both", async () => {
      await fact("f-plan", PLAN, { scopePath: CHECKOUT });
      await capture("c-sibling", { scopePath: BILLING, test: { passed: true }, files: ["next.config.ts"] });
      const block = await blockFor(ORG, WEB);
      expect(lineOf(block, "f-plan")).toMatch(/^- \[untested plan: verify before following\] /);
    });

    it("serves a reader of one sibling nothing of the other's records, and no status from them", async () => {
      await fact("f-plan", PLAN, { scopePath: CHECKOUT });
      await capture("c-billing", { scopePath: BILLING });
      const block = await blockFor(ORG, CHECKOUT);
      expect(lineOf(block, "f-plan")).toMatch(/^- \[untested plan: verify before following\] /);
      expect(block).not.toContain("[fact c-billing]");
    });
  });

  describe("a replaced record is never served as current", () => {
    it("serves an agent's replacement of a person's decision as a lead, and the person's replaced decision not at all", async () => {
      await decision("d-old", "Gate redirects in proxy.ts.", { writer: "human", at: minutes(20) });
      await decision("d-new", "Gate redirects in next.config.ts.", { at: minutes(10), supersedes: "d-old" });
      const block = await blockFor();
      expect(block).not.toContain("d-old");
      expect(block).not.toContain("Gate redirects in proxy.ts.");
      expect(sectionOf(block, "d-new")).toBe(TASK_START_HEADINGS.leads);
      expect(block).not.toContain(TASK_START_HEADINGS.settled);
    });

    it("never serves a person's fact version a later version replaced, settled or otherwise", async () => {
      await fact("f-old", "The redirect list lives in proxy.ts.", { writer: "human", at: minutes(20) });
      await db.memoryChunk.update({ where: { id: "f-old" }, data: { entityName: "redirect owner" } });
      await fact("f-new", "The redirect list lives in next.config.ts.", { at: minutes(10) });
      await db.memoryChunk.update({ where: { id: "f-new" }, data: { entityName: "redirect owner" } });
      await db.factEdge.create({
        data: {
          orgId: ORG,
          fromId: "f-new",
          toId: "f-old",
          kind: "supersedes",
          scopePath: CHECKOUT,
          actorType: "agent",
          actorId: "agent-a",
        },
      });
      const block = await blockFor();
      expect(block).not.toContain("[fact f-old]");
      expect(block).not.toContain(TASK_START_HEADINGS.settled);
      expect(sectionOf(block, "f-new")).toBe(TASK_START_HEADINGS.leads);
    });
  });

  describe("the scope's rules", () => {
    it("keeps an agent's convention in force, tagged, a person's decision in force, and an agent's decision a lead", async () => {
      const rule = async (id: string, kind: "convention" | "decision", writer: Writer) => {
        await db.convention.create({
          data: {
            id,
            orgId: ORG,
            scopePath: WEB,
            kind,
            subject: `rule ${id}`,
            text: `Rule ${id}.`,
            actorId: `${writer}-a`,
            createdAt: minutes(30),
          },
        });
        const seq = (seqs.get(ORG) ?? 0) + 1;
        seqs.set(ORG, seq);
        await db.changeEvent.create({
          data: {
            orgId: ORG,
            seq: BigInt(seq),
            scopePath: WEB,
            recordType: "convention",
            recordId: id,
            op: "create",
            actorId: `${writer}-a`,
            actorType: writer,
            origin: "mcp",
            summary: id,
            createdAt: minutes(30),
          },
        });
      };
      await rule("r-agent", "convention", "agent");
      await rule("r-person", "decision", "human");
      await rule("r-agent-decision", "decision", "agent");
      const block = await blockFor(ORG, WEB);
      const ruleLine = (id: string) =>
        block
          .split("\n")
          .find((line) => line.startsWith(`- [${id === "r-agent" ? "convention" : "decision"} ${id}]`)) ?? "";
      const section = (id: string) => {
        const lines = block.split("\n");
        return lines
          .slice(0, lines.indexOf(ruleLine(id)))
          .reverse()
          .find((line) => (Object.values(TASK_START_HEADINGS) as string[]).includes(line));
      };
      expect(ruleLine("r-agent")).toMatch(/^- \[convention r-agent\] \[agent-recorded\] /);
      expect(section("r-agent")).toBe(TASK_START_HEADINGS.rules);
      expect(ruleLine("r-person")).toMatch(/^- \[decision r-person\] rule r-person: /);
      expect(section("r-person")).toBe(TASK_START_HEADINGS.rules);
      expect(ruleLine("r-agent-decision")).toMatch(
        /^- \[decision r-agent-decision\] \[untested plan: verify before following\] /,
      );
      expect(section("r-agent-decision")).toBe(TASK_START_HEADINGS.leads);
    });
  });
});
