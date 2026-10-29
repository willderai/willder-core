"use client";

import { useState } from "react";
import { Card, Button, Chip } from "@/components/ui";
import { SortHeader } from "@/components/list-controls/list-controls";
import { compareText, type ListConfig } from "@/components/list-controls/list-query";
import { useListState } from "@/components/list-controls/use-list-state";
import type { OrgRoleRow } from "@/services/resolver/org-roles";
import { SearchPicker, type PickOption } from "@/components/search-picker/search-picker";
import { searchMembers } from "@/components/search-picker/pick-sources";
import { PagedSettingsList } from "./paged-settings-list";
import { failureReason } from "./failure-reason";

/**
 * How the role table searches and orders; its view lives under `roles.` in the URL.
 * The server does the work a page at a time (GET /api/settings/org-roles,
 * lib/settings-lists.ts), so the sorts name what that route accepts. Roles are
 * free-text titles, so there is nothing fixed to filter on.
 */
const ROLE_LIST: ListConfig<OrgRoleRow> = {
  noun: { one: "role", many: "roles" },
  searchText: (r) => [r.role, r.user.name, r.user.email, ...r.aliases],
  sorts: [
    {
      key: "role",
      label: "Role",
      compare: (a, b) => compareText(a.role, b.role),
      directionLabels: { asc: "A–Z", desc: "Z–A" },
    },
    {
      key: "person",
      label: "Person",
      compare: (a, b) => compareText(a.user.name ?? a.user.email, b.user.name ?? b.user.email),
      directionLabels: { asc: "A–Z", desc: "Z–A" },
    },
  ],
  paramPrefix: "roles.",
};

const inputCls =
  "min-h-11 min-w-0 w-full rounded-xl border border-[var(--field-border)] bg-[var(--field-background)] px-4 py-2.5 text-sm text-fg hover:border-[var(--field-border-hover)] focus-visible:border-[var(--field-border-focus)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-info placeholder:text-[var(--field-placeholder)]";
const labelCls = "text-sm font-medium text-fg-muted";
const MONO = "font-mono text-xs";
const TH = "px-4 py-3 text-left text-eyebrow font-semibold uppercase text-fg-subtle";

export function OrgRolesPanel() {
  const listView = useListState(ROLE_LIST);
  // Bumped after a save or remove, to read the current page again.
  const [revision, setRevision] = useState(0);
  const [showForm, setShowForm] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [removeErr, setRemoveErr] = useState<string | null>(null);

  const [form, setForm] = useState({
    role: "",
    aliasInput: "",
  });
  // The member the role maps to, searched on the server as the person types.
  const [person, setPerson] = useState<PickOption | null>(null);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!person) {
      setErr("Choose the person who holds this role.");
      return;
    }
    setSaving(true);
    setErr(null);
    try {
      const aliases = form.aliasInput
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      const res = await fetch("/api/settings/org-roles", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ role: form.role, userId: person.value, aliases }),
      });
      if (!res.ok) throw new Error(await failureReason(res));
      setShowForm(false);
      setForm({ role: "", aliasInput: "" });
      setPerson(null);
      setRevision((r) => r + 1);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "error");
    } finally {
      setSaving(false);
    }
  }

  // A refused or failed delete keeps the row and says why; only a delete the
  // server confirmed reloads the list.
  async function remove(row: OrgRoleRow) {
    setDeletingId(row.id);
    setRemoveErr(null);
    let failure: string | null = null;
    try {
      const res = await fetch(`/api/settings/org-roles/${row.id}`, { method: "DELETE" });
      if (!res.ok) failure = await failureReason(res);
    } catch (e) {
      failure = e instanceof Error ? e.message : "the request failed";
    }
    setDeletingId(null);
    if (failure !== null) {
      setRemoveErr(`Could not remove ${row.role}: ${failure}`);
      return;
    }
    setRevision((r) => r + 1);
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-base font-semibold text-fg">Org roles</p>
          <p className="mt-0.5 text-sm text-fg-subtle">
            Map job titles to people so &quot;our CEO&quot; resolves to a name before memory ingestion. Separate from
            Clerk permission roles — these are text-resolution aliases only.
          </p>
        </div>
        <Button variant="primary" size="sm" onClick={() => setShowForm((v) => !v)}>
          {showForm ? "Cancel" : "+ Add role"}
        </Button>
      </div>

      {showForm && (
        <Card glow="ember" className="p-6">
          <form onSubmit={save} className="flex flex-col gap-4">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="flex flex-col gap-2">
                <label className={labelCls}>Job title / role</label>
                <input
                  value={form.role}
                  onChange={(e) => setForm((f) => ({ ...f, role: e.target.value }))}
                  required
                  placeholder="e.g. CEO, CTO, Head of Sales"
                  className={inputCls}
                />
              </div>
              <div className="flex flex-col gap-2">
                <span className={labelCls}>Person</span>
                <SearchPicker
                  label="Person"
                  placeholder="Choose a member"
                  searchPlaceholder="Search by name or email"
                  selected={person}
                  onChange={setPerson}
                  search={searchMembers}
                />
              </div>
              <div className="sm:col-span-2 flex flex-col gap-2">
                <label className={labelCls}>Extra aliases (comma-separated)</label>
                <input
                  value={form.aliasInput}
                  onChange={(e) => setForm((f) => ({ ...f, aliasInput: e.target.value }))}
                  placeholder="the CEO, our CEO, Willder's CEO, founder"
                  className={inputCls}
                />
                <p className="text-sm text-fg-subtle">The job title itself is always included. Add variants here.</p>
              </div>
            </div>
            {err && <Chip tone="brick">{err}</Chip>}
            <div className="flex justify-end">
              <Button type="submit" variant="primary" size="sm" disabled={saving}>
                {saving ? "Saving…" : "Save role"}
              </Button>
            </div>
          </form>
        </Card>
      )}

      {removeErr && (
        <p role="alert">
          <Chip tone="brick">{removeErr}</Chip>
        </p>
      )}

      <PagedSettingsList
        path="/api/settings/org-roles"
        rowsKey="roles"
        config={ROLE_LIST}
        view={listView}
        revision={revision}
        onRetry={() => setRevision((r) => r + 1)}
        empty="No roles mapped yet. Add one above so job titles resolve to names in memory."
      >
        {(rows) => (
          <Card glow="gold" className="overflow-hidden">
            <div
              className="max-w-full overflow-x-auto overscroll-x-contain"
              role="region"
              aria-label="Organization roles"
              tabIndex={0}
            >
              <table className="w-full min-w-[36rem]">
                <thead>
                  <tr className="border-b border-divider">
                    <SortHeader config={ROLE_LIST} controls={listView} sortKey="role" className={TH} />
                    <SortHeader config={ROLE_LIST} controls={listView} sortKey="person" className={TH} />
                    <th scope="col" className={TH}>
                      Extra aliases
                    </th>
                    <th className={`${MONO} px-4 py-3`} />
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.id} className="border-b border-divider last:border-0 hover:bg-fg/[0.02]">
                      <td className="px-4 py-3">
                        <span className="text-sm font-medium text-fg">{r.role}</span>
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex flex-col gap-0.5">
                          <span className="text-sm text-fg">{r.user.name ?? r.user.email}</span>
                          {r.user.name && <span className="font-mono text-xs text-fg-subtle">{r.user.email}</span>}
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex flex-wrap gap-1">
                          {r.aliases.length > 0 ? (
                            r.aliases.map((a) => (
                              <span
                                key={a}
                                className="rounded-full border border-divider px-2 py-0.5 text-sm text-fg-muted"
                              >
                                {a}
                              </span>
                            ))
                          ) : (
                            <span className="text-sm text-fg-subtle">none</span>
                          )}
                        </div>
                      </td>
                      <td className="px-4 py-3 text-right">
                        <button
                          onClick={() => remove(r)}
                          disabled={deletingId === r.id}
                          className="text-sm font-semibold capitalize text-fg-muted hover:text-danger transition-colors disabled:opacity-40"
                        >
                          {deletingId === r.id ? "…" : "remove"}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        )}
      </PagedSettingsList>
    </div>
  );
}
