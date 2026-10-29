// POST /api/memory/conventions/[id]/confirm: the signed-in person confirms a rule an agent
// recorded, so it is served as settled instead of as a lead to verify. Their own version of
// the same rule replaces the agent's (services/memory/conventions.ts `confirmConvention`).
//
// Agents never reach this route: requireAccessContext resolves only a signed-in person, and
// a capability token is not a session. That is the point of a confirmation: an agent can
// propose a decision, and only a person can make it a standing rule.
import { NextResponse } from "next/server";
import { requireAccessContext } from "@/lib/access-context";
import { AccessDeniedError } from "@/services/access";
import { confirmConvention } from "@/services/memory/conventions";

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const rc = await requireAccessContext();
  if (!rc) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { id } = await params;
  try {
    const result = await confirmConvention(rc.ctx, id);
    switch (result.status) {
      case "confirmed":
        return NextResponse.json({ confirmed: result.id, replaced: result.replaced });
      case "alreadyConfirmed":
        return NextResponse.json({ confirmed: result.id, alreadyConfirmed: true });
      case "notInForce":
        return NextResponse.json(
          {
            error:
              "This rule was replaced or retired, so there is nothing to confirm. Open the current version in Memory, Explore, Rules and decisions.",
          },
          { status: 409 },
        );
      case "missing":
        return NextResponse.json({ error: "convention not found" }, { status: 404 });
    }
  } catch (e) {
    if (e instanceof AccessDeniedError) {
      return NextResponse.json({ error: e.decision.reason }, { status: 403 });
    }
    throw e;
  }
}
