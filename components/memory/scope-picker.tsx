"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { scopeSegmentLabel } from "./scope-label";

type Scope = { id: string; path: string; name: string };

// Custom scope dropdown. Always renders — shows the active scope and lets the
// user switch when multiple scopes are accessible.
// manageable=true (admins on the memory page only): adds inline create + delete.
export function ScopePicker({
  selected,
  onChange,
  manageable = false,
  align = "start",
  className,
}: {
  selected: string | null;
  onChange: (scope: string | null) => void;
  manageable?: boolean;
  /** Which trigger edge the open list lines up with from the `sm` width up. "end" keeps a picker at the right of a row from opening past the page edge. */
  align?: "start" | "end";
  className?: string;
}) {
  const [scopes, setScopes] = useState<Scope[]>([]);
  const [loading, setLoading] = useState(true);
  // Distinct from a genuinely empty scope list (scope-picker-silent-empty-
  // state-no-retry): a network failure and an HTTP error with a JSON body
  // must never both collapse into "no scopes" with no signal anything
  // failed, same class of bug ActorPicker's loadError closed for the audit
  // trail (audit-actor-identity-collision).
  const [loadError, setLoadError] = useState(false);
  // The route caps how many scopes it checks and sets `truncated` when the
  // org has more, so a member whose grants sort past the cap would otherwise
  // see a short or empty list with no sign anything was left out.
  const [truncated, setTruncated] = useState(false);
  // Separate from `loading` on purpose, same reasoning as ActorPicker's
  // `retrying`: `loading` drives the L~174 early return that replaces the
  // whole trigger with the disabled "Org root" placeholder, so reusing it
  // for a retry would hide the open dropdown and the error copy along with
  // it. `retrying` only changes the "Try again" button's own state.
  const [retrying, setRetrying] = useState(false);
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createName, setCreateName] = useState("");
  const [createBusy, setCreateBusy] = useState(false);
  const [createError, setCreateError] = useState("");
  const [confirmDelete, setConfirmDelete] = useState<Scope | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  const autoSelected = useRef(false);
  const subScopes = useMemo(() => scopes.filter((s) => s.path.includes(".")), [scopes]);
  const rootScope = useMemo(() => scopes.find((s) => !s.path.includes(".")), [scopes]);

  // The one fetch-and-apply path for the scope list, shared by the mount
  // effect, the "Try again" retry, and refreshScopes() below (post-create,
  // post-delete). All three hit the same endpoint with the same two failure
  // modes — a network throw, and an HTTP error with a JSON body that a bare
  // try/catch would still miss — so they share one implementation instead of
  // three copies drifting out of sync with each other (refreshScopes was
  // exactly that: a third copy that kept the old fetch-then-catch-to-empty
  // shape after the other two were fixed). On failure this leaves the
  // existing `scopes` untouched and only sets `loadError`, so a failed
  // refresh after a successful create/delete never silently replaces a
  // known-good list with an empty one.
  async function loadScopes(): Promise<void> {
    try {
      const r = await fetch("/api/memory/scopes");
      if (!r.ok) throw new Error(`GET /api/memory/scopes failed: ${r.status}`);
      const data = await r.json();
      setScopes(data.scopes ?? []);
      setTruncated(data.truncated === true);
      setLoadError(false);
    } catch {
      setLoadError(true);
    }
  }

  useEffect(() => {
    void (async () => {
      await loadScopes();
      setLoading(false);
    })();
  }, []);

  // A separate path from the mount effect above, wired only to the "Try
  // again" button's onClick, never to an effect — ScopePicker never
  // unmounts on close (only the `{open && ...}` dropdown JSX toggles), so
  // the mount-only effect had nothing left to trigger a real re-fetch on
  // retry/reopen.
  function retryLoadScopes() {
    if (retrying) return;
    setRetrying(true);
    // Leave `loadError` (and the error copy + this button) up until the
    // retry actually settles, don't clear it up front: only a genuine
    // success gets to clear it, same reasoning as ActorPicker's
    // retryLoadActors (actorpicker-degraded-retry-is-a-dead-end).
    loadScopes().finally(() => setRetrying(false));
  }

  useEffect(() => {
    if (loading || selected !== null || autoSelected.current) return;
    if (subScopes.length === 0 || rootScope) return;
    autoSelected.current = true;
    onChange(subScopes[0].path);
  }, [loading, selected, scopes.length, onChange]);

  useEffect(() => {
    if (!open) return;
    function onClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        closeDropdown();
      }
    }
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, [open]);

  function closeDropdown() {
    setOpen(false);
    setCreating(false);
    setCreateName("");
    setCreateError("");
    setConfirmDelete(null);
    setDeleteError("");
  }

  function select(path: string | null) {
    onChange(path);
    closeDropdown();
  }

  async function refreshScopes() {
    await loadScopes();
  }

  // Parent of newly created scope = currently selected scope, or root.
  const parentPath = selected ?? rootScope?.path ?? "";
  const parentLabel = selected
    ? (scopes.find((s) => s.path === selected)?.name ?? scopeSegmentLabel(selected.split(".").pop() ?? selected))
    : "Org root";

  // Full breadcrumb for the selected scope: ["Org root", "Acme", "Sales"]
  function getBreadcrumb(path: string | null): string[] {
    if (!path) return ["Org root"];
    const parts = path.split(".");
    const crumbs: string[] = ["Org root"];
    for (let i = 1; i < parts.length; i++) {
      const ancestorPath = parts.slice(0, i + 1).join(".");
      const found = scopes.find((s) => s.path === ancestorPath);
      crumbs.push(found?.name ?? scopeSegmentLabel(parts[i]));
    }
    return crumbs;
  }

  const breadcrumb = getBreadcrumb(selected);

  // For a scope row in the dropdown, get the parent name to show as context.
  function getParentName(path: string): string | null {
    const parts = path.split(".");
    if (parts.length <= 1) return null;
    const parentPath = parts.slice(0, -1).join(".");
    return scopes.find((s) => s.path === parentPath)?.name ?? null;
  }

  async function handleCreate() {
    const name = createName.trim();
    if (!name || createBusy) return;
    setCreateBusy(true);
    setCreateError("");
    try {
      const res = await fetch("/api/access/scopes", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, parentPath }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setCreateError(body.error ?? "create failed");
        return;
      }
      await refreshScopes();
      onChange(body.scope.path);
      closeDropdown();
    } catch {
      setCreateError("create failed");
    } finally {
      setCreateBusy(false);
    }
  }

  async function handleDelete(scope: Scope) {
    if (deleteBusy) return;
    setDeleteBusy(true);
    setDeleteError("");
    try {
      const res = await fetch(`/api/access/scopes/${scope.id}`, { method: "DELETE" });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setDeleteError(body.error ?? "delete failed");
        return;
      }
      if (selected === scope.path) onChange(null);
      await refreshScopes();
      setConfirmDelete(null);
    } catch {
      setDeleteError("delete failed");
    } finally {
      setDeleteBusy(false);
    }
  }

  const triggerCls =
    "flex w-full min-w-0 max-w-full items-center justify-between gap-2 rounded-full border border-divider bg-panel px-3 min-h-10 py-2 text-left text-sm text-fg-muted backdrop-blur-md transition-colors hover:border-accent/35 hover:text-fg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-info sm:w-auto";

  if (loading) {
    return (
      <div
        role="status"
        aria-label="Loading scopes"
        aria-busy="true"
        className={`${triggerCls} cursor-default${className ? ` ${className}` : ""}`}
      >
        <span className="min-w-0 break-all">{selected ?? "Loading scopes…"}</span>
      </div>
    );
  }

  return (
    <div ref={ref} className={`relative w-full min-w-0 max-w-full sm:w-auto${className ? ` ${className}` : ""}`}>
      {/* Trigger button */}
      <button
        type="button"
        onClick={() => (open ? closeDropdown() : setOpen(true))}
        className={triggerCls}
        title={selected ?? "Org root"}
      >
        <span className="flex min-w-0 flex-wrap items-center gap-1">
          {breadcrumb.map((crumb, i) => (
            <span key={i} className="flex min-w-0 max-w-full items-start gap-1">
              {i > 0 && <span className="shrink-0 text-fg-subtle">›</span>}
              <span
                className={`min-w-0 break-words [overflow-wrap:anywhere] ${i === breadcrumb.length - 1 ? "text-fg" : "text-fg-subtle"}`}
              >
                {crumb}
              </span>
            </span>
          ))}
        </span>
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

      {/* Dropdown panel */}
      {open && (
        <div
          className={`absolute left-0 top-full z-50 mt-2 min-w-[220px] max-w-[calc(100vw-2rem)] rounded-2xl border border-divider bg-panel shadow-2xl ${align === "end" ? "sm:left-auto sm:right-0" : ""}`}
        >
          <div className="flex flex-col gap-0.5 p-1.5">
            {/* Org root option */}
            <ScopeRow label="Org root" active={selected === null} onSelect={() => select(null)} />

            {/* Sub-scopes */}
            {subScopes.map((s) => (
              <div key={s.id}>
                <ScopeRow
                  label={s.name}
                  parentName={getParentName(s.path)}
                  active={selected === s.path}
                  depth={(s.path.split(".").length - 2) * 12}
                  onSelect={() => select(s.path)}
                  onDelete={
                    manageable
                      ? () => {
                          setConfirmDelete(s);
                          setDeleteError("");
                        }
                      : undefined
                  }
                />

                {/* Inline delete confirmation */}
                {confirmDelete?.id === s.id && (
                  <div className="mx-2 mb-1 mt-0.5 rounded-xl border border-danger/25 bg-surface px-3 py-3">
                    <p className="text-sm text-fg-muted">
                      Delete <span className="font-semibold text-fg">{s.name}</span>? Removes the scope and all its
                      grants.
                    </p>
                    {deleteError && <p className="mt-1 text-sm text-danger">{deleteError}</p>}
                    <div className="mt-2 flex items-center gap-2">
                      <button
                        onClick={() => void handleDelete(s)}
                        disabled={deleteBusy}
                        className="min-h-9 rounded-lg bg-danger px-3 text-sm font-semibold text-[var(--danger-foreground)] transition-opacity hover:opacity-90 disabled:opacity-50"
                      >
                        {deleteBusy ? "Deleting…" : "Delete"}
                      </button>
                      <button
                        onClick={() => {
                          setConfirmDelete(null);
                          setDeleteError("");
                        }}
                        className="min-h-9 rounded-lg px-3 text-sm text-fg-muted transition-colors hover:text-fg"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                )}
              </div>
            ))}

            {truncated && (
              <p role="note" className="px-3 py-2 text-sm text-fg-muted">
                This org has more scopes than this list can show. Some you can access may be missing.
              </p>
            )}

            {/* A failed load must surface even when the surviving list is
                not empty — e.g. a refresh after a successful delete failing
                leaves a known-stale list on screen with no signal anything
                is wrong. */}
            {!loading && loadError && (
              <div className="flex flex-col items-start gap-1 px-3 py-2">
                <p className="text-sm text-danger">Couldn&apos;t load scopes.</p>
                <button
                  type="button"
                  onClick={retryLoadScopes}
                  disabled={retrying}
                  aria-busy={retrying}
                  className="text-sm font-semibold text-fg underline underline-offset-2 hover:text-accent focus:outline-none disabled:cursor-wait disabled:text-fg-subtle disabled:no-underline"
                >
                  {retrying ? "Retrying…" : "Try again"}
                </button>
              </div>
            )}

            {/* Create scope — admin only */}
            {manageable && (
              <>
                <div className="my-1 border-t border-divider" />
                {creating ? (
                  <div className="flex flex-col gap-2 px-2 pb-1.5">
                    <p className="pt-0.5 text-sm text-fg-muted">
                      Under <span className="font-semibold text-fg">{parentLabel}</span>
                    </p>
                    <input
                      autoFocus
                      value={createName}
                      onChange={(e) => {
                        setCreateName(e.target.value);
                        setCreateError("");
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          void handleCreate();
                        }
                        if (e.key === "Escape") {
                          setCreating(false);
                          setCreateName("");
                          setCreateError("");
                        }
                      }}
                      placeholder="Scope name"
                      className="min-h-10 w-full rounded-xl border border-[var(--field-border)] bg-[var(--field-background)] px-3 py-2 text-sm text-fg placeholder:text-[var(--field-placeholder)] hover:border-[var(--field-border-hover)] focus-visible:border-[var(--field-border-focus)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-info"
                    />
                    {createError && <p className="text-sm text-danger">{createError}</p>}
                    <div className="flex gap-2">
                      <button
                        onClick={() => void handleCreate()}
                        disabled={createBusy || !createName.trim()}
                        className="min-h-9 flex-1 rounded-lg bg-action text-sm font-semibold text-action-foreground transition-opacity hover:opacity-90 disabled:opacity-40"
                      >
                        {createBusy ? "Creating…" : "Create"}
                      </button>
                      <button
                        onClick={() => {
                          setCreating(false);
                          setCreateName("");
                          setCreateError("");
                        }}
                        className="min-h-9 rounded-lg px-3 text-sm text-fg-muted transition-colors hover:text-fg"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => {
                      setCreating(true);
                      setConfirmDelete(null);
                    }}
                    className="flex min-h-10 w-full items-center gap-2 rounded-xl px-3 py-2 text-left text-sm text-fg-muted transition-colors hover:bg-fg/5 hover:text-fg"
                  >
                    <svg
                      width="11"
                      height="11"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2.5"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <path d="M12 5v14M5 12h14" />
                    </svg>
                    Create scope
                  </button>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function ScopeRow({
  label,
  parentName,
  active,
  depth = 0,
  onSelect,
  onDelete,
}: {
  label: string;
  parentName?: string | null;
  active: boolean;
  depth?: number;
  onSelect: () => void;
  onDelete?: () => void;
}) {
  return (
    <div className="group flex items-center gap-1" style={{ paddingLeft: depth > 0 ? `${depth}px` : undefined }}>
      <button
        type="button"
        onClick={onSelect}
        className={`flex min-h-10 min-w-0 flex-1 items-center gap-2 rounded-xl px-3 py-2 text-left text-sm transition-colors ${
          active ? "bg-fg/[0.08] font-semibold text-fg" : "text-fg-muted hover:bg-fg/5 hover:text-fg"
        }`}
      >
        {active && <span aria-hidden="true" className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />}
        <span className="flex min-w-0 flex-col gap-0 [overflow-wrap:anywhere]">
          <span>{label}</span>
          {parentName && <span className="text-sm font-normal text-fg-muted">in {parentName}</span>}
        </span>
      </button>
      {onDelete && (
        <button
          type="button"
          aria-label={`Delete ${label}`}
          onClick={(e) => {
            e.stopPropagation();
            onDelete();
          }}
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-fg-subtle opacity-0 transition hover:bg-danger/10 hover:text-danger focus-visible:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100"
        >
          <svg
            width="11"
            height="11"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M18 6 6 18M6 6l12 12" />
          </svg>
        </button>
      )}
    </div>
  );
}
