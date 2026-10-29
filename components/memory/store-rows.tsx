// The rows of each list on the Explore page: one component per stored kind of memory,
// each a card of rows with the row's own words first and its scope and time after.
import Link from "next/link";
import type { StoreBrief, StoreChunk, StoreFile, StoreNote, StoreRecord, StoreRule } from "@/types/memory";
import { Card, Chip } from "@/components/ui";
import { displayWriterLabel, fmt } from "@/components/audit/format";
import { ScopeLabel } from "./scope-label";

const BRIEF_TYPE_LABEL: Record<StoreBrief["type"], string> = {
  handoff: "Handoff",
  architecture_plan: "Architecture plan",
  qa_review: "QA review",
};
const RULE_KIND_LABEL: Record<StoreRule["kind"], string> = { convention: "Convention", decision: "Decision" };
const NOTE_KIND_LABEL: Record<StoreNote["kind"], string> = {
  claim: "Claim",
  intent: "Intent",
  status: "Status",
  question: "Question",
};

/** A row's trailing scope and time, aligned right on wide screens. */
function RowMeta({ scopePath, scopeName, time }: { scopePath: string | null; scopeName: string | null; time: string }) {
  return (
    <div className="flex items-center gap-3">
      <ScopeLabel path={scopePath} name={scopeName} />
      <span className="font-mono text-xs text-fg-subtle">{time}</span>
    </div>
  );
}

export function RecordsList({ records }: { records: StoreRecord[] }) {
  return (
    <Card className="divide-y divide-divider">
      {records.map((r) => (
        <div
          key={`${r.kind}:${r.id}`}
          className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 px-5 py-4"
        >
          <div className="min-w-0">
            <p className="truncate font-semibold text-fg">{r.title}</p>
            <p className="mt-0.5 text-sm text-fg-muted">{r.detail}</p>
          </div>
          <RowMeta scopePath={r.scopePath} scopeName={r.scopeName} time={fmt(r.updatedAt)} />
        </div>
      ))}
    </Card>
  );
}

export function BriefsList({ briefs }: { briefs: StoreBrief[] }) {
  return (
    <Card className="divide-y divide-divider">
      {briefs.map((b) => (
        <div key={b.id} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 px-5 py-4">
          <div className="min-w-0">
            <Link
              href={`/briefs/${b.id}`}
              className="block truncate font-semibold text-fg underline-offset-4 hover:text-accent hover:underline"
            >
              {b.title}
            </Link>
            <Chip className="mt-0.5 block">{BRIEF_TYPE_LABEL[b.type]}</Chip>
          </div>
          <RowMeta scopePath={b.scopePath} scopeName={b.scopeName} time={fmt(b.createdAt)} />
        </div>
      ))}
    </Card>
  );
}

export function RulesList({ rules }: { rules: StoreRule[] }) {
  return (
    <Card className="divide-y divide-divider">
      {rules.map((r) => (
        <div key={r.id} className="flex flex-col gap-2 px-5 py-4">
          <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
            <p className="min-w-0 break-words font-semibold text-fg">{r.subject}</p>
            <RowMeta scopePath={r.scopePath} scopeName={r.scopeName} time={fmt(r.createdAt)} />
          </div>
          <p className="whitespace-pre-line break-words text-sm leading-relaxed text-fg-muted">{r.text}</p>
          <div className="flex flex-wrap gap-x-3">
            <Chip>{RULE_KIND_LABEL[r.kind]}</Chip>
            {r.status === "replaced" && <Chip tone="ember">Replaced by a later version</Chip>}
            {r.status === "retired" && <Chip tone="ember">Retired</Chip>}
          </div>
        </div>
      ))}
    </Card>
  );
}

export function NotesList({ notes }: { notes: StoreNote[] }) {
  return (
    <Card className="divide-y divide-divider">
      {notes.map((n) => (
        <div key={n.id} className="flex flex-col gap-2 px-5 py-4">
          <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
            <p className="min-w-0 break-words font-semibold text-fg">{n.task}</p>
            <RowMeta scopePath={n.scopePath} scopeName={n.scopeName} time={fmt(n.createdAt)} />
          </div>
          <p className="whitespace-pre-line break-words text-sm leading-relaxed text-fg-muted">{n.body}</p>
          <div className="flex flex-wrap gap-x-3">
            <Chip>{NOTE_KIND_LABEL[n.kind]}</Chip>
            <Chip>{n.agentName === null ? "Removed agent" : displayWriterLabel(n.agentName)}</Chip>
            {n.status === "live" ? (
              <Chip tone="gold">Live until {fmt(n.expiresAt)}</Chip>
            ) : (
              <Chip>{n.status === "released" ? "Released" : "Expired"}</Chip>
            )}
          </div>
        </div>
      ))}
    </Card>
  );
}

export function ChunksList({ chunks }: { chunks: StoreChunk[] }) {
  return (
    <Card className="divide-y divide-divider">
      {chunks.map((c) => (
        <div key={c.id} className="flex flex-col gap-2 px-5 py-4">
          <p className="whitespace-pre-line break-words text-sm leading-relaxed text-fg">{c.snippet}</p>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className="break-words text-sm text-fg-muted">{displayWriterLabel(c.author ?? c.source)}</span>
            <ScopeLabel path={c.scopePath} name={c.scopeName} />
            {c.supersededById && (
              <span className="break-all font-mono text-xs text-fg-subtle">superseded by {c.supersededById}</span>
            )}
            <span className="font-mono text-xs text-fg-subtle">ingested {fmt(c.createdAt)}</span>
          </div>
        </div>
      ))}
    </Card>
  );
}

export function FilesList({ files }: { files: StoreFile[] }) {
  return (
    <Card className="divide-y divide-divider">
      {files.map((f) => (
        <div key={f.id} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 px-5 py-4">
          <div className="min-w-0">
            <p className="truncate font-semibold text-fg">{f.externalFileId}</p>
            <p className="mt-0.5 text-sm text-fg-muted">
              {displayWriterLabel(f.sourceName)} · {f.sourceType} · {f.chunkCount}{" "}
              {f.chunkCount === 1 ? "passage" : "passages"}
            </p>
          </div>
          <RowMeta scopePath={f.scopePath} scopeName={f.scopeName} time={`last sync ${fmt(f.syncedAt)}`} />
        </div>
      ))}
    </Card>
  );
}
