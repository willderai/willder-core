"use client";

import { useState } from "react";
import { Card, Button, Chip } from "@/components/ui";
import { SortHeader } from "@/components/list-controls/list-controls";
import { compareText, compareTime, type ListConfig } from "@/components/list-controls/list-query";
import { useListState } from "@/components/list-controls/use-list-state";
import { ALIAS_ENTITY_TYPES as ENTITY_TYPES } from "@/lib/settings-lists";
import type { AliasRow } from "@/services/memory/entity-aliases";
import { SearchPicker, type PickOption, type PickSearch } from "@/components/search-picker/search-picker";
import { searchAccounts, searchContacts, searchMembers } from "@/components/search-picker/pick-sources";
import { PagedSettingsList } from "./paged-settings-list";
import { failureReason } from "./failure-reason";

/** The entity types picked from a list, each with its field label and server search. */
const PICKED_ENTITIES: Partial<
  Record<
    (typeof ENTITY_TYPES)[number],
    { label: string; noun: string; placeholder: string; hint: string; search: PickSearch }
  >
> = {
  user: {
    label: "Member",
    noun: "member",
    placeholder: "Choose a member",
    hint: "Search by name or email",
    search: searchMembers,
  },
  contact: {
    label: "Contact",
    noun: "contact",
    placeholder: "Choose a contact",
    hint: "Search by name, email or title",
    search: searchContacts,
  },
  account: {
    label: "Account",
    noun: "account",
    placeholder: "Choose an account",
    hint: "Search by name or domain",
    search: searchAccounts,
  },
};

/**
 * How the aliases table searches, filters and orders; its view lives under `aliases.`
 * in the URL. The server does the work a page at a time (GET /api/settings/aliases,
 * lib/settings-lists.ts), so the sorts and filter name what that route accepts.
 */
const ALIAS_LIST: ListConfig<AliasRow> = {
  noun: { one: "alias entry", many: "alias entries" },
  searchText: (r) => [r.canonicalName, r.entityType, ...r.aliases],
  sorts: [
    {
      key: "name",
      label: "Canonical",
      compare: (a, b) => compareText(a.canonicalName, b.canonicalName),
      directionLabels: { asc: "A–Z", desc: "Z–A" },
    },
    {
      key: "type",
      label: "Type",
      compare: (a, b) => compareText(a.entityType, b.entityType),
      directionLabels: { asc: "A–Z", desc: "Z–A" },
    },
    {
      key: "created",
      label: "Date added",
      compare: (a, b) => compareTime(a.createdAt, b.createdAt),
      defaultDirection: "desc",
      directionLabels: { asc: "Oldest first", desc: "Newest first" },
    },
  ],
  filters: [
    {
      key: "type",
      label: "Type",
      options: ENTITY_TYPES.map((t) => ({ value: t, label: t[0].toUpperCase() + t.slice(1) })),
      matches: (r, type) => r.entityType === type,
    },
  ],
  paramPrefix: "aliases.",
};

const typeColor: Record<string, string> = {
  user: "text-gold",
  account: "text-ember",
  contact: "text-fg-muted",
  org: "text-danger",
};

const inputCls =
  "min-h-11 min-w-0 w-full rounded-xl border border-[var(--field-border)] bg-[var(--field-background)] px-4 py-2.5 text-sm text-fg hover:border-[var(--field-border-hover)] focus-visible:border-[var(--field-border-focus)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-info placeholder:text-[var(--field-placeholder)]";
const selectCls =
  "min-h-11 min-w-0 w-full rounded-xl border border-[var(--field-border)] bg-[var(--field-background)] px-4 py-2.5 text-sm text-fg hover:border-[var(--field-border-hover)] focus-visible:border-[var(--field-border-focus)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-info";
const labelCls = "text-sm font-medium text-fg-muted";
const MONO = "font-mono text-xs";
const TH = "px-4 py-3 text-left text-eyebrow font-semibold uppercase text-fg-subtle";

export function AliasesPanel() {
  const listView = useListState(ALIAS_LIST);
  // Bumped after a save or remove, to read the current page again.
  const [revision, setRevision] = useState(0);
  const [showForm, setShowForm] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [removeErr, setRemoveErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // The member, contact or account picked, label included; `form.entityId` is its id.
  const [entity, setEntity] = useState<PickOption | null>(null);

  const [form, setForm] = useState({
    entityId: "",
    entityType: "user" as (typeof ENTITY_TYPES)[number],
    canonicalName: "",
    aliasInput: "",
  });

  const picked = PICKED_ENTITIES[form.entityType];

  function pickEntity(option: PickOption) {
    setEntity(option);
    setForm((f) => ({ ...f, entityId: option.value, canonicalName: f.canonicalName || option.label }));
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (picked && !form.entityId) {
      setErr(`Choose the ${picked.noun} this alias names.`);
      return;
    }
    setSaving(true);
    setErr(null);
    try {
      const aliases = form.aliasInput
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      const res = await fetch("/api/settings/aliases", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          entityId: form.entityId,
          entityType: form.entityType,
          canonicalName: form.canonicalName,
          aliases,
        }),
      });
      if (!res.ok) throw new Error(await failureReason(res));
      setShowForm(false);
      setForm({ entityId: "", entityType: "user", canonicalName: "", aliasInput: "" });
      setEntity(null);
      setRevision((r) => r + 1);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "error");
    } finally {
      setSaving(false);
    }
  }

  // A refused or failed delete keeps the row and says why; only a delete the
  // server confirmed reloads the list.
  async function remove(row: AliasRow) {
    setDeletingId(row.id);
    setRemoveErr(null);
    let failure: string | null = null;
    try {
      const res = await fetch(`/api/settings/aliases/${row.id}`, { method: "DELETE" });
      if (!res.ok) failure = await failureReason(res);
    } catch (e) {
      failure = e instanceof Error ? e.message : "the request failed";
    }
    setDeletingId(null);
    if (failure !== null) {
      setRemoveErr(`Could not remove ${row.canonicalName}: ${failure}`);
      return;
    }
    setRevision((r) => r + 1);
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-base font-semibold text-fg">Entity aliases</p>
          <p className="mt-0.5 text-sm text-fg-subtle">
            Map nicknames, pronouns, and relational refs to canonical names before memory ingestion.
          </p>
        </div>
        <Button variant="primary" size="sm" onClick={() => setShowForm((v) => !v)}>
          {showForm ? "Cancel" : "+ Add alias"}
        </Button>
      </div>

      {showForm && (
        <Card glow="ember" className="p-6">
          <form onSubmit={save} className="flex flex-col gap-4">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="flex flex-col gap-2">
                <label className={labelCls}>Entity type</label>
                <select
                  value={form.entityType}
                  onChange={(e) => {
                    setEntity(null);
                    setForm((f) => ({
                      ...f,
                      entityType: e.target.value as (typeof ENTITY_TYPES)[number],
                      entityId: "",
                    }));
                  }}
                  className={selectCls}
                >
                  {ENTITY_TYPES.map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                </select>
              </div>
              <div className="flex flex-col gap-2">
                <span className={labelCls}>{picked?.label ?? "Entity"}</span>
                {picked ? (
                  <SearchPicker
                    label={picked.label}
                    placeholder={picked.placeholder}
                    searchPlaceholder={picked.hint}
                    selected={entity}
                    onChange={pickEntity}
                    search={picked.search}
                  />
                ) : (
                  <input
                    value={form.entityId}
                    onChange={(e) => setForm((f) => ({ ...f, entityId: e.target.value }))}
                    required
                    placeholder="Entity ID"
                    className={inputCls}
                  />
                )}
              </div>
              <div className="flex flex-col gap-2">
                <label className={labelCls}>Canonical name</label>
                <input
                  value={form.canonicalName}
                  onChange={(e) => setForm((f) => ({ ...f, canonicalName: e.target.value }))}
                  required
                  placeholder="e.g. Sarah Nguyen"
                  className={inputCls}
                />
              </div>
              <div className="flex flex-col gap-2">
                <label className={labelCls}>Aliases (comma-separated)</label>
                <input
                  value={form.aliasInput}
                  onChange={(e) => setForm((f) => ({ ...f, aliasInput: e.target.value }))}
                  placeholder="my mom, Mom, Sarah, sarah@co.com"
                  className={inputCls}
                />
              </div>
            </div>
            {err && <Chip tone="brick">{err}</Chip>}
            <div className="flex justify-end">
              <Button type="submit" variant="primary" size="sm" disabled={saving}>
                {saving ? "Saving…" : "Save alias"}
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
        path="/api/settings/aliases"
        rowsKey="aliases"
        config={ALIAS_LIST}
        view={listView}
        revision={revision}
        onRetry={() => setRevision((r) => r + 1)}
        empty="No aliases yet. Add one above to normalize entity references before ingestion."
      >
        {(rows) => (
          <Card glow="gold" className="overflow-hidden">
            <div
              className="max-w-full overflow-x-auto overscroll-x-contain"
              role="region"
              aria-label="Entity aliases"
              tabIndex={0}
            >
              <table className="w-full min-w-[36rem]">
                <thead>
                  <tr className="border-b border-divider">
                    <SortHeader config={ALIAS_LIST} controls={listView} sortKey="name" className={TH} />
                    <SortHeader config={ALIAS_LIST} controls={listView} sortKey="type" className={TH} />
                    <th scope="col" className={TH}>
                      Aliases
                    </th>
                    <th className={`${MONO} px-4 py-3`} />
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.id} className="border-b border-divider last:border-0 hover:bg-fg/[0.02]">
                      <td className="px-4 py-3">
                        <span className="text-sm font-medium text-fg">{r.canonicalName}</span>
                      </td>
                      <td className="px-4 py-3">
                        <span className={`${MONO} ${typeColor[r.entityType] ?? "text-fg-subtle"}`}>{r.entityType}</span>
                      </td>
                      <td className="px-4 py-3 max-w-xs">
                        <div className="flex flex-wrap gap-1">
                          {r.aliases.map((a) => (
                            <span
                              key={a}
                              className="rounded-full border border-divider px-2 py-0.5 text-sm text-fg-muted"
                            >
                              {a}
                            </span>
                          ))}
                          {r.aliases.length === 0 && <span className="text-sm text-fg-subtle">none</span>}
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
