// Export a Brief to a native Google Doc. Reuses the existing `drive.file` OAuth
// model exactly as services/connectors/gdrive.ts already authenticates: a
// short-lived Drive access token supplied per-request by the client (the same
// model app/api/sources/route.ts uses for gdrive — this repo has no stored
// refresh-token flow for Drive, so there is no second OAuth path to build here,
// just this one call site). Tenant-scoped read, same pattern as GET
// /api/briefs/[id].
import { db } from "@/lib/db";
import { requireAccessContext } from "@/lib/access-context";
import { briefNotFound } from "@/lib/brief-access";
import { createGoogleDoc } from "@/services/connectors/gdrive";
import { authorizeBrief, recordBriefExport } from "@/services/memory/briefs";

function buildDocContent(brief: { title: string; summary: string; sections: unknown }): string {
  const sections = Array.isArray(brief.sections)
    ? (brief.sections as { heading: string; content: string }[]).map((s) => `${s.heading}\n\n${s.content}`).join("\n\n")
    : "";
  return `${brief.title}\n\n${brief.summary}\n\n${sections}`;
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const rc = await requireAccessContext();
  if (!rc) return Response.json({ error: "unauthorized" }, { status: 401 });

  const { id } = await params;
  // Exporting copies the brief's full content out of Willder, so it is a read
  // of the brief's scope and gated like GET /api/briefs/:id.
  const access = await authorizeBrief(rc.ctx, id, { action: "memory.read" });
  if (access.status !== "allowed") return briefNotFound();
  const { brief } = access;

  const source = await db.source.findFirst({
    where: { orgId: rc.org.id, type: "gdrive" },
    select: { id: true },
  });
  if (!source) {
    return Response.json(
      { error: "no Drive integration connected for this org — connect Drive under Sources first" },
      { status: 400 },
    );
  }

  const body = (await req.json().catch(() => ({}))) as { token?: string };
  if (!body.token) {
    return Response.json({ error: "a Drive access token is required (token)" }, { status: 400 });
  }

  const doc = await createGoogleDoc(brief.title, buildDocContent(brief), body.token);

  await recordBriefExport(access, doc.url);

  return Response.json({ googleDocUrl: doc.url });
}
