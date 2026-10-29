"use client";

import { useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { ArrowRight, X } from "lucide-react";

const STORAGE_KEY = "willder:tips:dismissed";

function readVisibility() {
  try {
    return !localStorage.getItem(STORAGE_KEY);
  } catch {
    return false;
  }
}

function subscribeToDismissal(onChange: () => void) {
  function onStorage(event: StorageEvent) {
    if (event.key === STORAGE_KEY || event.key === null) onChange();
  }
  window.addEventListener("storage", onStorage);
  return () => window.removeEventListener("storage", onStorage);
}

const hiddenOnServer = () => false;

const TIPS = [
  {
    title: "Choose your scope",
    body: "Select the part of memory you want to search. Access still follows your permissions.",
  },
  {
    title: "Ask, then inspect",
    body: "Open Retrieved context beneath an answer to check the facts and source details returned.",
  },
  {
    title: "Follow changes",
    body: "Use change history to review recorded updates. Search again to retrieve fresh context.",
  },
];

export function FirstUseTips() {
  const visible = useSyncExternalStore(subscribeToDismissal, readVisibility, hiddenOnServer);
  const [dismissed, setDismissed] = useState(false);

  function dismiss() {
    try {
      localStorage.setItem(STORAGE_KEY, "1");
    } catch {
      // ignore
    }
    setDismissed(true);
  }

  if (!visible || dismissed) return null;

  return (
    <section
      aria-labelledby="memory-tips-title"
      className="mt-4 rounded-2xl border border-divider bg-panel p-5 sm:mt-6"
    >
      <div className="mb-3 flex items-center justify-between gap-3">
        <h2 id="memory-tips-title" className="text-base font-semibold text-fg">
          Make your first answer useful.
        </h2>
        <button
          onClick={dismiss}
          className="-my-2 -mr-2 flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-fg-subtle transition-colors hover:bg-fg/5 hover:text-fg"
          aria-label="Dismiss tips"
        >
          <X size={16} aria-hidden="true" />
        </button>
      </div>

      <ol className="grid gap-4 md:grid-cols-3">
        {TIPS.map((tip, index) => (
          <li key={tip.title} className="flex gap-3">
            <span className="text-sm font-semibold tabular-nums text-accent" aria-hidden="true">
              0{index + 1}
            </span>
            <div>
              <h3 className="mb-1 text-sm font-semibold text-fg">{tip.title}</h3>
              <p className="text-sm leading-relaxed text-fg-muted">{tip.body}</p>
            </div>
          </li>
        ))}
      </ol>

      <div className="mt-3 flex flex-wrap gap-x-6">
        <Link href="/dashboard" className="inline-flex min-h-11 items-center gap-2 text-sm font-semibold text-accent">
          Set up your workspace <ArrowRight size={13} aria-hidden="true" />
        </Link>
        <Link
          href="/audit?view=timeline"
          className="inline-flex min-h-11 items-center gap-2 text-sm font-semibold text-accent"
        >
          Open change history <ArrowRight size={13} aria-hidden="true" />
        </Link>
      </div>
    </section>
  );
}
