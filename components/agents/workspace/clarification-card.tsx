"use client";

// ClarificationCard — the just-in-time, typed clarification surface (design_agent
// _workspace_ux.md §3). Renders a ClarificationRequest's ClarifyQuestion[] with each
// question's recommended default PRE-SELECTED / PRE-FILLED, surfaces every option's
// trade-offs inline, and leads with a one-click "Accept recommendations". Emits a
// ResumePayload (types/agent-run.ts) to the parent, which POSTs it to …/answer.
//
// Brand law: this is the ONE accent-signal moment on the surface (design.md §3 rule 1)
// — an ice hairline + faint ice fill. A recommended default is the agent's
// RECOMMENDATION, never dressed up as a confirmed org FACT; `source` drives that tag.

import { useMemo, useState } from "react";
import { BUTTON_PRIMARY, BUTTON_QUIET, FIELD, FOCUS } from "@/components/agents/agent-ui";
import type {
  ClarificationRequest,
  ClarifyOption,
  ClarifyQuestion,
  RecommendationSource,
  ResumePayload,
} from "@/types/agent-run";

type LocalAnswer =
  | { kind: "single"; optionId: string }
  | { kind: "multi"; optionIds: string[] }
  | { kind: "value"; value: string }
  | { kind: "number"; value: number }
  | { kind: "text"; value: string };

/** Seed a question's local answer from its recommended default (pre-select / pre-fill). */
function seed(q: ClarifyQuestion): LocalAnswer {
  switch (q.kind) {
    case "single":
      return { kind: "single", optionId: q.recommended.value };
    case "multi":
      return { kind: "multi", optionIds: [...q.recommended.values] };
    case "value":
      return { kind: "value", value: q.recommended.value };
    case "number":
      return { kind: "number", value: q.recommended.value };
    case "text":
      return { kind: "text", value: q.recommended?.value ?? "" };
  }
}

function SourceTag({ source }: { source: RecommendationSource }) {
  const fact = source === "fact";
  return (
    <span
      className={`inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-eyebrow font-semibold uppercase ${
        fact ? "border-divider text-fg-muted" : "border-accent/60 text-fg"
      }`}
      title={
        fact
          ? "Retrieved from your org's memory — a confirmed fact."
          : "The agent's recommendation (common practice / assumption) — not a confirmed fact."
      }
    >
      {fact ? "from memory" : "recommended"}
    </span>
  );
}

/** Inline trade-offs for one option (pros/cons/cost + common practice / example). */
function OptionMeta({ opt }: { opt: ClarifyOption }) {
  const hasTradeoffs = opt.pros || opt.cons || opt.cost;
  if (!hasTradeoffs && !opt.commonPractice && !opt.example && !opt.detail) return null;
  return (
    <div className="mt-1.5 space-y-1 pl-6 [overflow-wrap:anywhere]">
      {opt.detail && <p className="text-sm text-fg-muted">{opt.detail}</p>}
      {hasTradeoffs && (
        <div className="flex flex-col gap-0.5 text-sm">
          {opt.pros && (
            <span className="text-fg-muted">
              <span className="font-semibold text-fg">+ </span>
              {opt.pros}
            </span>
          )}
          {opt.cons && (
            <span className="text-fg-muted">
              <span className="font-semibold text-fg">− </span>
              {opt.cons}
            </span>
          )}
          {opt.cost && <span className="text-fg-muted">{opt.cost}</span>}
        </div>
      )}
      {(opt.commonPractice || opt.example) && (
        <p className="text-sm text-fg-muted">
          {opt.commonPractice && <>Common practice: {opt.commonPractice}. </>}
          {opt.example && <>e.g. {opt.example}</>}
        </p>
      )}
    </div>
  );
}

export function ClarificationCard({
  request,
  submitting,
  error,
  onSubmit,
  onDefer,
}: {
  request: ClarificationRequest;
  submitting: boolean;
  error?: string | null;
  /** Builds a ResumePayload; untouched questions are sent as acceptedDefault. */
  onSubmit: (payload: ResumePayload) => void;
  /** Non-blocking asks may be skipped ("use your judgment"). */
  onDefer?: () => void;
}) {
  const [answers, setAnswers] = useState<Record<string, LocalAnswer>>(() =>
    Object.fromEntries(request.questions.map((q) => [q.id, seed(q)])),
  );
  // Which questions the human actually touched (overrode). Untouched ⇒ accept default.
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  const [otherText, setOtherText] = useState<Record<string, string>>({});

  function set(id: string, next: LocalAnswer) {
    setAnswers((a) => ({ ...a, [id]: next }));
    setTouched((t) => ({ ...t, [id]: true }));
  }

  const anyOverridden = Object.values(touched).some(Boolean);

  // Validation: multi min/max on any touched multi question.
  const valid = useMemo(() => {
    for (const q of request.questions) {
      if (q.kind === "multi" && touched[q.id]) {
        const a = answers[q.id];
        const n = a?.kind === "multi" ? a.optionIds.length : 0;
        if (q.min != null && n < q.min) return false;
        if (q.max != null && n > q.max) return false;
      }
    }
    return true;
  }, [request.questions, answers, touched]);

  function buildPayload(acceptAll: boolean): ResumePayload {
    return {
      checkpointId: request.checkpointId,
      answers: request.questions.map((q) => {
        const wasTouched = !acceptAll && touched[q.id];
        if (!wasTouched) return { questionId: q.id, acceptedDefault: true };
        return { questionId: q.id, answer: answers[q.id] };
      }),
    };
  }

  const blocking = request.blocking;
  const pendingCount = request.questions.filter((q) => !touched[q.id]).length;

  return (
    <div
      role="group"
      aria-label="The agent needs your input to continue"
      className="relative overflow-hidden rounded-xl border border-accent/35 bg-accent/[0.03] p-4 sm:p-5"
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <svg
          className="h-4 w-4 shrink-0 text-accent"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M12 3a6 6 0 0 0-6 6c0 2 1 3 2 4 .5.5 1 1 1 2h6c0-1 .5-1.5 1-2 1-1 2-2 2-4a6 6 0 0 0-6-6Z" />
          <line x1="9" y1="21" x2="15" y2="21" />
        </svg>
        <p className="text-eyebrow font-semibold uppercase text-fg">Needs input{blocking ? "" : " (optional)"}</p>
        {pendingCount > 0 && <span className="text-sm text-fg-muted">· {pendingCount} to review</span>}
      </div>

      <div className="mt-4 space-y-6">
        {request.questions.map((q) => (
          <fieldset key={q.id} className="min-w-0 space-y-2 border-t border-divider pt-5 first:border-0 first:pt-0">
            <legend className="flex max-w-full items-start gap-2 text-base font-semibold text-fg">
              <span
                className={`mt-2.5 h-1.5 w-1.5 shrink-0 rounded-full ${touched[q.id] ? "bg-success" : "bg-warning"}`}
                title={touched[q.id] ? "Answered" : "Pending — using the recommended default"}
                aria-hidden="true"
              />
              <span className="min-w-0 [overflow-wrap:anywhere]">{q.prompt}</span>
            </legend>
            {q.help && <p className="-mt-1 text-sm text-fg-muted [overflow-wrap:anywhere]">{q.help}</p>}

            {q.kind === "single" && (
              <div className="space-y-1.5">
                {q.options.map((opt) => {
                  const a = answers[q.id];
                  const checked = a?.kind === "single" && a.optionId === opt.value;
                  const isRec = opt.value === q.recommended.value;
                  return (
                    <label
                      key={opt.value}
                      className={`block cursor-pointer rounded-xl border px-3 py-2.5 transition-colors ${
                        checked
                          ? "border-accent/50 bg-accent/[0.05]"
                          : "border-divider bg-fg/[0.02] hover:border-accent/35"
                      }`}
                    >
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                        <input
                          type="radio"
                          name={q.id}
                          checked={checked}
                          onChange={() => set(q.id, { kind: "single", optionId: opt.value })}
                          className={`h-4 w-4 shrink-0 accent-action ${FOCUS}`}
                        />
                        <span className="min-w-0 text-sm font-medium text-fg [overflow-wrap:anywhere]">
                          {opt.label}
                        </span>
                        {isRec && <SourceTag source={q.recommended.source} />}
                      </div>
                      <OptionMeta opt={opt} />
                    </label>
                  );
                })}
                {q.allowOther && (
                  <input
                    type="text"
                    value={otherText[q.id] ?? ""}
                    placeholder="Other…"
                    onChange={(e) => {
                      setOtherText((o) => ({ ...o, [q.id]: e.target.value }));
                      set(q.id, { kind: "single", optionId: e.target.value });
                    }}
                    className={FIELD}
                  />
                )}
                <p className="text-sm text-fg-muted [overflow-wrap:anywhere]">↳ {q.recommended.rationale}</p>
              </div>
            )}

            {q.kind === "multi" && (
              <div className="space-y-1.5">
                {q.options.map((opt) => {
                  const a = answers[q.id];
                  const set0 = a?.kind === "multi" ? a.optionIds : [];
                  const checked = set0.includes(opt.value);
                  const isRec = q.recommended.values.includes(opt.value);
                  return (
                    <label
                      key={opt.value}
                      className={`block cursor-pointer rounded-xl border px-3 py-2.5 transition-colors ${
                        checked
                          ? "border-accent/50 bg-accent/[0.05]"
                          : "border-divider bg-fg/[0.02] hover:border-accent/35"
                      }`}
                    >
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() =>
                            set(q.id, {
                              kind: "multi",
                              optionIds: checked ? set0.filter((v) => v !== opt.value) : [...set0, opt.value],
                            })
                          }
                          className={`h-4 w-4 shrink-0 rounded accent-action ${FOCUS}`}
                        />
                        <span className="min-w-0 text-sm font-medium text-fg [overflow-wrap:anywhere]">
                          {opt.label}
                        </span>
                        {isRec && <SourceTag source={q.recommended.source} />}
                      </div>
                      <OptionMeta opt={opt} />
                    </label>
                  );
                })}
                {(q.min != null || q.max != null) && (
                  <p className="text-sm text-fg-muted">
                    select {q.min ?? 0}
                    {q.max != null ? `–${q.max}` : "+"}
                  </p>
                )}
                <p className="text-sm text-fg-muted [overflow-wrap:anywhere]">↳ {q.recommended.rationale}</p>
              </div>
            )}

            {(q.kind === "value" || q.kind === "number") && (
              <div className="space-y-1.5">
                <div className="flex items-center gap-2">
                  <input
                    type={q.kind === "number" ? "number" : q.inputType === "date" ? "date" : "text"}
                    value={
                      answers[q.id]?.kind === "number"
                        ? String((answers[q.id] as { value: number }).value)
                        : ((answers[q.id] as { value: string })?.value ?? "")
                    }
                    placeholder={q.placeholder}
                    onChange={(e) =>
                      set(
                        q.id,
                        q.kind === "number"
                          ? { kind: "number", value: Number(e.target.value) }
                          : { kind: "value", value: e.target.value },
                      )
                    }
                    className={`min-w-0 ${FIELD}`}
                  />
                  {q.unit && (
                    <span className="max-w-[40%] font-mono text-xs text-fg-muted [overflow-wrap:anywhere]">
                      {q.unit}
                    </span>
                  )}
                </div>
                <p className="text-sm text-fg-muted [overflow-wrap:anywhere]">
                  <SourceTag source={q.recommended.source} /> {q.recommended.rationale}
                </p>
              </div>
            )}

            {q.kind === "text" && (
              <div className="space-y-1.5">
                <textarea
                  rows={3}
                  maxLength={q.maxLen}
                  value={(answers[q.id] as { value: string })?.value ?? ""}
                  placeholder={q.placeholder}
                  onChange={(e) => set(q.id, { kind: "text", value: e.target.value })}
                  className={FIELD}
                />
                {q.recommended && (
                  <p className="text-sm text-fg-muted [overflow-wrap:anywhere]">
                    <SourceTag source={q.recommended.source} /> {q.recommended.rationale}
                  </p>
                )}
              </div>
            )}
          </fieldset>
        ))}
      </div>

      {error && <p className="mt-3 break-words text-sm text-danger">{error}</p>}

      <div className="mt-5 flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={submitting || !valid}
          onClick={() => onSubmit(buildPayload(!anyOverridden))}
          className={BUTTON_PRIMARY}
        >
          {submitting ? "Submitting…" : anyOverridden ? "Submit answers" : "Accept recommendations"}
        </button>
        {anyOverridden && (
          <button
            type="button"
            disabled={submitting}
            onClick={() => onSubmit(buildPayload(true))}
            className={BUTTON_QUIET}
          >
            Accept all recommendations instead
          </button>
        )}
        {!blocking && onDefer && (
          <button type="button" disabled={submitting} onClick={onDefer} className={BUTTON_QUIET}>
            Use your judgment
          </button>
        )}
      </div>
    </div>
  );
}
