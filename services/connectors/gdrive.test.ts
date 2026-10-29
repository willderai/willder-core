// The Drive connector's real branch against Drive v3 payloads in Drive's own
// shape (fixtures/gdrive.ts): listing a mixed folder across pages, the change
// key each kind of file gets, download and export, the API's error answers, and
// the folder's sharing list. GDRIVE_MOCK is read at import, so each test
// imports the module fresh with the real branch selected.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DRIVE_MIME,
  editDriveFile,
  fakeDrive,
  largeDriveFolder,
  messyDriveFolder,
  pdfBytes,
  type FakeDriveState,
} from "./fixtures/gdrive";

const TOKEN = "test-drive-token";
const FOLDER = "folder-shared-1";

beforeEach(() => vi.stubEnv("GDRIVE_MOCK", "false"));
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.resetModules();
});

async function withDrive(state: FakeDriveState) {
  const drive = fakeDrive(state);
  vi.stubGlobal("fetch", vi.fn(drive.fetch));
  // The error class from the same fresh module graph the connector was imported in.
  return { ...(await import("./gdrive")), ...(await import("./source-access")), requests: drive.requests };
}

describe("listFolderFiles", () => {
  it("lists the folder's supported files and skips folders, shortcuts, video, trashed files and other folders' files", async () => {
    const { listFolderFiles } = await withDrive(messyDriveFolder(FOLDER));
    const files = await listFolderFiles(FOLDER, TOKEN);
    expect(files.map((f) => [f.id, f.fileType])).toEqual([
      ["f-contract", "pdf"],
      ["f-handbook", "docx"],
      ["f-spec", "docx"],
      ["f-budget", "pdf"],
      ["f-deck", "pdf"],
      ["f-notes-a", "pdf"],
      ["f-notes-b", "pdf"],
      ["f-unicode", "pdf"],
      ["f-diagram", "image"],
      ["f-large", "pdf"],
    ]);
    expect(files.find((f) => f.id === "f-unicode")?.name).toBe("会議メモ 🚀 — Zoë.pdf");
  });

  it("keeps two files with the same name apart by id", async () => {
    const { listFolderFiles } = await withDrive(messyDriveFolder(FOLDER));
    const notes = (await listFolderFiles(FOLDER, TOKEN)).filter((f) => f.name === "Notes.pdf");
    expect(notes.map((f) => f.id)).toEqual(["f-notes-a", "f-notes-b"]);
    expect(notes[0].checksum).not.toBe(notes[1].checksum);
  });

  it("versions a binary file by its bytes and a Google-native one, which has no md5, by modifiedTime", async () => {
    const state = messyDriveFolder(FOLDER);
    const { listFolderFiles } = await withDrive(state);
    const before = await listFolderFiles(FOLDER, TOKEN);

    const contract = state.files.find((f) => f.id === "f-contract");
    const spec = state.files.find((f) => f.id === "f-spec");
    const handbook = state.files.find((f) => f.id === "f-handbook");
    if (!contract || !spec || !handbook) throw new Error("fixture lost a file");
    editDriveFile(contract, pdfBytes(49_000, "contract v2"), "2026-10-13T08:00:00.000Z");
    editDriveFile(spec, new TextEncoder().encode("spec v3"), "2026-10-13T08:05:00.000Z");
    // A metadata change Drive stamps with a new modifiedTime, bytes untouched.
    handbook.modifiedTime = "2026-10-13T08:10:00.000Z";

    const after = await listFolderFiles(FOLDER, TOKEN);
    const key = (list: typeof before, id: string) => list.find((f) => f.id === id)?.checksum;
    expect(key(after, "f-contract")).not.toBe(key(before, "f-contract"));
    expect(key(after, "f-spec")).not.toBe(key(before, "f-spec"));
    expect(key(after, "f-handbook")).toBe(key(before, "f-handbook"));
  });

  it("changes the change key on a rename, which keeps Drive's md5Checksum, and on nothing else", async () => {
    const state = messyDriveFolder(FOLDER);
    const { listFolderFiles } = await withDrive(state);
    const before = await listFolderFiles(FOLDER, TOKEN);

    const contract = state.files.find((f) => f.id === "f-contract");
    const spec = state.files.find((f) => f.id === "f-spec");
    if (!contract || !spec) throw new Error("fixture lost a file");
    const md5 = contract.md5Checksum;
    contract.name = "Contract (signed).pdf";
    spec.name = "Spec — v2 (final)";

    const after = await listFolderFiles(FOLDER, TOKEN);
    const key = (list: typeof before, id: string) => list.find((f) => f.id === id)?.checksum;
    expect(contract.md5Checksum).toBe(md5);
    expect(key(after, "f-contract")).not.toBe(key(before, "f-contract"));
    expect(key(after, "f-spec")).not.toBe(key(before, "f-spec"));
    expect(after.find((f) => f.id === "f-spec")?.name).toBe("Spec — v2 (final)");
    for (const file of after.filter((f) => f.id !== "f-contract" && f.id !== "f-spec")) {
      expect(file.checksum).toBe(key(before, file.id));
    }
  });

  it("stores no file name in the change key, only a sha256 digest", async () => {
    const state = messyDriveFolder(FOLDER);
    const { listFolderFiles } = await withDrive(state);
    const files = await listFolderFiles(FOLDER, TOKEN);
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      expect(file.checksum).toMatch(/^[0-9a-f]{64}$/);
      expect(file.checksum.toLowerCase()).not.toContain(file.name.toLowerCase());
    }
  });

  it("follows nextPageToken through a 230-file folder and asks only for the fields it reads", async () => {
    const { listFolderFiles, requests } = await withDrive(largeDriveFolder(FOLDER, 230, 0));
    const files = await listFolderFiles(FOLDER, TOKEN);

    expect(files).toHaveLength(240);
    expect(new Set(files.map((f) => f.id)).size).toBe(240);
    const lists = requests.filter((r) => r.path === "/drive/v3/files");
    expect(lists).toHaveLength(3);
    expect(lists[0].query).toEqual({
      q: `'${FOLDER}' in parents and trashed = false`,
      fields: "nextPageToken,files(id,name,mimeType,md5Checksum,modifiedTime)",
      pageSize: "100",
    });
    expect(lists[1].query.pageToken).toBeDefined();
  });

  // The sync picks the line it shows the person by the status and reason in the
  // message (lib/inngest/sync-failure-message.ts), so both must be in it.
  it("fails on an expired sign-in, a rate limit, a quota error or a 5xx rather than reading the folder as empty", async () => {
    for (const failWith of [
      { status: 401, reason: "authError" },
      { status: 429, reason: "rateLimitExceeded" },
      { status: 403, reason: "userRateLimitExceeded" },
      { status: 500, reason: "backendError" },
    ] as const) {
      const state = messyDriveFolder(FOLDER);
      state.failWith = failWith;
      const { listFolderFiles, SourceAccessError, DriveRequestError } = await withDrive(state);
      const listing = listFolderFiles(FOLDER, TOKEN);
      await expect(listing).rejects.toThrow(/Drive files\.get failed for the synced folder: .*Quota exceeded/);
      await expect(listing).rejects.toBeInstanceOf(DriveRequestError);
      await expect(listing).rejects.toMatchObject({
        status: failWith.status,
        message: expect.stringContaining(`: ${failWith.status} {`),
      });
      await expect(listing).rejects.toThrow(failWith.reason);
      await expect(listing).rejects.not.toThrow(SourceAccessError);
      vi.resetModules();
    }
  });

  // Access can end between the folder read and the listing, or between pages.
  // The listing then comes back short, which reads as files that left the
  // folder, so the folder is read again once the listing is done.
  it.each([
    [
      "stops being shared with the account",
      (state: FakeDriveState) => {
        state.files = state.files.filter((f) => f.id !== FOLDER && !f.parents.includes(FOLDER));
      },
      "lost",
    ],
    [
      "is moved to the trash",
      (state: FakeDriveState) => {
        for (const f of state.files) if (f.id === FOLDER || f.parents.includes(FOLDER)) f.trashed = true;
      },
      "trashed",
    ],
  ] as const)(
    "reads the folder again after listing, so a folder that %s while it is listed is never an empty listing",
    async (_case, lose, expected) => {
      const state = messyDriveFolder(FOLDER);
      const drive = fakeDrive(state);
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: RequestInfo | URL) => {
          const res = await drive.fetch(input);
          if (drive.requests.length === 1) lose(state); // right after the first folder read
          return res;
        }),
      );
      const { listFolderFiles } = await import("./gdrive");
      const { SourceAccessError } = await import("./source-access");
      const listing = listFolderFiles(FOLDER, TOKEN);
      if (expected === "lost") await expect(listing).rejects.toThrow(SourceAccessError);
      else await expect(listing).resolves.toEqual([]);
      expect(drive.requests.map((r) => r.path)).toEqual([
        `/drive/v3/files/${FOLDER}`,
        "/drive/v3/files",
        `/drive/v3/files/${FOLDER}`,
      ]);
    },
  );

  // Drive lists nothing under a folder the account can no longer open, which
  // reads as an empty folder and would retire every stored file.
  it.each([
    [
      "no longer shared with the account (404)",
      (state: FakeDriveState) => {
        state.files = state.files.filter((f) => f.id !== FOLDER);
      },
    ],
    [
      "refused to the account (an access 403)",
      (state: FakeDriveState) => {
        state.failWith = { status: 403, reason: "insufficientFilePermissions" };
      },
    ],
  ])("reports a folder %s as lost access naming the fix, never as an empty folder", async (_case, lose) => {
    const state = messyDriveFolder(FOLDER);
    lose(state);
    const { listFolderFiles, SourceAccessError } = await withDrive(state);
    const listing = listFolderFiles(FOLDER, TOKEN);
    await expect(listing).rejects.toThrow(SourceAccessError);
    await expect(listing).rejects.toThrow(
      /can no longer open this Drive folder.*Share the folder with this account again/,
    );
  });

  it("lists nothing for a folder in the trash, Drive's sign that it is gone", async () => {
    const state = messyDriveFolder(FOLDER);
    state.files.find((f) => f.id === FOLDER)!.trashed = true;
    const { listFolderFiles, requests } = await withDrive(state);
    expect(await listFolderFiles(FOLDER, TOKEN)).toEqual([]);
    expect(requests.map((r) => r.path)).toEqual([`/drive/v3/files/${FOLDER}`]);
  });
});

describe("downloadFile", () => {
  it("downloads a binary file whole with alt=media, 5 MB included", async () => {
    const { listFolderFiles, downloadFile, requests } = await withDrive(messyDriveFolder(FOLDER));
    const large = (await listFolderFiles(FOLDER, TOKEN)).find((f) => f.id === "f-large");
    if (!large) throw new Error("large file not listed");
    const blob = await downloadFile(large, TOKEN);
    expect(blob.size).toBe(5 * 1024 * 1024);
    expect(new TextDecoder().decode((await blob.arrayBuffer()).slice(0, 8))).toBe("%PDF-1.7");
    expect(requests.at(-1)).toEqual({ path: "/drive/v3/files/f-large", query: { alt: "media" } });
  });

  it("exports a Google Doc as .docx and a Sheet as PDF, since Drive will not serve their bytes", async () => {
    const { listFolderFiles, downloadFile, requests } = await withDrive(messyDriveFolder(FOLDER));
    const files = await listFolderFiles(FOLDER, TOKEN);
    for (const id of ["f-spec", "f-budget"]) {
      const file = files.find((f) => f.id === id);
      if (!file) throw new Error(`${id} not listed`);
      await downloadFile(file, TOKEN);
    }
    expect(requests.slice(-2)).toEqual([
      { path: "/drive/v3/files/f-spec/export", query: { mimeType: DRIVE_MIME.docx } },
      { path: "/drive/v3/files/f-budget/export", query: { mimeType: DRIVE_MIME.pdf } },
    ]);
  });

  it("names the file when Drive refuses to export one over its 10 MB limit", async () => {
    const state = messyDriveFolder(FOLDER);
    const spec = state.files.find((f) => f.id === "f-spec");
    if (!spec) throw new Error("fixture lost f-spec");
    spec.bytes = new Uint8Array(11 * 1024 * 1024);
    const { listFolderFiles, downloadFile } = await withDrive(state);
    const file = (await listFolderFiles(FOLDER, TOKEN)).find((f) => f.id === "f-spec");
    if (!file) throw new Error("f-spec not listed");
    await expect(downloadFile(file, TOKEN)).rejects.toThrow(
      /exportSizeLimitExceeded[^]*\(file "Spec — v2 \(draft\)"\)/,
    );
  });
});

// processDriveFile stops the whole sync when the sign-in is rejected and counts
// any other failure against the one file, so the flag must hold for exactly 401.
describe("DriveRequestError.credentialFailed", () => {
  it.each([
    [401, "authError", true],
    // Drive's answer about one file, which must not stop every later sync at it.
    [403, "insufficientFilePermissions", false],
    [403, "domainPolicy", false],
    [403, "appNotAuthorizedToFile", false],
    [403, "userRateLimitExceeded", false],
    [403, "exportSizeLimitExceeded", false],
    [429, "rateLimitExceeded", false],
    [500, "backendError", false],
  ] as const)("a download answered %i %s: %s", async (status, reason, expected) => {
    const state = messyDriveFolder(FOLDER);
    const { listFolderFiles, downloadFile } = await withDrive(state);
    const file = (await listFolderFiles(FOLDER, TOKEN)).find((f) => f.id === "f-large")!;
    state.failWith = { status, reason };
    await expect(downloadFile(file, TOKEN)).rejects.toMatchObject({ status, credentialFailed: expected });
  });
});

describe("listFolderReaders", () => {
  it("maps named people and discoverable domains, and leaves groups, link-only shares and deleted users unmappable", async () => {
    const { listFolderReaders } = await withDrive(messyDriveFolder(FOLDER));
    expect(await listFolderReaders(FOLDER, TOKEN)).toEqual({
      kind: "known",
      readers: [
        { kind: "email", email: "owner@acme.test" },
        { kind: "email", email: "editor@acme.test" },
        { kind: "unmappable" },
        { kind: "unmappable" },
        { kind: "domain", domain: "acme.test" },
        { kind: "unmappable" },
        { kind: "unmappable" },
      ],
    });
  });

  it("follows nextPageToken through a sharing list of 157 entries", async () => {
    const { listFolderReaders, requests } = await withDrive(largeDriveFolder(FOLDER, 0, 150));
    const readers = await listFolderReaders(FOLDER, TOKEN);
    expect(readers.kind === "known" && readers.readers).toHaveLength(157);
    expect(requests.filter((r) => r.path.endsWith("/permissions"))).toHaveLength(2);
  });

  it("reports readers as unknown when Drive answers with an error", async () => {
    const state = messyDriveFolder(FOLDER);
    state.failWith = { status: 429, reason: "rateLimitExceeded" };
    const { listFolderReaders } = await withDrive(state);
    expect((await listFolderReaders(FOLDER, TOKEN)).kind).toBe("unknown");
  });
});
