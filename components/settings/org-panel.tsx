"use client";

// Settings › Members: the org's members, with an invite and a remove for admins.
//
// The list comes from GET /api/settings/members, a page at a time, searched,
// filtered by role and ordered on the server, so an org of any size is listed in
// full rather than the first page Clerk's client returns. Invites and removals
// still go through Clerk, which owns membership; the list here mirrors it through
// the membership webhook and sign-ins (services/access/membership.ts). When Clerk
// counts a different number of members than the list holds, the panel says so
// rather than leave a gap unexplained.

import { useCallback, useEffect, useState } from "react";
import { useOrganization, useUser } from "@clerk/nextjs";
import { TextField, Label, Input } from "@heroui/react";
import { Button, Card, Chip, Modal } from "@/components/ui";
import { ListControls, ListNoMatch, ListPagination } from "@/components/list-controls/list-controls";
import {
  compareText,
  compareTime,
  isNarrowed,
  type ListConfig,
  type ListState,
} from "@/components/list-controls/list-query";
import { useListState } from "@/components/list-controls/use-list-state";
import { serverListPage, useUrlPage } from "@/components/list-controls/use-url-page";
import { MAX_MEMBER_PAGE } from "@/lib/page-limits";

type MemberRole = "owner" | "admin" | "member";

type Member = {
  id: string;
  clerkId: string;
  name: string | null;
  email: string;
  role: MemberRole;
  joinedAt: string;
};

type MembersPage = { members: Member[]; total: number; memberCount: number; page: number; pageSize: number };

const ROLE_LABEL: Record<MemberRole, string> = { owner: "Owner", admin: "Admin", member: "Member" };

/**
 * How the members list searches, filters and orders. The server does the work
 * (GET /api/settings/members); these entries mirror what it matches, so the
 * toolbar and the URL describe the same view as the request.
 */
const MEMBER_LIST: ListConfig<Member> = {
  noun: { one: "member", many: "members" },
  searchText: (m) => [m.name, m.email],
  sorts: [
    {
      key: "name",
      label: "Name",
      compare: (a, b) => compareText(a.name ?? a.email, b.name ?? b.email),
      directionLabels: { asc: "A–Z", desc: "Z–A" },
    },
    { key: "role", label: "Role", compare: (a, b) => compareText(a.role, b.role) },
    {
      key: "joined",
      label: "Joined",
      compare: (a, b) => compareTime(a.joinedAt, b.joinedAt),
      defaultDirection: "desc",
      directionLabels: { asc: "Oldest first", desc: "Newest first" },
    },
  ],
  filters: [
    {
      key: "role",
      label: "Role",
      options: (Object.keys(ROLE_LABEL) as MemberRole[]).map((role) => ({ value: role, label: ROLE_LABEL[role] })),
      matches: (m, role) => m.role === role,
    },
  ],
  paramPrefix: "members.",
};

function membersUrl(view: ListState, page: number): string {
  const params = new URLSearchParams({ sort: view.sort, order: view.direction, page: String(page) });
  const query = view.query.trim();
  if (query !== "") params.set("q", query);
  if (view.filters.role) params.set("role", view.filters.role);
  return `/api/settings/members?${params}`;
}

type Loaded = { url: string; data: MembersPage } | { url: string; failed: true };

export function OrgPanel() {
  const { organization, membership, isLoaded } = useOrganization();
  const { user } = useUser();

  const listView = useListState(MEMBER_LIST);
  // The page is in the URL; a new search, filter or order starts again at page 1.
  const [page, setPage] = useUrlPage(
    `${MEMBER_LIST.paramPrefix}page`,
    JSON.stringify(listView.committed),
    MAX_MEMBER_PAGE,
  );
  const url = membersUrl(listView.committed, page);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [revision, setRevision] = useState(0);

  const [inviteOpen, setInviteOpen] = useState(false);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState("org:member");
  const [inviting, setInviting] = useState(false);
  const [inviteError, setInviteError] = useState<string | null>(null);
  const [inviteDone, setInviteDone] = useState(false);

  const [removingId, setRemovingId] = useState<string | null>(null);
  const [removeError, setRemoveError] = useState<string | null>(null);

  const isAdmin = membership?.role === "org:admin";

  useEffect(() => {
    const controller = new AbortController();
    fetch(url, { signal: controller.signal })
      .then(async (res) => {
        if (!res.ok) throw new Error(`GET ${url} failed: ${res.status}`);
        const data = (await res.json()) as MembersPage;
        if (!controller.signal.aborted) setLoaded({ url, data });
      })
      .catch(() => {
        if (!controller.signal.aborted) setLoaded({ url, failed: true });
      });
    return () => controller.abort();
  }, [url, revision]);

  const reload = useCallback(() => setRevision((r) => r + 1), []);

  async function handleInvite(e: React.FormEvent) {
    e.preventDefault();
    if (!organization || !inviteEmail.trim()) return;
    setInviting(true);
    setInviteError(null);
    try {
      await organization.inviteMembers({ emailAddresses: [inviteEmail.trim()], role: inviteRole });
      setInviteDone(true);
      setInviteEmail("");
      setTimeout(() => {
        setInviteOpen(false);
        setInviteDone(false);
      }, 1200);
    } catch (err) {
      setInviteError(err instanceof Error ? err.message : "Invite failed");
    } finally {
      setInviting(false);
    }
  }

  async function handleRemove(clerkUserId: string) {
    if (!organization) return;
    setRemovingId(clerkUserId);
    setRemoveError(null);
    try {
      await organization.removeMember(clerkUserId);
      reload();
    } catch (err) {
      setRemoveError(err instanceof Error ? err.message : "Could not remove the member");
    } finally {
      setRemovingId(null);
    }
  }

  if (!isLoaded) {
    return <p className="text-sm text-fg-subtle">Loading…</p>;
  }

  if (!organization) return null;

  const current = loaded?.url === url ? loaded : null;
  const data = current && "data" in current ? current.data : null;
  const shown = data?.members ?? [];
  const paging = data ? serverListPage({ ...data, rows: data.members }, setPage) : null;
  // Clerk owns membership; a different count means some changes have not reached this list yet.
  const unsynced = data && !isNarrowed(listView.committed) ? organization.membersCount - data.memberCount : 0;

  return (
    <div className="flex flex-col gap-8">
      {/* Members */}
      <Card glow="gold">
        <div className="flex items-center justify-between border-b border-divider px-6 py-4">
          <div>
            <h2 className="text-base font-semibold text-fg">Members</h2>
            <p className="mt-0.5 text-sm text-fg-subtle">
              {data ? `${data.memberCount.toLocaleString()} member${data.memberCount === 1 ? "" : "s"}` : "\u00a0"}
            </p>
          </div>
          {isAdmin && (
            <Button
              variant="primary"
              size="sm"
              onClick={() => {
                setInviteEmail("");
                setInviteError(null);
                setInviteOpen(true);
              }}
            >
              + Invite
            </Button>
          )}
        </div>

        {(data === null || data.memberCount > 1 || isNarrowed(listView.state)) && (
          <div className="border-b border-divider px-6 py-4">
            <ListControls
              config={MEMBER_LIST}
              controls={listView}
              total={data?.memberCount ?? null}
              shown={data?.total ?? null}
            />
          </div>
        )}

        {removeError && (
          <p role="alert" className="px-6 pt-4 text-sm text-danger">
            {removeError}
          </p>
        )}

        {current === null ? (
          <p role="status" className="px-6 py-8 text-center text-sm text-fg-subtle">
            Loading members…
          </p>
        ) : "failed" in current ? (
          <p role="alert" className="px-6 py-8 text-center text-sm text-danger">
            Could not load the members.{" "}
            <button type="button" onClick={reload} className="underline underline-offset-4">
              Try again
            </button>
          </p>
        ) : shown.length === 0 && isNarrowed(listView.committed) && page === 1 ? (
          <div className="p-6">
            <ListNoMatch config={MEMBER_LIST} controls={listView} />
          </div>
        ) : shown.length === 0 && page > 1 ? (
          // A removal can empty the last page; the pager is gone with its rows, so this is the way back.
          <p className="px-6 py-8 text-center text-sm text-fg-subtle">
            No members on this page.{" "}
            <button type="button" onClick={() => setPage(1)} className="underline underline-offset-4">
              Back to the first page
            </button>
          </p>
        ) : shown.length === 0 ? (
          <p className="px-6 py-8 text-center text-sm text-fg-subtle">No members yet.</p>
        ) : (
          <div className="divide-y divide-divider">
            {shown.map((m) => {
              const name = m.name || m.email || "Unknown";
              const isSelf = m.clerkId === user?.id;
              return (
                <div key={m.id} className="flex items-center gap-4 px-6 py-3.5">
                  <div
                    aria-hidden
                    className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-fg/10 text-sm font-semibold text-fg-subtle"
                  >
                    {name[0]?.toUpperCase()}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="truncate text-sm font-medium text-fg">
                      {name}
                      {isSelf && <span className="ml-1.5 text-fg-subtle">(you)</span>}
                    </p>
                    <p className="truncate text-sm text-fg-subtle">{m.email}</p>
                  </div>
                  <Chip tone="muted">{ROLE_LABEL[m.role]}</Chip>
                  {isAdmin && !isSelf && (
                    <button
                      onClick={() => handleRemove(m.clerkId)}
                      disabled={removingId === m.clerkId}
                      aria-label={`Remove ${name}`}
                      className="ml-2 text-sm text-fg-subtle transition-colors hover:text-danger disabled:opacity-40"
                    >
                      {removingId === m.clerkId ? "…" : "Remove"}
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {paging && shown.length > 0 && (
          <ListPagination className="border-t border-divider px-6 py-3" noun={MEMBER_LIST.noun} paging={paging} />
        )}
        {unsynced !== 0 && (
          <p className="border-t border-divider px-6 py-3 text-sm text-fg-subtle">
            {unsynced > 0
              ? `${unsynced.toLocaleString()} more ${unsynced === 1 ? "member has" : "members have"} joined in your identity provider and will appear here once synced.`
              : `${(-unsynced).toLocaleString()} ${unsynced === -1 ? "removal has" : "removals have"} not synced here yet.`}
          </p>
        )}
      </Card>

      {/* Invite modal */}
      {inviteOpen && (
        <Modal
          title="Invite member"
          glow="gold"
          onClose={() => {
            setInviteOpen(false);
            setInviteEmail("");
            setInviteError(null);
          }}
          footer={
            !inviteDone ? (
              <>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setInviteOpen(false);
                    setInviteEmail("");
                    setInviteError(null);
                  }}
                >
                  Cancel
                </Button>
                <Button type="submit" form="invite-form" variant="primary" size="sm" disabled={inviting}>
                  {inviting ? "Sending…" : "Send invite"}
                </Button>
              </>
            ) : undefined
          }
        >
          {inviteDone ? (
            <p className="text-sm text-fg-subtle">Invite sent!</p>
          ) : (
            <form id="invite-form" onSubmit={handleInvite} className="flex flex-col gap-4">
              <TextField value={inviteEmail} onChange={setInviteEmail} isRequired>
                <Label>Email address</Label>
                <Input type="email" placeholder="teammate@company.com" fullWidth />
              </TextField>
              <div className="flex flex-col gap-2">
                <label className="text-sm font-medium text-fg-muted">Role</label>
                <select
                  value={inviteRole}
                  onChange={(e) => setInviteRole(e.target.value)}
                  className="min-h-11 rounded-xl border border-[var(--field-border)] bg-[var(--field-background)] px-4 py-2.5 text-sm text-fg hover:border-[var(--field-border-hover)] focus-visible:border-[var(--field-border-focus)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-info"
                >
                  <option value="org:member">Member</option>
                  <option value="org:admin">Admin</option>
                </select>
              </div>
              {inviteError && <Chip tone="brick">{inviteError}</Chip>}
            </form>
          )}
        </Modal>
      )}
    </div>
  );
}
