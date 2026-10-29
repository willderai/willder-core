// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// Uploads in the memory export (docs/export-format.md), cases
// org-export-uploads.realdb.test.ts does not cover:
// - a passage with no scope (NULL scopePath) that names an erased person keeps its upload
//   out for an admin and for a member, and the upload's raw file is never read;
// - another tenant's passage never decides an upload's fate, and a passage never names
//   another tenant's upload;
// - a bystander whose name contains the erased name keeps the upload (no over-erasure);
// - more import refusals: a repeated id across an erased and a
//   kept upload, an upload id that is a fact id, a part after a "missing" upload, a
//   tampered file of an upload the target erases, and the file stream failing mid-part.
//
// Raw files live in an in-memory fake for Vercel Blob, mocked at lib/blob-storage.ts.
import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";
import type { AccessContext } from "@/services/access";
import { seedMember } from "@/services/access/member.testsupport";

const blobs = vi.hoisted(() => {
  const stored = new Map<string, { pathname: string; bytes: Buffer }>();
  const state = { stored, next: 0, reads: [] as string[], open: 0 };
  return {
    state,
    seed(pathname: string, bytes: Buffer): string {
      const at = `blob://qa${state.next++}/${pathname}`;
      stored.set(at, { pathname, bytes });
      return at;
    },
    async put(pathname: string, body: ReadableStream<Uint8Array>): Promise<{ url: string }> {
      const held: Buffer[] = [];
      state.open++;
      try {
        for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) held.push(Buffer.from(chunk));
      } finally {
        state.open--;
      }
      const at = `blob://qa${state.next++}/${pathname}`;
      stored.set(at, { pathname, bytes: Buffer.concat(held) });
      return { url: at };
    },
    async read(at: string): Promise<ReadableStream<Uint8Array> | null> {
      state.reads.push(at);
      const file = stored.get(at);
      if (!file) return null;
      const bytes = file.bytes;
      return new ReadableStream<Uint8Array>({
        start(controller) {
          if (bytes.length > 0) controller.enqueue(new Uint8Array(bytes));
          controller.close();
        },
      });
    },
  };
});

vi.mock("@/lib/blob-storage", () => ({
  putPrivateBlob: vi.fn((pathname: string, body: ReadableStream<Uint8Array>) => blobs.put(pathname, body)),
  readPrivateBlob: vi.fn((url: string) => blobs.read(url)),
  deletePrivateBlob: vi.fn(async (url: string) => void blobs.state.stored.delete(url)),
  listPrivateBlobs: vi.fn(async () => []),
}));

const QA_URL = process.env.QA_DATABASE_URL;

const A = "qalisaa";
const OTHER = "qalisao";
const T = "qalisat";
const ORGS = [A, OTHER, T];
const ROOT_A = `org_${A}`;
const ADMIN = "u-qa-export-admin";
const MEMBER = "u-qa-export-sales";
const ERASED = "Jordan Example";
const BEFORE = new Date("2026-01-01T00:00:00Z");
const DIMENSIONS = 384;

function embed(text: string): number[] {
  const vector: number[] = [];
  for (let block = 0; vector.length < DIMENSIONS; block++) {
    for (const byte of createHash("sha256").update(`${block}:${text}`).digest()) vector.push(byte / 255 - 0.5);
  }
  const unit = vector.slice(0, DIMENSIONS);
  const norm = Math.hypot(...unit);
  return unit.map((x) => x / norm);
}

async function embeddingService(url: string | URL | Request, init?: RequestInit): Promise<Response> {
  const path = new URL(String(url instanceof Request ? url.url : url)).pathname;
  const body = JSON.parse(String(init?.body ?? "{}")) as { text?: string; texts?: string[] };
  if (path === "/embed") return Response.json({ embedding: embed(body.text ?? "") });
  if (path === "/embed-batch") return Response.json({ embeddings: (body.texts ?? []).map(embed) });
  return new Response("not found", { status: 404 });
}

const person = (orgId: string, id: string, role: "admin" | "member" = "admin"): AccessContext => ({
  orgId,
  actor: { type: "human", id, role },
  origin: "app",
});
type Line = { type: string; [k: string]: unknown };

describe.skipIf(!QA_URL)("uploads in the export, real Postgres", () => {
  let db: PrismaClient;
  let exportMemory: (typeof import("./org-export"))["exportMemory"];
  let importMemory: (typeof import("./org-import"))["importMemory"];
  const urlOf = new Map<string, string>();

  async function collect(ctx: AccessContext): Promise<string[]> {
    const lines: string[] = [];
    for await (const line of exportMemory(ctx)) lines.push(line.trimEnd());
    return lines;
  }
  const records = (lines: string[]) => lines.map((l) => JSON.parse(l) as Line);
  const uploadIds = (lines: string[]) =>
    records(lines)
      .filter((r) => r.type === "upload")
      .map((r) => r.id as string)
      .sort();
  async function* stream(lines: string[]) {
    yield* lines;
  }

  async function seedUpload(
    orgId: string,
    id: string,
    scope: string,
    filename: string,
    bytes = Buffer.from(`bytes of ${id}`),
  ) {
    const blobUrl = blobs.seed(`memory/${orgId}/${filename}`, bytes);
    urlOf.set(id, blobUrl);
    await db.uploadedFile.create({
      data: { id, orgId, scopePath: scope, filename, fileType: "pdf", blobUrl, actorId: ADMIN, createdAt: BEFORE },
    });
  }
  async function seedPassage(orgId: string, id: string, scope: string | null, content: string, uploadId: string) {
    await db.$executeRaw`
      INSERT INTO memory_chunks (id, "orgId", content, source, "actorType", "actorId", "scopePath", "uploadId", "factVersion", embedding, "createdAt")
      VALUES (${id}, ${orgId}, ${content}, 'upload', 'human', ${ADMIN}, ${scope}, ${uploadId}, false,
        ${`[${embed(content).join(",")}]`}::vector, ${BEFORE})`;
  }
  async function seedOrg(orgId: string) {
    await db.org.create({ data: { id: orgId, name: orgId } });
    const root = await db.scope.create({ data: { orgId, path: `org_${orgId}`, name: "root" } });
    await db.grant.create({
      data: { orgId, scopeId: root.id, granteeType: "role", granteeId: "admin", permission: "admin" },
    });
    await seedMember(db, { orgId, userId: ADMIN, role: "admin" });
  }
  async function reset() {
    await db.memoryChunk.deleteMany({ where: { orgId: { in: ORGS } } });
    await db.org.deleteMany({ where: { id: { in: ORGS } } });
    await db.user.deleteMany({ where: { id: { in: [ADMIN, MEMBER] } } });
  }
  /** Rows and stored files the target org holds: a refused import must leave none. */
  async function leftIn(orgId: string) {
    return {
      uploads: await db.uploadedFile.count({ where: { orgId } }),
      chunks: await db.memoryChunk.count({ where: { orgId } }),
      blobs: [...blobs.state.stored.values()].filter((f) => f.pathname.startsWith(`memory/${orgId}/`)).length,
      open: blobs.state.open,
    };
  }
  const empty = { uploads: 0, chunks: 0, blobs: 0, open: 0 };

  beforeAll(async () => {
    process.env.DATABASE_URL = QA_URL;
    vi.stubGlobal("fetch", vi.fn(embeddingService));
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });
    ({ exportMemory } = await import("./org-export"));
    ({ importMemory } = await import("./org-import"));
    await reset();
    for (const org of ORGS) await seedOrg(org);
    for (const path of ["sales", "sales_eu"])
      await db.scope.create({ data: { orgId: A, path: `${ROOT_A}.${path}`, name: path } });
    const sales = await db.scope.findUniqueOrThrow({ where: { orgId_path: { orgId: A, path: `${ROOT_A}.sales` } } });
    await seedMember(db, { orgId: A, userId: MEMBER, role: "member" });
    await db.grant.create({
      data: { orgId: A, scopeId: sales.id, granteeType: "user", granteeId: MEMBER, permission: "read" },
    });

    // A passage with no scope names her: nobody's readable set holds a NULL scope.
    await seedUpload(A, "q-null", `${ROOT_A}.sales`, "minutes.pdf");
    await seedPassage(A, "qp-null", null, `${ERASED} took the minutes.`, "q-null");
    // A sibling scope's passage names her; the upload is in sales.
    await seedUpload(A, "q-sib", `${ROOT_A}.sales`, "forecast.pdf");
    await seedPassage(A, "qp-sib", `${ROOT_A}.sales_eu`, `${ERASED} owns the EU forecast.`, "q-sib");
    // A bystander whose name contains hers, in a passage: kept.
    await seedUpload(A, "q-by", `${ROOT_A}.sales`, "lease.pdf");
    await seedPassage(A, "qp-by", `${ROOT_A}.sales`, "Jordan Example-Barnes signed the lease.", "q-by");
    // Another tenant's passage names her and points at A's upload: A's upload is still A's call.
    await seedUpload(A, "q-tenant", `${ROOT_A}.sales`, "quota.pdf");
    await seedPassage(OTHER, "qp-tenant", `org_${OTHER}`, `${ERASED} set the quota.`, "q-tenant");
    // A's passage points at another tenant's upload: it must never be named.
    await seedUpload(OTHER, "q-theirs", `org_${OTHER}`, "theirs.pdf");
    await seedPassage(A, "qp-theirs", `${ROOT_A}.sales`, "The partner sent a contract.", "q-theirs");
    // A sibling-scope upload the member cannot read.
    await seedUpload(A, "q-eu", `${ROOT_A}.sales_eu`, "eu-only.pdf");

    const { recordSuppressions } = await import("./erasure-suppression");
    await recordSuppressions(db, A, "erasure-qa-a", { emails: [], names: [ERASED], contactIds: [] });
    await recordSuppressions(db, OTHER, "erasure-qa-o", { emails: [], names: [ERASED], contactIds: [] });
    await recordSuppressions(db, T, "erasure-qa-t", { emails: [], names: [ERASED], contactIds: [] });
  }, 60_000);

  afterAll(async () => {
    vi.unstubAllGlobals();
    if (!db) return;
    await reset();
    await db.$disconnect();
  });

  it("admin: an upload named by a no-scope or sibling passage stays out, unread; a bystander and another tenant's passage do not take it", async () => {
    blobs.state.reads = [];
    const lines = await collect(person(A, ADMIN));
    expect(uploadIds(lines)).toEqual(["q-by", "q-eu", "q-tenant"]);
    expect(blobs.state.reads).not.toContain(urlOf.get("q-null"));
    expect(blobs.state.reads).not.toContain(urlOf.get("q-sib"));
    // Never another tenant's upload, by record or by a passage's link.
    expect(lines.join("\n")).not.toContain("q-theirs");
    expect(records(lines).find((r) => r.id === "qp-theirs")).toMatchObject({ uploadId: null });
  });

  it("member: the same uploads stay out, and a sibling scope's upload is never written", async () => {
    blobs.state.reads = [];
    const lines = await collect(person(A, MEMBER, "member"));
    expect(uploadIds(lines)).toEqual(["q-by", "q-tenant"]);
    for (const id of ["q-null", "q-sib", "q-eu"]) expect(blobs.state.reads).not.toContain(urlOf.get(id));
    expect(lines.join("\n")).not.toContain("eu-only");
  });

  describe("further import refusals leave no rows and no stored file", () => {
    const upload = (id: string, filename: string, file = "follows") =>
      JSON.stringify({
        type: "upload",
        id,
        scope: "",
        filename,
        fileType: "pdf",
        actorId: ADMIN,
        file,
        createdAt: BEFORE.toISOString(),
      });
    const part = (uploadId: string, data: Buffer, index = 0) =>
      JSON.stringify({ type: "upload_part", uploadId, index, data: data.toString("base64") });
    const end = (uploadId: string, data: Buffer, parts = 1) =>
      JSON.stringify({
        type: "upload_end",
        uploadId,
        parts,
        bytes: data.length,
        sha256: createHash("sha256").update(data).digest("hex"),
      });
    const manifest = JSON.stringify({
      type: "manifest",
      format: "willder-export",
      schemaVersion: 2,
      exportedAt: BEFORE.toISOString(),
      coverage: "org",
      scopes: [""],
    });
    const fact = (id: string, content: string, uploadId: string | null = null) =>
      JSON.stringify({
        type: "fact",
        id,
        scope: "",
        content,
        entityName: null,
        factVersion: false,
        role: null,
        source: "upload",
        actorType: "human",
        actorId: ADMIN,
        actorName: null,
        sourceId: null,
        uploadId,
        occurredAt: null,
        createdAt: BEFORE.toISOString(),
      });
    const close = (counts: Record<string, number>) =>
      JSON.stringify({
        type: "end",
        counts: {
          scope: 0,
          source: 0,
          fact: 0,
          upload: 0,
          convention: 0,
          working_note: 0,
          brief: 0,
          edge: 0,
          audit: 0,
          ...counts,
        },
      });
    const data = Buffer.from("a raw file");

    const cases: [string, string[], RegExp][] = [
      [
        "one id on an upload the target erases and on a kept one",
        [
          manifest,
          upload("u1", "Jordan_Example_cv.pdf"),
          part("u1", data),
          end("u1", data),
          upload("u1", "clean.pdf"),
          part("u1", data),
          end("u1", data),
          close({ upload: 2 }),
        ],
        /appears twice/,
      ],
      [
        "an upload id that is a fact's id",
        [
          manifest,
          fact("f1", "A plain fact."),
          upload("f1", "clean.pdf"),
          part("f1", data),
          end("f1", data),
          close({ fact: 1, upload: 1 }),
        ],
        /appears twice/,
      ],
      [
        "one id on a missing upload and on a kept one",
        [
          manifest,
          upload("u1", "lost.pdf", "missing"),
          upload("u1", "clean.pdf"),
          part("u1", data),
          end("u1", data),
          close({ upload: 2 }),
        ],
        /appears twice/,
      ],
      [
        "a part after a missing upload",
        [manifest, upload("u1", "clean.pdf", "missing"), part("u1", data), end("u1", data), close({ upload: 1 })],
        /out of place/,
      ],
      [
        "a tampered file of an upload the target erases",
        [
          manifest,
          upload("u1", "Jordan_Example_cv.pdf"),
          part("u1", Buffer.from("other bytes")),
          end("u1", data),
          close({ upload: 1 }),
        ],
        /checksum/,
      ],
      [
        "a fact uploadId in a version 1 file",
        [
          manifest.replace('"schemaVersion":2', '"schemaVersion":1'),
          fact("f1", "A plain fact.", "u9"),
          close({ fact: 1 }),
        ],
        /schema version 1 does not have/,
      ],
    ];
    for (const [name, lines, reason] of cases) {
      it(name, async () => {
        await expect(importMemory(person(T, ADMIN), stream(lines))).rejects.toThrow(reason);
        expect(await leftIn(T)).toEqual(empty);
      });
    }

    it("the file's own stream failing mid-part, with a kept upload already stored and one open", async () => {
      async function* broken() {
        yield manifest;
        yield fact("f1", "Pricing is forty dollars.", "u1");
        yield upload("u1", "first.pdf");
        yield part("u1", data);
        yield end("u1", data);
        yield upload("u2", "second.pdf");
        yield part("u2", data);
        throw new Error("connection reset");
      }
      await expect(importMemory(person(T, ADMIN), broken())).rejects.toThrow(/connection reset/);
      expect(await leftIn(T)).toEqual(empty);
    });

    it("a passage the target erases keeps its upload's file out, and the rest imports", async () => {
      const lines = [
        manifest,
        fact("f1", `${ERASED} wrote this.`, "u1"),
        fact("f2", "Nothing to erase.", "u2"),
        upload("u1", "notes.pdf"),
        part("u1", data),
        end("u1", data),
        upload("u2", "kept.pdf"),
        part("u2", data),
        end("u2", data),
        close({ fact: 2, upload: 2 }),
      ];
      const receipt = await importMemory(person(T, ADMIN), stream(lines));
      expect(receipt.erased).toMatchObject({ fact: 1, upload: 1 });
      expect(receipt.imported).toMatchObject({ fact: 1, upload: 1 });
      const rows = await db.uploadedFile.findMany({ where: { orgId: T } });
      expect(rows.map((r) => r.filename)).toEqual(["kept.pdf"]);
      expect(
        [...blobs.state.stored.values()].filter((f) => f.pathname.startsWith(`memory/${T}/`)).map((f) => f.pathname),
      ).toEqual([`memory/${T}/kept.pdf`]);
      const passage = await db.memoryChunk.findFirstOrThrow({ where: { orgId: T } });
      expect(passage.uploadId).toBe(rows[0]!.id);
    });
  });
});
