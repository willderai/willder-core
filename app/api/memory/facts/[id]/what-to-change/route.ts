// GET /api/memory/facts/:id/what-to-change?scope=<path>: the records a change to this
// record invalidates, nearest first, each with the relations that lead to it:
// { scope, recordId, items, truncated }. One memory.read decision on the scope, inside
// whatToChange(); only relations recorded inside the scope are walked.
import { whatToChange } from "@/services/memory/dependencies";
import { readAtScope } from "../../../dependency-scope";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return readAtScope(req, async (ctx, scopePath) => ({ recordId: id, ...(await whatToChange(ctx, id, scopePath)) }));
}
