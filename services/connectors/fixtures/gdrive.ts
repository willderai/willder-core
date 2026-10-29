// Google Drive v3 payloads in the shape www.googleapis.com returns them, and an
// in-memory Drive that serves one folder the way the real API does: `files.list`
// honours the `'<folder>' in parents and trashed = false` query, pages with
// `nextPageToken`, and returns only the fields the `fields` parameter names.
// Google-native files carry no `md5Checksum`; binary files do.
//
// The rule this file keeps: a field exists because Drive sends it. Every name
// and address is made up and every domain is `.test`.

import { createHash } from "node:crypto";
import { providerResponse, requestUrl } from "./provider-response";
import type { ReadLog } from "./read-tracker";

export const DRIVE_MIME = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  googleDoc: "application/vnd.google-apps.document",
  googleSheet: "application/vnd.google-apps.spreadsheet",
  googleSlides: "application/vnd.google-apps.presentation",
  folder: "application/vnd.google-apps.folder",
  shortcut: "application/vnd.google-apps.shortcut",
  png: "image/png",
  mp4: "video/mp4",
} as const;

/** One stored Drive file, with every field the API can return for it. */
export interface DriveFileResource {
  kind: "drive#file";
  id: string;
  name: string;
  mimeType: string;
  parents: string[];
  trashed: boolean;
  /** Absent on Google-native files: they have no stored bytes to hash. */
  md5Checksum?: string;
  modifiedTime: string;
  size?: string;
  /** The bytes `alt=media` or `export` returns. */
  bytes: Uint8Array;
}

export interface DrivePermissionResource {
  kind: "drive#permission";
  id: string;
  type: "user" | "group" | "domain" | "anyone";
  role: "owner" | "organizer" | "fileOrganizer" | "writer" | "commenter" | "reader";
  emailAddress?: string;
  domain?: string;
  allowFileDiscovery?: boolean;
  deleted?: boolean;
}

export interface FakeDriveState {
  files: DriveFileResource[];
  /** Sharing list per file or folder id. */
  permissions: Map<string, DrivePermissionResource[]>;
  /** Answer every request with this status and Drive's error body for it. */
  failWith: { status: 401 | 403 | 429 | 500; reason: string } | null;
}

/** A PDF of `sizeBytes` bytes with a real header and trailer, so a sniffer sees a PDF. */
export function pdfBytes(sizeBytes: number, seed = "doc"): Uint8Array {
  const head = Buffer.from(`%PDF-1.7\n%âãÏÓ\n1 0 obj\n<< /Type /Catalog /Title (${seed}) >>\nendobj\n`, "latin1");
  const tail = Buffer.from("\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n", "latin1");
  const body = Buffer.alloc(Math.max(sizeBytes - head.length - tail.length, 0), 0x20);
  return new Uint8Array(Buffer.concat([head, body, tail]));
}

export function driveFile(
  folderId: string,
  id: string,
  fields: {
    name: string;
    mimeType: string;
    modifiedTime: string;
    bytes?: Uint8Array;
    trashed?: boolean;
    parents?: string[];
  },
): DriveFileResource {
  const bytes = fields.bytes ?? new TextEncoder().encode(`${fields.name} contents`);
  const nativeGoogle = fields.mimeType.startsWith("application/vnd.google-apps.");
  const file: DriveFileResource = {
    kind: "drive#file",
    id,
    name: fields.name,
    mimeType: fields.mimeType,
    parents: fields.parents ?? [folderId],
    trashed: fields.trashed ?? false,
    modifiedTime: fields.modifiedTime,
    bytes,
  };
  if (!nativeGoogle) {
    file.md5Checksum = createHash("md5").update(bytes).digest("hex");
    file.size = String(bytes.byteLength);
  }
  return file;
}

/** Replace a file's bytes as an edit in Drive does: same id, new checksum and modifiedTime. */
export function editDriveFile(file: DriveFileResource, bytes: Uint8Array, modifiedTime: string): void {
  file.bytes = bytes;
  file.modifiedTime = modifiedTime;
  if (file.md5Checksum !== undefined) {
    file.md5Checksum = createHash("md5").update(bytes).digest("hex");
    file.size = String(bytes.byteLength);
  }
}

/** Keep only the fields a `fields=nextPageToken,files(a,b,c)` selector names. */
function selectFields(file: DriveFileResource, selector: string): Record<string, unknown> {
  const inner = /files\(([^)]*)\)/.exec(selector)?.[1];
  const names = inner ? inner.split(",").map((s) => s.trim()) : ["kind", "id", "name", "mimeType"];
  const record = file as unknown as Record<string, unknown>;
  return Object.fromEntries(names.filter((n) => record[n] !== undefined).map((n) => [n, record[n]]));
}

function selectPermissionFields(permission: DrivePermissionResource, selector: string): Record<string, unknown> {
  const inner = /permissions\(([^)]*)\)/.exec(selector)?.[1];
  const names = inner ? inner.split(",").map((s) => s.trim()) : ["kind", "id", "type", "role"];
  const record = permission as unknown as Record<string, unknown>;
  return Object.fromEntries(names.filter((n) => record[n] !== undefined).map((n) => [n, record[n]]));
}

function driveError(status: number, reason: string, message: string): Response {
  return providerResponse(
    { error: { code: status, message, errors: [{ message, domain: "usageLimits", reason }] } },
    { status },
  );
}

/** Page through `items` with an opaque `nextPageToken`, as Drive does. */
function page<T>(items: T[], url: URL, defaultSize: number): { slice: T[]; nextPageToken?: string } {
  const size = Math.min(parseInt(url.searchParams.get("pageSize") ?? String(defaultSize), 10) || defaultSize, 1000);
  const offset = url.searchParams.has("pageToken")
    ? parseInt(Buffer.from(url.searchParams.get("pageToken") ?? "", "base64url").toString(), 10)
    : 0;
  const slice = items.slice(offset, offset + size);
  const next = offset + size < items.length ? Buffer.from(String(offset + size)).toString("base64url") : undefined;
  return next ? { slice, nextPageToken: next } : { slice };
}

const IN_PARENTS = /^'([^']+)' in parents and trashed = false$/;

export interface DriveRequest {
  path: string;
  query: Record<string, string>;
}

/**
 * A `fetch` that answers like the Drive v3 API for `files.list`, `files.get`
 * with `alt=media`, `files.export` and `permissions.list`. With a read log,
 * each JSON body is tracked for the drift check as `files.list` or
 * `permissions.list`.
 */
export function fakeDrive(state: FakeDriveState, log?: ReadLog) {
  const requests: DriveRequest[] = [];
  const fetch = async (input: RequestInfo | URL): Promise<Response> => {
    const url = requestUrl(input);
    requests.push({ path: url.pathname, query: Object.fromEntries(url.searchParams) });
    if (state.failWith)
      return driveError(state.failWith.status, state.failWith.reason, "Quota exceeded for quota metric 'Queries'.");

    if (url.pathname === "/drive/v3/files") {
      const parent = IN_PARENTS.exec(url.searchParams.get("q") ?? "")?.[1];
      if (!parent) return driveError(400, "invalid", "Invalid Value");
      const matching = state.files.filter((f) => f.parents.includes(parent) && !f.trashed);
      const { slice, nextPageToken } = page(matching, url, 100);
      const fields = url.searchParams.get("fields") ?? "";
      const body = {
        ...(nextPageToken ? { nextPageToken } : {}),
        files: slice.map((f) => selectFields(f, fields)),
      };
      return providerResponse(body, { track: log ? { root: "files.list", log } : undefined });
    }

    const permissions = /^\/drive\/v3\/files\/([^/]+)\/permissions$/.exec(url.pathname);
    if (permissions) {
      const list = state.permissions.get(decodeURIComponent(permissions[1]));
      if (!list) return driveError(404, "notFound", `File not found: ${permissions[1]}.`);
      const { slice, nextPageToken } = page(list, url, 100);
      const fields = url.searchParams.get("fields") ?? "";
      const body = {
        ...(nextPageToken ? { nextPageToken } : {}),
        permissions: slice.map((p) => selectPermissionFields(p, fields)),
      };
      return providerResponse(body, { track: log ? { root: "permissions.list", log } : undefined });
    }

    const content = /^\/drive\/v3\/files\/([^/]+)(\/export)?$/.exec(url.pathname);
    if (content) {
      const file = state.files.find((f) => f.id === decodeURIComponent(content[1]));
      if (!file) return driveError(404, "notFound", `File not found: ${content[1]}.`);
      // files.get without alt=media answers the file's metadata, cut to `fields`.
      if (!content[2] && url.searchParams.get("alt") !== "media" && url.searchParams.has("fields")) {
        return providerResponse(selectFields(file, `files(${url.searchParams.get("fields")})`), {
          track: log ? { root: "files.get", log } : undefined,
        });
      }
      const isNative = file.mimeType.startsWith("application/vnd.google-apps.");
      if (content[2]) {
        if (!isNative) return driveError(403, "fileNotExportable", "Only Google Docs files can be exported.");
        if (file.bytes.byteLength > 10 * 1024 * 1024)
          return driveError(403, "exportSizeLimitExceeded", "This file is too large to be exported.");
        return new Response(file.bytes as BlobPart, {
          headers: { "content-type": url.searchParams.get("mimeType") ?? "application/octet-stream" },
        });
      }
      if (url.searchParams.get("alt") !== "media") return driveError(400, "invalid", "alt=media required for content");
      if (isNative)
        return driveError(
          403,
          "fileNotDownloadable",
          "Only files with binary content can be downloaded. Use Export with Docs Editors files.",
        );
      return new Response(file.bytes as BlobPart, { headers: { "content-type": file.mimeType } });
    }
    return driveError(404, "notFound", "Not Found");
  };
  return { fetch, requests };
}

/**
 * One shared folder with what a real one holds: binary files and Google-native
 * documents, a subfolder and a shortcut, a video, two files with the same name,
 * unicode names, a trashed file, a file outside the folder, a 5 MB PDF, and
 * more files than one page holds when the page size is small.
 */
export function messyDriveFolder(folderId = "folder-shared-1"): FakeDriveState {
  const at = (day: number) => `2026-10-${String(day).padStart(2, "0")}T09:15:42.118Z`;
  const files = [
    // The picked folder itself, in the account's root.
    driveFile(folderId, folderId, {
      name: "Shared specs",
      mimeType: DRIVE_MIME.folder,
      modifiedTime: at(1),
      parents: ["root"],
    }),
    driveFile(folderId, "f-contract", {
      name: "Contract.pdf",
      mimeType: DRIVE_MIME.pdf,
      modifiedTime: at(1),
      bytes: pdfBytes(48_000, "contract"),
    }),
    driveFile(folderId, "f-handbook", { name: "Handbook.docx", mimeType: DRIVE_MIME.docx, modifiedTime: at(2) }),
    driveFile(folderId, "f-spec", { name: "Spec — v2 (draft)", mimeType: DRIVE_MIME.googleDoc, modifiedTime: at(3) }),
    driveFile(folderId, "f-budget", { name: "Budget FY27", mimeType: DRIVE_MIME.googleSheet, modifiedTime: at(4) }),
    driveFile(folderId, "f-deck", { name: "Launch deck", mimeType: DRIVE_MIME.googleSlides, modifiedTime: at(5) }),
    driveFile(folderId, "f-sub", { name: "Archive", mimeType: DRIVE_MIME.folder, modifiedTime: at(5) }),
    driveFile(folderId, "f-link", { name: "Shortcut to Roadmap", mimeType: DRIVE_MIME.shortcut, modifiedTime: at(5) }),
    driveFile(folderId, "f-video", { name: "Demo recording.mp4", mimeType: DRIVE_MIME.mp4, modifiedTime: at(6) }),
    driveFile(folderId, "f-notes-a", {
      name: "Notes.pdf",
      mimeType: DRIVE_MIME.pdf,
      modifiedTime: at(7),
      bytes: pdfBytes(2_000, "notes-a"),
    }),
    driveFile(folderId, "f-notes-b", {
      name: "Notes.pdf",
      mimeType: DRIVE_MIME.pdf,
      modifiedTime: at(8),
      bytes: pdfBytes(2_100, "notes-b"),
    }),
    driveFile(folderId, "f-unicode", {
      name: "会議メモ 🚀 — Zoë.pdf",
      mimeType: DRIVE_MIME.pdf,
      modifiedTime: at(9),
      bytes: pdfBytes(3_000, "unicode"),
    }),
    driveFile(folderId, "f-diagram", {
      name: "Architecture.png",
      mimeType: DRIVE_MIME.png,
      modifiedTime: at(10),
      bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]),
    }),
    driveFile(folderId, "f-large", {
      name: "Board pack.pdf",
      mimeType: DRIVE_MIME.pdf,
      modifiedTime: at(11),
      bytes: pdfBytes(5 * 1024 * 1024, "large"),
    }),
    driveFile(folderId, "f-trashed", {
      name: "Old draft.pdf",
      mimeType: DRIVE_MIME.pdf,
      modifiedTime: at(12),
      trashed: true,
    }),
    driveFile(folderId, "f-elsewhere", {
      name: "Someone else's.pdf",
      mimeType: DRIVE_MIME.pdf,
      modifiedTime: at(12),
      parents: ["folder-other"],
    }),
  ];
  const permission = (id: string, fields: Omit<DrivePermissionResource, "kind" | "id">): DrivePermissionResource => ({
    kind: "drive#permission",
    id,
    ...fields,
  });
  const permissions = new Map([
    [
      folderId,
      [
        permission("p-owner", { type: "user", role: "owner", emailAddress: "owner@acme.test", deleted: false }),
        permission("p-editor", { type: "user", role: "writer", emailAddress: "editor@acme.test", deleted: false }),
        permission("p-gone", { type: "user", role: "reader", emailAddress: "former@acme.test", deleted: true }),
        permission("p-group", { type: "group", role: "reader", emailAddress: "eng@acme.test" }),
        permission("p-domain", { type: "domain", role: "reader", domain: "acme.test", allowFileDiscovery: true }),
        permission("p-domain-link", {
          type: "domain",
          role: "reader",
          domain: "partner.test",
          allowFileDiscovery: false,
        }),
        permission("p-anyone-link", { type: "anyone", role: "reader", allowFileDiscovery: false }),
      ],
    ],
  ]);
  return { files, permissions, failWith: null };
}

/**
 * The messy folder grown past one page: `files` more PDFs and `readers` more
 * named people on its sharing list, so both `files.list` and
 * `permissions.list` answer with a `nextPageToken`.
 */
export function largeDriveFolder(folderId = "folder-shared-1", files = 230, readers = 150): FakeDriveState {
  const state = messyDriveFolder(folderId);
  for (let i = 0; i < files; i++) {
    state.files.push(
      driveFile(folderId, `f-bulk-${i}`, {
        name: `Minutes ${i}.pdf`,
        mimeType: DRIVE_MIME.pdf,
        modifiedTime: "2026-10-14T00:00:00.000Z",
        bytes: pdfBytes(600, `bulk-${i}`),
      }),
    );
  }
  const sharing = state.permissions.get(folderId) ?? [];
  for (let i = 0; i < readers; i++) {
    sharing.push({
      kind: "drive#permission",
      id: `p-reader-${i}`,
      type: "user",
      role: "reader",
      emailAddress: `reader${i}@acme.test`,
      deleted: false,
    });
  }
  state.permissions.set(folderId, sharing);
  return state;
}
