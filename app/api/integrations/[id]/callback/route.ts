import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireAccessContext } from "@/lib/access-context";
import { ORG_ADMIN_ROLES, requireOrgRole } from "@/lib/org-role";
import { sealSecret } from "@/lib/crypto";
import {
  exchangeConnectorCode,
  isConnectorOAuthProvider,
  stateIntegrationId,
  verifyState,
  type ConnectorOAuthProvider,
} from "@/services/integrations/connector-oauth";
import { exchangeCode, isMailboxProvider, sealTokens, type MailboxProvider } from "@/services/integrations/mailbox";

// GET /api/integrations/:provider/callback — the OAuth redirect target. The
// provider sends the user's browser here with `?code&state`; we exchange the code
// for an account id + tokens, store the tokens encrypted, and flip the pending
// integration to `connected`. On a provider error we mark the row `error`.
//
// Both branches below (mailbox: gmail | outlook, and connector: slack | figma)
// resolve the pending row only through the signed-in owner/admin's own org and a
// `state` whose MAC binds the integration id, org, provider and expiry
// (signState / verifyState in services/integrations/connector-oauth.ts). A
// callback that fails those checks changes nothing, so a forged, expired or
// cross-org request cannot attach a token to, or mark errored, another org's row.
//
// In mock mode the connect route's authorize URL points the browser straight here
// with a fake code and the same signed state, so the whole flow, verification
// included, runs with no real provider / public URL.
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id: provider } = await params;
  if (isConnectorOAuthProvider(provider)) return connectorCallback(req, provider);
  if (isMailboxProvider(provider)) return mailboxCallback(req, provider);
  return NextResponse.json({ error: `unsupported provider '${provider}'` }, { status: 400 });
}

function redirectToInbox(connected: boolean) {
  const base = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, "") || "http://localhost:3000";
  return NextResponse.redirect(`${base}/inbox?connected=${connected ? 1 : 0}`);
}

async function mailboxCallback(req: Request, provider: MailboxProvider) {
  const rc = await requireAccessContext();
  if (!rc) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!(await requireOrgRole(rc, ORG_ADMIN_ROLES, "integrations:mailbox-callback"))) {
    return NextResponse.json({ error: "only an org owner or admin can connect a mailbox" }, { status: 403 });
  }
  const orgId = rc.org.id;

  const url = new URL(req.url);
  const state = url.searchParams.get("state") ?? "";
  const code = url.searchParams.get("code");
  const oauthError = url.searchParams.get("error");

  const integrationId = stateIntegrationId(state);
  const pending = integrationId
    ? await db.integration.findFirst({
        where: { id: integrationId, orgId, provider, status: "pending" },
        select: { id: true },
      })
    : null;
  if (!pending || !verifyState(state, { integrationId: pending.id, orgId, provider })) {
    return NextResponse.json(
      { error: "invalid or expired connect attempt; start again from the inbox" },
      { status: 400 },
    );
  }

  // User declined / provider error → mark the pending row errored, then bounce back.
  if (oauthError || !code) {
    await db.integration.updateMany({
      where: { id: pending.id, orgId, status: "pending" },
      data: { status: "error", meta: { error: oauthError ?? "no authorization code" } },
    });
    return redirectToInbox(false);
  }

  try {
    const account = await exchangeCode({ provider, code });
    const sealed = sealTokens(account.tokens);

    await db.$transaction(async (tx) => {
      // Reconnecting the same mailbox replaces its earlier row, keeping the
      // (org, provider, account) unique index satisfied. A different mailbox of
      // the same provider is its own connection and is left alone.
      await tx.integration.deleteMany({
        where: { orgId, provider, externalAccountId: account.accountId, id: { not: pending.id } },
      });
      const { count } = await tx.integration.updateMany({
        where: { id: pending.id, orgId, status: "pending" },
        data: {
          status: "connected",
          externalAccountId: account.accountId,
          encryptedTokens: sealed,
          meta: account.email ? { email: account.email } : {},
        },
      });
      // A concurrent callback already completed (or failed) this attempt.
      if (count === 0) throw new Error("connect attempt is no longer pending");
    });

    return redirectToInbox(true);
  } catch (e) {
    console.error("[callback] exchange failed:", e instanceof Error ? e.message : e);
    await db.integration
      .updateMany({
        where: { id: pending.id, orgId, status: "pending" },
        data: { status: "error", meta: { error: e instanceof Error ? e.message : "exchange failed" } },
      })
      .catch(() => {});
    return redirectToInbox(false);
  }
}

// Slack / Figma.
function redirectToIntegrations(provider: ConnectorOAuthProvider, connected: boolean) {
  const base = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, "") || "http://localhost:3000";
  return NextResponse.redirect(`${base}/integrations?integration=${provider}&connected=${connected ? 1 : 0}`);
}

async function connectorCallback(req: Request, provider: ConnectorOAuthProvider) {
  const rc = await requireAccessContext();
  if (!rc) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!(await requireOrgRole(rc, ORG_ADMIN_ROLES, "integrations:connector-callback"))) {
    return NextResponse.json({ error: "only an org owner or admin can connect an integration" }, { status: 403 });
  }
  const orgId = rc.org.id;

  const url = new URL(req.url);
  const state = url.searchParams.get("state") ?? "";
  const code = url.searchParams.get("code");
  const oauthError = url.searchParams.get("error");

  const integrationId = stateIntegrationId(state);
  const pending = integrationId
    ? await db.integration.findFirst({
        where: { id: integrationId, orgId, provider, status: "pending" },
        select: { id: true },
      })
    : null;
  if (!pending || !verifyState(state, { integrationId: pending.id, orgId, provider })) {
    return NextResponse.json(
      { error: "invalid or expired connect attempt; start again from Integrations" },
      { status: 400 },
    );
  }

  if (oauthError || !code) {
    await db.integration.updateMany({
      where: { id: pending.id, orgId, status: "pending" },
      data: { status: "error", meta: { error: oauthError ?? "no authorization code" } },
    });
    return redirectToIntegrations(provider, false);
  }

  try {
    const account = await exchangeConnectorCode(provider, code);
    const encryptedTokens = account.tokens ? sealSecret(account.tokens) : null;
    await db.$transaction(async (tx) => {
      // Reconnecting the same account replaces its earlier row, keeping the
      // (org, provider, account) unique index satisfied.
      await tx.integration.deleteMany({
        where: { orgId, provider, externalAccountId: account.accountId, id: { not: pending.id } },
      });
      const { count } = await tx.integration.updateMany({
        where: { id: pending.id, orgId, status: "pending" },
        data: { status: "connected", externalAccountId: account.accountId, encryptedTokens, meta: account.meta },
      });
      // A concurrent callback already completed (or failed) this attempt.
      if (count === 0) throw new Error("connect attempt is no longer pending");
    });
    return redirectToIntegrations(provider, true);
  } catch (e) {
    console.error(`[callback] ${provider} connect failed:`, e instanceof Error ? e.message : e);
    await db.integration
      .updateMany({
        where: { id: pending.id, orgId, status: "pending" },
        data: { status: "error", meta: { error: e instanceof Error ? e.message : "exchange failed" } },
      })
      .catch(() => {});
    return redirectToIntegrations(provider, false);
  }
}
