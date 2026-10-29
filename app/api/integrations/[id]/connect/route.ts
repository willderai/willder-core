import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireAccessContext } from "@/lib/access-context";
import { ORG_ADMIN_ROLES, requireOrgRole } from "@/lib/org-role";
import { createAuthLink, isMailboxProvider, type MailboxProvider } from "@/services/integrations/mailbox";
import {
  ConnectorOAuthConfigError,
  assertConnectorOAuthConfigured,
  buildAuthorizeUrl,
  isConnectorOAuthProvider,
  signState,
  type ConnectorOAuthProvider,
} from "@/services/integrations/connector-oauth";

// POST /api/integrations/:provider/connect — start connecting an org account via
// the provider's OAuth. Creates a `pending` integration row, then returns the
// provider authorize URL the user is redirected to; the OAuth callback
// (/api/integrations/:provider/callback) exchanges the code and flips the row to
// `connected`.
//
//   gmail | outlook  a customer mailbox we send from (services/integrations/mailbox.ts)
//   slack | figma    a read-only knowledge-source account (services/integrations/connector-oauth.ts)
//
// Connecting either kind hands Willder a credential for the customer's account, so
// it is restricted to org owners/admins. Tenant comes from the auth context.
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const rc = await requireAccessContext();
  if (!rc) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  if (!(await requireOrgRole(rc, ORG_ADMIN_ROLES, "integrations:connect"))) {
    return NextResponse.json({ error: "only an org owner or admin can connect an integration" }, { status: 403 });
  }

  const { id: provider } = await params;
  if (isMailboxProvider(provider)) return connectMailbox(rc.org.id, provider);
  if (isConnectorOAuthProvider(provider)) return connectConnector(rc.org.id, provider);
  return NextResponse.json(
    { error: `unsupported provider '${provider}' (supported: gmail, outlook, slack, figma)` },
    { status: 400 },
  );
}

async function connectMailbox(orgId: string, provider: MailboxProvider) {
  // A fresh pending row per connect attempt. NULL externalAccountId keeps the
  // (org, provider, account) unique index from colliding across pending rows.
  const integration = await db.integration.create({
    data: { orgId, provider, status: "pending" },
    select: { id: true, provider: true, status: true, createdAt: true },
  });

  try {
    // The callback accepts only this state, for this row, in this org.
    const { state, expiresAt } = signState({ integrationId: integration.id, orgId, provider });
    return NextResponse.json(
      { integration, authUrl: createAuthLink({ provider, state }), expiresAt: expiresAt.toISOString() },
      { status: 201 },
    );
  } catch (e) {
    // Couldn't mint the link — mark the row errored so it doesn't dangle as pending.
    await db.integration.update({ where: { id: integration.id }, data: { status: "error" } });
    return NextResponse.json({ error: e instanceof Error ? e.message : "failed to start connect" }, { status: 502 });
  }
}

async function connectConnector(orgId: string, provider: ConnectorOAuthProvider) {
  // Refuse before creating a row when the server can't finish the flow anyway.
  try {
    assertConnectorOAuthConfigured(provider);
  } catch (e) {
    if (e instanceof ConnectorOAuthConfigError) {
      return NextResponse.json({ error: e.message }, { status: 503 });
    }
    throw e;
  }

  const integration = await db.integration.create({
    data: { orgId, provider, status: "pending" },
    select: { id: true, provider: true, status: true, createdAt: true },
  });
  const { state, expiresAt } = signState({ integrationId: integration.id, orgId, provider });
  return NextResponse.json(
    { integration, authUrl: buildAuthorizeUrl(provider, state), expiresAt: expiresAt.toISOString() },
    { status: 201 },
  );
}
