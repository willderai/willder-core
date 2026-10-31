// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// memory_query names the synced item a connector's fact came from, by the id the item's
// change event carries.
//
// The workload: a GitHub source syncs issues, and graph extraction states each issue as facts
// in its own words, so no served fact reads like the item it came from. An agent that sees a
// change notice for an item, or a reviewer checking where a fact came from, needs the item's
// id on the fact, not its text. A Drive file is synced as passages, each stored as its own row
// and served from it.
//
// Real: the hosted MCP endpoint over a socket, check() against live capabilities, the
// connector syncs' own writes (syncOneTextItem, processDriveFile) into Postgres and their
// change events, pgvector's SQL, and the read path through GuardedMemoryStore and
// GraphitiMemoryStore. A stand-in memory service plays Graphiti's extraction and /search
// (mcp/extracting-memory-service.testsupport.ts). Not simulated: ranking, and how Graphiti
// decides two items state the same fact.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { PrismaClient } from "@/lib/generated/prisma/client";
// The leaf module, not the `@/services/access` barrel: the barrel builds the `@/lib/db`
// singleton at import time, before beforeAll points DATABASE_URL at the test database.
import { hashCapabilityToken } from "@/services/access/capabilities";
import type { DriveFile } from "@/services/connectors/gdrive";
import { ExtractingMemoryService } from "./extracting-memory-service.testsupport";
import { deleteOrgsWithRetry } from "@/lib/org-cleanup.testsupport";

vi.mock("@/services/guardrails", () => ({
  checkEpisodeCap: async () => undefined,
  recordEpisode: async () => undefined,
}));

const QA_URL = process.env.QA_DATABASE_URL;
const ORG = "itemcite";
const ROOT = `org_${ORG}`;
const SCOPE = `${ROOT}.billing`;

const ISSUE_412 =
  "Issue #412 (open; billing): Refund flow double-charges EU cards\n\nSteps: pay with an EU card, refund, check the statement.";
const ISSUE_413 = "Issue #413 (open; billing): Refunds post twice for SEPA payments";
const ISSUE_414 = "Issue #414 (closed; billing): Duplicate refund on retried webhook";

describe.skipIf(!QA_URL)("memory_query names the synced item a connector's fact came from", () => {
  const service = new ExtractingMemoryService();
  let db: PrismaClient;
  let mcpUrl: string;
  let closeMcp: () => Promise<void>;
  let ClientClass: (typeof import("@modelcontextprotocol/sdk/client/index.js"))["Client"];
  let Transport: (typeof import("@modelcontextprotocol/sdk/client/streamableHttp.js"))["StreamableHTTPClientTransport"];
  let syncOneTextItem: (typeof import("@/lib/inngest/connector-text-items"))["syncOneTextItem"];
  let processDriveFile: (typeof import("@/lib/inngest/connector-drive-files"))["processDriveFile"];
  const repo = {
    id: "",
    orgId: ORG,
    type: "github",
    name: "acme/billing",
    scopePath: SCOPE,
    connectAuthorizationId: null,
  };
  const drive = { id: "", orgId: ORG, name: "Billing runbooks", scopePath: SCOPE, connectAuthorizationId: null };

  /** The answer's bullets, the way an agent reading memory_query takes facts apart. */
  async function bullets(query: string): Promise<string[]> {
    const token = `wcap_test_reader_${Math.random().toString(36).slice(2)}`;
    await db.capability.create({
      data: {
        orgId: ORG,
        agentId: "reader",
        tokenHash: hashCapabilityToken(token),
        scopePath: SCOPE,
        permission: "read",
        grantGoverned: false,
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    });
    const client: Client = new ClientClass({ name: "item-citation", version: "0.0.0" });
    await client.connect(
      new Transport(new URL(mcpUrl), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }),
    );
    try {
      const result = await client.callTool({ name: "memory_query", arguments: { query, scopePath: SCOPE, limit: 50 } });
      const text = (result.content as { text?: string }[])[0]?.text ?? "";
      expect(result.isError, text).toBeFalsy();
      return text.split("\n").filter((line) => line.startsWith("•"));
    } finally {
      await client.close();
    }
  }

  /** The episode each `create` change event of this org names, newest last. */
  async function createdItems(): Promise<string[]> {
    const events = await db.changeEvent.findMany({
      where: { orgId: ORG, recordType: "fact", op: "create" },
      orderBy: { seq: "asc" },
    });
    return events.map((e) => e.recordId);
  }

  async function syncIssue(id: string, text: string): Promise<string> {
    expect(await syncOneTextItem(repo, { id, text, checksum: `c-${id}` }, null)).toBe("synced");
    return (await createdItems()).at(-1)!;
  }

  async function syncDriveFile(id: string, passages: string[]): Promise<{ items: string[]; rows: string[] }> {
    service.passagesOfNextFile(passages);
    const before = (await createdItems()).length;
    const file: DriveFile = {
      id,
      name: `${id}.pdf`,
      mimeType: "application/pdf",
      fileType: "pdf",
      checksum: `c-${id}`,
      contentVersion: `c-${id}`,
    };
    const outcome = await processDriveFile(drive, file, "drive-token", {
      downloadFile: async () => new Blob(["%PDF"]),
      put: async (pathname) => ({ url: `https://blob.test/${pathname}` }),
      del: async () => undefined,
    });
    expect(outcome).toBe("synced");
    const { chunkIds } = await db.sourceFile.findUniqueOrThrow({
      where: { sourceId_externalFileId: { sourceId: drive.id, externalFileId: id } },
    });
    return { items: (await createdItems()).slice(before), rows: chunkIds };
  }

  beforeAll(async () => {
    if (QA_URL === undefined) return;
    if (QA_URL === process.env.DATABASE_URL) throw new Error("QA_DATABASE_URL must not be DATABASE_URL");
    process.env.DATABASE_URL = QA_URL;
    process.env.GRAPHITI_SERVICE_URL = await service.start();
    process.env.GRAPHITI_SERVICE_API_KEY = "test-key";
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });

    ({ syncOneTextItem } = await import("@/lib/inngest/connector-text-items"));
    ({ processDriveFile } = await import("@/lib/inngest/connector-drive-files"));
    ({ Client: ClientClass } = await import("@modelcontextprotocol/sdk/client/index.js"));
    ({ StreamableHTTPClientTransport: Transport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js"));
    const { startMcpTestServer } = await import("./http-test-server");
    const mcp = await startMcpTestServer();
    mcpUrl = mcp.url;
    closeMcp = mcp.close;

    await deleteOrgsWithRetry(db, { where: { id: ORG } });
    await db.org.create({ data: { id: ORG, name: ORG } });
    await db.scope.create({ data: { orgId: ORG, path: ROOT, name: ROOT } });
    await db.scope.create({ data: { orgId: ORG, path: SCOPE, name: "Billing" } });
    repo.id = (
      await db.source.create({
        data: { orgId: ORG, type: "github", externalId: "acme/billing", name: repo.name, scopePath: SCOPE },
      })
    ).id;
    drive.id = (
      await db.source.create({
        data: { orgId: ORG, type: "gdrive", externalId: "folder-runbooks", name: drive.name, scopePath: SCOPE },
      })
    ).id;
  }, 60_000);

  afterAll(async () => {
    if (QA_URL === undefined) return;
    await closeMcp?.();
    await service.stop();
    await deleteOrgsWithRetry(db, { where: { id: ORG } });
    await db.$disconnect();
  });

  it("names the item a fact stated in other words came from, by the id its change event carries", async () => {
    service.extracts(ISSUE_412, ["EU card refunds are charged twice"]);
    const item = await syncIssue("issue-412", ISSUE_412);

    expect((await bullets("EU card refunds")).filter((line) => line.includes("charged twice"))).toEqual([
      `• EU card refunds are charged twice — source: acme/billing (github) · item ${item}`,
    ]);
  });

  it("names no item for a fact two items state, rather than pick one", async () => {
    service.extracts(ISSUE_413, ["Refunds are posted twice"]);
    service.extracts(ISSUE_414, ["Refunds are posted twice"]);
    await syncIssue("issue-413", ISSUE_413);
    await syncIssue("issue-414", ISSUE_414);

    expect((await bullets("refunds posted twice")).filter((line) => line.includes("posted twice"))).toEqual([
      "• Refunds are posted twice — source: acme/billing (github)",
    ]);
  });

  it("names the item of a one-passage file's passage, served from its own row, beside the row's version", async () => {
    const passage = "Refunds over $500 need a second approver before they are issued.";
    const { items, rows } = await syncDriveFile("refund-approvals", [passage]);
    expect(items).toHaveLength(1);

    expect((await bullets("refund approver")).filter((line) => line.includes("second approver"))).toEqual([
      expect.stringMatching(
        new RegExp(
          `^• ${escape(passage)} \\(as of [^)]+\\) — source: Billing runbooks \\(gdrive\\) · item ${items[0]} · version ${rows[0]}$`,
        ),
      ),
    ]);
  });

  it("names no item on the passages of a longer file, whose rows its sync record does not pair with episodes", async () => {
    const passages = ["Chargebacks are answered within seven days.", "Chargeback evidence goes in the billing drive."];
    const { items, rows } = await syncDriveFile("chargebacks", passages);
    expect(items).toHaveLength(2);
    expect(rows).toHaveLength(2);

    const served = (await bullets("chargebacks")).filter((line) => line.includes("Chargeback"));
    expect(served).toHaveLength(2);
    expect(served.every((line) => !line.includes(" · item "))).toBe(true);
    expect(served.map((line) => / · version (\S+)$/.exec(line)?.[1]).toSorted()).toEqual(rows.toSorted());
  });

  // The app reads `episode_ids` from the memory service, so the app can deploy before the
  // service does. An older service leaves the field out, and then nothing resolves a
  // connector's fact to an item its source still syncs: it is not served
  // (services/memory/graph-fact-sources.ts), and the read does not fail.
  it("serves no unresolvable connector fact, and does not fail, from a memory service that predates episode ids", async () => {
    service.reportsEpisodes = false;
    try {
      expect((await bullets("EU card refunds")).filter((line) => line.includes("charged twice"))).toEqual([]);
    } finally {
      service.reportsEpisodes = true;
    }
  });
});

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
