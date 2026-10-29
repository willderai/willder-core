// Google Drive connector — list and download files from a user-picked folder.
// Uses the non-sensitive `drive.file` scope (no Google security review / no CASA
// assessment required). The user picks a folder via the Google Picker on the client;
// the client posts the folder id + a short-lived access token to the server.
//
// MOCK (default): set GDRIVE_MOCK=false to use real Drive API.
// Real branch requires NEXT_PUBLIC_GOOGLE_CLIENT_ID + NEXT_PUBLIC_GOOGLE_API_KEY
// (for the Picker) and a valid OAuth access token from the client.

import { createHash } from "node:crypto";
import type { SourceReader, SourceReaders } from "@/services/access";
import { SourceAccessError } from "./source-access";

export const GDRIVE_MOCK = process.env.GDRIVE_MOCK !== "false";

/** Supported Drive mimeTypes → our FileIngestInput["fileType"]. */
const MIME_MAP: Record<string, "pdf" | "docx" | "image"> = {
  "application/pdf": "pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/msword": "docx",
  // Google-native formats are exported
  "application/vnd.google-apps.document": "docx",
  "application/vnd.google-apps.presentation": "pdf",
  "application/vnd.google-apps.spreadsheet": "pdf",
  "image/jpeg": "image",
  "image/png": "image",
  "image/webp": "image",
  "image/gif": "image",
};

/** Export mimeType for Google-native formats (Drive won't serve them as binary). */
const EXPORT_MIME: Record<string, string> = {
  "application/vnd.google-apps.document": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.google-apps.presentation": "application/pdf",
  "application/vnd.google-apps.spreadsheet": "application/pdf",
};

export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  /**
   * What changes whenever the stored copy of this file must: `contentVersion`
   * together with the file's name. See `driveChangeKey`.
   */
  checksum: string;
  /** md5Checksum for a binary file; modifiedTime for a Google-native one, which has no md5. */
  contentVersion: string;
  fileType: "pdf" | "docx" | "image";
}

/**
 * The key a sync compares to decide whether a stored file is still current.
 *
 * A rename leaves Drive's md5Checksum alone, but the stored episodes carry the
 * file's name, so the name is part of the key: a renamed file is synced again
 * and an untouched one is still skipped. The parent folder is not, because the
 * listing reads one folder and a file moved out of it is no longer listed.
 *
 * The key is a sha256 digest, as Slack's and Figma's are, because it is stored in
 * `source_files.checksum`, which a person erasure does not rewrite: a file name
 * can name the erased person, and the stored key must not.
 */
function driveChangeKey(contentVersion: string, name: string): string {
  return createHash("sha256")
    .update(JSON.stringify([contentVersion, name]))
    .digest("hex");
}

/** The reason code in Drive's JSON error body, or undefined for any other body. */
function driveReason(body: string): string | undefined {
  try {
    return (JSON.parse(body) as { error?: { errors?: { reason?: string }[] } }).error?.errors?.[0]?.reason;
  } catch {
    return undefined;
  }
}

/** Drive's 403 reasons that mean this account may not open the item, as against a rate limit or quota. */
const NO_ACCESS_REASONS = new Set([
  "insufficientFilePermissions",
  "insufficientPermissions",
  "forbidden",
  "domainPolicy",
  "appNotAuthorizedToFile",
]);

/**
 * A Drive request that failed: an expired sign-in (401), a refusal, a rate
 * limit or quota, or an error on Google's side. The message is "<request>
 * failed: <status> <Drive's body> (<what it was for>)": the logs keep Drive's
 * answer, and the sync reads the status and reason from it to show the person a
 * plain line instead (lib/inngest/sync-failure-message.ts). What the request
 * was for goes last, so a file name cannot be read as the status.
 */
export class DriveRequestError extends Error {
  /**
   * True when the run's Google sign-in itself was rejected (401, most often
   * expired). Every later request of the run would fail the same way, so a sync
   * stops on it rather than counting one file failed. A 403 or 404 is Drive's
   * answer about one file (its owner's domain policy, a file the picked folder
   * did not grant), so it stays that file's failure: stopping on it would stop
   * every later sync at the same file.
   */
  readonly credentialFailed: boolean;
  constructor(
    request: string,
    readonly status: number,
    body: string,
    subject?: string,
  ) {
    super(`${request}: ${status} ${body}${subject ? ` (${subject})` : ""}`);
    this.name = "DriveRequestError";
    this.credentialFailed = status === 401;
  }
}

/**
 * Whether the folder is in the trash, read before its listing and after it. Drive lists
 * nothing under a folder the account can no longer open, the same answer as an
 * empty folder, so that listing alone would retire every stored file. A folder
 * Drive cannot find for this account (404), or will not show it (an access 403),
 * throws `SourceAccessError`: Drive gives that answer both to a folder deleted
 * for good and to one the account lost access to, and only the trash is a sign
 * that the folder is gone.
 */
async function folderIsTrashed(folderId: string, token: string): Promise<boolean> {
  const res = await fetch(
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(folderId)}?fields=id,trashed&supportsAllDrives=true`,
    {
      headers: { Authorization: `Bearer ${token}` },
    },
  );
  if (res.ok) return ((await res.json()) as { trashed?: boolean }).trashed === true;
  const err = await res.text().catch(() => res.statusText);
  const reason = driveReason(err);
  if (res.status === 404 || (res.status === 403 && reason !== undefined && NO_ACCESS_REASONS.has(reason))) {
    throw new SourceAccessError(
      "This Google account can no longer open this Drive folder. Drive gives that answer when the folder stopped being shared with the account, and also when it was deleted for good. Share the folder with this account again and re-sync, or disconnect this source if the folder is gone.",
    );
  }
  throw new DriveRequestError("Drive files.get failed for the synced folder", res.status, err);
}

/**
 * List all supported files under a Drive folder (non-recursive for MVP —
 * top-level files only). Returns files whose mimeType we can extract, and
 * none for a folder in the trash. The folder is read before the listing and
 * again after it, so a folder the account cannot open, before or during the
 * listing, throws `SourceAccessError` (see `folderIsTrashed`).
 */
export async function listFolderFiles(folderId: string, token: string): Promise<DriveFile[]> {
  if (GDRIVE_MOCK) {
    return [
      {
        id: `mock_file_1_${folderId}`,
        name: "Company Overview.pdf",
        mimeType: "application/pdf",
        checksum: driveChangeKey("mock_checksum_1", "Company Overview.pdf"),
        contentVersion: "mock_checksum_1",
        fileType: "pdf",
      },
      {
        id: `mock_file_2_${folderId}`,
        name: "Sales Deck.pdf",
        mimeType: "application/pdf",
        checksum: driveChangeKey("mock_checksum_2", "Sales Deck.pdf"),
        contentVersion: "mock_checksum_2",
        fileType: "pdf",
      },
      {
        id: `mock_file_3_${folderId}`,
        name: "Case Study.docx",
        mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        checksum: driveChangeKey("mock_checksum_3", "Case Study.docx"),
        contentVersion: "mock_checksum_3",
        fileType: "docx",
      },
    ];
  }

  if (await folderIsTrashed(folderId, token)) return [];
  const files: DriveFile[] = [];
  let pageToken: string | undefined;

  do {
    const params = new URLSearchParams({
      q: `'${folderId}' in parents and trashed = false`,
      fields: "nextPageToken,files(id,name,mimeType,md5Checksum,modifiedTime)",
      pageSize: "100",
    });
    if (pageToken) params.set("pageToken", pageToken);

    const res = await fetch(`https://www.googleapis.com/drive/v3/files?${params}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      const err = await res.text().catch(() => res.statusText);
      throw new DriveRequestError("Drive files.list failed", res.status, err);
    }
    const data = (await res.json()) as {
      nextPageToken?: string;
      files: { id: string; name: string; mimeType: string; md5Checksum?: string; modifiedTime?: string }[];
    };

    for (const f of data.files ?? []) {
      const fileType = MIME_MAP[f.mimeType];
      if (!fileType) continue; // unsupported type, skip
      const contentVersion = f.md5Checksum ?? f.modifiedTime ?? f.id;
      files.push({
        id: f.id,
        name: f.name,
        mimeType: f.mimeType,
        checksum: driveChangeKey(contentVersion, f.name),
        contentVersion,
        fileType,
      });
    }
    pageToken = data.nextPageToken;
  } while (pageToken);

  // Read the folder again now the listing is done. Access lost while it was
  // being read empties the remaining pages, which reads as files that left the
  // folder and would retire them; this read then fails, so nothing is retired.
  if (await folderIsTrashed(folderId, token)) return [];
  return files;
}

/**
 * Download a Drive file as a Blob. Google-native formats (Docs/Slides/Sheets)
 * are exported to a compatible binary format before download.
 */
export async function downloadFile(file: DriveFile, token: string): Promise<Blob> {
  if (GDRIVE_MOCK) {
    const content = `Mock content for ${file.name}. This is a test document used in GDRIVE_MOCK mode.`;
    return new Blob([content], { type: "text/plain" });
  }

  const exportMime = EXPORT_MIME[file.mimeType];
  let url: string;
  if (exportMime) {
    url = `https://www.googleapis.com/drive/v3/files/${file.id}/export?mimeType=${encodeURIComponent(exportMime)}`;
  } else {
    url = `https://www.googleapis.com/drive/v3/files/${file.id}?alt=media`;
  }

  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    const err = await res.text().catch(() => res.statusText);
    throw new DriveRequestError("Drive file download failed", res.status, err, `file "${file.name}"`);
  }
  return res.blob();
}

/** One entry of a Drive permissions.list response, with the fields we request. */
interface DrivePermission {
  type?: "user" | "group" | "domain" | "anyone";
  emailAddress?: string;
  domain?: string;
  allowFileDiscovery?: boolean;
  deleted?: boolean;
}

/**
 * One Drive permission as a source reader. Only a share that names a person, or
 * that anyone in a domain (or anyone at all) can find without a link, maps to
 * readers; a group's members are not listed to us, and a link-only share is
 * readable only by whoever holds the link, so both are unmappable and leave
 * the people behind them counted as widening.
 */
function toSourceReader(permission: DrivePermission): SourceReader {
  if (permission.type === "user" && permission.emailAddress && !permission.deleted) {
    return { kind: "email", email: permission.emailAddress };
  }
  if (permission.type === "domain" && permission.domain && permission.allowFileDiscovery === true) {
    return { kind: "domain", domain: permission.domain };
  }
  if (permission.type === "anyone" && permission.allowFileDiscovery === true) return { kind: "everyone" };
  return { kind: "unmappable" };
}

/**
 * Who can read a Drive folder at the source: the folder's own sharing list,
 * which every file in it inherits. Any failure to read that list reports the
 * readers as unknown, never as an empty list, because an empty list would read
 * as "nobody gains access" when the truth is that nobody checked.
 *
 * The folder's list is the floor for its files, not each file's exact list: a
 * file can be shared more widely than its folder, and a limited-access folder
 * can stop a file inheriting. Carrying each file's own list is a later phase.
 */
export async function listFolderReaders(folderId: string, token: string): Promise<SourceReaders> {
  if (GDRIVE_MOCK) {
    return { kind: "unknown", reason: "Drive fixture mode has no real sharing list" };
  }

  const readers: SourceReader[] = [];
  let pageToken: string | undefined;
  try {
    do {
      const params = new URLSearchParams({
        fields: "nextPageToken,permissions(type,emailAddress,domain,allowFileDiscovery,deleted)",
        pageSize: "100",
        supportsAllDrives: "true",
      });
      if (pageToken) params.set("pageToken", pageToken);
      const res = await fetch(
        `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(folderId)}/permissions?${params}`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      if (!res.ok) return { kind: "unknown", reason: "Google Drive did not return this folder's sharing list" };
      const data = (await res.json()) as { nextPageToken?: string; permissions?: DrivePermission[] };
      readers.push(...(data.permissions ?? []).map(toSourceReader));
      pageToken = data.nextPageToken;
    } while (pageToken);
  } catch {
    return { kind: "unknown", reason: "Google Drive could not be reached to read this folder's sharing list" };
  }
  return { kind: "known", readers };
}

/**
 * Create a native Google Doc from plain-text content. Uploading with
 * mimeType `application/vnd.google-apps.document` auto-converts the uploaded
 * text into a real, shareable Doc — no separate Docs API call, and still only
 * the `drive.file` scope (creating files the app owns).
 */
export async function createGoogleDoc(
  title: string,
  content: string,
  token: string,
): Promise<{ id: string; url: string }> {
  if (GDRIVE_MOCK) {
    const id = `mock_doc_${Date.now()}`;
    return { id, url: `https://docs.google.com/document/d/${id}/edit` };
  }

  const boundary = `willder_${Math.random().toString(36).slice(2)}`;
  const metadata = JSON.stringify({ name: title, mimeType: "application/vnd.google-apps.document" });
  const body =
    `--${boundary}\r\n` +
    `Content-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n` +
    `--${boundary}\r\n` +
    `Content-Type: text/plain; charset=UTF-8\r\n\r\n${content}\r\n` +
    `--${boundary}--`;

  const res = await fetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": `multipart/related; boundary=${boundary}`,
    },
    body,
  });
  if (!res.ok) {
    const err = await res.text().catch(() => res.statusText);
    throw new Error(`Drive doc creation failed: ${err}`);
  }
  const data = (await res.json()) as { id: string };
  return { id: data.id, url: `https://docs.google.com/document/d/${data.id}/edit` };
}
