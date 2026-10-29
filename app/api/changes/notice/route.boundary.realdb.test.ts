// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// The task-start block after Claude Code compacts or clears a session's context.
//
// Compaction keeps the session id, so before this the model after a compaction was never told
// the block again: the delivery row said the session was served, and the summary that replaced
// the conversation need not hold what the block said. The hook installed by `willder init` now
// answers SessionStart with source `compact` by asking the notice route with X-Willder-Reason:
// compact, which makes a block delivered before that request due once more for the session. A
// `/clear` starts a new session id; the hook asks at its SessionStart(clear) with X-Willder-Reason:
// clear. Either boundary's block is laid out verified first: what the hook saw the last session
// do, then what still fails, the decisions, and the plan and next step last, as claims to check.
// A handoff the session recorded through memory_ingest reaches the next session part by part.
//
// What this pins, on the real seam: the hook `willder init --capture` installs, run as Claude
// Code runs it (a node process fed the event Claude Code sends, with the fields a probe of
// Claude Code 2.1.290 showed), against the real notice and MCP routes on a socket, check()
// against live capabilities and Postgres. Agent A records a decision with its reason in session
// one; after `/compact` the same session, and after `/clear` the next session, is told it again,
// with what the capture written at PreCompact or Stop saw first among the verified lines. A prompt
// after that is not told it a second time. A startup is left to the first prompt; a compaction whose
// reply was abandoned leaves the block for the next prompt; one whose request lands after the
// next call was told the block re-arms nothing; a compaction is the caller's own, so it never
// makes another agent's, task's or session's block due; and it never serves a record the token
// may not read.
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { PrismaClient } from "@/lib/generated/prisma/client";
// The leaf module, not the `@/services/access` barrel: the barrel builds the `@/lib/db`
// singleton at import time, before beforeAll points DATABASE_URL at the test database.
import { hashCapabilityToken } from "@/services/access/capabilities";
import type { AccessContext } from "@/services/access";
import { init } from "@/cli/willder.mjs";
import { EmptyGraphMemoryService } from "@/mcp/memory-service-stub.testsupport";
import { TASK_START_HEADER, TASK_START_HEADINGS, TASK_START_OBSERVED_LABEL } from "@/mcp/task-start-headings";
import { HANDOFF_PARTS, handoffParts } from "@/services/memory/session-handoff";

vi.mock("@/services/guardrails", () => ({
  checkEpisodeCap: async () => undefined,
  recordEpisode: async () => undefined,
}));
vi.mock("@/lib/llm", () => ({
  createLLMClient: () => ({
    chat: {
      completions: {
        create: async () => {
          throw new Error("no llm in this test");
        },
      },
    },
  }),
  LLM_MODEL_EXTRACT: "test-model",
  LLM_MODEL_ORCHESTRATOR: "test-model",
}));

const QA_URL = process.env.QA_DATABASE_URL;
const ORG = "boundaryreserve";
const ROOT = `org_${ORG}`;
const WEB = `${ROOT}.web`;
/** A sibling of `web`, not a descendant: agent A's token on `web` may not read it. */
const WEB_INTERNAL = `${ROOT}.web_internal`;
const SPAWN_TIMEOUT_MS = 30_000;

const TASK = "WEB-977";
const OTHER_TASK = "WEB-978";
/** The decision agent A records in session one, with its reason: what must survive each boundary. */
const DECISION = {
  name: "Session store",
  kind: "decision",
  content:
    "WEB-977: keep sessions in Postgres, not Redis, because a Redis restart logged every user out during the September incident.",
};
/** A record in the sibling scope that names the task: never served to a token on `web`. */
const HIDDEN = "WEB-977: internal note, the staging database password rotates on Fridays.";
const LAST_MESSAGE = "Moved the session store to Postgres; the session tests pass. Next I wire the logout path.";

describe.skipIf(!QA_URL)(
  "the task-start block after a context boundary, through the installed hook, against a real database",
  () => {
    const service = new EmptyGraphMemoryService();
    const clients: Client[] = [];
    let db: PrismaClient;
    let origin = "";
    let closeServer: () => Promise<void>;
    let ClientClass: (typeof import("@modelcontextprotocol/sdk/client/index.js"))["Client"];
    let Transport: (typeof import("@modelcontextprotocol/sdk/client/streamableHttp.js"))["StreamableHTTPClientTransport"];
    let toolCallNotice: (typeof import("@/mcp/change-notices"))["toolCallNotice"];
    let projectDir = "";
    let stateTmp = "";
    let hookPath = "";
    let transcriptPath = "";
    const tokens: Record<string, string> = {};
    /** Requests the notice route received, by the boundary each named ("" for none). */
    const noticeRequests: string[] = [];

    async function mint(agentId: string, permission: "read" | "write", scopePath = WEB): Promise<string> {
      const token = `wcap_test_${agentId}_${Math.random().toString(36).slice(2)}`;
      await db.capability.create({
        data: {
          orgId: ORG,
          agentId,
          tokenHash: hashCapabilityToken(token),
          scopePath,
          permission,
          grantGoverned: false,
          expiresAt: new Date(Date.now() + 60 * 60 * 1000),
        },
      });
      return token;
    }

    /** One memory_ingest call over the real /api/mcp route, with the reply's text. */
    async function callIngest(
      token: string,
      args: Record<string, unknown>,
      meta: Record<string, string>,
    ): Promise<string> {
      const client: Client = new ClientClass({ name: "agent", version: "0.0.0" });
      await client.connect(
        new Transport(new URL(`${origin}/api/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }),
      );
      clients.push(client);
      const result = await client.callTool({ name: "memory_ingest", arguments: args, _meta: meta });
      return (result.content as { text?: string }[])[0]?.text ?? "";
    }

    async function ingest(token: string, args: Record<string, unknown>, meta: Record<string, string>): Promise<void> {
      expect(await callIngest(token, args, meta)).toMatch(/^Recorded decision /);
    }

    /**
     * Run the installed hook once, as Claude Code runs it, and return the context it hands the
     * model, or "" when it prints nothing. `token` defaults to agent A's.
     */
    function runHook(
      input: Record<string, unknown>,
      { token = tokens.a!, task = TASK, env = {} as Record<string, string> } = {},
    ): Promise<string> {
      return new Promise((done, fail) => {
        const child = execFile(
          process.execPath,
          [hookPath],
          {
            cwd: projectDir,
            env: {
              NODE_ENV: "test",
              PATH: process.env.PATH,
              TMPDIR: stateTmp,
              WILLDER_TOKEN: token,
              WILLDER_URL: origin,
              WILLDER_TASK: task,
              WILLDER_CAPTURE: "session-state",
              ...env,
            },
          },
          (error, stdout) =>
            error
              ? fail(error)
              : done(stdout === "" ? "" : (JSON.parse(stdout).hookSpecificOutput.additionalContext as string)),
        );
        child.stdin!.end(JSON.stringify({ cwd: projectDir, transcript_path: transcriptPath, ...input }));
      });
    }

    /** The block in what the hook handed over, without the change notices that may follow it; "" when there is none. */
    const blockIn = (context: string) =>
      context.includes(TASK_START_HEADER)
        ? context.slice(context.indexOf(TASK_START_HEADER)).split("\n\nChanged in your scope")[0]!
        : "";
    /** The lines of what the hook saw a session do, as a boundary's block serves them first. */
    const observedLines = (block: string) =>
      block.split("\n").filter((line) => line.startsWith(`- ${TASK_START_OBSERVED_LABEL}`));

    /** One session of agent A before its boundary: a prompt, the decision with its reason, a passing run. */
    async function workBeforeBoundary(session: string): Promise<void> {
      await runHook({ hook_event_name: "UserPromptSubmit", session_id: session, prompt: "Move the session store." });
      await ingest(tokens.a!, DECISION, { "willder/session": session, "willder/task": TASK });
      writeFileSync(join(projectDir, "sessions.ts"), "export const store = 'postgres';\n");
      await runHook({
        hook_event_name: "PostToolUse",
        session_id: session,
        tool_name: "Bash",
        tool_input: { command: "npx vitest run sessions.test.ts" },
        tool_response: { stdout: " Test Files  1 passed (1)\n      Tests  4 passed (4)\n", stderr: "" },
      });
      writeFileSync(
        transcriptPath,
        `${JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: LAST_MESSAGE }] } })}\n`,
      );
    }

    beforeAll(async () => {
      if (QA_URL === undefined) return;
      if (QA_URL === process.env.DATABASE_URL) throw new Error("QA_DATABASE_URL must not be DATABASE_URL");
      process.env.DATABASE_URL = QA_URL;
      process.env.GRAPHITI_SERVICE_URL = await service.start();
      process.env.GRAPHITI_SERVICE_API_KEY = "test-key";
      db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });

      const inngestModule = await import("@/lib/inngest");
      vi.spyOn(inngestModule.inngest, "send").mockImplementation((async () => ({ ids: ["job"] })) as never);
      ({ Client: ClientClass } = await import("@modelcontextprotocol/sdk/client/index.js"));
      ({ StreamableHTTPClientTransport: Transport } = await import(
        "@modelcontextprotocol/sdk/client/streamableHttp.js"
      ));
      ({ toolCallNotice } = await import("@/mcp/change-notices"));
      const { GET } = await import("./route");
      const { startMcpTestServer } = await import("@/mcp/http-test-server");
      const server = await startMcpTestServer({
        "/api/changes/notice": {
          GET: (req) => {
            noticeRequests.push(req.headers.get("x-willder-reason") ?? "");
            return GET(req);
          },
        },
      });
      origin = new URL(server.url).origin;
      closeServer = server.close;

      await db.org.deleteMany({ where: { id: ORG } });
      await db.org.create({ data: { id: ORG, name: ORG } });
      for (const path of [ROOT, WEB, WEB_INTERNAL]) await db.scope.create({ data: { orgId: ORG, path, name: path } });
      tokens.a = await mint("boundary-agent-a", "write");
      tokens.b = await mint("boundary-agent-b", "read");
      tokens.aInternal = await mint("boundary-agent-a", "write", WEB_INTERNAL);
      tokens.internal = await mint("boundary-agent-c", "write", WEB_INTERNAL);
      await ingest(
        tokens.internal,
        { name: "Staging note", kind: "decision", content: HIDDEN },
        { "willder/session": "c-1", "willder/task": TASK },
      );

      projectDir = mkdtempSync(join(tmpdir(), "willder-boundary-"));
      stateTmp = mkdtempSync(join(tmpdir(), "willder-boundary-state-"));
      transcriptPath = join(stateTmp, "transcript.jsonl");
      writeFileSync(transcriptPath, "");
      ({ hookPath } = init({ projectDir, url: origin, capture: true }));
    }, 120_000);

    afterAll(async () => {
      if (QA_URL === undefined) return;
      await Promise.all(clients.map((client) => client.close()));
      await closeServer?.();
      await service.stop();
      await db.org.deleteMany({ where: { id: ORG } });
      await db.$disconnect();
      rmSync(projectDir, { recursive: true, force: true });
      rmSync(stateTmp, { recursive: true, force: true });
    });

    beforeEach(() => {
      noticeRequests.length = 0;
    });

    describe("after /compact: the same session id, told again once", () => {
      const SESSION = "3c1fc0c1-compact-session";
      let block = "";
      let promptAfter = "";

      beforeAll(async () => {
        if (QA_URL === undefined) return;
        await workBeforeBoundary(SESSION);
        // As Claude Code sends them for a manual /compact: PreCompact, then SessionStart(compact) with the same id.
        await runHook({
          hook_event_name: "PreCompact",
          session_id: SESSION,
          trigger: "manual",
          custom_instructions: null,
        });
        block = blockIn(
          await runHook({
            hook_event_name: "SessionStart",
            session_id: SESSION,
            source: "compact",
            model: "claude-haiku-4-5",
          }),
        );
        promptAfter = await runHook({ hook_event_name: "UserPromptSubmit", session_id: SESSION, prompt: "Continue." });
      }, SPAWN_TIMEOUT_MS * 4);

      it("serves the session-one decision with its reason, and opens with what the capture written at PreCompact saw", () => {
        expect(block).toContain("because a Redis restart logged every user out");
        expect(block.split("\n")[1]).toBe(TASK_START_HEADINGS.verified);
        expect(observedLines(block)[0]).toContain("captured automatically by the Willder hook at PreCompact");
        expect(observedLines(block)[0]).toContain(`session ${SESSION.slice(0, 8)}`);
      });

      it("does not tell the prompt after the boundary the block a second time", () => {
        expect(blockIn(promptAfter)).toBe("");
      });

      it("keeps the re-served block within a boundary block's budget", async () => {
        const { estimateTokens, BOUNDARY_TASK_START_MAX_TOKENS } = await import("@/mcp/task-start-notice");
        expect(estimateTokens(block)).toBeLessThanOrEqual(BOUNDARY_TASK_START_MAX_TOKENS);
      });

      it("never serves a record the token may not read", () => {
        expect(block).not.toContain(HIDDEN);
      });
    });

    describe("after /clear: a new session id, told once, at its SessionStart", () => {
      const BEFORE = "5e8d0a42-clear-before";
      const AFTER = "1bae966f-clear-after";
      let atSessionStart = "";
      let block = "";
      let promptAfter = "";
      let noticeRequestsAtClear: string[] = [];

      beforeAll(async () => {
        if (QA_URL === undefined) return;
        await workBeforeBoundary(BEFORE);
        // As Claude Code sends them for /clear: Stop ended the last turn, SessionEnd(clear) the old
        // session, then SessionStart(clear) under a new id, then the person's next prompt.
        await runHook({ hook_event_name: "Stop", session_id: BEFORE, last_assistant_message: LAST_MESSAGE });
        await runHook({ hook_event_name: "SessionEnd", session_id: BEFORE, reason: "clear" });
        noticeRequests.length = 0;
        atSessionStart = await runHook({ hook_event_name: "SessionStart", session_id: AFTER, source: "clear" });
        noticeRequestsAtClear = [...noticeRequests];
        block = blockIn(atSessionStart);
        promptAfter = await runHook({
          hook_event_name: "UserPromptSubmit",
          session_id: AFTER,
          prompt: "Wire the logout path.",
        });
      }, SPAWN_TIMEOUT_MS * 6);

      it("asks at SessionStart(clear), naming the boundary", () => {
        expect(noticeRequestsAtClear).toContain("clear");
      });

      it("serves the earlier session's decision with its reason, and what its capture saw first", () => {
        expect(block).toContain("because a Redis restart logged every user out");
        expect(observedLines(block)[0]).toContain("captured automatically by the Willder hook at Stop");
        expect(observedLines(block)[0]).toContain(`session ${BEFORE.slice(0, 8)}`);
      });

      it("does not tell the prompt after the boundary the block a second time", () => {
        expect(blockIn(promptAfter)).toBe("");
      });
    });

    describe("a long session's handoff, across /clear (M1)", () => {
      const HANDOFF_TASK = "WEB-979";
      const BEFORE = "7c9d2e10-handoff-before";
      const AFTER = "2f6a8b44-handoff-after";
      const HANDOFF = [
        "Still failing or unfinished: the logout path still keeps the Redis session cookie alive after sign-out.",
        "Done and checked: npx vitest run sessions.test.ts: 4 passed, on sessions.ts.",
        "Decisions: keep sessions in Postgres, because a Redis restart logged every user out in September.",
        "Rejected: a Redis cluster, since it still loses sessions on a full restart.",
        "Not yet checked: whether the mobile client caches the old cookie name.",
        "Next step: verify sign-out clears the cookie with a test in sessions.test.ts, then wire the logout route.",
      ].join("\n");
      const name = `Handoff: ${HANDOFF_TASK}, session ${BEFORE.slice(0, 8)}`;
      const meta = { "willder/session": BEFORE, "willder/task": HANDOFF_TASK };
      let ask = "";
      let refused = "";
      let stored = "";
      let nudge = "";
      let block = "";

      beforeAll(async () => {
        if (QA_URL === undefined) return;
        const hookFor = (input: Record<string, unknown>, env: Record<string, string> = {}) =>
          runHook(input, { task: HANDOFF_TASK, env });
        await hookFor({ hook_event_name: "UserPromptSubmit", session_id: BEFORE, prompt: "Move the session store." });
        const usage = {
          input_tokens: 12,
          cache_read_input_tokens: 131_000,
          cache_creation_input_tokens: 400,
          output_tokens: 90,
        };
        writeFileSync(
          transcriptPath,
          `${JSON.stringify({ type: "assistant", message: { id: "m9", usage, content: [{ type: "text", text: LAST_MESSAGE }] } })}\n`,
        );
        ask = await hookFor({
          hook_event_name: "PostToolUse",
          session_id: BEFORE,
          tool_name: "Bash",
          tool_input: { command: "npx vitest run sessions.test.ts 2>&1 | tail -3" },
          tool_response: { stdout: " Test Files  1 passed (1)\n      Tests  4 passed (4)\n", stderr: "" },
        });
        refused = await callIngest(tokens.a!, { name, content: HANDOFF.replace(/^Rejected:.*\n/m, "") }, meta);
        stored = await callIngest(tokens.a!, { name, content: HANDOFF }, meta);
        nudge = await hookFor(
          {
            hook_event_name: "PostToolUse",
            session_id: BEFORE,
            tool_name: "mcp__willder__memory_ingest",
            tool_input: { name, content: HANDOFF },
            tool_response: [{ type: "text", text: stored }],
          },
          { WILLDER_RESTART_NUDGE: "on" },
        );
        await hookFor({ hook_event_name: "Stop", session_id: BEFORE, last_assistant_message: LAST_MESSAGE });
        await hookFor({ hook_event_name: "SessionEnd", session_id: BEFORE, reason: "clear" });
        block = blockIn(await hookFor({ hook_event_name: "SessionStart", session_id: AFTER, source: "clear" }));
      }, SPAWN_TIMEOUT_MS * 8);

      it("asks for the six-part handoff at a checkpoint past the threshold, and only the stored one turns on the restart line", async () => {
        const { HANDOFF_RESTART_LINE } = await import("@/cli/hooks/willder-handoff.mjs");
        for (const { heading } of HANDOFF_PARTS) expect(ask).toContain(`\n${heading}`);
        expect(ask).toContain(`"${name}"`);
        expect(refused).toMatch(/^incomplete_handoff: nothing was stored\. .*missing Rejected:/);
        expect(stored).toMatch(/Version: \S+\./);
        expect(nudge).toContain(HANDOFF_RESTART_LINE);
      });

      it("serves every part of the handoff to the next session, from its start, with its source", () => {
        const squash = (text: string) => text.replace(/\s+/g, " ").trim();
        const parts = handoffParts(HANDOFF);
        for (const { key } of HANDOFF_PARTS) expect(squash(block)).toContain(squash(parts[key]!).slice(0, 60));
        const handoffLines = block.split("\n").filter((line) => line.includes(name));
        expect(handoffLines).toHaveLength(HANDOFF_PARTS.length);
        for (const line of handoffLines) expect(line).toMatch(/ — boundary-agent-a, \d\d-\d\d$/);
      });

      it("lays the block out verified first and the next step last, with the handoff among the first three items", () => {
        const headings = block
          .split("\n")
          .filter((line) => (Object.values(TASK_START_HEADINGS) as string[]).includes(line));
        expect(headings.slice(0, 2)).toEqual([TASK_START_HEADINGS.verified, TASK_START_HEADINGS.unfinished]);
        expect(headings.indexOf(TASK_START_HEADINGS.claims)).toBeGreaterThan(
          headings.indexOf(TASK_START_HEADINGS.decided),
        );
        const items = block.split("\n").filter((line) => line.startsWith("- "));
        expect(items.slice(0, 3).some((line) => line.includes(name))).toBe(true);
        expect(block.indexOf("Next step: verify sign-out")).toBeGreaterThan(block.indexOf(TASK_START_HEADINGS.claims));
      });
    });

    it(
      "asks nothing at a startup or a resume, so the first prompt is still told the block, ranked by that prompt",
      async () => {
        for (const source of ["startup", "resume"]) {
          expect(await runHook({ hook_event_name: "SessionStart", session_id: `start-${source}`, source })).toBe("");
        }
        expect(noticeRequests).toEqual([]);
        expect(
          blockIn(
            await runHook({
              hook_event_name: "UserPromptSubmit",
              session_id: "start-startup",
              prompt: "Move the session store.",
            }),
          ),
        ).not.toBe("");
      },
      SPAWN_TIMEOUT_MS * 3,
    );

    it("re-serves only for the exact value compact: any other X-Willder-Reason is a served session's ordinary poll", async () => {
      const { GET } = await import("./route");
      const poll = async (session: string, reason?: string) => {
        const res = await GET(
          new Request(`${origin}/api/changes/notice`, {
            headers: {
              authorization: `Bearer ${tokens.a}`,
              "x-willder-task": TASK,
              "x-willder-session": session,
              ...(reason === undefined ? {} : { "x-willder-reason": reason }),
            },
          }),
        );
        return blockIn(((await res.json()) as { notice: string | null }).notice ?? "");
      };
      for (const reason of ["clear", "startup", "resume", "Compact", "compact,clear", "true"]) {
        const session = `reason-${reason}`;
        expect(await poll(session)).not.toBe("");
        expect(await poll(session, reason), reason).toBe("");
      }
      expect(await poll("reason-compact", undefined)).not.toBe("");
      expect(await poll("reason-compact", "compact")).not.toBe("");
    });

    it("leaves the block due when the boundary's reply was abandoned, so the next prompt is told it", async () => {
      const ctx: AccessContext = {
        orgId: ORG,
        actor: { type: "agent", id: "boundary-agent-a", capabilityToken: tokens.a! },
        origin: "api",
      };
      const request = (abandoned?: AbortSignal) => ({
        taskStart: {
          sessionKey: "abandoned-session",
          taskText: TASK,
          taskKey: TASK,
          ...(abandoned ? { abandoned } : {}),
        },
      });
      expect(blockIn((await toolCallNotice(ctx, WEB, request())) ?? "")).not.toBe("");

      const atBoundary = request(AbortSignal.abort());
      expect(
        blockIn(
          (await toolCallNotice(ctx, WEB, { taskStart: { ...atBoundary.taskStart, compactedAt: new Date() } })) ?? "",
        ),
      ).toBe("");
      expect(blockIn((await toolCallNotice(ctx, WEB, request())) ?? "")).not.toBe("");
      expect(blockIn((await toolCallNotice(ctx, WEB, request())) ?? "")).toBe("");
    });

    it("tells each compaction once: two in a row each serve the block, and racing calls after one serve it exactly once", async () => {
      const ctx: AccessContext = {
        orgId: ORG,
        actor: { type: "agent", id: "boundary-agent-a", capabilityToken: tokens.a! },
        origin: "api",
      };
      const call = (compactedAt?: Date) =>
        toolCallNotice(ctx, WEB, {
          taskStart: {
            sessionKey: "twice-session",
            taskText: TASK,
            taskKey: TASK,
            ...(compactedAt ? { compactedAt } : {}),
          },
        });
      expect(blockIn((await call()) ?? "")).not.toBe("");
      for (let compaction = 0; compaction < 2; compaction += 1) {
        expect(blockIn((await call(new Date())) ?? "")).not.toBe("");
        expect(blockIn((await call()) ?? "")).toBe("");
      }

      // The boundary's own reply abandoned, then five calls at once: one claim wins.
      await toolCallNotice(ctx, WEB, {
        taskStart: {
          sessionKey: "twice-session",
          taskText: TASK,
          taskKey: TASK,
          compactedAt: new Date(),
          abandoned: AbortSignal.abort(),
        },
      });
      const racing = await Promise.all(Array.from({ length: 5 }, () => call()));
      expect(racing.filter((notice) => blockIn(notice ?? "") !== "")).toHaveLength(1);
    });

    it("orders a delivery in the compaction's own millisecond before it, and one a millisecond later after it", async () => {
      // Both instants are whole milliseconds; a tie used to count as "after", so a session that
      // called in the compaction's millisecond was never told the block again (the flake this pins).
      const ctx: AccessContext = {
        orgId: ORG,
        actor: { type: "agent", id: "boundary-agent-a", capabilityToken: tokens.a! },
        origin: "api",
      };
      const sessionKey = "same-millisecond-session";
      const call = (compactedAt?: Date) =>
        toolCallNotice(ctx, WEB, {
          taskStart: { sessionKey, taskText: TASK, taskKey: TASK, ...(compactedAt ? { compactedAt } : {}) },
        });
      const deliveredAt = async () => {
        const [row] = await db.$queryRaw<{ at: string }[]>`
        SELECT to_char("deliveredAt", 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "at" FROM "task_start_deliveries"
        WHERE "orgId" = ${ORG} AND "agentId" = 'boundary-agent-a' AND "sessionKey" = ${sessionKey}`;
        expect(row!.at, "stored to the whole millisecond").toMatch(/\.\d{3}000Z$/);
        return new Date(row!.at);
      };
      expect(blockIn((await call()) ?? "")).not.toBe("");
      const first = await deliveredAt();
      expect(blockIn((await call(new Date(first.getTime() - 1))) ?? "")).toBe("");
      expect(blockIn((await call(first)) ?? "")).not.toBe("");
      const second = await deliveredAt();
      expect(blockIn((await call(second)) ?? "")).not.toBe("");
    });

    it("re-arms nothing when the compaction's request lands after a later call was already told the block", async () => {
      // The request reporting a compaction reached the server first, but a cold start held it until
      // after the session's next call, on a row idle past the window, had claimed the block.
      const ctx: AccessContext = {
        orgId: ORG,
        actor: { type: "agent", id: "boundary-agent-a", capabilityToken: tokens.a! },
        origin: "api",
      };
      const call = (extra: { compactedAt?: Date; abandoned?: AbortSignal } = {}) =>
        toolCallNotice(ctx, WEB, {
          taskStart: { sessionKey: "late-compaction-session", taskText: TASK, taskKey: TASK, ...extra },
        });
      const compactedAt = new Date();
      expect(blockIn((await call()) ?? "")).not.toBe("");
      expect(blockIn((await call({ compactedAt, abandoned: AbortSignal.abort() })) ?? "")).toBe("");
      expect(blockIn((await call()) ?? "")).toBe("");
    });

    it.each([
      ["another agent's boundary in the same session", { token: "b", task: TASK, other: "" }],
      ["the same agent's boundary on another task in the same session", { token: "a", task: OTHER_TASK, other: "" }],
      ["the same agent's boundary through its token on another scope", { token: "aInternal", task: TASK, other: "" }],
      ["the same agent's boundary in another session", { token: "a", task: TASK, other: "-other" }],
    ] as const)(
      "is the caller's own: %s does not make the block due again",
      async (_, boundary) => {
        const session = `own-${boundary.token}-${boundary.task}${boundary.other}`;
        expect(
          blockIn(await runHook({ hook_event_name: "UserPromptSubmit", session_id: session, prompt: "Go." })),
        ).not.toBe("");
        await runHook(
          { hook_event_name: "SessionStart", session_id: `${session}${boundary.other}`, source: "compact" },
          { token: tokens[boundary.token]!, task: boundary.task },
        );
        expect(
          blockIn(await runHook({ hook_event_name: "UserPromptSubmit", session_id: session, prompt: "Go on." })),
        ).toBe("");
      },
      SPAWN_TIMEOUT_MS * 3,
    );

    // A complete handoff stored in a scope the reader may
    // not see is never served, and never switches the block to the boundary layout, which would tell
    // the reader that a handoff exists. A reader on that scope is the control: it is served.
    describe("a handoff in a scope the reader may not see", () => {
      const QA_TASK = "WEB-990";
      const SECRET = "Case857-HIDDEN-PART the vault key lives in ops/keys.ts";
      const content = [
        `Still failing or unfinished: ${SECRET}.`,
        "Done and checked: npx vitest run vault.test.ts: 3 passed.",
        "Decisions: keep the vault in Postgres, because the old store lost keys.",
        "Rejected: none",
        "Not yet checked: whether rotation works.",
        "Next step: verify rotation with vault.test.ts, then ship.",
      ].join("\n");
      let hiddenBlock = "";
      let hiddenClear = "";
      let controlBlock = "";

      beforeAll(async () => {
        if (QA_URL === undefined) return;
        const stored = await callIngest(
          tokens.internal!,
          { name: `Handoff: ${QA_TASK}, session case857hid`, content },
          { "willder/session": "case857hid-internal", "willder/task": QA_TASK },
        );
        expect(stored).toMatch(/Version: \S+\./);
        await ingest(
          await mint("case857-agent-d", "write"),
          { name: "Vault plan", kind: "decision", content: `${QA_TASK}: the vault keeps one key per org.` },
          { "willder/session": "case857-web-d", "willder/task": QA_TASK },
        );
        hiddenBlock = blockIn(
          await runHook(
            { hook_event_name: "UserPromptSubmit", session_id: "case857-web-b", prompt: "Finish the vault." },
            { token: tokens.b!, task: QA_TASK },
          ),
        );
        hiddenClear = blockIn(
          await runHook(
            { hook_event_name: "SessionStart", session_id: "case857-web-b2", source: "clear" },
            { token: tokens.b!, task: QA_TASK },
          ),
        );
        controlBlock = blockIn(
          await runHook(
            { hook_event_name: "UserPromptSubmit", session_id: "case857-int-a", prompt: "Finish the vault." },
            { token: tokens.aInternal!, task: QA_TASK },
          ),
        );
      }, SPAWN_TIMEOUT_MS * 5);

      it("is never served to a token on web, and leaves its first block's layout", () => {
        expect(hiddenBlock).not.toBe("");
        expect(hiddenBlock).not.toContain("Case857-HIDDEN-PART");
        expect(hiddenBlock).not.toContain("Handoff:");
        expect(hiddenBlock).not.toContain(TASK_START_HEADINGS.verified);
        expect(hiddenBlock).not.toContain(TASK_START_HEADINGS.claims);
      });

      it("is never served at a /clear boundary to a token on web", () => {
        expect(hiddenClear).not.toContain("Case857-HIDDEN-PART");
        expect(hiddenClear).not.toContain("Handoff:");
      });

      it("is served, verified first, to a reader on its scope (the control)", () => {
        expect(controlBlock).toContain("Case857-HIDDEN-PART");
        expect(controlBlock).toContain(TASK_START_HEADINGS.claims);
      });
    });
  },
);
