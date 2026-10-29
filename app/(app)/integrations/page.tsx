import Link from "next/link";
import { auth } from "@clerk/nextjs/server";
import { requireAccessContext } from "@/lib/access-context";
import { pagePermissions } from "@/lib/page-permissions";
import { PageHeader } from "@/components/ui";
import { AdminOnly } from "@/components/settings/admin-only";
import { SourcesPanel } from "@/components/settings/sources-panel";
import { ConnectorsPanel } from "@/components/settings/connectors-panel";
import { IntegrationsPanel } from "@/components/settings/integrations-panel";
import { McpPanel } from "@/components/settings/mcp-panel";
import { ConnectedAppsPanel } from "@/components/settings/connected-apps-panel";
import { IntegrationsTabs, type IntegrationsTab } from "@/components/settings/integrations-tabs";
import { mcpOAuthEnabled } from "@/mcp/oauth-discovery";

// Integrations: everything that connects to Willder, one tab each. Knowledge sources
// (Drive, GitHub), Connectors (Slack, Figma, PostHog) and Mailboxes (Gmail, Outlook)
// bring knowledge in; Connect your AI (the tokens an MCP client connects with) and
// Connected apps (OAuth) read and write it. Settings keeps the organization itself. Each
// tab opens on the anchor its panel had on Settings, so a link Settings forwards here
// (components/settings/legacy-settings-redirect.tsx) lands on the same panel; the tabs
// themselves are components/settings/integrations-tabs.tsx.
//
// Who sees what is decided on the server (lib/page-permissions.ts). A panel mounts only
// for someone its route would allow, so a member's visit leaves no denial on the audit
// trail for a request they never made; anyone else sees who to ask instead.
// - The source panels need memory.write on the org root.
// - Connect your AI lists and issues tokens, which needs access.manage on the org root.
// - Mailboxes mount for every member.
// - Connected apps lists the person's own OAuth connections, so it has a tab for everyone
//   once MCP_OAUTH_ENABLED is on, and none before.
export default async function IntegrationsPage() {
  const { orgId } = await auth();
  const rc = orgId ? await requireAccessContext() : null;
  if (!rc) return <NoWorkspace />;

  const allowed = await pagePermissions(rc);
  const oauthEnabled = mcpOAuthEnabled();

  // The connectors panel renders nothing while connectors are switched off, so it gets no tab then.
  const connectorsTab = allowed.writeMemory && process.env.NEXT_PUBLIC_CONNECTORS_ENABLED === "true";
  // Without a Connectors tab (switched off, or not this person's to use), a link to it
  // opens the sources tab, which says what is available instead.
  const sourceAliases = connectorsTab ? undefined : ["connectors"];

  const tabs: IntegrationsTab[] = [
    allowed.writeMemory
      ? { id: "sources", label: "Knowledge sources", aliases: sourceAliases, panel: <SourcesPanel /> }
      : {
          id: "sources",
          label: "Sources and connectors",
          aliases: sourceAliases,
          panel: (
            <AdminOnly title="Knowledge sources and connectors">
              Adding and syncing sources needs write access to the whole organization. Ask an admin to connect one.
            </AdminOnly>
          ),
        },
    ...(connectorsTab ? [{ id: "connectors", label: "Connectors", panel: <ConnectorsPanel /> }] : []),
    { id: "mailboxes", label: "Mailboxes", panel: <IntegrationsPanel /> },
    {
      id: "connect-ai",
      label: "Connect your AI",
      panel: allowed.manageAccess ? (
        <McpPanel />
      ) : (
        <AdminOnly title="Connect your AI">
          Your AI connects with a token that only an admin of this organization can issue. Ask one for a token.
        </AdminOnly>
      ),
    },
    ...(oauthEnabled ? [{ id: "connected-apps", label: "Connected apps", panel: <ConnectedAppsPanel /> }] : []),
  ];

  return (
    <div className="mx-auto max-w-6xl px-5 py-8 sm:px-8 sm:py-12">
      <PageHeader eyebrow="Integrations" title="What connects to Willder">
        The tools your knowledge comes from, and the AI that reads and writes it. Each reaches only what your access
        rules allow.
      </PageHeader>

      <IntegrationsTabs tabs={tabs} className="mt-6 sm:mt-8" />
    </div>
  );
}

function NoWorkspace() {
  return (
    <div className="mx-auto max-w-6xl px-5 py-8 sm:px-8 sm:py-12">
      <PageHeader eyebrow="Integrations" title="What connects to Willder">
        Integrations belong to a workspace.{" "}
        <Link href="/settings" className="font-semibold text-info underline-offset-2 hover:underline">
          Create your workspace
        </Link>{" "}
        first, then connect a source or your AI here.
      </PageHeader>
    </div>
  );
}
