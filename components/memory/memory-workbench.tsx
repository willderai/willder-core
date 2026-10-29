"use client";

import { useRef, useState } from "react";
import type { MemoryFact, RetrievalBreakdown } from "@/types/memory";
import { Button, Card, Pill } from "@/components/ui";
import { Reveal } from "@/components/reveal";
import { ScopePicker } from "./scope-picker";
import { UploadButton } from "./upload-button";
import { HelpTip } from "@/components/help";
import { AlertCircle, ArrowUpRight, BookOpen, ChevronDown, Search, ShieldCheck } from "lucide-react";
import { FactProvenance } from "./fact-provenance";
import { RetrievalBreakdownRow } from "./retrieval-breakdown";
import { displayWriterLabel } from "@/components/audit/format";

type ChatIntent = "read" | "write" | "chat";
type ChatMode = "chat" | "ask" | "write";

const SAVE_WORDS = /\b(remember|save|store|note|record|keep track|log that|add that)\b/i;
const SEARCH_WORDS = /\b(what|who|when|where|how|tell me|find|look up|show me|do we|did|does|is there|any info)\b/i;
const LONG_INPUT_CHARS = 800;

function detectModeHint(mode: ChatMode, input: string): string | null {
  if (!input.trim() || mode === "chat") return null;
  if (input.length > LONG_INPUT_CHARS) return "That's a lot — try breaking it into smaller facts for better results.";
  if (mode === "ask" && SAVE_WORDS.test(input)) return "Switch to Write to save this.";
  if (mode === "write" && SEARCH_WORDS.test(input) && !SAVE_WORDS.test(input)) return "Switch to Ask to search memory.";
  return null;
}

type AskTurn = {
  kind: "ask";
  id: number;
  query: string;
  mode: ChatMode;
  scope: string | null;
  retrievedAt?: string;
  correctedFactIds?: string[];
  removedFactIds?: string[];
  intent?: ChatIntent;
  answer?: string;
  facts?: MemoryFact[];
  /** Which stores the read behind `facts` asked, and what it cost in context. */
  breakdown?: RetrievalBreakdown;
  error?: string;
  loading?: boolean;
  disambiguate?: { name: string; options: string[] };
  // write confirmation: show what will be stored, wait for user approval
  confirm?: { summary: string; episode: string; pendingContent?: string };
  // read with no facts: entities the user asked about that aren't in memory
  noData?: { entities: string[] };
  cancelled?: boolean;
};
type NoteTurn = { kind: "note"; id: number; text: string; tone: "ember" | "brick" };
type UploadTurn = { kind: "upload"; id: number; filename: string; done: boolean; error?: string };
type Turn = AskTurn | NoteTurn | UploadTurn;

// A secondary action has a hairline border and no fill; the composer's submit is the one filled button.
const SECONDARY =
  "inline-flex items-center justify-center gap-2 rounded-xl border border-divider text-sm font-semibold text-fg transition-colors hover:border-accent/35 hover:bg-fg/5 disabled:opacity-40";
const FIELD =
  "border border-[var(--field-border)] bg-[var(--field-background)] text-fg placeholder:text-[var(--field-placeholder)] hover:border-[var(--field-border-hover)] focus-visible:border-[var(--field-border-focus)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-info";
const EYEBROW = "text-eyebrow font-semibold uppercase text-fg-subtle";

export function MemoryWorkbench({
  canDelete,
  canWrite,
  canManageScopes,
  initialScope = null,
}: {
  canDelete: boolean;
  canWrite: boolean;
  canManageScopes: boolean;
  initialScope?: string | null;
}) {
  const [mode, setMode] = useState<ChatMode>("ask");
  const [scope, setScope] = useState<string | null>(initialScope);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);

  const modeHint = detectModeHint(mode, input);
  const [addingFact, setAddingFact] = useState(false);
  const [newFact, setNewFact] = useState("");
  const [addingBusy, setAddingBusy] = useState(false);
  const nextId = useRef(1);
  const inputRef = useRef<HTMLInputElement>(null);

  const addNote = (text: string, tone: "ember" | "brick") =>
    setTurns((t) => [...t, { kind: "note", id: nextId.current++, text, tone }]);

  function reviseQuestion(turn: AskTurn) {
    setInput(turn.query);
    setMode(turn.mode);
    setScope(turn.scope);
    inputRef.current?.focus();
  }

  function buildHistory(
    snapshot: Turn[],
    requestScope: string | null,
    requestMode: ChatMode,
  ): { role: "user" | "assistant"; content: string }[] {
    const out: { role: "user" | "assistant"; content: string }[] = [];
    for (const t of snapshot) {
      // Conversation history is model context too. A new scope or mode must
      // not inherit answers retrieved under a different memory boundary.
      if (t.kind !== "ask" || !t.answer || t.error || t.scope !== requestScope || t.mode !== requestMode) continue;
      out.push({ role: "user", content: t.query });
      out.push({ role: "assistant", content: t.answer });
    }
    return out.slice(-10);
  }

  async function submitQuery(
    queryStr: string,
    opts?: {
      confirmed?: boolean;
      turnId?: number;
      disambiguated?: boolean;
      pendingContent?: string;
      context?: Pick<AskTurn, "mode" | "scope">;
    },
  ) {
    if (!queryStr || busy) return;
    setBusy(true);

    let id: number;
    const snapshot = turns; // capture before any setState
    // Results and confirmations retain their original scope if the composer changes.
    const existingTurn =
      opts?.turnId === undefined
        ? undefined
        : snapshot.find((turn): turn is AskTurn => turn.kind === "ask" && turn.id === opts.turnId);
    const requestContext = opts?.context ?? existingTurn;
    const requestMode = requestContext?.mode ?? mode;
    const requestScope = requestContext ? requestContext.scope : scope;

    if (opts?.turnId !== undefined) {
      // Confirmation resubmit — update the existing turn in-place, no new bubble.
      id = opts.turnId;
      setTurns((t) =>
        t.map((x) =>
          x.kind === "ask" && x.id === id
            ? { ...x, loading: true, confirm: undefined, answer: undefined, error: undefined, noData: undefined }
            : x,
        ),
      );
    } else {
      id = nextId.current++;
      setInput("");
      setTurns((t) => [
        ...t,
        { kind: "ask", id, query: queryStr, mode: requestMode, scope: requestScope, loading: true },
      ]);
    }

    const history = buildHistory(snapshot, requestScope, requestMode);

    try {
      const res = await fetch("/api/memory/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          query: queryStr,
          history,
          confirmed: opts?.confirmed,
          pendingContent: opts?.pendingContent,
          disambiguated: opts?.disambiguated,
          mode: requestMode,
          scope: requestScope ?? undefined,
        }),
      });

      if (!res.ok || !res.body) {
        const err = await res.json().catch(() => ({}));
        setTurns((t) =>
          t.map((turn) =>
            turn.kind === "ask" && turn.id === id
              ? { ...turn, loading: false, error: err.error ?? "request failed" }
              : turn,
          ),
        );
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      let completed = false;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          try {
            const event = JSON.parse(line.slice(6)) as {
              type: string;
              intent?: ChatIntent;
              facts?: MemoryFact[];
              breakdown?: RetrievalBreakdown;
              text?: string;
              error?: string;
              name?: string;
              options?: string[];
              summary?: string;
              episode?: string;
              pendingContent?: string;
              entities?: string[];
            };
            if (event.type === "intent" && event.intent) {
              setTurns((t) =>
                t.map((turn) => (turn.kind === "ask" && turn.id === id ? { ...turn, intent: event.intent } : turn)),
              );
            } else if (event.type === "disambiguate" && event.name && event.options) {
              setTurns((t) =>
                t.map((turn) =>
                  turn.kind === "ask" && turn.id === id
                    ? { ...turn, loading: false, disambiguate: { name: event.name!, options: event.options! } }
                    : turn,
                ),
              );
            } else if (event.type === "confirm" && event.summary) {
              setTurns((t) =>
                t.map((turn) =>
                  turn.kind === "ask" && turn.id === id
                    ? {
                        ...turn,
                        loading: false,
                        confirm: {
                          summary: event.summary!,
                          episode: event.episode ?? event.summary!,
                          pendingContent: event.pendingContent,
                        },
                      }
                    : turn,
                ),
              );
            } else if (event.type === "no_data") {
              setTurns((t) =>
                t.map((turn) =>
                  turn.kind === "ask" && turn.id === id
                    ? { ...turn, noData: { entities: event.entities ?? [] } }
                    : turn,
                ),
              );
            } else if (event.type === "facts") {
              setTurns((t) =>
                t.map((turn) =>
                  turn.kind === "ask" && turn.id === id
                    ? {
                        ...turn,
                        facts: event.facts ?? [],
                        breakdown: event.breakdown,
                        retrievedAt: new Date().toISOString(),
                      }
                    : turn,
                ),
              );
            } else if (event.type === "delta" && event.text) {
              setTurns((t) =>
                t.map((turn) =>
                  turn.kind === "ask" && turn.id === id ? { ...turn, answer: (turn.answer ?? "") + event.text } : turn,
                ),
              );
            } else if (event.type === "done") {
              completed = true;
              setTurns((t) =>
                t.map((turn) => (turn.kind === "ask" && turn.id === id ? { ...turn, loading: false } : turn)),
              );
            } else if (event.type === "error") {
              completed = true;
              setTurns((t) =>
                t.map((turn) =>
                  turn.kind === "ask" && turn.id === id
                    ? { ...turn, loading: false, error: event.error ?? "generation failed" }
                    : turn,
                ),
              );
            }
          } catch {
            // malformed SSE line — skip
          }
        }
      }
      if (!completed) {
        setTurns((current) =>
          current.map((turn) =>
            turn.kind === "ask" && turn.id === id
              ? {
                  ...turn,
                  loading: false,
                  error: "The connection ended before the response finished. Your message is available to try again.",
                }
              : turn,
          ),
        );
      }
    } catch {
      setTurns((t) =>
        t.map((turn) =>
          turn.kind === "ask" && turn.id === id ? { ...turn, loading: false, error: "network error" } : turn,
        ),
      );
    } finally {
      setBusy(false);
    }
  }

  function ask(e: React.FormEvent) {
    e.preventDefault();
    void submitQuery(input.trim());
  }

  async function submitFact(e: React.FormEvent) {
    e.preventDefault();
    const fact = newFact.trim();
    if (!fact || addingBusy) return;
    setAddingBusy(true);
    try {
      const res = await fetch("/api/memory/facts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ fact, scope: scope ?? undefined }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? "add failed");
      setNewFact("");
      setAddingFact(false);
      addNote("Fact added — extracting into memory…", "ember");
    } catch (err) {
      addNote(err instanceof Error ? err.message : "add failed", "brick");
    } finally {
      setAddingBusy(false);
    }
  }

  function removeFactFromTurn(turnId: number, uuid: string) {
    setTurns((t) =>
      t.map((x) =>
        x.kind === "ask" && x.id === turnId
          ? // Keep the retrieval snapshot and its citation numbers stable after
            // removal, while preventing further mutations of the removed fact.
            { ...x, removedFactIds: [...new Set([...(x.removedFactIds ?? []), uuid])] }
          : x,
      ),
    );
  }

  function updateFactInTurn(turnId: number, uuid: string) {
    setTurns((t) =>
      t.map((x) =>
        x.kind === "ask" && x.id === turnId
          ? {
              ...x,
              // A correction queues a replacement; its new provenance is not
              // available yet. Keep this retrieved snapshot instead of putting
              // new text under the original fact's ID and source attribution.
              correctedFactIds: [...new Set([...(x.correctedFactIds ?? []), uuid])],
            }
          : x,
      ),
    );
  }

  return (
    <Reveal className="mt-4 sm:mt-6">
      <div className="mx-auto flex max-w-4xl flex-col gap-6 pb-8">
        {turns.length === 0 && (
          <Card className="relative overflow-hidden px-5 py-10 text-center sm:px-8 sm:py-12">
            <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full border border-accent/20 bg-accent/[0.06] text-accent">
              <BookOpen size={21} strokeWidth={1.5} aria-hidden="true" />
            </div>
            <p className="text-lg font-semibold text-fg">
              {mode === "chat"
                ? "Chat without memory."
                : mode === "ask"
                  ? "Know what your agents know."
                  : "Give your agents useful context."}
            </p>
            <p className="mx-auto mt-2 max-w-md text-base leading-relaxed text-fg-muted">
              {mode === "chat"
                ? "Conversational mode — memory is not accessed."
                : mode === "ask"
                  ? "Choose where to look. Ask a question. See the facts and sources behind the response."
                  : "Save a note or upload a document. Review what will be stored before adding it to memory."}
            </p>
            {mode === "ask" && (
              <div className="mx-auto mt-6 flex max-w-lg flex-wrap justify-center gap-2">
                {["What decisions have we made?", "Who owns the next release?"].map((question) => (
                  <button
                    key={question}
                    type="button"
                    onClick={() => {
                      setInput(question);
                      inputRef.current?.focus();
                    }}
                    className="flex min-h-11 items-center gap-2 rounded-xl border border-divider px-3.5 py-2 text-sm text-fg-muted transition-colors hover:border-accent/35 hover:bg-fg/5 hover:text-fg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-info"
                  >
                    {question}
                    <ArrowUpRight size={14} aria-hidden="true" />
                  </button>
                ))}
              </div>
            )}
            {canWrite && mode === "write" && (
              <>
                <p className="mt-4 text-base text-fg-muted">
                  Upload a file (.txt, .md, .csv) or add a fact directly below.
                </p>
                <p className="mt-2 text-sm text-fg-subtle">
                  Org roles and entity aliases are configuration — manage them in Settings, not here.
                </p>
              </>
            )}
          </Card>
        )}

        {turns.map((turn) =>
          turn.kind === "note" ? (
            <div key={turn.id} className="flex justify-center">
              <Pill dot={turn.tone === "brick" ? "brick" : "ember"}>{turn.text}</Pill>
            </div>
          ) : turn.kind === "upload" ? (
            <div
              key={turn.id}
              className="flex items-center gap-3 self-start rounded-xl border border-divider bg-fg/[0.03] px-4 py-3"
            >
              {turn.error ? (
                <>
                  <span className="h-2 w-2 shrink-0 rounded-full bg-danger" />
                  <span className="text-sm text-danger">{turn.error}</span>
                </>
              ) : turn.done ? (
                <>
                  <span className="h-2 w-2 shrink-0 rounded-full bg-ember" />
                  <span className="text-sm text-fg-muted">
                    <span className="font-semibold text-fg">&quot;{turn.filename}&quot;</span> uploaded — processing in
                    background. Refresh the graph in ~20s.
                  </span>
                </>
              ) : (
                <>
                  <span className="h-2 w-2 shrink-0 rounded-full bg-accent motion-safe:animate-pulse" />
                  <span className="text-sm text-fg-muted">
                    Uploading <span className="font-semibold text-fg">&quot;{turn.filename}&quot;</span>…
                  </span>
                </>
              )}
            </div>
          ) : (
            <div key={turn.id} className="flex flex-col gap-4">
              {/* user bubble */}
              <div className="max-w-[90%] break-words self-end rounded-2xl rounded-br-md border border-divider bg-fg/[0.05] px-4 py-3 text-base leading-relaxed text-fg sm:max-w-[80%]">
                {turn.query}
              </div>

              {turn.loading && !turn.answer ? (
                <div role="status" className="flex items-center gap-2.5 self-start text-fg-muted">
                  <span
                    className="h-4 w-4 rounded-full border border-info/25 border-t-info motion-safe:animate-spin"
                    aria-hidden="true"
                  />
                  <span className="text-sm">
                    {turn.mode === "chat"
                      ? "Preparing a response…"
                      : turn.mode === "write"
                        ? "Preparing your memory update…"
                        : "Searching your accessible memory…"}
                  </span>
                </div>
              ) : turn.error ? (
                <div
                  role="alert"
                  className="flex items-start gap-3 rounded-xl border border-danger/20 bg-danger/[0.04] p-4"
                >
                  <AlertCircle size={17} className="mt-0.5 shrink-0 text-danger" aria-hidden="true" />
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-fg">The request couldn’t finish</p>
                    <p className="mt-1 break-words text-sm text-fg-muted">{turn.error}</p>
                    <button
                      type="button"
                      onClick={() => reviseQuestion(turn)}
                      className="mt-3 min-h-9 rounded-md text-sm font-medium text-info underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-info"
                    >
                      Edit and try again
                    </button>
                  </div>
                </div>
              ) : turn.cancelled ? (
                <span className="self-start text-sm text-fg-subtle">Cancelled.</span>
              ) : turn.disambiguate ? (
                <DisambiguatePanel
                  name={turn.disambiguate.name}
                  options={turn.disambiguate.options}
                  originalQuery={turn.query}
                  onSelect={(refined) => void submitQuery(refined, { disambiguated: true, context: turn })}
                />
              ) : turn.confirm ? (
                <ConfirmPanel
                  summary={turn.confirm.summary}
                  episode={turn.confirm.episode}
                  scope={turn.scope}
                  onConfirm={() =>
                    void submitQuery(turn.query, {
                      confirmed: true,
                      turnId: turn.id,
                      pendingContent: turn.confirm?.pendingContent,
                    })
                  }
                  onCancel={() =>
                    setTurns((t) =>
                      t.map((x) =>
                        x.kind === "ask" && x.id === turn.id ? { ...x, confirm: undefined, cancelled: true } : x,
                      ),
                    )
                  }
                />
              ) : (
                <div className="flex flex-col gap-3">
                  {/* streaming answer */}
                  {(turn.answer !== undefined || turn.loading) && (
                    <div className="w-full text-base leading-relaxed text-fg">
                      <p className={`mb-2 ${EYEBROW}`}>
                        {turn.intent === "write"
                          ? "Memory update"
                          : turn.mode === "chat"
                            ? "Conversation · no memory search"
                            : "Generated answer"}
                      </p>
                      <span className="whitespace-pre-wrap break-words">{turn.answer ?? ""}</span>
                      {turn.loading && (
                        <span className="ml-0.5 inline-block h-4 w-0.5 bg-fg-subtle motion-safe:animate-pulse" />
                      )}
                    </div>
                  )}

                  {/* write path: saved badge */}
                  {turn.intent === "write" && !turn.loading && turn.answer !== undefined && (
                    <span className="inline-flex items-center gap-1.5 self-start rounded-full border border-divider px-2.5 py-1 text-sm text-fg-muted">
                      <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-ember" />
                      <span className="first-letter:uppercase">memory update submitted</span>
                    </span>
                  )}

                  {turn.intent !== "write" && !turn.loading && turn.breakdown && (
                    <RetrievalBreakdownRow breakdown={turn.breakdown} />
                  )}

                  {/* read path: sources */}
                  {turn.intent !== "write" && turn.facts !== undefined && (
                    <SourcesList
                      turnId={turn.id}
                      facts={turn.facts ?? []}
                      scope={turn.scope}
                      retrievedAt={turn.retrievedAt}
                      correctedFactIds={turn.correctedFactIds}
                      removedFactIds={turn.removedFactIds}
                      canDelete={canDelete}
                      canWrite={canWrite}
                      onRemoved={(uuid) => removeFactFromTurn(turn.id, uuid)}
                      onEdited={(uuid) => updateFactInTurn(turn.id, uuid)}
                      onNote={addNote}
                      onRevise={() => reviseQuestion(turn)}
                    />
                  )}

                  {/* no-data prompt: suggest adding the missing entities */}
                  {turn.noData && !turn.loading && canWrite && (
                    <div className="flex flex-wrap items-center gap-2 self-start">
                      {turn.noData.entities.length > 0 ? (
                        turn.noData.entities.map((e) => (
                          <button
                            key={e}
                            onClick={() => {
                              setMode("write");
                              setScope(turn.scope);
                              setInput(`${e} is `);
                            }}
                            className={`${SECONDARY} min-h-10 px-3 py-1.5`}
                          >
                            + Add {e} to memory
                          </button>
                        ))
                      ) : (
                        <button
                          onClick={() => {
                            setMode("write");
                            setScope(turn.scope);
                            setInput("");
                          }}
                          className={`${SECONDARY} min-h-10 px-3 py-1.5`}
                        >
                          + Add to memory
                        </button>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
          ),
        )}

        {/* composer */}
        <div className="z-10 mt-4 flex flex-col gap-3 border-t border-divider bg-ink pb-5 pt-4 sm:sticky sm:bottom-0">
          {/* mode selector */}
          <div className="flex flex-wrap items-center justify-between gap-3">
            <HelpTip tip="Ask: search memory without changing it. Write: add information after confirmation. Chat: talk without accessing memory.">
              <div className="flex items-center gap-1 self-start rounded-full border border-divider bg-fg/[0.03] p-1">
                {(["ask", ...(canWrite ? ["write"] : []), "chat"] as ChatMode[]).map((m) => (
                  <button
                    key={m}
                    type="button"
                    aria-pressed={mode === m}
                    onClick={() => setMode(m)}
                    className={`min-h-10 rounded-full px-4 py-2 text-sm font-semibold capitalize transition-colors focus-visible:outline-2 focus-visible:outline-info ${
                      mode === m ? "bg-accent/15 text-fg dark:text-accent" : "text-fg-subtle hover:text-fg"
                    }`}
                  >
                    {m}
                  </button>
                ))}
              </div>
            </HelpTip>
            {mode !== "chat" && (
              <div className="flex w-full min-w-0 flex-wrap items-center gap-2 sm:w-auto">
                <span className="flex items-center gap-1.5 text-sm text-fg-subtle">
                  <ShieldCheck size={14} aria-hidden="true" />
                  {mode === "write" ? "Save into" : "Search within"}
                </span>
                <ScopePicker selected={scope} onChange={setScope} manageable={canManageScopes} align="end" />
              </div>
            )}
          </div>
          <p id="memory-mode-description" className="px-1 text-sm leading-relaxed text-fg-subtle">
            {mode === "chat"
              ? "Memory is off. This conversation does not search or change this workspace's memory."
              : mode === "ask"
                ? "Only memory you can access in this scope is searched. Asking does not change it."
                : "New information goes into this scope. Your permission is checked when you save."}
          </p>

          {modeHint && <p className="px-1 text-sm text-fg-subtle">{modeHint}</p>}
          <form onSubmit={ask} className="flex flex-wrap items-center gap-2.5">
            {canWrite && mode === "write" && (
              <HelpTip tip="Upload a .txt, .md, or .csv file — its contents are extracted into memory.">
                <UploadButton
                  scope={scope}
                  onStarted={(name) => {
                    const id = nextId.current++;
                    setTurns((t) => [...t, { kind: "upload", id, filename: name, done: false }]);
                  }}
                  onUploaded={(name) => {
                    setTurns((t) =>
                      t.map((x) => (x.kind === "upload" && x.filename === name && !x.done ? { ...x, done: true } : x)),
                    );
                  }}
                  onError={(msg) => {
                    setTurns((t) =>
                      t.map((x) => (x.kind === "upload" && !x.done ? { ...x, done: true, error: msg } : x)),
                    );
                  }}
                />
              </HelpTip>
            )}
            <input
              ref={inputRef}
              aria-label={mode === "chat" ? "Chat message" : mode === "ask" ? "Ask memory" : "Write to memory"}
              aria-describedby="memory-mode-description"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder={
                mode === "chat"
                  ? "Chat without memory…"
                  : mode === "ask"
                    ? "Ask memory…"
                    : "Ask or tell memory something…"
              }
              className={`order-first min-h-11 min-w-0 basis-full flex-1 rounded-xl px-4 py-3 text-base backdrop-blur-md transition-colors ${FIELD} sm:order-none sm:basis-0`}
            />
            <HelpTip tip="Submit your message to memory.">
              <Button
                type="submit"
                size="lg"
                className="ml-auto min-w-24 sm:ml-0 sm:min-w-0"
                disabled={busy || !input.trim()}
              >
                {mode === "chat" ? "Chat" : mode === "ask" ? "Ask" : "Send"}
              </Button>
            </HelpTip>
            {canWrite && mode === "write" && (
              <HelpTip tip="Open a quick form to type a single fact directly into memory.">
                <button
                  type="button"
                  onClick={() => setAddingFact((v) => !v)}
                  title="Add a fact"
                  aria-label="Add a fact"
                  className={`${SECONDARY} min-h-11 shrink-0 px-4`}
                >
                  <svg
                    width="16"
                    height="16"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M12 5v14M5 12h14" />
                  </svg>
                </button>
              </HelpTip>
            )}
          </form>

          {addingFact && canWrite && (
            <form
              onSubmit={submitFact}
              className="flex flex-col items-stretch gap-3 rounded-xl border border-[var(--field-border)] bg-[var(--field-background)] p-4 backdrop-blur-md focus-within:border-[var(--field-border-focus)] sm:flex-row sm:items-start"
            >
              <textarea
                aria-label="New fact"
                value={newFact}
                onChange={(e) => setNewFact(e.target.value)}
                placeholder='State a fact, e.g. "Acme Corp uses Salesforce and has 200 employees."'
                rows={2}
                className="min-w-0 flex-1 resize-none border-0 bg-transparent text-base text-fg outline-none placeholder:text-[var(--field-placeholder)]"
                autoFocus
              />
              <div className="flex shrink-0 gap-1.5 sm:flex-col">
                <Button type="submit" size="sm" disabled={addingBusy || !newFact.trim()}>
                  {addingBusy ? "Adding…" : "Add"}
                </Button>
                <button
                  type="button"
                  onClick={() => {
                    setAddingFact(false);
                    setNewFact("");
                  }}
                  className="min-h-9 rounded-lg px-3 text-sm text-fg-subtle transition-colors hover:text-fg"
                >
                  Cancel
                </button>
              </div>
            </form>
          )}
        </div>
      </div>
    </Reveal>
  );
}

function SourcesList({
  turnId,
  facts,
  scope,
  retrievedAt,
  correctedFactIds = [],
  removedFactIds = [],
  canDelete,
  canWrite,
  onRemoved,
  onEdited,
  onNote,
  onRevise,
}: {
  turnId: number;
  facts: MemoryFact[];
  scope: string | null;
  retrievedAt?: string;
  correctedFactIds?: string[];
  removedFactIds?: string[];
  canDelete: boolean;
  canWrite: boolean;
  onRemoved: (uuid: string) => void;
  onEdited: (uuid: string, text: string) => void;
  onNote: (text: string, tone: "ember" | "brick") => void;
  onRevise: () => void;
}) {
  const [open, setOpen] = useState(facts.length === 0);
  const sourceCount = new Set(facts.map((fact) => fact.sourceId).filter(Boolean)).size;
  const factsWithoutSource = facts.filter((fact) => !fact.sourceId).length;

  return (
    <section className="w-full rounded-2xl border border-divider bg-fg/[0.02]" aria-label="Retrieved context">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={`retrieved-context-${turnId}`}
        onClick={() => setOpen((v) => !v)}
        className="flex min-h-16 w-full items-center gap-3 rounded-2xl px-4 py-3 text-left transition-colors hover:bg-fg/[0.03] sm:px-5"
      >
        <Search size={17} className="shrink-0 text-info" aria-hidden="true" />
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-semibold text-fg">
            Retrieved context{" "}
            <span className="ml-1.5 font-mono text-xs font-normal text-fg-subtle">
              {facts.length} {facts.length === 1 ? "fact" : "facts"}
            </span>
          </span>
          <span className="mt-1 block break-words text-sm leading-relaxed text-fg-subtle">
            {facts.length === 0
              ? "No matching context returned"
              : sourceCount > 0
                ? `${sourceCount} identified ${sourceCount === 1 ? "source" : "sources"}`
                : "Source information not recorded"}
            <span className="mx-1.5" aria-hidden="true">
              ·
            </span>
            <span>{scope || "Organization root"}</span>
          </span>
        </span>
        <ChevronDown
          size={16}
          className={`shrink-0 text-fg-subtle transition-transform motion-reduce:transition-none ${open ? "rotate-180" : ""}`}
          aria-hidden="true"
        />
      </button>

      {open && (
        <div id={`retrieved-context-${turnId}`} className="border-t border-divider px-4 pb-2 pt-4 sm:px-5">
          <div className="mb-3 flex flex-wrap items-start justify-between gap-x-4 gap-y-1 text-sm text-fg-subtle">
            <span className="flex min-w-0 items-start gap-1.5">
              <ShieldCheck size={13} className="mt-0.5 shrink-0" aria-hidden="true" />
              <span>
                Search scope{" "}
                <span className="ml-1 break-all font-mono text-xs text-fg-muted">{scope || "Organization root"}</span>
              </span>
            </span>
            {retrievedAt && (
              <time dateTime={retrievedAt} title={retrievedAt} className="font-mono text-xs">
                Received {new Date(retrievedAt).toLocaleTimeString()}
              </time>
            )}
          </div>
          {facts.length > 0 && (
            <p className="mb-2 text-sm leading-relaxed text-fg-subtle">
              These facts were returned to the assistant. The answer may use only some of them.
              {factsWithoutSource > 0 &&
                ` A source is not recorded for ${factsWithoutSource} ${factsWithoutSource === 1 ? "fact" : "facts"}.`}
            </p>
          )}
          {facts.length === 0 && (
            <div className="mb-3 py-2">
              <p className="text-sm font-semibold text-fg">No matching facts were returned in this search scope.</p>
              <p className="mt-1.5 text-sm leading-relaxed text-fg-muted">
                Try a specific project, person, or decision. If the information belongs elsewhere, select that scope
                before asking again.
              </p>
              <button
                type="button"
                onClick={onRevise}
                className={`${SECONDARY} mt-3 min-h-10 px-3 focus-visible:outline-2 focus-visible:outline-info`}
              >
                Revise question
              </button>
            </div>
          )}
          <div className="divide-y divide-divider">
            {facts.map((f, index) => (
              <FactCard
                key={`${turnId}-${f.uuid}`}
                fact={f}
                citation={index + 1}
                correctionPending={correctedFactIds.includes(f.uuid)}
                removed={removedFactIds.includes(f.uuid)}
                scope={scope}
                canDelete={canDelete}
                canWrite={canWrite}
                onRemoved={onRemoved}
                onEdited={onEdited}
                onNote={onNote}
              />
            ))}
          </div>
        </div>
      )}
    </section>
  );
}

const PROVENANCE: Record<string, { label: string; dot: "gold" | "marble" }> = {
  human: { label: "human", dot: "gold" },
  agent: { label: "agent", dot: "marble" },
  extraction: { label: "extracted", dot: "marble" },
};

export function FactCard({
  fact,
  citation,
  correctionPending = false,
  removed = false,
  scope,
  canDelete,
  canWrite,
  onRemoved,
  onEdited,
  onNote,
}: {
  fact: MemoryFact;
  citation?: number;
  correctionPending?: boolean;
  removed?: boolean;
  scope: string | null;
  canDelete: boolean;
  canWrite: boolean;
  onRemoved: (uuid: string) => void;
  onEdited: (uuid: string, text: string) => void;
  onNote: (text: string, tone: "ember" | "brick") => void;
}) {
  const [removing, setRemoving] = useState(false);
  const [removalConfirmed, setRemovalConfirmed] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editText, setEditText] = useState(fact.fact);
  const [saving, setSaving] = useState(false);
  const [correctionSubmitted, setCorrectionSubmitted] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const prov = fact.actorType ? PROVENANCE[fact.actorType] : null;
  // Set when the read served this fact as an excerpt to fit its token budget: the full length.
  const excerptOfChars = fact.excerptOfChars;

  async function remove() {
    if (removing) return;
    setRemoving(true);
    setErr(null);
    try {
      // Must carry the selected scope, not send none at all: the route
      // otherwise defaults to org root for every delete regardless of which
      // scope the fact actually lives under (the same ScopePicker `scope`
      // state this component's caller threads to ask()/submitFact()/
      // UploadButton belongs here too).
      const qs = scope ? `?scope=${encodeURIComponent(scope)}` : "";
      const res = await fetch(`/api/memory/facts/${encodeURIComponent(fact.uuid)}${qs}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? "remove failed");
      }
      onRemoved(fact.uuid);
      setRemovalConfirmed(true);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "remove failed");
      setRemoving(false);
    }
  }

  async function saveEdit(e: React.FormEvent) {
    e.preventDefault();
    const text = editText.trim();
    if (!text || text === fact.fact || saving) return;
    setSaving(true);
    setErr(null);
    try {
      // Same finding #2 fix as remove() above — without this, PATCH's
      // delete-then-reingest defaulted to org root, so a sub-scoped fact's
      // correction landed at a broader scope than the original.
      const res = await fetch(`/api/memory/facts/${encodeURIComponent(fact.uuid)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ fact: text, scope: scope ?? undefined }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        // The fact is gone though the corrected text was not confirmed saved: the card says
        // so, and keeps the text in the editor for the person to add again.
        if (body.factRemoved === true) {
          onRemoved(fact.uuid);
          setRemovalConfirmed(true);
        }
        throw new Error(body.error ?? "edit failed");
      }
      onEdited(fact.uuid, text);
      setCorrectionSubmitted(true);
      onNote("Fact corrected — re-extracting into memory…", "ember");
      setEditing(false);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "edit failed");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="group min-w-0 scroll-mb-56 py-4">
      <div className="flex flex-col items-start gap-3">
        <div className="min-w-0 w-full flex-1">
          {editing ? (
            <form onSubmit={saveEdit} className="flex flex-col gap-2">
              <textarea
                aria-label="Edit fact"
                value={editText}
                onChange={(e) => setEditText(e.target.value)}
                rows={3}
                autoFocus
                className={`w-full resize-none rounded-xl px-3 py-2 text-base leading-relaxed ${FIELD}`}
              />
              <div className="flex items-center gap-2">
                <Button
                  type="submit"
                  size="sm"
                  disabled={saving || removed || removalConfirmed || !editText.trim() || editText.trim() === fact.fact}
                >
                  {saving ? "Saving…" : "Save"}
                </Button>
                <button
                  type="button"
                  onClick={() => {
                    setEditing(false);
                    setEditText(fact.fact);
                    setErr(null);
                  }}
                  className="min-h-9 rounded-lg px-3 text-sm text-fg-subtle transition-colors hover:text-fg"
                >
                  Cancel
                </button>
                {err && <span className="text-sm text-danger">{err}</span>}
              </div>
            </form>
          ) : (
            <>
              <p className="break-words text-sm leading-relaxed text-fg sm:text-base">
                {citation && <span className="mr-2 font-mono text-xs text-info">[{citation}]</span>}
                {fact.fact}
              </p>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                {prov && <Pill dot={prov.dot}>{prov.label}</Pill>}
                {fact.actorName && (
                  <span className="break-words text-sm text-fg-muted">{displayWriterLabel(fact.actorName)}</span>
                )}
                {excerptOfChars && (
                  <span className="text-sm text-fg-subtle">
                    excerpt of {excerptOfChars.toLocaleString("en-US")} characters
                  </span>
                )}
                {err && <span className="text-sm text-danger">{err}</span>}
              </div>
            </>
          )}
        </div>
        {!editing && !correctionPending && !correctionSubmitted && !removed && !removalConfirmed && (
          <div className="flex flex-wrap items-center gap-2">
            {/* A correction replaces the whole stored fact with the text sent, so a card
                that holds only an excerpt of it offers none. */}
            {canWrite && !excerptOfChars && (
              <button
                onClick={() => {
                  setEditing(true);
                  setEditText(fact.fact);
                }}
                title="Edit fact"
                className="min-h-9 rounded-lg border border-divider px-3 py-1 text-sm text-fg-muted transition-colors hover:border-accent/35 hover:text-fg focus-visible:outline-2 focus-visible:outline-info"
              >
                edit
              </button>
            )}
            {canDelete && (
              <button
                onClick={remove}
                disabled={removing}
                title="Remove from memory"
                className="min-h-9 rounded-lg px-3 py-1 text-sm text-fg-subtle transition-colors hover:text-danger focus-visible:outline-2 focus-visible:outline-info disabled:opacity-50"
              >
                {removing ? "removing…" : "remove"}
              </button>
            )}
          </div>
        )}
      </div>
      {removed || removalConfirmed ? (
        <p role="status" className="mt-3 rounded-lg bg-fg/[0.04] px-3 py-2.5 text-sm leading-relaxed text-fg-muted">
          Removed from memory. This earlier retrieval is preserved so its citations stay unchanged.
        </p>
      ) : (
        (correctionPending || correctionSubmitted) && (
          <p role="status" className="mt-3 rounded-lg bg-info/[0.06] px-3 py-2.5 text-sm leading-relaxed text-info">
            Correction submitted. This is the earlier retrieved fact. Search again after processing to inspect the
            updated memory.
          </p>
        )
      )}
      <FactProvenance fact={fact} scope={scope} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// ConfirmPanel — shown before writing to memory; user must approve
// ---------------------------------------------------------------------------

function ConfirmPanel({
  summary,
  episode,
  scope,
  onConfirm,
  onCancel,
}: {
  summary: string;
  episode: string;
  scope: string | null;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="self-start flex flex-col gap-3 rounded-2xl border border-divider bg-fg/[0.03] px-5 py-4">
      <p className={EYEBROW}>Save to memory?</p>
      <p className="flex items-start gap-1.5 text-sm text-fg-subtle">
        <ShieldCheck size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
        <span>
          Destination{" "}
          <span className="ml-1 break-all font-mono text-xs text-fg-muted">{scope || "Organization root"}</span>
        </span>
      </p>
      <p className="text-base leading-relaxed text-fg">{summary}</p>
      {episode !== summary && <p className="font-mono text-xs leading-relaxed text-fg-subtle">{episode}</p>}
      <div className="flex items-center gap-2">
        <Button size="sm" onClick={onConfirm}>
          Save to memory
        </Button>
        <button
          onClick={onCancel}
          className="min-h-9 rounded-lg px-3 text-sm text-fg-subtle transition-colors hover:text-fg"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// DisambiguatePanel — shown when the overview agent detects multiple entities
// with the same name. Renders the options as clickable chips; clicking one
// resubmits the original query with that specific identifier appended.
// ---------------------------------------------------------------------------

function DisambiguatePanel({
  name,
  options,
  originalQuery,
  onSelect,
}: {
  name: string;
  options: string[];
  originalQuery: string;
  onSelect: (refinedQuery: string) => void;
}) {
  return (
    <div className="self-start flex flex-col gap-3">
      <p className="text-base text-fg-muted">
        Found multiple <span className="font-semibold text-fg">{name}</span>s in memory. Which one did you mean?
      </p>
      <div className="flex flex-wrap gap-2">
        {options.map((option) => (
          <button
            key={option}
            onClick={() => onSelect(`${originalQuery} — referring to ${option}`)}
            className={`${SECONDARY} min-h-10 px-4 py-2`}
          >
            {option}
          </button>
        ))}
      </div>
    </div>
  );
}
