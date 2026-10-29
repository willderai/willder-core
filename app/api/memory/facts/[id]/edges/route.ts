// GET /api/memory/facts/:id/edges?scope=<path>: every dependency-graph relation touching
// one record inside the scope: { scope, outgoing, incoming, truncated }. One memory.read
// decision on the scope, inside edgesOf().
import { edgesOf } from "@/services/memory/dependencies";
import { readAtScope } from "../../../dependency-scope";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return readAtScope(req, async (ctx, scopePath) => ({ recordId: id, ...(await edgesOf(ctx, id, scopePath)) }));
}
