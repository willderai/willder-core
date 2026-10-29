"use client";

import { useRef, useState } from "react";
import { useAnalytics } from "@/components/posthog-provider";
import { useToast } from "@/components/ui";

const ACCEPT = [
  ".pdf",
  ".docx",
  ".doc",
  ".jpg",
  ".jpeg",
  ".png",
  ".webp",
  ".gif",
  ".txt",
  ".md",
  ".markdown",
  ".csv",
  ".json",
].join(",");

const TEXT_EXTS = new Set(["txt", "md", "markdown", "csv", "json"]);
const MAX_TEXT_BYTES = 1_000_000; // 1 MB — read client-side as text
const MAX_BINARY_MB = 20;

function fileExt(filename: string) {
  return filename.split(".").pop()?.toLowerCase() ?? "";
}

export function UploadButton({
  onStarted,
  onUploaded,
  onError,
  scope,
}: {
  onStarted?: (name: string) => void;
  onUploaded: (name: string) => void;
  onError: (message: string) => void;
  scope?: string | null;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const posthog = useAnalytics();
  const { toast } = useToast();

  // Upload a single file to the right route by type. Throws on failure so the
  // caller can record it per-file and keep going.
  async function uploadOne(file: File): Promise<void> {
    onStarted?.(file.name);
    posthog?.capture("file_upload_started", { filename: file.name, size_bytes: file.size, scope });
    const ext = fileExt(file.name);

    if (TEXT_EXTS.has(ext)) {
      // Plain text: read client-side, POST as JSON to the existing ingest route.
      if (file.size > MAX_TEXT_BYTES) throw new Error("too large for text upload (max 1 MB)");
      const content = await file.text();
      const res = await fetch("/api/memory/ingest", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content, name: file.name, source: "document", scope: scope ?? undefined }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? "upload failed");
      posthog?.capture("file_upload_completed", { filename: file.name, type: "text", scope });
      return;
    }

    // PDF / DOCX / image: send as multipart to /api/memory/upload.
    if (file.size > MAX_BINARY_MB * 1024 * 1024) throw new Error(`exceeds the ${MAX_BINARY_MB} MB limit`);
    const form = new FormData();
    form.append("file", file);
    // Carry the selected scope the same way the text branch above does (omit the
    // field entirely when unselected, don't send an empty string) — the route
    // falls back to the org root itself, but only for a genuinely absent field.
    if (scope) form.append("scope", scope);
    const res = await fetch("/api/memory/upload", { method: "POST", body: form });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error ?? "upload failed");
    posthog?.capture("file_upload_completed", { filename: file.name, type: "binary", scope });
  }

  async function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    e.target.value = "";
    if (files.length === 0) return;
    setBusy(true);
    setProgress({ done: 0, total: files.length });

    let ok = 0;
    const failed: string[] = [];
    // Sequential: keeps progress honest and stays well under the ingest rate limits.
    for (const file of files) {
      try {
        await uploadOne(file);
        onUploaded(file.name);
        ok++;
      } catch (err) {
        const msg = err instanceof Error ? err.message : "upload failed";
        onError(`"${file.name}": ${msg}`);
        failed.push(file.name);
        posthog?.capture("file_upload_failed", { filename: file.name, error: msg, scope });
      } finally {
        setProgress((p) => (p ? { ...p, done: p.done + 1 } : p));
      }
    }

    setBusy(false);
    setProgress(null);
    if (ok > 0 && failed.length === 0) {
      toast(
        files.length === 1
          ? `"${files[0].name}" queued for memory processing`
          : `${ok} files queued for memory processing`,
        "success",
      );
    } else if (ok > 0) {
      toast(`${ok} queued · ${failed.length} failed`, "error");
    } else {
      toast("Upload failed", "error");
    }
  }

  return (
    <>
      <input ref={inputRef} type="file" accept={ACCEPT} multiple onChange={onPick} className="hidden" />
      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        disabled={busy}
        title="Upload one or more PDFs, DOCX, images, or text files to memory"
        className="inline-flex min-h-11 shrink-0 items-center gap-2 rounded-xl border border-divider px-4 py-2.5 text-sm font-semibold text-fg transition-colors hover:border-accent/35 hover:bg-fg/5 disabled:opacity-40"
        aria-label="Upload files to memory"
      >
        {busy ? (
          <span className="inline-block first-letter:uppercase">
            {progress && progress.total > 1 ? `uploading ${progress.done}/${progress.total}…` : "uploading…"}
          </span>
        ) : (
          <>
            <svg
              width="15"
              height="15"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.7"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M21 12.5l-8.5 8.5a5 5 0 01-7-7l9-9a3.3 3.3 0 014.7 4.7l-9 9a1.7 1.7 0 01-2.4-2.4l8-8" />
            </svg>
            Upload
          </>
        )}
      </button>
    </>
  );
}
