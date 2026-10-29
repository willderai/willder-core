"use client";

// Memory → Ask → Memory chat (#memory-chat). One field: the name memory chat uses for the person
// asking. Unset, chat uses the signed-in user's own name. Admins and owners can
// change it; the API refuses members.
import { useEffect, useState } from "react";
import { Card, Button } from "@/components/ui";

const ENDPOINT = "/api/settings/memory-chat";

export function MemoryChatPanel() {
  const [saved, setSaved] = useState<string>("");
  const [draft, setDraft] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [justSaved, setJustSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch(ENDPOINT)
      .then(async (r) => {
        if (!r.ok) throw new Error("Could not load the memory chat name");
        return (await r.json()) as { memoryChatName: string | null };
      })
      .then((data) => {
        setSaved(data.memoryChatName ?? "");
        setDraft(data.memoryChatName ?? "");
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : "Could not load the memory chat name"))
      .finally(() => setLoading(false));
  }, []);

  const dirty = draft.trim() !== saved;

  async function handleSave() {
    setSaving(true);
    setError(null);
    setJustSaved(false);
    try {
      const res = await fetch(ENDPOINT, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ memoryChatName: draft }),
      });
      const json = (await res.json()) as { memoryChatName?: string | null; error?: string };
      if (!res.ok) {
        setError(json.error ?? "Failed to save");
        return;
      }
      setSaved(json.memoryChatName ?? "");
      setDraft(json.memoryChatName ?? "");
      setJustSaved(true);
      setTimeout(() => setJustSaved(false), 2500);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div>
        <p className="text-base font-semibold text-fg">Memory chat</p>
        <p className="mt-0.5 text-sm text-fg-subtle">
          The name memory chat uses for the person asking. Leave it empty to use each person&apos;s own name.
        </p>
      </div>

      <Card glow="ember" className="space-y-4 p-6">
        <label htmlFor="memory-chat-name" className="block text-sm font-medium text-fg-muted">
          Name in memory chat
        </label>
        <input
          id="memory-chat-name"
          type="text"
          maxLength={100}
          disabled={loading}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={loading ? "Loading…" : 'e.g. "Jane" or "the Sales team"'}
          className="min-h-11 w-full rounded-xl border border-[var(--field-border)] bg-[var(--field-background)] px-4 py-2.5 text-sm text-fg placeholder:text-[var(--field-placeholder)] hover:border-[var(--field-border-hover)] focus-visible:border-[var(--field-border-focus)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-info"
        />
        <div className="flex items-center gap-3">
          <Button variant="primary" size="sm" disabled={loading || !dirty || saving} onClick={handleSave}>
            {saving ? "Saving…" : "Save"}
          </Button>
          {dirty && !saving && (
            <button onClick={() => setDraft(saved)} className="text-sm text-fg-subtle hover:text-fg">
              Discard
            </button>
          )}
          {justSaved && <span className="text-sm text-accent">Saved</span>}
          {error && (
            <span role="alert" className="text-sm text-danger">
              {error}
            </span>
          )}
        </div>
      </Card>
    </div>
  );
}
