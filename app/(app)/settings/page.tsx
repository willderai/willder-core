import Link from "next/link";
import { auth } from "@clerk/nextjs/server";
import { CreateOrganization } from "@clerk/nextjs";
import { requireAccessContext } from "@/lib/access-context";
import { pagePermissions } from "@/lib/page-permissions";
import { PageHeader } from "@/components/ui";
import { LegacySettingsRedirect } from "@/components/settings/legacy-settings-redirect";
import { OrgPanel } from "@/components/settings/org-panel";
import { AliasesPanel } from "@/components/settings/aliases-panel";
import { OrgRolesPanel } from "@/components/settings/org-roles-panel";

const LINK = "font-semibold text-info underline-offset-2 hover:underline";

// Settings: the organization itself. Create the workspace if there isn't one yet,
// otherwise manage its members, invitations and roles (Clerk's OrganizationProfile),
// its org roles and its entity aliases. When an org is active requireAccessContext
// syncs it into Postgres (ensureTenant) so the rest of the app has a tenant to scope
// against.
//
// Everything that connects to Willder (sources, connectors, mailboxes, Connect your AI,
// Connected apps) is on /integrations, and the memory chat name is on /memory/ask, next
// to the chat it names. An old Settings link to any of them is forwarded there
// (components/settings/legacy-settings-redirect.tsx).
//
// Org roles and aliases list through admin-only routes that also ask check() to read the
// org root, so they mount only for an org owner or admin it allows (lib/page-permissions.ts);
// anyone else's visit asks for neither and leaves no denial on the audit trail.
export default async function SettingsPage() {
  const { orgId } = await auth();
  const rc = orgId ? await requireAccessContext() : null;
  const orgAdmin = rc ? (await pagePermissions(rc)).orgAdmin : false;

  const hasOrg = Boolean(orgId);

  return (
    <div className="mx-auto max-w-6xl px-5 py-8 sm:px-8 sm:py-12">
      <PageHeader eyebrow="Settings" title="Organization">
        {hasOrg ? (
          <>
            Your workspace, its members and roles, and the names memory resolves. Sources and your AI&apos;s tokens are
            on{" "}
            <Link href="/integrations" className={LINK}>
              Integrations
            </Link>
            ; the memory chat name is on{" "}
            <Link href="/memory/ask#memory-chat" className={LINK}>
              Ask
            </Link>
            .
          </>
        ) : (
          "Create your workspace to start. You can invite people next."
        )}
      </PageHeader>

      <div className="mt-6 sm:mt-8">
        {hasOrg ? (
          <div className="flex flex-col gap-6 sm:gap-8">
            <LegacySettingsRedirect />
            <OrgPanel />
            {orgAdmin && (
              <>
                <section id="org-roles" className="scroll-mt-24" aria-label="Org roles">
                  <OrgRolesPanel />
                </section>
                <section id="aliases" className="scroll-mt-24" aria-label="Entity aliases">
                  <AliasesPanel />
                </section>
              </>
            )}
          </div>
        ) : (
          <div className="flex justify-center">
            <CreateOrganization routing="hash" afterCreateOrganizationUrl="/settings" skipInvitationScreen={false} />
          </div>
        )}
      </div>
    </div>
  );
}
