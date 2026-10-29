"use client";

import { ChevronDown, Fingerprint, Link2, ShieldCheck } from "lucide-react";
import type { MemoryFact } from "@/types/memory";
import { displayWriterLabel } from "@/components/audit/format";

const ACTOR_LABELS = {
  human: "Human assertion",
  agent: "Agent assertion",
  extraction: "Extracted from a source",
} as const;

/** Describe only the provenance returned with a fact, never inferred freshness. */
export function FactProvenance({ fact, scope }: { fact: MemoryFact; scope: string | null }) {
  const timestamp = fact.validAt ? new Date(fact.validAt) : null;
  const hasTimestamp = timestamp !== null && !Number.isNaN(timestamp.getTime());

  return (
    <details className="group/provenance mt-3">
      <summary className="flex min-h-9 cursor-pointer list-none items-center gap-2 rounded-md text-sm text-fg-muted transition-colors hover:text-fg [&::-webkit-details-marker]:hidden">
        <Fingerprint size={15} aria-hidden="true" />
        Source &amp; history
        <ChevronDown
          size={14}
          aria-hidden="true"
          className="ml-auto transition-transform motion-reduce:transition-none group-open/provenance:rotate-180"
        />
      </summary>
      <dl className="mt-3 grid gap-x-6 gap-y-4 text-sm sm:grid-cols-2">
        <div>
          <dt className="text-fg-subtle">Added by</dt>
          <dd className="mt-1 break-words text-fg">
            {fact.actorName ? displayWriterLabel(fact.actorName) : "Name not recorded"}
          </dd>
          <dd className="mt-0.5 text-sm text-fg-subtle">
            {fact.actorType ? ACTOR_LABELS[fact.actorType] : "Assertion type not recorded"}
          </dd>
        </div>
        <div>
          <dt className="flex items-center gap-1.5 text-fg-subtle">
            <ShieldCheck size={14} aria-hidden="true" /> Search scope
          </dt>
          <dd className="mt-1 break-all font-mono text-xs leading-relaxed text-fg-muted">
            {scope || "Organization root"}
          </dd>
        </div>
        <div>
          <dt className="flex items-center gap-1.5 text-fg-subtle">
            <Link2 size={14} aria-hidden="true" /> Source identifier
          </dt>
          <dd className="mt-1 break-all font-mono text-xs leading-relaxed text-fg-muted">
            {fact.sourceId || "No source identifier returned"}
          </dd>
        </div>
        <div>
          <dt className="text-fg-subtle">Memory timestamp</dt>
          <dd className="mt-1 text-fg">
            {hasTimestamp ? (
              <time dateTime={timestamp.toISOString()} title={timestamp.toISOString()}>
                {timestamp.toLocaleString()}
              </time>
            ) : (
              "Not recorded"
            )}
          </dd>
        </div>
        <div className="sm:col-span-2">
          <dt className="text-fg-subtle">Fact identifier</dt>
          <dd className="mt-1 select-all break-all font-mono text-xs leading-relaxed text-fg-muted">{fact.uuid}</dd>
        </div>
        <div className="sm:col-span-2">
          <dt className="text-fg-subtle">Source events</dt>
          <dd className="mt-1 text-fg-muted">
            {fact.sourceEventIds?.length ? (
              <ul className="space-y-1">
                {fact.sourceEventIds.map((id, index) => (
                  <li key={`${id}-${index}`} className="select-all break-all font-mono text-xs leading-relaxed">
                    {id}
                  </li>
                ))}
              </ul>
            ) : (
              "No event identifiers returned"
            )}
          </dd>
        </div>
      </dl>
      <p className="mt-3 text-sm leading-relaxed text-fg-subtle">
        This timestamp may describe when a fact applies or when it was stored. The result does not distinguish them.
        Source freshness is not included in this result.
      </p>
    </details>
  );
}
