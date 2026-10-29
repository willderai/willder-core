// POST /api/agents/attachments/extract — small helper for PER-RUN, EPHEMERAL agent
// attachments (docs/design_per_run_attachments.md, the MVV). Extracts a doc's text so
// the client can pass it into an interactive run's start body as reference context.
//
// This deliberately does NOT ingest into memory (no Graphiti, no pgvector, no scope
// fact). It reuses the existing memory-service extraction (extractBytes, the same path
// app/api/memory/upload uses) and returns the plain text; the run stashes it on its meta
// and injects it into the agent's reasoning for that one run only.
//
// Accepts multipart/form-data with a single "file" field. Returns { name, content }.
import { NextResponse } from "next/server";
import { requireAccessContext } from "@/lib/access-context";
import { check } from "@/services/access";
import { isRateLimited, per } from "@/lib/rate-limit";
import { graphitiStore } from "@/services/memory";
import { sanitizeForLLM, LIMITS } from "@/lib/sanitize";

// Same surface as the memory upload route: binary types go through extraction, plain
// text is decoded directly.
const BINARY_TYPE_MAP: Record<string, "pdf" | "docx" | "image"> = {
  pdf: "pdf",
  docx: "docx",
  doc: "docx",
  jpg: "image",
  jpeg: "image",
  png: "image",
  webp: "image",
  gif: "image",
};
const TEXT_EXTS = new Set(["txt", "md", "markdown", "csv", "json"]);
const MAX_BYTES = 20 * 1024 * 1024; // ~20 MB, same ceiling as /api/memory/upload

export async function POST(req: Request) {
  const rc = await requireAccessContext();
  if (!rc) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  // Attaching reference material is a write-shaped action (it consumes extraction
  // budget), so reuse the existing memory.write gate rather than inventing a permission.
  if (isRateLimited(`agent:attach:${rc.org.id}`, 30, per.hour)) {
    return NextResponse.json({ error: "rate limit exceeded" }, { status: 429 });
  }
  const decision = await check(rc.ctx, { action: "memory.write", target: "attachment" });
  if (!decision.allowed) return NextResponse.json({ error: decision.reason }, { status: 403 });

  let formData: FormData;
  try {
    formData = await req.formData();
  } catch {
    return NextResponse.json({ error: "expected multipart/form-data" }, { status: 400 });
  }

  const file = formData.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "file field is required" }, { status: 400 });
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json({ error: "file exceeds the 20 MB limit" }, { status: 400 });
  }

  const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
  const binaryType = BINARY_TYPE_MAP[ext];
  if (!binaryType && !TEXT_EXTS.has(ext)) {
    return NextResponse.json({ error: `unsupported file type: .${ext}` }, { status: 400 });
  }

  let raw: string;
  try {
    if (binaryType) {
      const buffer = Buffer.from(await file.arrayBuffer());
      const contentB64 = buffer.toString("base64");
      // extractBytes lives on GraphitiMemoryStore, not on `memory` (the HybridMemoryStore
      // facade) -- same item-67 interface mismatch as app/api/memory/upload/route.ts.
      const { chunks } = await graphitiStore.extractBytes({
        contentB64,
        fileType: binaryType,
        filename: file.name,
      });
      raw = (chunks as string[]).join("\n\n");
    } else {
      raw = await file.text();
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : "extraction failed";
    return NextResponse.json({ error: msg }, { status: 502 });
  }

  // Attachments are attacker-influenced text going straight into an LLM's reasoning, so
  // screen for injection before it can be attached (stronger than the durable upload path).
  const { safe, injectionDetected } = sanitizeForLLM(raw, LIMITS.memoryContent);
  if (injectionDetected) {
    return NextResponse.json(
      { error: "the document contains content that can't be used as agent context" },
      { status: 422 },
    );
  }
  if (!safe.trim()) {
    return NextResponse.json({ error: "no text could be extracted from this file" }, { status: 422 });
  }

  return NextResponse.json({ name: file.name, content: safe }, { status: 200 });
}
