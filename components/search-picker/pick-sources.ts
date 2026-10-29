/**
 * The searches behind each SearchPicker: one function per kind of row, each asking
 * its list route for one short page of matches (lib/pick-query.ts). They live at
 * module level so a picker's `search` prop keeps one identity across renders.
 */
import { displayWriterLabel } from "@/components/audit/format";
import { PICK_LIMIT } from "@/lib/pick-query";
import type { PickOption, PickResult } from "./search-picker";

async function readJson<T>(url: string, signal: AbortSignal): Promise<T> {
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`GET ${url.split("?")[0]} failed: ${res.status}`);
  return (await res.json()) as T;
}

function pickUrl(path: string, query: string): string {
  return `${path}?${new URLSearchParams({ limit: String(PICK_LIMIT), q: query })}`;
}

type Member = { id: string; name: string | null; email: string };

/** A member as the pickers show one: the name with the email beneath, or the email alone. */
export function memberOption(member: Member): PickOption {
  return member.name
    ? { value: member.id, label: displayWriterLabel(member.name), detail: member.email }
    : { value: member.id, label: member.email };
}

/** Org members by name or email, one page of the Settings members list. */
export async function searchMembers(query: string, signal: AbortSignal): Promise<PickResult> {
  const params = new URLSearchParams({ page: "1", sort: "name", order: "asc", q: query });
  const data = await readJson<{ members: Member[]; total: number }>(`/api/settings/members?${params}`, signal);
  return { options: data.members.map(memberOption), more: data.total > data.members.length };
}

/**
 * Agents, built-in and custom, by name or key. The value is the agent key, which
 * grants and tokens name an agent by, so a grant and a token for one agent match.
 */
export async function searchAgents(query: string, signal: AbortSignal): Promise<PickResult> {
  const data = await readJson<{ agents: { agentKey: string; name: string }[]; more: boolean }>(
    pickUrl("/api/agents", query),
    signal,
  );
  return {
    options: data.agents.map((a) => ({ value: a.agentKey, label: displayWriterLabel(a.name) })),
    more: data.more,
  };
}

/** Contacts by name, email or title. */
export async function searchContacts(query: string, signal: AbortSignal): Promise<PickResult> {
  const data = await readJson<{
    contacts: { id: string; name: string; email: string | null; title: string | null }[];
    more: boolean;
  }>(pickUrl("/api/contacts", query), signal);
  return {
    options: data.contacts.map((c) => ({
      value: c.id,
      label: c.name,
      detail: [c.title, c.email].filter(Boolean).join(" · ") || undefined,
    })),
    more: data.more,
  };
}

/** Accounts by name or domain. */
export async function searchAccounts(query: string, signal: AbortSignal): Promise<PickResult> {
  const data = await readJson<{ accounts: { id: string; name: string; domain: string | null }[]; more: boolean }>(
    pickUrl("/api/accounts", query),
    signal,
  );
  return {
    options: data.accounts.map((a) => ({ value: a.id, label: a.name, detail: a.domain ?? undefined })),
    more: data.more,
  };
}
