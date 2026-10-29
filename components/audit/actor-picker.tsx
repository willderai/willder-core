"use client";

import { useEffect, useRef, useState } from "react";
import { WRITER_SLOT_CHARS } from "./format";
import { WriterLabel } from "./writer-label";

type Actor = { actorType: string; actorId: string; name: string };
export type SelectedActor = { actorType: string; actorId: string };

// Identity picker for the audit page's revocation-scoped filter (item
// rev-scoped-audit-filter): pick a real identity, then see only the audit
// facts that actually touch it. A real select control, not a bare query
// param, backed by GET /api/audit/actors (org-scoped, same admin gate as the
// audit list itself). Modeled on ScopePicker's trigger+dropdown shape, without
// the create/delete affordances that don't apply to a read-only actor list.
//
// `selected`/`onChange` carry the full (actorType, actorId) pair, never a
// bare actorId: a human User.id and an agent capability agentKey/agentId are
// not guaranteed disjoint namespaces, so an actorId-only selection can
// silently resolve to the wrong actor if a human and an agent ever share the
// same id string.
export function ActorPicker({
  selected,
  onChange,
  className,
}: {
  selected: SelectedActor | null;
  onChange: (actor: SelectedActor | null) => void;
  className?: string;
}) {
  const [actors, setActors] = useState<Actor[]>([]);
  const [loading, setLoading] = useState(true);
  // Distinct from a genuinely empty trail: a network failure and an HTTP
  // error with a JSON body (GET /api/audit/actors returns
  // {error:"unauthorized"|"forbidden"} on 401/403) must never both collapse
  // into "no actors" -- the caller learned nothing about the trail, that's
  // not the same claim.
  const [loadError, setLoadError] = useState(false);
  // Separate from `loading` on purpose: `loading` drives the L102 early
  // return that replaces the whole trigger with the
  // disabled "All identities" placeholder, so reusing it for a retry would
  // hide the open dropdown and the error copy along with it. `retrying` only
  // changes the "Try again" button itself, giving the click a visible,
  // distinguishable-from-idle state without collapsing the menu.
  const [retrying, setRetrying] = useState(false);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetch("/api/audit/actors")
      .then((r) => {
        if (!r.ok) throw new Error(`GET /api/audit/actors failed: ${r.status}`);
        return r.json();
      })
      .then((data) => setActors(data.actors ?? []))
      .catch(() => setLoadError(true))
      .finally(() => setLoading(false));
  }, []);

  // A separate path from the mount effect above, not a shared helper called
  // from it: ActorPicker never unmounts on close (only the `{open && ...}`
  // dropdown JSX toggles), so the mount-only effect had nothing left to
  // trigger a real re-fetch on retry/reopen (actorpicker-degraded-retry-is-
  // a-dead-end). Only wired to the "Try again" button's onClick, an event
  // handler, never to an effect -- reusing it there previously tripped
  // react-hooks/set-state-in-effect by giving the effect body a synchronous
  // path to a setState call it couldn't statically rule out.
  function retryLoadActors() {
    // Guard against an overlapping second request: the button below is
    // disabled while `retrying` is true, so this only matters for a
    // programmatic double-invoke, not a real click -- belt and suspenders.
    if (retrying) return;
    setRetrying(true);
    // Leave `loadError` (and the error copy + this button) up until the
    // retry actually settles, don't clear it up front: for the whole
    // duration of an in-flight retry the component otherwise sits at
    // actors=[]/!loading/!loadError -- the exact branch below that renders
    // "No actors in the audit trail yet.", a false claim about a trail this
    // request hasn't heard back on yet. Only a genuine success (a real
    // answer about the trail's contents) gets to clear it.
    fetch("/api/audit/actors")
      .then((r) => {
        if (!r.ok) throw new Error(`GET /api/audit/actors failed: ${r.status}`);
        return r.json();
      })
      .then((data) => {
        setActors(data.actors ?? []);
        setLoadError(false);
      })
      .catch(() => setLoadError(true))
      .finally(() => setRetrying(false));
  }

  useEffect(() => {
    if (!open) return;
    function onClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, [open]);

  function select(actor: SelectedActor | null) {
    onChange(actor);
    setOpen(false);
  }

  const selectedActor = selected
    ? actors.find((a) => a.actorType === selected.actorType && a.actorId === selected.actorId)
    : undefined;
  const selectedLabel = selected ? (selectedActor?.name ?? selected.actorId) : "All identities";

  const triggerCls =
    "flex items-center gap-2 rounded-full border border-divider bg-panel px-3 min-h-10 py-2 text-sm text-fg-muted backdrop-blur-md transition-colors hover:border-accent/35 hover:text-fg focus:outline-none";

  if (loading) {
    return (
      <div className={`${triggerCls} cursor-default opacity-40${className ? ` ${className}` : ""}`}>All identities</div>
    );
  }

  return (
    <div ref={ref} className={`relative${className ? ` ${className}` : ""}`}>
      <button type="button" onClick={() => setOpen((o) => !o)} className={triggerCls}>
        {selectedActor && (
          <span
            className={`h-1.5 w-1.5 shrink-0 rounded-full ${
              selectedActor.actorType === "agent" ? "bg-ember" : "bg-accent"
            }`}
          />
        )}
        <WriterLabel label={selectedLabel} maxChars={WRITER_SLOT_CHARS.actorPicker} className="text-fg" />
        <svg
          width="10"
          height="10"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          className={`shrink-0 transition-transform ${open ? "rotate-180" : ""}`}
        >
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>

      {open && (
        <div className="absolute left-0 top-full z-50 mt-1.5 max-h-72 w-max min-w-[220px] max-w-[min(24rem,calc(100vw-2.5rem))] overflow-y-auto rounded-2xl border border-divider bg-overlay shadow-2xl">
          <div className="flex flex-col gap-0.5 p-1.5">
            <ActorRow label="All identities" active={selected === null} onSelect={() => select(null)} />
            {actors.length === 0 && !loading && loadError && (
              <div className="flex flex-col items-start gap-1 px-3 py-2">
                <p className="text-sm text-danger">Couldn&apos;t load actors.</p>
                <button
                  type="button"
                  onClick={retryLoadActors}
                  disabled={retrying}
                  aria-busy={retrying}
                  className="text-sm font-medium text-fg-muted underline underline-offset-2 hover:text-fg disabled:cursor-wait disabled:text-fg-subtle disabled:no-underline"
                >
                  {retrying ? "Retrying…" : "Try again"}
                </button>
              </div>
            )}
            {actors.length === 0 && !loading && !loadError && (
              <p className="px-3 py-2 text-sm text-fg-subtle">No actors in the audit trail yet.</p>
            )}
            {actors.map((a) => (
              <ActorRow
                key={`${a.actorType}:${a.actorId}`}
                label={a.name}
                dot={a.actorType === "agent" ? "ember" : "gold"}
                active={selected?.actorType === a.actorType && selected?.actorId === a.actorId}
                onSelect={() => select({ actorType: a.actorType, actorId: a.actorId })}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function ActorRow({
  label,
  dot,
  active,
  onSelect,
}: {
  label: string;
  dot?: "gold" | "ember";
  active: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={`flex items-center gap-2 rounded-xl px-3 py-2 text-left text-sm transition ${
        active ? "bg-fg/[0.08] text-fg" : "text-fg-muted hover:bg-fg/[0.04] hover:text-fg"
      }`}
    >
      {dot && <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${dot === "ember" ? "bg-ember" : "bg-accent"}`} />}
      <WriterLabel label={label} />
    </button>
  );
}
