"use client";

// The overview page's first-run checklist: three steps from a new workspace to memory
// doing something true, each marked done only from the org's own records
// (GET /api/onboarding/first-run). Render it only for someone the server has already
// found may manage access: the route audits a refusal. `fallback` covers the rare 403
// when that permission is revoked between page render and fetch.
import { useCallback, useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import { ArrowRight, Circle, CircleCheck } from "lucide-react";
import type { FirstRunStatus } from "@/app/api/onboarding/first-run/route";

type Load =
  | { state: "loading" }
  | { state: "ready"; status: FirstRunStatus }
  | { state: "forbidden" }
  | { state: "error" };

interface Step {
  title: string;
  done: boolean;
  /** One line: what is true now when done, the next action when not. */
  detail: string;
  action?: { label: string; href: string };
  secondary?: { label: string; href: string };
}

export function FirstRunChecklist({ fallback }: { fallback: ReactNode }) {
  const [load, setLoad] = useState<Load>({ state: "loading" });

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch("/api/onboarding/first-run", { cache: "no-store" });
      if (res.status === 403) return setLoad({ state: "forbidden" });
      if (!res.ok) return setLoad({ state: "error" });
      setLoad({ state: "ready", status: (await res.json()) as FirstRunStatus });
    } catch {
      setLoad({ state: "error" });
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- initial data load, not a derived/cascading render
    void fetchStatus();
  }, [fetchStatus]);

  if (load.state === "forbidden") return <>{fallback}</>;

  const steps = load.state === "ready" ? stepsFrom(load.status) : [];
  const doneCount = steps.filter((s) => s.done).length;

  return (
    <section aria-labelledby="first-run-title" className="rounded-2xl border border-info/25 bg-info/[0.04] p-5 sm:p-6">
      <div className="mb-4 flex items-baseline justify-between gap-3">
        <h2 id="first-run-title" className="font-display text-2xl font-semibold text-fg">
          See your memory work.
        </h2>
        {load.state === "ready" && (
          <p className="shrink-0 text-sm tabular-nums text-fg-muted">
            {doneCount} of {steps.length} done
          </p>
        )}
      </div>

      {load.state === "loading" && (
        <p className="text-sm text-fg-muted" role="status">
          Checking your workspace…
        </p>
      )}

      {load.state === "error" && (
        <p className="text-sm text-fg-muted" role="alert">
          Your setup progress could not be loaded.{" "}
          <button onClick={() => void fetchStatus()} className="min-h-11 font-semibold text-info">
            Try again
          </button>
        </p>
      )}

      {load.state === "ready" && (
        <>
          <ol className="grid gap-1 md:grid-cols-3">
            {steps.map((step) => (
              <li key={step.title} className="flex gap-3 rounded-xl px-1 py-3 sm:px-3">
                {step.done ? (
                  <CircleCheck size={18} className="mt-0.5 shrink-0 text-success" aria-label="Done" />
                ) : (
                  <Circle size={18} className="mt-0.5 shrink-0 text-fg-subtle" aria-label="Not done" />
                )}
                <div className="min-w-0">
                  <h3 className="text-sm font-semibold text-fg">{step.title}</h3>
                  <p className="mt-1 break-words text-sm leading-relaxed text-fg-muted">{step.detail}</p>
                  {(step.action || step.secondary) && (
                    <div className="flex flex-wrap gap-x-4">
                      {[step.action, step.secondary]
                        .filter((a) => a !== undefined)
                        .map((a) => (
                          <Link
                            key={a.href}
                            href={a.href}
                            className="inline-flex min-h-11 items-center gap-1.5 text-sm font-semibold text-info"
                          >
                            {a.label} <ArrowRight size={13} aria-hidden="true" />
                          </Link>
                        ))}
                    </div>
                  )}
                </div>
              </li>
            ))}
          </ol>
          {!load.status.fact && (
            <Link
              href="/timelapse"
              className="mt-2 inline-flex min-h-11 items-center gap-1.5 text-sm text-fg-muted transition-colors hover:text-info"
            >
              No agent yet? Replay a real team&apos;s memory, read-only <ArrowRight size={13} aria-hidden="true" />
            </Link>
          )}
        </>
      )}
    </section>
  );
}

/** The three steps, each worded from what the records say right now. */
function stepsFrom(status: FirstRunStatus): Step[] {
  const { fact, openedFact, subScopeToken, denied } = status;
  return [
    fact
      ? {
          title: "Write a first fact",
          done: true,
          detail: `${fact.writer} wrote to ${fact.scopeName}${fact.source ? ` via ${fact.source}` : ""}.`,
        }
      : {
          title: "Write a first fact",
          done: false,
          detail: "Connect a source, or let your agent write one.",
          action: { label: "Connect your agent", href: "/integrations#connect-ai" },
          secondary: { label: "Connect a source", href: "/integrations#sources" },
        },
    !fact
      ? {
          title: "See who wrote it",
          done: false,
          detail: "Every fact shows its writer and source. Starts after step 1.",
        }
      : {
          title: "See who wrote it",
          done: openedFact,
          detail: openedFact
            ? "You opened a fact's writer and source in the Timeline."
            : "Open it to see its writer, source and versions.",
          action: { label: "Open the fact", href: `/audit?view=timeline&change=${encodeURIComponent(fact.changeId)}` },
        },
    !subScopeToken
      ? {
          title: "Give an agent less",
          done: false,
          detail: "Mint a token on a smaller scope, then let it ask outside.",
          action: { label: "Mint a token", href: "/access?tab=tokens" },
        }
      : {
          title: "Give an agent less",
          done: denied,
          detail: denied
            ? `${subScopeToken.agent} was refused. Its token covers ${subScopeToken.scopeName} only.`
            : `${subScopeToken.agent}'s token covers ${subScopeToken.scopeName} only. Have it ask outside.`,
          action: denied
            ? { label: "See the denial", href: "/audit" }
            : { label: "Open the access log", href: "/audit" },
        },
  ];
}
