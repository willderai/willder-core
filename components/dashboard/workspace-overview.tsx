import Link from "next/link";
import { ArrowRight, History, Link2, Search, ShieldCheck } from "lucide-react";
import { FirstRunChecklist } from "@/components/onboarding/first-run-checklist";

const FIRST_STEPS = [
  { title: "Connect a source", detail: "Bring in one useful document.", href: "/integrations#sources" },
  { title: "Choose access", detail: "Review who can read and write.", href: "/access" },
  { title: "Inspect an answer", detail: "Ask, then check its context.", href: "/memory" },
  { title: "Connect your agent", detail: "Use memory in your own tools.", href: "/integrations#connect-ai" },
];

const WORKSPACE_ACTIONS = [
  {
    label: "Retrieval",
    title: "See what shaped an answer.",
    description: "Inspect retrieved facts, source references, and the scope used for a search.",
    action: "Ask and inspect",
    href: "/memory",
    icon: Search,
  },
  {
    label: "Updates",
    title: "Follow what changed.",
    description: "Review recorded memory changes and check which scope each change belongs to.",
    action: "Open change history",
    href: "/audit?view=timeline",
    icon: History,
  },
  {
    label: "Sources",
    title: "Trace knowledge to its source.",
    description: "Review connected sources, their destination scopes, and the latest sync attempt.",
    action: "Manage sources",
    href: "/integrations#sources",
    icon: Link2,
  },
  {
    label: "Permissions",
    title: "Decide who gets access.",
    description: "Manage grants for people and agents. Inspect allowed and denied requests in the access log.",
    action: "Review access",
    href: "/access",
    icon: ShieldCheck,
  },
];

/**
 * @param canManageAccess whether the server allows this person `access.manage`, the
 * check behind the checklist's route; anyone else gets the suggested path and no request.
 */
export function WorkspaceOverview({ canManageAccess }: { canManageAccess: boolean }) {
  return (
    <div className="mt-8 space-y-8">
      {canManageAccess ? <FirstRunChecklist fallback={<SuggestedPath />} /> : <SuggestedPath />}

      <section aria-labelledby="workspace-actions-title">
        <div className="mb-4 flex flex-col gap-1 sm:flex-row sm:items-baseline sm:justify-between">
          <h2 id="workspace-actions-title" className="text-base font-semibold text-fg">
            Your memory, in view
          </h2>
          <Link
            href="/audit"
            className="inline-flex min-h-11 items-center gap-2 text-sm text-fg-muted transition-colors hover:text-info"
          >
            View access decisions <ArrowRight size={14} aria-hidden="true" />
          </Link>
        </div>
        <div className="grid gap-4 lg:grid-cols-2">
          {WORKSPACE_ACTIONS.map(({ label, title, description, action, href, icon: Icon }) => (
            <Link
              key={label}
              href={href}
              className="group flex flex-col rounded-2xl border border-divider bg-panel p-6 transition-colors hover:border-info/40 sm:p-7"
            >
              <div className="mb-4 flex items-center gap-2.5 text-info">
                <Icon size={17} strokeWidth={1.5} aria-hidden="true" />
                <span className="text-eyebrow font-semibold uppercase">{label}</span>
              </div>
              <h3 className="font-display text-2xl font-medium leading-tight text-fg">{title}</h3>
              <p className="mb-5 mt-2 max-w-md text-sm leading-relaxed text-fg-muted">{description}</p>
              <span className="mt-auto inline-flex items-center gap-2 text-sm font-semibold text-info">
                {action}
                <ArrowRight
                  size={15}
                  className="transition-transform motion-safe:group-hover:translate-x-0.5"
                  aria-hidden="true"
                />
              </span>
            </Link>
          ))}
        </div>
      </section>
    </div>
  );
}

/** The suggested first steps, for a person who cannot see the org-wide checklist. */
function SuggestedPath() {
  return (
    <section
      aria-labelledby="first-workflow-title"
      className="rounded-2xl border border-info/25 bg-info/[0.04] p-5 sm:p-6"
    >
      <div className="mb-5 flex flex-col gap-2 lg:flex-row lg:items-baseline lg:justify-between">
        <h2 id="first-workflow-title" className="font-display text-2xl font-semibold text-fg">
          Start with one source.
        </h2>
        <p className="text-sm text-fg-muted">A simple path to your first useful answer.</p>
      </div>
      <ol className="grid gap-1 sm:grid-cols-2 xl:grid-cols-4">
        {FIRST_STEPS.map((step, index) => (
          <li key={step.title}>
            <Link
              href={step.href}
              className="group flex h-full items-start gap-3 rounded-xl px-3 py-4 transition-colors hover:bg-info/[0.07]"
            >
              <span className="mt-px text-sm font-semibold tabular-nums text-fg-muted" aria-hidden="true">
                {String(index + 1).padStart(2, "0")}
              </span>
              <div className="min-w-0 flex-1">
                <span className="flex items-center gap-2 text-sm font-semibold text-fg">
                  {step.title}
                  <ArrowRight
                    size={13}
                    className="shrink-0 text-info transition-transform motion-safe:group-hover:translate-x-0.5"
                    aria-hidden="true"
                  />
                </span>
                <p className="mt-1 text-sm leading-relaxed text-fg-muted">{step.detail}</p>
              </div>
            </Link>
          </li>
        ))}
      </ol>
    </section>
  );
}
