import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { requireAccessContext } from "@/lib/access-context";
import { pagePermissions } from "@/lib/page-permissions";
import { WorkspaceOverview } from "@/components/dashboard/workspace-overview";
import { PageHeader } from "@/components/ui";

// Keep the landing page light: the linked surfaces own their live data and access
// checks. The first-run checklist marks a step done only from the org's own records
// (GET /api/onboarding/first-run), which only an access manager may read. Whether this
// person is one is probed here with can(), which audits nothing, so a member gets the
// suggested path without a refused request landing on the audit trail.
export default async function DashboardPage() {
  const ctx = await requireAccessContext();
  const canManageAccess = ctx ? (await pagePermissions(ctx)).manageAccess : false;

  return (
    <div className="mx-auto max-w-6xl px-5 py-8 sm:px-8 sm:py-12">
      <PageHeader
        eyebrow="Overview"
        title="One memory. Clear boundaries."
        actions={
          ctx && (
            <Link
              href="/memory"
              className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl bg-action px-5 py-3 text-sm font-semibold text-action-foreground transition-opacity hover:opacity-90"
            >
              Ask your memory <ArrowRight size={16} aria-hidden="true" />
            </Link>
          )
        }
      >
        Bring your sources into one memory, choose which agents and people can use each part, and inspect the context
        behind each answer.
      </PageHeader>

      {ctx ? (
        <WorkspaceOverview canManageAccess={canManageAccess} />
      ) : (
        <section className="mt-8 rounded-2xl border border-divider bg-panel px-6 py-8 sm:px-8">
          <h2 className="font-display text-2xl font-semibold text-fg">One memory for your agents.</h2>
          <p className="mt-3 max-w-xl text-sm leading-relaxed text-fg-muted">
            Create or select an organization to connect your first source and decide who can access it.
          </p>
          <Link
            href="/settings"
            className="mt-5 inline-flex min-h-11 items-center gap-2 text-sm font-semibold text-info"
          >
            Set up your workspace <ArrowRight size={16} aria-hidden="true" />
          </Link>
        </section>
      )}
    </div>
  );
}
