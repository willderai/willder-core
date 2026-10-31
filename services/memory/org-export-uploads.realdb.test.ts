// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// Uploads in the memory export (docs/export-format.md): an upload's record and its raw
// file travel in the export, under the export's access rules, and an import restores
// both. This file proves the round trip byte for byte, the access rules (two tenants, an
// admin against a member, a sibling scope, an agent), the erasure rule on both sides (a
// filename or a passage that names an erased person keeps the whole file out), that a
// large file is streamed rather than held, and that a cut-short or tampered file is
// refused with nothing left behind.
//
// Raw files live in an in-memory fake of Vercel Blob, mocked at lib/blob-storage.ts:
// no test here writes to real storage. Embeddings come from a deterministic fake of
// the memory service, stubbed at the fetch seam.
//
// Set QA_DATABASE_URL to an ISOLATED test database. Never the sandbox's inherited
// DATABASE_URL, which points at live Neon.
import { createHash } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";
import type { AccessContext } from "@/services/access";
import { seedMember } from "@/services/access/member.testsupport";
import { deleteOrgsWithRetry } from "@/lib/org-cleanup.testsupport";

/** The in-memory blob store: every raw file the tests seed, and every one an import stores. */
const blobs = vi.hoisted(() => {
  /** A stored file, held whole, or made on demand when it is too large to hold in a test. */
  type Stored = {
    pathname: string;
    bytes: Buffer | null;
    make: (() => ReadableStream<Uint8Array>) | null;
    sha256: string;
    size: number;
  };
  const stored = new Map<string, Stored>();
  const state = {
    stored,
    next: 0,
    /** Pathnames passed to putPrivateBlob, in order. */
    puts: [] as string[],
    /** Fail the next put once its stream has started, as storage dropping mid-upload would. */
    failNextPut: false,
    /** Bytes every put has read so far: see the large-file test. */
    consumed: 0,
    /** Puts still reading their stream. A refused import must leave none waiting on it. */
    open: 0,
    /** Read size of a stored file's stream: not a multiple of the export's part size. */
    readChunk: 10_000,
    /** Run before a read of the blob at that URL, as a removal racing the export would. */
    beforeRead: new Map<string, () => Promise<void>>(),
  };
  const url = (pathname: string) => `blob://${state.next++}/${pathname}`;
  return {
    state,
    /** Seed a raw file as if an upload stored it. */
    seed(pathname: string, bytes: Buffer): string {
      const at = url(pathname);
      stored.set(at, {
        pathname,
        bytes,
        make: null,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        size: bytes.length,
      });
      return at;
    },
    /** Seed a raw file made on demand by `make`, with its known digest and size. */
    seedMade(pathname: string, make: () => ReadableStream<Uint8Array>, sha256: string, size: number): string {
      const at = url(pathname);
      stored.set(at, { pathname, bytes: null, make, sha256, size });
      return at;
    },
    async put(pathname: string, body: Buffer | File | ReadableStream<Uint8Array>): Promise<{ url: string }> {
      state.puts.push(pathname);
      if (!(body instanceof ReadableStream)) throw new Error("an import must stream its raw files");
      const fail = state.failNextPut;
      state.failNextPut = false;
      const reader = body.getReader();
      const hash = createHash("sha256");
      const held: Buffer[] = [];
      let size = 0;
      state.open++;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (fail) {
            await reader.cancel();
            throw new Error("storage unavailable");
          }
          hash.update(value);
          size += value.length;
          state.consumed += value.length;
          if (size <= 4 * 1024 * 1024) held.push(Buffer.from(value));
        }
      } finally {
        state.open--;
      }
      const at = url(pathname);
      stored.set(at, {
        pathname,
        bytes: size <= 4 * 1024 * 1024 ? Buffer.concat(held) : null,
        make: null,
        sha256: hash.digest("hex"),
        size,
      });
      return { url: at };
    },
    async read(at: string): Promise<ReadableStream<Uint8Array> | null> {
      await state.beforeRead.get(at)?.();
      const file = stored.get(at);
      if (!file) return null;
      if (file.make) return file.make();
      const bytes = file.bytes!;
      let offset = 0;
      return new ReadableStream<Uint8Array>({
        pull(controller) {
          if (offset >= bytes.length) return controller.close();
          controller.enqueue(new Uint8Array(bytes.subarray(offset, offset + state.readChunk)));
          offset += state.readChunk;
        },
      });
    },
  };
});

vi.mock("@/lib/blob-storage", () => ({
  putPrivateBlob: vi.fn((pathname: string, body: Buffer | File | ReadableStream<Uint8Array>) =>
    blobs.put(pathname, body),
  ),
  readPrivateBlob: vi.fn((url: string) => blobs.read(url)),
  deletePrivateBlob: vi.fn(async (url: string) => void blobs.state.stored.delete(url)),
  listPrivateBlobs: vi.fn(async () => []),
}));

const QA_URL = process.env.QA_DATABASE_URL;

// Alphanumeric ids, so orgRootPath(id) is a valid ltree label as it is for a real cuid.
const A = "qaupa";
const B = "qaupb";
const OTHER = "qaupother";
const S = "qaups";
const E = "qaupe";
const L = "qaupl";
const L2 = "qaupl2";
const BAD = "qaupbad";
const V1 = "qaupv1";
const HELD = "qauph";
const RACE = "qaupr";
const GAP = "qaupgap";
const GAP_SOURCE = "qaupgaps";
const GAP_TARGET = "qaupgapt";
const ORGS = [A, B, OTHER, S, E, L, L2, BAD, V1, HELD, RACE, GAP, GAP_SOURCE, GAP_TARGET];
const ROOT_A = `org_${A}`;

const ADMIN = "u-qa-upload-admin";
const SALES_MEMBER = "u-qa-upload-sales";
const GAP_MEMBER = "u-qa-upload-gap-sales";
const ERASED = "Jordan Example";
const BEFORE_ERASURE = new Date("2026-01-01T00:00:00Z");
const AFTER_ERASURE = new Date("2099-01-01T00:00:00Z");

const DIMENSIONS = 384;

function embed(text: string): number[] {
  const vector: number[] = [];
  for (let block = 0; vector.length < DIMENSIONS; block++) {
    const bytes = createHash("sha256").update(`${block}:${text.toLowerCase()}`).digest();
    for (const byte of bytes) vector.push(byte / 255 - 0.5);
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

/** `size` bytes that differ at every offset, so a dropped, repeated or reordered part changes the digest. */
function bytesOf(size: number, seed: number): Buffer {
  const out = Buffer.alloc(size);
  for (let i = 0; i < size; i++) out[i] = (i * 31 + (i >> 8) + seed) & 255;
  return out;
}

const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const person = (orgId: string, id: string, role: "admin" | "member" = "admin"): AccessContext => ({
  orgId,
  actor: { type: "human", id, role },
  origin: "app",
});

type Line = { type: string; [k: string]: unknown };

describe.skipIf(!QA_URL)("uploads in the memory export and import, real Postgres", () => {
  let db: PrismaClient;
  let exportMemory: (typeof import("./org-export"))["exportMemory"];
  let UPLOAD_PART_BYTES: number;
  let importMemory: (typeof import("./org-import"))["importMemory"];
  let ImportRefusedError: (typeof import("./org-import"))["ImportRefusedError"];
  let AccessDeniedError: (typeof import("@/services/access"))["AccessDeniedError"];
  let readPrivateBlob: ReturnType<typeof vi.fn>;

  /** Org A's export by its admin, kept for the imports below. */
  let exported: string[] = [];
  /** The raw bytes of each of org A's seeded uploads, by filename. */
  const seededBytes = new Map<string, Buffer>();

  async function collect(ctx: AccessContext): Promise<string[]> {
    const lines: string[] = [];
    for await (const line of exportMemory(ctx)) lines.push(line.trimEnd());
    return lines;
  }
  const records = (lines: string[]) => lines.map((l) => JSON.parse(l) as Line);
  async function* stream(lines: string[]) {
    yield* lines;
  }
  const uploadsIn = (lines: string[]) => records(lines).filter((r) => r.type === "upload");

  /** The raw file of upload `id` as the export wrote it: its parts decoded and joined. */
  function fileOf(lines: string[], id: string): Buffer {
    const parts = records(lines).filter((r) => r.type === "upload_part" && r.uploadId === id);
    return Buffer.concat(parts.map((p) => Buffer.from(p.data as string, "base64")));
  }

  /** Every raw file stored under `orgId`'s pathname prefix. */
  const storedFor = (orgId: string) =>
    [...blobs.state.stored.values()].filter((f) => f.pathname.startsWith(`memory/${orgId}/`));

  async function seedUpload(
    orgId: string,
    id: string,
    {
      scope,
      filename,
      bytes,
      createdAt = BEFORE_ERASURE,
      removed = false,
      missing = false,
    }: {
      scope: string;
      filename: string;
      bytes?: Buffer;
      createdAt?: Date;
      removed?: boolean;
      missing?: boolean;
    },
  ) {
    const content = bytes ?? Buffer.alloc(0);
    if (orgId === A) seededBytes.set(filename, content);
    const blobUrl = missing ? `blob://gone/${id}` : blobs.seed(`memory/${orgId}/${filename}`, content);
    await db.uploadedFile.create({
      data: {
        id,
        orgId,
        scopePath: scope,
        filename,
        fileType: "pdf",
        blobUrl,
        actorId: ADMIN,
        createdAt,
        removedAt: removed ? new Date() : null,
      },
    });
  }

  async function seedPassage(
    orgId: string,
    id: string,
    {
      scope,
      content,
      uploadId,
      createdAt = BEFORE_ERASURE,
    }: { scope: string | null; content: string; uploadId: string; createdAt?: Date },
  ) {
    await db.$executeRaw`
      INSERT INTO memory_chunks (id, "orgId", content, source, "actorType", "actorId", "scopePath", "uploadId", "factVersion", embedding, "createdAt")
      VALUES (${id}, ${orgId}, ${content}, 'upload', 'human', ${ADMIN}, ${scope}, ${uploadId}, false,
        ${`[${embed(content).join(",")}]`}::vector, ${createdAt})`;
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
    await deleteOrgsWithRetry(db, { where: { id: { in: ORGS } } });
    await db.user.deleteMany({ where: { id: { in: [ADMIN, SALES_MEMBER, GAP_MEMBER] } } });
  }

  beforeAll(async () => {
    process.env.DATABASE_URL = QA_URL;
    vi.stubGlobal("fetch", vi.fn(embeddingService));
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });
    ({ exportMemory } = await import("./org-export"));
    ({ UPLOAD_PART_BYTES } = await import("./export-format"));
    ({ importMemory, ImportRefusedError } = await import("./org-import"));
    ({ AccessDeniedError } = await import("@/services/access"));
    readPrivateBlob = (await import("@/lib/blob-storage")).readPrivateBlob as unknown as ReturnType<typeof vi.fn>;
    await reset();

    for (const org of ORGS) await seedOrg(org);
    for (const path of ["sales", "eng", "sales_eu"]) {
      await db.scope.create({ data: { orgId: A, path: `${ROOT_A}.${path}`, name: path } });
    }
    const sales = await db.scope.findUniqueOrThrow({ where: { orgId_path: { orgId: A, path: `${ROOT_A}.sales` } } });
    await seedMember(db, { orgId: A, userId: SALES_MEMBER, role: "member" });
    await db.grant.create({
      data: { orgId: A, scopeId: sales.id, granteeType: "user", granteeId: SALES_MEMBER, permission: "read" },
    });

    // Org A. Four parts, the last short, read from storage in pieces that do not line up with them.
    await seedUpload(A, "up-sales", { scope: `${ROOT_A}.sales`, filename: "pricing.pdf", bytes: bytesOf(150_000, 1) });
    await seedPassage(A, "pa-sales", {
      scope: `${ROOT_A}.sales`,
      content: "Pricing starts at forty dollars a seat.",
      uploadId: "up-sales",
    });
    await seedUpload(A, "up-eng", { scope: `${ROOT_A}.eng`, filename: "runbook.docx", bytes: bytesOf(1_000, 2) });
    // A sibling of sales whose name starts with it: `_` must not match as a wildcard.
    await seedUpload(A, "up-sibling", { scope: `${ROOT_A}.sales_eu`, filename: "sibling.pdf", bytes: bytesOf(10, 3) });
    await seedUpload(A, "up-root", { scope: ROOT_A, filename: "empty.pdf", bytes: Buffer.alloc(0) });
    // Exactly one part long: the part boundary falls on the end of the file.
    await seedUpload(A, "up-exact", { scope: ROOT_A, filename: "exact.pdf", bytes: bytesOf(48 * 1024, 4) });
    // Named by its filename, written the way #790's matcher reads a name without spaces.
    await seedUpload(A, "up-erased-name", {
      scope: `${ROOT_A}.sales`,
      filename: "Jordan_Example_offer.pdf",
      bytes: bytesOf(100, 5),
    });
    // Named by one passage; the other passage stays, with no upload to point at.
    await seedUpload(A, "up-erased-content", {
      scope: `${ROOT_A}.sales`,
      filename: "call-notes.pdf",
      bytes: bytesOf(100, 6),
    });
    await seedPassage(A, "pa-call-named", {
      scope: `${ROOT_A}.sales`,
      content: `${ERASED} asked about the renewal.`,
      uploadId: "up-erased-content",
    });
    await seedPassage(A, "pa-call-kept", {
      scope: `${ROOT_A}.sales`,
      content: "The renewal is in March.",
      uploadId: "up-erased-content",
    });
    // Named by a passage in a scope the sales member cannot read: the file is still hers to lose.
    await seedUpload(A, "up-hidden-erased", {
      scope: `${ROOT_A}.sales`,
      filename: "board-deck.pdf",
      bytes: bytesOf(100, 7),
    });
    await seedPassage(A, "pa-board", {
      scope: `${ROOT_A}.eng`,
      content: `${ERASED} presented the deck.`,
      uploadId: "up-hidden-erased",
    });
    await seedUpload(A, "up-removed", {
      scope: `${ROOT_A}.sales`,
      filename: "old.pdf",
      bytes: bytesOf(100, 8),
      removed: true,
    });
    // Passages a sales member can read, of an upload they cannot, and of one being removed.
    await seedPassage(A, "pa-of-eng", {
      scope: `${ROOT_A}.sales`,
      content: "The runbook covers the sales handoff.",
      uploadId: "up-eng",
    });
    await seedPassage(A, "pa-of-removed", {
      scope: `${ROOT_A}.sales`,
      content: "The old price list is retired.",
      uploadId: "up-removed",
    });
    await seedUpload(A, "up-missing", { scope: `${ROOT_A}.sales`, filename: "lost.pdf", missing: true });
    // Uploaded after the erasure: a new, deliberate act, kept as every other record is.
    await seedUpload(A, "up-after", {
      scope: `${ROOT_A}.sales`,
      filename: "Jordan_Example_signed.pdf",
      bytes: bytesOf(300, 9),
      createdAt: AFTER_ERASURE,
    });
    await seedUpload(OTHER, "up-other", {
      scope: `org_${OTHER}`,
      filename: "other-tenant.pdf",
      bytes: bytesOf(100, 10),
    });

    const { recordSuppressions } = await import("./erasure-suppression");
    await recordSuppressions(db, A, "erasure-upload-a", { emails: [], names: [ERASED], contactIds: [] });
    exported = await collect(person(A, ADMIN));
    // Seeds ten orgs on a real database: past the default hook timeout on a busy machine.
  }, 60_000);

  beforeEach(() => {
    blobs.state.failNextPut = false;
  });

  afterAll(async () => {
    vi.unstubAllGlobals();
    if (!db) return;
    await reset();
    await db.$disconnect();
  });

  it("writes every kept upload the admin may read, each followed by its exact bytes", () => {
    const uploads = uploadsIn(exported);
    expect(uploads.map((u) => u.filename).sort()).toEqual([
      "Jordan_Example_signed.pdf",
      "empty.pdf",
      "exact.pdf",
      "lost.pdf",
      "pricing.pdf",
      "runbook.docx",
      "sibling.pdf",
    ]);
    for (const upload of uploads) {
      if (upload.file === "missing") continue;
      const expected = seededBytes.get(upload.filename as string)!;
      expect(fileOf(exported, upload.id as string).equals(expected)).toBe(true);
      const end = records(exported).find((r) => r.type === "upload_end" && r.uploadId === upload.id)!;
      expect(end).toMatchObject({
        bytes: expected.length,
        sha256: sha(expected),
        parts: Math.ceil(expected.length / UPLOAD_PART_BYTES),
      });
    }
    expect(uploads.find((u) => u.filename === "pricing.pdf")).toMatchObject({
      scope: "sales",
      fileType: "pdf",
      actorId: ADMIN,
      file: "follows",
      createdAt: BEFORE_ERASURE.toISOString(),
    });
    expect(uploads.find((u) => u.filename === "lost.pdf")).toMatchObject({ file: "missing" });
    expect(records(exported).some((r) => r.type === "upload_part" && r.uploadId === "up-missing")).toBe(false);
    // No part line holds more than one part: the export never holds a whole file.
    const longest = Math.max(...exported.filter((l) => l.startsWith('{"type":"upload_part"')).map((l) => l.length));
    expect(longest).toBeLessThan((UPLOAD_PART_BYTES * 4) / 3 + 200);
    expect(records(exported).at(-1)!.counts).toMatchObject({ upload: 7 });
  });

  it("writes each upload's file right after it, and a passage points at its upload", () => {
    const all = records(exported);
    const at = all.findIndex((r) => r.type === "upload" && r.id === "up-sales");
    expect(all.slice(at + 1, at + 6).map((r) => r.type)).toEqual([
      "upload_part",
      "upload_part",
      "upload_part",
      "upload_part",
      "upload_end",
    ]);
    expect(all.find((r) => r.type === "fact" && r.id === "pa-sales")).toMatchObject({ uploadId: "up-sales" });
    expect(all.find((r) => r.type === "fact" && r.id === "pa-of-eng")).toMatchObject({ uploadId: "up-eng" });
    // A removed upload is not named, even by a passage of it that stays.
    expect(all.find((r) => r.type === "fact" && r.id === "pa-of-removed")).toMatchObject({ uploadId: null });
    // Every upload comes after every fact: a passage that names an erased person decides first.
    expect(all.findLastIndex((r) => r.type === "fact")).toBeLessThan(all.findIndex((r) => r.type === "upload"));
  });

  it("keeps out an upload an erasure covers by its filename, a passage, or a passage the reader cannot see, and a removed one", () => {
    const text = exported.join("\n");
    for (const left of [
      "up-erased-name",
      "up-hidden-erased",
      "up-removed",
      "Jordan_Example_offer",
      "call-notes",
      "board-deck",
      "old.pdf",
    ]) {
      expect(text).not.toContain(left);
    }
    expect(uploadsIn(exported).some((u) => u.id === "up-erased-content")).toBe(false);
    // The passage that does not name her stays. It still names its upload, read before the
    // upload was judged, and an import leaves it pointing at nothing (tested below).
    expect(records(exported).find((r) => r.type === "fact" && r.id === "pa-call-kept")).toMatchObject({
      uploadId: "up-erased-content",
    });
  });

  it("never writes another tenant's upload", () => {
    expect(exported.join("\n")).not.toContain("other-tenant");
  });

  it("gives a member only the uploads in scopes they can read, judged by the same erasure rule", async () => {
    const lines = await collect(person(A, SALES_MEMBER, "member"));
    expect(
      uploadsIn(lines)
        .map((u) => u.filename)
        .sort(),
    ).toEqual(["Jordan_Example_signed.pdf", "lost.pdf", "pricing.pdf"]);
    expect(fileOf(lines, "up-sales").equals(seededBytes.get("pricing.pdf")!)).toBe(true);
    const text = lines.join("\n");
    for (const hidden of ["sibling.pdf", "runbook.docx", "empty.pdf", "board-deck", "up-hidden-erased", "up-eng"])
      expect(text).not.toContain(hidden);
    // The passage is hers to read; the upload it came from is not, so it is not named.
    expect(records(lines).find((r) => r.type === "fact" && r.id === "pa-of-eng")).toMatchObject({ uploadId: null });
  });

  it("refuses an agent before reading any raw file", async () => {
    readPrivateBlob.mockClear();
    const agent = {
      orgId: A,
      actor: { type: "agent", id: "agent-1", capabilityToken: "wcap_none" },
      origin: "mcp",
    } as AccessContext;
    await expect(collect(agent)).rejects.toBeInstanceOf(AccessDeniedError);
    expect(readPrivateBlob).not.toHaveBeenCalled();
  });

  it("imports into a fresh org: the same bytes and metadata, and the passage points at the new upload", async () => {
    const receipt = await importMemory(person(B, ADMIN), stream(exported));
    expect(receipt.imported.upload).toBe(6);
    expect(receipt.uploadsWithoutFile).toBe(1);
    expect(receipt.erased.upload).toBe(0);

    const before = await db.uploadedFile.findMany({
      where: {
        orgId: A,
        removedAt: null,
        id: { in: ["up-sales", "up-eng", "up-sibling", "up-root", "up-exact", "up-after"] },
      },
    });
    const after = await db.uploadedFile.findMany({ where: { orgId: B } });
    const meta = (rows: typeof after, root: string) =>
      rows
        .map((r) => ({
          filename: r.filename,
          fileType: r.fileType,
          actorId: r.actorId,
          scope: r.scopePath.replace(root, ""),
          createdAt: r.createdAt.toISOString(),
          removedAt: r.removedAt,
        }))
        .sort((x, y) => x.filename.localeCompare(y.filename));
    expect(meta(after, `org_${B}`)).toEqual(meta(before, ROOT_A));
    for (const row of after) {
      const file = blobs.state.stored.get(row.blobUrl)!;
      expect(file.pathname.startsWith(`memory/${B}/`)).toBe(true);
      expect(file.bytes!.equals(seededBytes.get(row.filename)!)).toBe(true);
    }

    const pricing = after.find((r) => r.filename === "pricing.pdf")!;
    const passage = await db.memoryChunk.findFirstOrThrow({
      where: { orgId: B, content: "Pricing starts at forty dollars a seat." },
    });
    expect(passage.uploadId).toBe(pricing.id);
    const orphan = await db.memoryChunk.findFirstOrThrow({ where: { orgId: B, content: "The renewal is in March." } });
    expect(orphan.uploadId).toBeNull();
  });

  it("re-exports the imported org to the same uploads and bytes, ids aside", async () => {
    /** Each upload by filename: its record without its id, its parts' data in order, its end without the id. */
    const comparable = (lines: string[]) => {
      const all = records(lines);
      return Object.fromEntries(
        all
          .filter((r) => r.type === "upload")
          .map(({ id, ...upload }) => [
            upload.filename,
            {
              upload,
              parts: all.filter((r) => r.type === "upload_part" && r.uploadId === id).map((p) => [p.index, p.data]),
              end: all
                .filter((r) => r.type === "upload_end" && r.uploadId === id)
                .map(({ uploadId: _id, ...end }) => end),
            },
          ]),
      );
    };
    const { "lost.pdf": _missing, ...fromA } = comparable(exported);
    // B never had A's missing raw file, so it has no record of that upload at all.
    expect(comparable(await collect(person(B, ADMIN)))).toEqual(fromA);
  });

  it("applies the target org's erasures: a covered upload's raw file is never stored", async () => {
    const offerBytes = bytesOf(200, 11);
    await seedUpload(S, "s-name", { scope: `org_${S}`, filename: "Jordan_Example_cv.pdf", bytes: offerBytes });
    await seedUpload(S, "s-camel", { scope: `org_${S}`, filename: "JordanExample offer.pdf", bytes: offerBytes });
    await seedUpload(S, "s-content", { scope: `org_${S}`, filename: "interview.pdf", bytes: offerBytes });
    await seedPassage(S, "s-content-named", {
      scope: `org_${S}`,
      content: `${ERASED} interviewed on Monday.`,
      uploadId: "s-content",
    });
    // Another person whose name contains hers, by #790's rules, and an upload made after the erasure.
    await seedUpload(S, "s-other", { scope: `org_${S}`, filename: "Jordan_Example-Barnes_CV.pdf", bytes: offerBytes });
    await seedUpload(S, "s-later", {
      scope: `org_${S}`,
      filename: "Jordan_Example_later.pdf",
      bytes: offerBytes,
      createdAt: AFTER_ERASURE,
    });
    await seedUpload(S, "s-clean", { scope: `org_${S}`, filename: "clean.pdf", bytes: offerBytes });
    await seedUpload(S, "s-gone", { scope: `org_${S}`, filename: "Jordan_Example_gone.pdf", missing: true });
    // A filename is a name: it never takes the stored file out of the org's prefix.
    await seedUpload(S, "s-path", { scope: `org_${S}`, filename: `../../${B}/escape.pdf`, bytes: offerBytes });
    const fromS = await collect(person(S, ADMIN));
    expect(uploadsIn(fromS)).toHaveLength(8);

    const { recordSuppressions } = await import("./erasure-suppression");
    await recordSuppressions(db, E, "erasure-upload-e", { emails: [], names: [ERASED], contactIds: [] });
    const puts = blobs.state.puts.length;
    const receipt = await importMemory(person(E, ADMIN), stream(fromS));
    expect(receipt.erased.upload).toBe(4);
    expect(receipt.imported.upload).toBe(4);
    expect(receipt.uploadsWithoutFile).toBe(0);
    const kept = await db.uploadedFile.findMany({ where: { orgId: E }, select: { filename: true } });
    expect(kept.map((r) => r.filename).sort()).toEqual([
      `../../${B}/escape.pdf`,
      "Jordan_Example-Barnes_CV.pdf",
      "Jordan_Example_later.pdf",
      "clean.pdf",
    ]);
    const stored = blobs.state.puts.slice(puts);
    expect(stored.map((p) => p.replace(`memory/${E}/`, "")).sort()).toEqual([
      `.._.._${B}_escape.pdf`,
      "Jordan_Example-Barnes_CV.pdf",
      "Jordan_Example_later.pdf",
      "clean.pdf",
    ]);
    expect(await db.memoryChunk.count({ where: { orgId: E, content: { contains: "Jordan" } } })).toBe(0);
  });

  it("streams a large file through export and import without holding it", async () => {
    const SIZE = 25 * 1024 * 1024;
    const CHUNK = 256 * 1024;
    const expected = createHash("sha256");
    for (let at = 0; at < SIZE; at += CHUNK) expected.update(bytesOf(Math.min(CHUNK, SIZE - at), at));
    const digest = expected.digest("hex");

    let produced = 0;
    const make = () => {
      let at = 0;
      return new ReadableStream<Uint8Array>({
        pull(controller) {
          if (at >= SIZE) return controller.close();
          const chunk = bytesOf(Math.min(CHUNK, SIZE - at), at);
          at += chunk.length;
          produced += chunk.length;
          controller.enqueue(new Uint8Array(chunk));
        },
      });
    };
    const blobUrl = blobs.seedMade(`memory/${L}/big.pdf`, make, digest, SIZE);
    await db.uploadedFile.create({
      data: {
        id: "l-big",
        orgId: L,
        scopePath: `org_${L}`,
        filename: "big.pdf",
        fileType: "pdf",
        blobUrl,
        actorId: ADMIN,
      },
    });

    // Export: storage is read only as far as the parts written so far, plus what is in hand.
    let exportedBytes = 0;
    let readAhead = 0;
    // Import: what the file has fed in, ahead of what storage has taken.
    let fed = 0;
    let inFlight = 0;
    blobs.state.consumed = 0;
    async function* piped(): AsyncGenerator<string> {
      for await (const line of exportMemory(person(L, ADMIN))) {
        const record = JSON.parse(line) as Line;
        if (record.type === "upload_part") {
          const size = Buffer.from(record.data as string, "base64").length;
          exportedBytes += size;
          readAhead = Math.max(readAhead, produced - exportedBytes);
          fed += size;
          inFlight = Math.max(inFlight, fed - blobs.state.consumed);
        }
        yield line;
      }
    }
    const receipt = await importMemory(person(L2, ADMIN), piped());
    expect(receipt.imported.upload).toBe(1);
    expect(exportedBytes).toBe(SIZE);
    // Less than one part held by the export, the read it is cutting into parts, and the one
    // read storage's stream queues ahead of it.
    expect(readAhead).toBeLessThanOrEqual(UPLOAD_PART_BYTES + 2 * CHUNK);
    expect(inFlight).toBeLessThanOrEqual(4 * UPLOAD_PART_BYTES);
    const row = await db.uploadedFile.findFirstOrThrow({ where: { orgId: L2 } });
    expect(blobs.state.stored.get(row.blobUrl)).toMatchObject({ size: SIZE, sha256: digest });
  }, 120_000);

  describe("a file that is not a whole export is refused, and leaves no upload or raw file behind", () => {
    const refusals: [string, (lines: string[]) => string[], RegExp][] = [
      [
        "a part dropped",
        (lines) => lines.filter((l, i) => i !== lines.findIndex((x) => x.includes('"uploadId":"up-sales","index":1'))),
        /part 2 where part 1 belongs/,
      ],
      [
        "a part repeated",
        (lines) => lines.flatMap((l) => (l.includes('"uploadId":"up-sales","index":1') ? [l, l] : [l])),
        /part 1 where part 2 belongs/,
      ],
      [
        "a part's bytes changed, same length",
        (lines) =>
          lines.map((l) =>
            l.includes('"uploadId":"up-sales","index":0')
              ? l.replace(/"data":"..../, (m) => (m.endsWith("AAAA") ? '"data":"BBBB' : '"data":"AAAA'))
              : l,
          ),
        /checksum/,
      ],
      [
        "a part's bytes added",
        (lines) =>
          lines.map((l) => (l.includes('"uploadId":"up-eng","index":0') ? l.replace('"data":"', '"data":"AAAA') : l)),
        /checksum/,
      ],
      [
        "a file's end claiming one more part",
        (lines) =>
          lines.map((l) =>
            l.includes('"type":"upload_end","uploadId":"up-eng"') ? l.replace('"parts":1', '"parts":2') : l,
          ),
        /checksum/,
      ],
      [
        "an upload id repeated",
        (lines) => {
          const group = lines.filter((l) => /"(id|uploadId)":"up-eng"/.test(l) && /"type":"upload/.test(l));
          const at = lines.indexOf(group.at(-1)!) + 1;
          return [...lines.slice(0, at), ...group, ...lines.slice(at)];
        },
        /appears twice/,
      ],
      [
        "a file's end dropped",
        (lines) => lines.filter((l) => !l.includes('"type":"upload_end","uploadId":"up-sales"')),
        /cut short/,
      ],
      [
        "a file's end claiming more bytes",
        (lines) =>
          lines.map((l) =>
            l.includes('"type":"upload_end","uploadId":"up-eng"') ? l.replace(/"bytes":\d+/, '"bytes":1001') : l,
          ),
        /checksum/,
      ],
      [
        "a part that is not base64",
        (lines) =>
          lines.map((l) => (l.includes('"uploadId":"up-eng","index":0') ? l.replace('"data":"', '"data":"!!') : l)),
        /base64/,
      ],
      [
        "a part of another upload",
        (lines) =>
          lines.map((l) => (l.includes('"uploadId":"up-sales","index":2') ? l.replace('"up-sales"', '"up-eng"') : l)),
        /out of place/,
      ],
      [
        "a part before any upload",
        (lines) => [lines[0]!, '{"type":"upload_part","uploadId":"x","index":0,"data":""}', ...lines.slice(1)],
        /out of place/,
      ],
      [
        "the end record while a file is open",
        (lines) => [
          ...lines.slice(0, lines.findIndex((l) => l.includes('"uploadId":"up-sales","index":0')) + 1),
          lines.at(-1)!,
        ],
        /cut short/,
      ],
      // Read only once its raw file is stored, so the stored file must be deleted again.
      [
        "an upload's scope too long to store",
        (lines) =>
          lines.map((l) =>
            l.includes('"type":"upload","id":"up-eng"')
              ? l.replace('"scope":"eng"', `"scope":"${"x".repeat(1001)}"`)
              : l,
          ),
        /not a valid scope path/,
      ],
      [
        "a passage after its upload, which could no longer keep the file out",
        (lines) => {
          const passage = lines.find((l) => l.includes('"id":"pa-sales"'))!;
          const at = lines.findIndex((l) => l.includes('"type":"upload_end","uploadId":"up-sales"')) + 1;
          return [...lines.slice(0, at).filter((l) => l !== passage), passage, ...lines.slice(at)];
        },
        /fact record after the upload records/,
      ],
      [
        "uploads in a schema version 1 file",
        (lines) => [lines[0]!.replace('"schemaVersion":2', '"schemaVersion":1'), ...lines.slice(1)],
        /schema version 1 does not have/,
      ],
      [
        "a part larger than a part may be",
        (lines) =>
          lines.map((l) =>
            l.includes('"uploadId":"up-sales","index":0')
              ? l.replace(/"data":"[^"]*"/, `"data":"${Buffer.alloc(48 * 1024 + 3).toString("base64")}"`)
              : l,
          ),
        /at most 49152 bytes per part/,
      ],
      [
        "counts that disagree, after every file was stored",
        (lines) => [...lines.slice(0, -1), lines.at(-1)!.replace(/"upload":\d+/, '"upload":99')],
        /holds 99 upload records/,
      ],
    ];
    for (const [name, tamper, reason] of refusals) {
      it(name, async () => {
        await expect(importMemory(person(BAD, ADMIN), stream(tamper(exported)))).rejects.toThrow(reason);
        // A file being stored when the import was refused is abandoned, not left waiting.
        expect(blobs.state.open).toBe(0);
        expect(await db.uploadedFile.count({ where: { orgId: BAD } })).toBe(0);
        expect(storedFor(BAD)).toEqual([]);
        expect(await db.memoryChunk.count({ where: { orgId: BAD } })).toBe(0);
      });
    }

    it("storage failing mid-file", async () => {
      blobs.state.failNextPut = true;
      await expect(importMemory(person(BAD, ADMIN), stream(exported))).rejects.toThrow(/storage unavailable/);
      expect(await db.uploadedFile.count({ where: { orgId: BAD } })).toBe(0);
      expect(storedFor(BAD)).toEqual([]);
    });
  });

  it("leaves out an upload removed while the export ran, and marks one whose file alone is gone", async () => {
    // Removed after its page was read and before its file was: once with its file deleted,
    // once with the delete still owed (a removal mid-way, or an erasure that has not reached it yet).
    await seedUpload(RACE, "race-first", {
      scope: `org_${RACE}`,
      filename: "first.pdf",
      bytes: bytesOf(10, 14),
      createdAt: new Date("2025-12-01T00:00:00Z"),
    });
    await seedUpload(RACE, "race-marked", { scope: `org_${RACE}`, filename: "marked.pdf", bytes: bytesOf(10, 15) });
    await seedUpload(RACE, "race-removed", { scope: `org_${RACE}`, filename: "racing.pdf", bytes: bytesOf(10, 13) });
    await seedUpload(RACE, "race-gone", { scope: `org_${RACE}`, filename: "gone.pdf", missing: true });
    const first = await db.uploadedFile.findUniqueOrThrow({ where: { id: "race-first" } });
    blobs.state.beforeRead.set(first.blobUrl, async () => {
      await db.uploadedFile.update({ where: { id: "race-marked" }, data: { removedAt: new Date() } });
    });
    const racing = await db.uploadedFile.findUniqueOrThrow({ where: { id: "race-removed" } });
    blobs.state.beforeRead.set(racing.blobUrl, async () => {
      await db.uploadedFile.update({ where: { id: "race-removed" }, data: { removedAt: new Date() } });
      blobs.state.stored.delete(racing.blobUrl);
    });
    const uploads = uploadsIn(await collect(person(RACE, ADMIN)));
    expect(uploads.map((u) => [u.filename, u.file])).toEqual([
      ["first.pdf", "follows"],
      ["gone.pdf", "missing"],
    ]);
  });

  it("stops reading storage when the export is abandoned at an upload or mid-file", async () => {
    let cancelled = 0;
    const blobUrl = blobs.seedMade(
      `memory/${RACE}/long.pdf`,
      () =>
        new ReadableStream<Uint8Array>({
          pull: (controller) => controller.enqueue(new Uint8Array(64 * 1024)),
          cancel: () => void cancelled++,
        }),
      "",
      0,
    );
    await db.uploadedFile.create({
      data: {
        id: "race-long",
        orgId: RACE,
        scopePath: `org_${RACE}`,
        filename: "long.pdf",
        fileType: "pdf",
        blobUrl,
        actorId: ADMIN,
      },
    });
    for (const stopAt of [
      (line: string) => line.includes('"filename":"long.pdf"'),
      (line: string) => line.includes('"uploadId":"race-long","index":2'),
    ]) {
      for await (const line of exportMemory(person(RACE, ADMIN))) if (stopAt(line)) break;
    }
    expect(cancelled).toBe(2);
  });

  it("refuses an org that holds a kept upload, and not one whose only upload is marked removed", async () => {
    await seedUpload(HELD, "held-1", { scope: `org_${HELD}`, filename: "held.pdf", bytes: bytesOf(10, 12) });
    await expect(importMemory(person(HELD, ADMIN), stream(exported))).rejects.toThrow(/already holds memory/);
    await db.uploadedFile.update({ where: { id: "held-1" }, data: { removedAt: new Date() } });
    await expect(importMemory(person(HELD, ADMIN), stream(exported))).resolves.toMatchObject({
      imported: { upload: 6 },
    });
  });

  describe("an upload made before an erasure whose passages were extracted after it", () => {
    // Rows the file-ingest job wrote before it judged an upload's passages at the upload's
    // own time: each passage dated after the erasure, its file uploaded before it.
    async function seedGapOrg(orgId: string) {
      for (const path of ["sales", "eng"])
        await db.scope.create({ data: { orgId, path: `org_${orgId}.${path}`, name: path } });
      const sales = `org_${orgId}.sales`;
      await seedUpload(orgId, `${orgId}-late`, { scope: sales, filename: "minutes.pdf", bytes: bytesOf(100, 21) });
      await seedPassage(orgId, `${orgId}-late-named`, {
        scope: sales,
        content: `${ERASED} chaired the meeting.`,
        uploadId: `${orgId}-late`,
        createdAt: AFTER_ERASURE,
      });
      await seedPassage(orgId, `${orgId}-late-kept`, {
        scope: sales,
        content: "The budget was approved.",
        uploadId: `${orgId}-late`,
        createdAt: AFTER_ERASURE,
      });
      // Named by a passage in a scope a sales reader cannot see.
      await seedUpload(orgId, `${orgId}-hidden`, { scope: sales, filename: "deck.pdf", bytes: bytesOf(100, 22) });
      await seedPassage(orgId, `${orgId}-hidden-named`, {
        scope: `org_${orgId}.eng`,
        content: `${ERASED} presented.`,
        uploadId: `${orgId}-hidden`,
        createdAt: AFTER_ERASURE,
      });
      // Another person whose name holds hers, and a file uploaded after the erasure: both stay.
      await seedUpload(orgId, `${orgId}-bystander`, {
        scope: sales,
        filename: "bystander.pdf",
        bytes: bytesOf(100, 23),
      });
      await seedPassage(orgId, `${orgId}-bystander-p`, {
        scope: sales,
        content: `${ERASED}-Barnes chaired.`,
        uploadId: `${orgId}-bystander`,
        createdAt: AFTER_ERASURE,
      });
      await seedUpload(orgId, `${orgId}-new`, {
        scope: sales,
        filename: "new.pdf",
        bytes: bytesOf(100, 24),
        createdAt: AFTER_ERASURE,
      });
      await seedPassage(orgId, `${orgId}-new-p`, {
        scope: sales,
        content: `${ERASED} signed.`,
        uploadId: `${orgId}-new`,
        createdAt: AFTER_ERASURE,
      });
    }
    const listErasure = async (orgId: string) => {
      const { recordSuppressions } = await import("./erasure-suppression");
      await recordSuppressions(db, orgId, `erasure-${orgId}`, { emails: [], names: [ERASED], contactIds: [] });
    };
    const factIds = (lines: string[]) =>
      records(lines)
        .filter((r) => r.type === "fact")
        .map((r) => r.id)
        .sort();

    it("the export judges each passage by when its file was uploaded: the file and the passage naming her stay out", async () => {
      await seedGapOrg(GAP);
      await listErasure(GAP);

      const lines = await collect(person(GAP, ADMIN));
      expect(
        uploadsIn(lines)
          .map((u) => u.id)
          .sort(),
      ).toEqual([`${GAP}-bystander`, `${GAP}-new`]);
      expect(factIds(lines)).toEqual([`${GAP}-bystander-p`, `${GAP}-late-kept`, `${GAP}-new-p`].sort());
      expect(
        records(lines).some(
          (r) => r.type.startsWith("upload_") && [`${GAP}-late`, `${GAP}-hidden`].includes(r.uploadId as string),
        ),
      ).toBe(false);

      // A reader of sales alone: the passage that names her is out of sight, and the file still stays out.
      const sales = await db.scope.findUniqueOrThrow({
        where: { orgId_path: { orgId: GAP, path: `org_${GAP}.sales` } },
      });
      await seedMember(db, { orgId: GAP, userId: GAP_MEMBER, role: "member" });
      await db.grant.create({
        data: { orgId: GAP, scopeId: sales.id, granteeType: "user", granteeId: GAP_MEMBER, permission: "read" },
      });
      const member = await collect(person(GAP, GAP_MEMBER, "member"));
      expect(
        uploadsIn(member)
          .map((u) => u.id)
          .sort(),
      ).toEqual([`${GAP}-bystander`, `${GAP}-new`]);
    });

    it("the import judges each passage by when its file was uploaded: neither the raw file nor that passage is stored", async () => {
      await seedGapOrg(GAP_SOURCE);
      const fromSource = await collect(person(GAP_SOURCE, ADMIN));
      expect(uploadsIn(fromSource)).toHaveLength(4);
      await listErasure(GAP_TARGET);
      const puts = blobs.state.puts.length;

      const receipt = await importMemory(person(GAP_TARGET, ADMIN), stream(fromSource));

      expect(receipt.erased).toMatchObject({ upload: 2, fact: 2 });
      expect(receipt.imported).toMatchObject({ upload: 2, fact: 3 });
      const kept = await db.uploadedFile.findMany({ where: { orgId: GAP_TARGET }, select: { filename: true } });
      expect(kept.map((r) => r.filename).sort()).toEqual(["bystander.pdf", "new.pdf"]);
      expect(
        blobs.state.puts
          .slice(puts)
          .map((p) => p.replace(`memory/${GAP_TARGET}/`, ""))
          .sort(),
      ).toEqual(["bystander.pdf", "new.pdf"]);
      const passages = await db.memoryChunk.findMany({ where: { orgId: GAP_TARGET }, select: { content: true } });
      expect(passages.map((p) => p.content).sort()).toEqual([
        `${ERASED} signed.`,
        `${ERASED}-Barnes chaired.`,
        "The budget was approved.",
      ]);
    });
  });

  it("still imports a schema version 1 file, which has no uploads, and refuses a later version", async () => {
    const v1 = records(exported)
      .filter((r) => !r.type.startsWith("upload"))
      .map((r) => {
        if (r.type === "manifest") return { ...r, schemaVersion: 1 };
        if (r.type === "end") {
          const { upload: _upload, ...counts } = r.counts as Record<string, number>;
          return { ...r, counts };
        }
        if (r.type !== "fact") return r;
        const { uploadId: _upload, ...fact } = r;
        return fact;
      })
      .map((r) => JSON.stringify(r));
    const receipt = await importMemory(person(V1, ADMIN), stream(v1));
    expect(receipt.imported.upload).toBe(0);
    expect(await db.memoryChunk.count({ where: { orgId: V1, uploadId: { not: null } } })).toBe(0);

    const later = [exported[0]!.replace('"schemaVersion":2', '"schemaVersion":3'), ...exported.slice(1)];
    await expect(importMemory(person(BAD, ADMIN), stream(later))).rejects.toBeInstanceOf(ImportRefusedError);
  });
});
