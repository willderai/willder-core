"use client";

import { useState } from "react";
import { Modal } from "@/components/ui/modal";
import { Button } from "@/components/ui/button";

const STEPS = [
  {
    key: "companyDescription",
    label: "What does your company do?",
    placeholder: "Our support and sales agents share one memory, each scoped to its own team...",
    hint: "1-3 sentences. This becomes the foundation of your governed memory — every agent reads from it.",
  },
  {
    key: "icp",
    label: "What are you building right now?",
    placeholder: "A Next.js app on Vercel + Neon; the focus is contractor onboarding...",
    hint: "The product, project, or system you are working on. Agents plan and test against this.",
  },
  {
    key: "valueProp",
    label: "What key decisions or facts should memory hold?",
    placeholder: "We moved the send pipeline from SQS to a Postgres queue; Priya owns onboarding...",
    hint: "A few decisions, conventions, or facts to seed the graph. You can always add more later.",
  },
  {
    key: "tone",
    label: "How should agents write for you?",
    placeholder: "Concise and direct, no jargon, always show trade-offs...",
    hint: "Optional. Shapes the voice of briefs and drafts. Leave blank for the default.",
  },
];

type Answers = {
  companyDescription: string;
  icp: string;
  valueProp: string;
  tone: string;
  domain: string;
};

/** What the user reads when Finish did not save; the answers are kept either way. */
function saveErrorMessage(status: number | null): string {
  if (status === 401)
    return "Your session has no workspace yet. Sign in again or pick an organization, then press Finish. Your answers are kept.";
  if (status === 403)
    return "Your role cannot write to this workspace's memory. Ask an admin to finish setup, or skip. Your answers are kept.";
  return "Your answers were not saved. Check your connection and press Finish again; they are kept.";
}

export function OnboardingModal({ onDone }: { onDone: () => void }) {
  const [step, setStep] = useState(0);
  const [answers, setAnswers] = useState<Answers>({
    companyDescription: "",
    icp: "",
    valueProp: "",
    tone: "",
    domain: "",
  });
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const current = STEPS[step];
  const isLast = step === STEPS.length - 1;
  const value = answers[current.key as keyof Answers];

  function next() {
    if (isLast) return submit();
    setStep((s) => s + 1);
  }

  function back() {
    setStep((s) => Math.max(0, s - 1));
  }

  // The modal closes only once the server has saved the answers. On any failure
  // they stay in the form so Finish can be pressed again.
  async function submit() {
    setSaving(true);
    setSaveError(null);
    try {
      const res = await fetch("/api/onboarding", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(answers),
      });
      if (res.ok) return onDone();
      setSaveError(saveErrorMessage(res.status));
    } catch {
      setSaveError(saveErrorMessage(null));
    } finally {
      setSaving(false);
    }
  }

  async function skip() {
    await fetch("/api/onboarding", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    onDone();
  }

  return (
    <Modal
      title="Set up your workspace"
      glow="gold"
      onClose={skip}
      footer={
        <div className="flex w-full items-center justify-between">
          <div className="flex items-center gap-2">
            {STEPS.map((_, i) => (
              <div
                key={i}
                className={`h-1.5 rounded-full transition-all ${
                  i === step ? "w-6 bg-accent" : i < step ? "w-3 bg-accent/40" : "w-3 bg-fg/15"
                }`}
              />
            ))}
          </div>
          <div className="flex gap-2">
            {step > 0 && (
              <Button variant="ghost" size="sm" onClick={back}>
                Back
              </Button>
            )}
            <Button variant="ghost" size="sm" onClick={skip}>
              Skip
            </Button>
            <Button variant="primary" size="sm" onClick={next} disabled={saving || (!value && step < 3)}>
              {saving ? "Saving…" : isLast ? "Finish" : "Next"}
            </Button>
          </div>
        </div>
      }
    >
      <div className="space-y-4">
        <div>
          <p className="mb-1 text-sm text-fg-subtle">
            Step {step + 1} of {STEPS.length}
          </p>
          <h3 className="text-base font-semibold text-fg">{current.label}</h3>
          <p className="mt-1 text-sm text-fg-muted">{current.hint}</p>
        </div>

        <textarea
          autoFocus
          value={value}
          onChange={(e) => setAnswers((a) => ({ ...a, [current.key]: e.target.value }))}
          placeholder={current.placeholder}
          rows={4}
          className="w-full resize-none rounded-xl px-4 py-3 border border-[var(--field-border)] bg-[var(--field-background)] text-sm text-fg placeholder:text-[var(--field-placeholder)] hover:border-[var(--field-border-hover)] focus-visible:border-[var(--field-border-focus)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-info"
        />

        {/* Domain field shown alongside tone step */}
        {isLast && (
          <div>
            <p className="mb-1.5 text-sm font-medium text-fg">
              Company website domain <span className="font-normal text-fg-subtle">(optional)</span>
            </p>
            <input
              type="text"
              value={answers.domain}
              onChange={(e) => setAnswers((a) => ({ ...a, domain: e.target.value }))}
              placeholder="acme.com"
              className="min-h-11 w-full rounded-xl px-4 py-2.5 border border-[var(--field-border)] bg-[var(--field-background)] text-sm text-fg placeholder:text-[var(--field-placeholder)] hover:border-[var(--field-border-hover)] focus-visible:border-[var(--field-border-focus)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-info"
            />
            <p className="mt-1.5 text-sm text-fg-subtle">
              We&apos;ll research your company and add it to memory automatically.
            </p>
          </div>
        )}

        {saveError && (
          <p role="alert" className="text-sm text-danger">
            {saveError}
          </p>
        )}
      </div>
    </Modal>
  );
}
