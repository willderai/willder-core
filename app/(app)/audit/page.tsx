"use client";

import { Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { PageHeader, Tabs } from "@/components/ui";
import { Reveal } from "@/components/reveal";
import { ScopePicker } from "@/components/memory/scope-picker";
import { AuditLog } from "@/components/audit/audit-log";
import { AuditTimeline } from "@/components/audit/timeline";
import { AuditExport } from "@/components/audit/audit-export";
import { SessionStarts } from "@/components/audit/session-starts";
import { useUrlParam } from "@/components/memory/store-list-tab";

const VIEWS = [
  { key: "table", label: "Access log" },
  { key: "timeline", label: "Timeline" },
  { key: "sessions", label: "Session starts" },
];

export default function AuditPage() {
  return (
    <Suspense
      fallback={
        <div role="status" className="mx-auto max-w-6xl px-5 py-12 text-sm text-fg-muted sm:px-8">
          Loading access and activity…
        </div>
      }
    >
      <AuditPageContent />
    </Suspense>
  );
}

function AuditPageContent() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const requested = searchParams.get("view");
  const view = requested === "timeline" || requested === "sessions" ? requested : "table";
  const scope = searchParams.get("scope") || null;
  // The change whose detail is open: in the address, so a link to one change can be handed on.
  const change = searchParams.get("change") || null;
  const [, setLogPage] = useUrlParam("page", "replace");
  const [, setSessionsPage] = useUrlParam("sessions.page", "replace");

  function updateFilter(key: "view" | "scope" | "change", value: string | null) {
    const params = new URLSearchParams(searchParams.toString());
    if (value) params.set(key, value);
    else params.delete(key);
    // A new scope is a new list: the access log and session starts open on page 1. Their
    // pages leave the address bar now, not when the router catches up, because the lists
    // remount for the new scope first and read their page from it.
    if (key === "scope") {
      setLogPage(null);
      setSessionsPage(null);
      params.delete("page");
      params.delete("sessions.page");
    }
    const query = params.toString();
    router.replace(`/audit${query ? `?${query}` : ""}`, { scroll: false });
  }

  return (
    <div className="mx-auto max-w-6xl px-5 py-8 sm:px-8 sm:py-12">
      <Reveal>
        <PageHeader eyebrow="Observability" title="Access & activity">
          Inspect access decisions, follow recorded memory changes, and see what agents started with.
        </PageHeader>
      </Reveal>
      <Reveal delay={0.08}>
        <div className="mt-6 flex flex-col gap-4 sm:mt-8 sm:gap-6">
          <div className="flex flex-wrap items-center justify-between gap-3 sm:gap-4">
            <Tabs items={VIEWS} value={view} onChange={(key) => updateFilter("view", key)} />
            <ScopePicker selected={scope} onChange={(value) => updateFilter("scope", value)} />
          </div>
          {view === "timeline" ? (
            <AuditTimeline
              key={scope ?? ""}
              scope={scope}
              selected={change}
              onSelect={(id) => updateFilter("change", id)}
            />
          ) : view === "sessions" ? (
            <SessionStarts key={scope ?? ""} scope={scope} />
          ) : (
            <AuditLog key={scope ?? ""} scope={scope} />
          )}
          <AuditExport />
        </div>
      </Reveal>
    </div>
  );
}
