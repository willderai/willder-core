import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireAccessContext } from "@/lib/access-context";
import { ORG_ADMIN_ROLES, requireOrgRole } from "@/lib/org-role";
import { unsealSecret } from "@/lib/crypto";
import { isConnectorOAuthProvider, revokeConnectorToken } from "@/services/integrations/connector-oauth";
import { isMailboxProvider, revokeMailboxGrant, unsealTokens } from "@/services/integrations/mailbox";

// DELETE /api/integrations/:id — disconnect a connection. Logical disconnect: we
// flip status to `disconnected`, drop the provider account reference (so the
// unique index frees up for a reconnect) and delete the stored tokens, rather than
// hard-deleting the row, keeping the history. The grant is also revoked upstream
// first where the provider allows it (Slack, Gmail). A failed or impossible
// upstream revoke (Outlook has no revoke endpoint) never keeps our copy of the
// token alive: the response says `providerRevoked: false` and why, so the person
// can remove the app at the provider themselves.
// Owner/admin only; tenant-scoped so you can't touch another org's row.
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const rc = await requireAccessContext();
  if (!rc) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  if (!(await requireOrgRole(rc, ORG_ADMIN_ROLES, "integrations:disconnect"))) {
    return NextResponse.json({ error: "only an org owner or admin can disconnect an integration" }, { status: 403 });
  }

  const { id } = await params;
  const integration = await db.integration.findFirst({
    where: { id, orgId: rc.org.id },
    select: { provider: true, encryptedTokens: true },
  });
  if (!integration) return NextResponse.json({ error: "integration not found" }, { status: 404 });

  const { provider, encryptedTokens } = integration;
  let providerRevoked: boolean | null = null;
  let providerRevokeError: string | undefined;
  if (encryptedTokens && (isConnectorOAuthProvider(provider) || isMailboxProvider(provider))) {
    try {
      if (isConnectorOAuthProvider(provider)) {
        await revokeConnectorToken(provider, unsealSecret(encryptedTokens));
      } else {
        await revokeMailboxGrant(provider, unsealTokens(encryptedTokens));
      }
      providerRevoked = true;
    } catch (e) {
      providerRevokeError = e instanceof Error ? e.message : "upstream revoke failed";
      console.warn(`[integrations] ${provider} upstream revoke failed:`, providerRevokeError);
      providerRevoked = false;
    }
  }

  // Scoped to this tenant again, so the write carries the same predicate as the read.
  await db.integration.updateMany({
    where: { id, orgId: rc.org.id },
    data: { status: "disconnected", externalAccountId: null, encryptedTokens: null },
  });

  return NextResponse.json({ disconnected: id, providerRevoked, ...(providerRevokeError && { providerRevokeError }) });
}
