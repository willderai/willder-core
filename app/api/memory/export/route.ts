// GET /api/memory/export: the signed-in person's export of this org's memory, as one
// JSON Lines file (docs/export-format.md). services/memory/org-export.ts decides what it
// holds: everything for an admin, the readable scopes for a member. The file is streamed
// as it is read, so a large org never sits in memory here.
import { NextResponse } from "next/server";
import { requireAccessContext } from "@/lib/access-context";
import { AccessDeniedError } from "@/services/access";
import { exportMemory } from "@/services/memory/org-export";

export async function GET() {
  const rc = await requireAccessContext();
  if (!rc) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const lines = exportMemory(rc.ctx);
  // The first line is read before answering, so a refusal is a 403, not a broken download.
  let first: IteratorResult<string>;
  try {
    first = await lines.next();
  } catch (error) {
    if (error instanceof AccessDeniedError) return NextResponse.json({ error: error.message }, { status: 403 });
    throw error;
  }

  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      if (!first.done) controller.enqueue(encoder.encode(first.value));
    },
    async pull(controller) {
      const next = await lines.next();
      if (next.done) controller.close();
      else controller.enqueue(encoder.encode(next.value));
    },
    async cancel() {
      await lines.return(undefined);
    },
  });
  const date = new Date().toISOString().slice(0, 10);
  return new Response(body, {
    headers: {
      "content-type": "application/x-ndjson; charset=utf-8",
      "content-disposition": `attachment; filename="willder-export-${date}.jsonl"`,
      "cache-control": "no-store",
    },
  });
}
