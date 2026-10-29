"use client";

// The confirm page's card: the rule as recorded, who recorded it, and one button. The button
// posts to /api/memory/conventions/[id]/confirm and the card then says what happened, from
// the server's answer only: "Confirmed" is shown after a 200, never before.
import { useState } from "react";
import Link from "next/link";
import { CheckCircle2 } from "lucide-react";
import { Button, Card, Chip } from "@/components/ui";
import { displayWriterLabel } from "@/components/audit/format";
import { ScopeLabel } from "@/components/memory/scope-label";

/** The rule as the page shows it; every field is already readable by the viewer. */
export interface ConfirmableRule {
  id: string;
  kind: "convention" | "decision";
  subject: string;
  text: string;
  scopePath: string;
  scopeName: string | null;
  recordedBy: "person" | "agent" | "unknown";
  writerName: string | null;
  inForce: boolean;
}

type Outcome =
  | { state: "idle" }
  | { state: "saving" }
  | { state: "confirmed"; id: string; already: boolean }
  | { state: "error"; message: string };

const KIND_LABEL = { convention: "Convention", decision: "Decision" } as const;

/** Who the card says recorded the rule. */
function recordedByLabel(rule: ConfirmableRule): string {
  const name = rule.writerName === null ? null : displayWriterLabel(rule.writerName);
  if (rule.recordedBy === "person") return name === null ? "Recorded by a person" : `Recorded by ${name}`;
  if (rule.recordedBy === "agent") return name === null ? "Recorded by an agent" : `Recorded by ${name}`;
  return "Writer not recorded";
}

export function ConfirmRule({ rule, canWrite }: { rule: ConfirmableRule; canWrite: boolean }) {
  const [outcome, setOutcome] = useState<Outcome>({ state: "idle" });

  async function confirm() {
    setOutcome({ state: "saving" });
    try {
      const res = await fetch(`/api/memory/conventions/${encodeURIComponent(rule.id)}/confirm`, { method: "POST" });
      const body = (await res.json().catch(() => ({}))) as {
        confirmed?: string;
        alreadyConfirmed?: boolean;
        error?: string;
      };
      if (res.ok && typeof body.confirmed === "string") {
        setOutcome({ state: "confirmed", id: body.confirmed, already: body.alreadyConfirmed === true });
        return;
      }
      setOutcome({
        state: "error",
        message: body.error ?? `Could not confirm it (HTTP ${res.status}). Nothing was saved.`,
      });
    } catch {
      setOutcome({ state: "error", message: "Could not reach Willder. Nothing was confirmed; try again." });
    }
  }

  const label = KIND_LABEL[rule.kind].toLowerCase();
  return (
    <Card className="mt-6 flex flex-col gap-4 px-5 py-5 sm:mt-8">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <p className="min-w-0 break-words font-semibold text-fg">{rule.subject}</p>
        <ScopeLabel path={rule.scopePath} name={rule.scopeName} />
      </div>
      <p className="whitespace-pre-line break-words text-sm leading-relaxed text-fg-muted">{rule.text}</p>
      <div className="flex flex-wrap gap-x-3 gap-y-1">
        <Chip>{KIND_LABEL[rule.kind]}</Chip>
        <Chip>{recordedByLabel(rule)}</Chip>
        {!rule.inForce && <Chip tone="ember">Replaced or retired</Chip>}
      </div>
      <Status rule={rule} canWrite={canWrite} outcome={outcome} label={label} onConfirm={confirm} />
    </Card>
  );
}

function Status({
  rule,
  canWrite,
  outcome,
  label,
  onConfirm,
}: {
  rule: ConfirmableRule;
  canWrite: boolean;
  outcome: Outcome;
  label: string;
  onConfirm: () => void;
}) {
  if (outcome.state === "confirmed") {
    return (
      <p role="status" className="flex items-center gap-2 text-sm text-fg">
        <CheckCircle2 aria-hidden className="size-4 shrink-0 text-accent" />
        {outcome.already
          ? `A person already recorded this ${label}. Nothing changed.`
          : `Confirmed. Your version replaces ${rule.recordedBy === "agent" ? "the agent's" : "the one recorded before"}, and new sessions in this scope get it as a standing rule.`}
      </p>
    );
  }
  if (!rule.inForce) {
    return (
      <p className="text-sm text-fg-muted">
        This version is no longer served, so there is nothing to confirm. The current one is in{" "}
        <Link
          href={`/memory/explore?scope=${encodeURIComponent(rule.scopePath)}`}
          className="font-medium text-fg underline underline-offset-4"
        >
          Explore memory
        </Link>
        , under Rules and decisions.
      </p>
    );
  }
  if (rule.recordedBy === "person") {
    return <p className="text-sm text-fg-muted">A person recorded this {label}. There is nothing to confirm.</p>;
  }
  if (!canWrite) {
    return (
      <p className="text-sm text-fg-muted">
        You can read this scope but not write to it, so you cannot confirm it. Ask someone who can write here.
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <Button onClick={onConfirm} disabled={outcome.state === "saving"} aria-busy={outcome.state === "saving"}>
          {outcome.state === "saving" ? "Confirming…" : `Confirm ${label}`}
        </Button>
      </div>
      {outcome.state === "error" && (
        <p role="alert" className="text-sm text-danger">
          {outcome.message}
        </p>
      )}
    </div>
  );
}
