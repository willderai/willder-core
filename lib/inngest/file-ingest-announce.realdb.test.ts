// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// An inline upload's passages and its document event commit together
// (lib/inngest/file-ingest.ts, storeFilePassages with `announceAs`).
//
// upload-without-blob-storage.realdb.test.ts covers the embedding failing before
// anything is written. This covers the other half of "one transaction": the document
// event's own write failing after the passages' INSERT ran. If the event were written
// in a transaction of its own, the passages would stay stored with no event naming
// them, and the person's retry would store them a second time.
//
// Real: Postgres, the pgvector INSERT, the change feed's writer. Doubles: the embedding
// service (one fixed vector) and a fault on the change feed's writer for document
// events only.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";
import { deleteOrgsWithRetry } from "@/lib/org-cleanup.testsupport";

/** When set, the change feed's writer refuses a document event. */
const fault = vi.hoisted(() => ({ refuseDocumentEvent: false }));

vi.mock("@/services/memory/change-events", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/memory/change-events")>();
  return {
    ...actual,
    recordChangeEvent: (async (tx, input) => {
      if (fault.refuseDocumentEvent && input.recordType === "document") throw new Error("change feed write refused");
      return actual.recordChangeEvent(tx, input);
    }) satisfies typeof actual.recordChangeEvent,
  };
});

const QA_URL = process.env.QA_DATABASE_URL;
const ORG = "qa_fileIngestAnnounce";
const SCOPE = `org_${ORG}.planning`;
const DIMENSIONS = 384;
const CHUNKS = ["Q3 targets: 40 new logos.", "Each target has a named owner."];

describe.skipIf(!QA_URL)("an inline upload's passages and its document event commit together", () => {
  let db: PrismaClient;
  let storeFilePassages: (typeof import("./file-ingest"))["storeFilePassages"];
  const file = {
    groupId: ORG,
    actorId: "qa-uploader",
    actorType: "human" as const,
    filename: "q3-plan.pdf",
    scopePath: SCOPE,
    origin: "app" as const,
  };

  async function stored(): Promise<{ passages: number; documentEvents: number }> {
    return {
      passages: await db.memoryChunk.count({ where: { orgId: ORG } }),
      documentEvents: await db.changeEvent.count({ where: { orgId: ORG, recordType: "document" } }),
    };
  }

  async function wipe(): Promise<void> {
    await db.changeEvent.deleteMany({ where: { orgId: ORG } });
    await db.memoryChunk.deleteMany({ where: { orgId: ORG } });
  }

  beforeAll(async () => {
    process.env.DATABASE_URL = QA_URL;
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ embedding: new Array(DIMENSIONS).fill(0.01) })));
    ({ storeFilePassages } = await import("./file-ingest"));
    await wipe();
    await deleteOrgsWithRetry(db, { where: { id: ORG } });
    await db.org.create({ data: { id: ORG, name: ORG } });
  });

  beforeEach(async () => {
    fault.refuseDocumentEvent = false;
    await wipe();
  });

  afterAll(async () => {
    vi.unstubAllGlobals();
    if (QA_URL === undefined) return;
    await wipe();
    await deleteOrgsWithRetry(db, { where: { id: ORG } });
    await db.$disconnect();
  });

  it("control: stores every passage and announces the file once", async () => {
    await storeFilePassages(file, CHUNKS, "doc-control");
    expect(await stored()).toEqual({ passages: 2, documentEvents: 1 });
  });

  it("keeps no passage when the document event's write fails, and the retry stores each passage once", async () => {
    fault.refuseDocumentEvent = true;
    await expect(storeFilePassages(file, CHUNKS, "doc-refused")).rejects.toThrow("change feed write refused");
    expect(await stored()).toEqual({ passages: 0, documentEvents: 0 });

    fault.refuseDocumentEvent = false;
    await storeFilePassages(file, CHUNKS, "doc-retry");
    expect(await stored()).toEqual({ passages: 2, documentEvents: 1 });
  });
});
