"use client";

import { useState, useEffect, useCallback } from "react";
import {
  Inbox,
  Megaphone,
  Brain,
  Bot,
  Lock,
  ScrollText,
  Settings,
  CircleHelp,
  ArrowRight,
  Zap,
  BookOpen,
  ChevronRight,
  ChevronLeft,
  GitPullRequest,
  Plug,
  Link2,
} from "lucide-react";

// ---------------------------------------------------------------------------
// Card data
// ---------------------------------------------------------------------------

type CardData = {
  id: string;
  eyebrow: string;
  title: string;
  icon: React.ReactNode;
  body: React.ReactNode;
};

const ICON = { size: 22, strokeWidth: 1.5 } as const;

const CARDS: CardData[] = [
  {
    id: "overview",
    eyebrow: "Getting started",
    title: "The governed memory loop",
    icon: <ArrowRight {...ICON} />,
    body: (
      <div className="space-y-5">
        <p className="text-base leading-relaxed text-fg-muted">
          Willder is governed memory plus a team of scoped, audited agents — Briefing, Architecture, and QA. Hand real
          knowledge to AI safely: every fact is stamped with who said it, every agent is fenced to exactly the scope you
          grant, and every read is on the record.
        </p>
        <ol className="space-y-3">
          {[
            "Capture — decisions, PRDs, interviews, and conventions become facts in memory, stamped with who said it.",
            "Fence — scope the work into grants: per person, time-bounded for contractors, default deny.",
            "Plan — the Architecture agent turns confirmed decisions into a design, flagging contradictions.",
            "Hand off — the Briefing agent onboards a bounded builder; QA tests the running product.",
            "Correct — corrections re-enter as higher-authority facts; disagreements become disputes. All audited.",
          ].map((step, i) => (
            <li key={i} className="flex items-start gap-3">
              <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-accent/30 bg-accent/10 text-sm font-semibold text-fg dark:text-accent">
                {i + 1}
              </span>
              <span className="text-base text-fg-muted">{step}</span>
            </li>
          ))}
        </ol>
      </div>
    ),
  },
  {
    id: "help-mode",
    eyebrow: "Context help",
    title: "The ? button",
    icon: <CircleHelp {...ICON} />,
    body: (
      <div className="space-y-5">
        <p className="text-base leading-relaxed text-fg-muted">
          Press the{" "}
          <span className="inline-flex items-center gap-1 rounded border border-accent/30 bg-accent/10 px-1.5 py-0.5 text-sm font-semibold text-fg dark:text-accent">
            <CircleHelp size={11} /> Help
          </span>{" "}
          button at the bottom of the sidebar to enter help mode.
        </p>
        <p className="text-base leading-relaxed text-fg-muted">
          Every element across the app will show an explanation tooltip when you hover over it. Clicking elements is
          intercepted so you can safely explore without accidentally triggering anything.
        </p>
        <div className="flex items-start gap-2.5 rounded-lg border border-divider bg-fg/[0.03] px-4 py-3">
          <Zap size={14} className="mt-0.5 shrink-0 text-accent" />
          <p className="text-sm text-fg-muted">
            Press <kbd className="rounded border border-divider bg-fg/[0.06] px-1.5 py-0.5 font-mono text-xs">Esc</kbd>{" "}
            or click the button again to exit.
          </p>
        </div>
      </div>
    ),
  },
  {
    id: "memory",
    eyebrow: "Capture",
    title: "Capture memory",
    icon: <Brain {...ICON} />,
    body: (
      <div className="space-y-4">
        <p className="text-base leading-relaxed text-fg-muted">
          Memory is Willder&apos;s governed knowledge layer — a graph of entities (people, systems, decisions) and the
          facts connecting them, each stamped with <strong className="text-fg">who asserted it</strong> and when. This
          provenance is what every agent reads from.
        </p>
        <div className="grid gap-2">
          {[
            { mode: "Chat", desc: "Free conversation, memory optionally accessed." },
            { mode: "Ask", desc: 'Read-only search. "What did we decide about the queue?"' },
            { mode: "Write", desc: "Save decisions, paste PRDs, upload docs into memory." },
          ].map(({ mode, desc }) => (
            <div key={mode} className="flex items-start gap-3 rounded-lg border border-divider bg-fg/[0.02] px-4 py-3">
              <span className="mt-0.5 w-10 shrink-0 text-sm font-semibold text-fg">{mode}</span>
              <span className="text-sm text-fg-muted">{desc}</span>
            </div>
          ))}
        </div>
        <p className="text-sm text-fg-subtle">
          The <strong className="text-fg-muted">Graph</strong> tab visualizes the knowledge graph.{" "}
          <strong className="text-fg-muted">Facts</strong> lists raw facts, each tagged human / agent / extracted.
        </p>
      </div>
    ),
  },
  {
    id: "access",
    eyebrow: "Fence",
    title: "Scope access",
    icon: <Lock {...ICON} />,
    body: (
      <div className="space-y-4">
        <p className="text-base leading-relaxed text-fg-muted">
          Fence your knowledge into scopes so an agent (or a person) sees exactly what you grant — nothing else. Every
          read and write is gated through a single{" "}
          <code className="rounded bg-fg/[0.06] px-1.5 py-0.5 font-mono text-xs text-fg">check()</code> call: default
          deny, org-isolated, scope-contained.
        </p>
        <div className="grid gap-2">
          {[
            {
              label: "Scopes",
              desc: "Partition memory by project or team. A grant on a parent auto-covers its children.",
            },
            {
              label: "Grants",
              desc: "Give a member, role, or agent read/write on a scope — time-bounded for contractors.",
            },
            {
              label: "Tokens",
              desc: "Scoped capability tokens for agents — they expire and are audited on every use.",
            },
          ].map(({ label, desc }) => (
            <div key={label} className="flex items-start gap-3 rounded-lg border border-divider bg-fg/[0.02] px-4 py-3">
              <span className="mt-0.5 w-14 shrink-0 text-sm font-semibold text-fg">{label}</span>
              <span className="text-sm text-fg-muted">{desc}</span>
            </div>
          ))}
        </div>
        <div className="flex items-start gap-2.5 rounded-lg border border-divider bg-fg/[0.03] px-4 py-3">
          <Zap size={14} className="mt-0.5 shrink-0 text-accent" />
          <p className="text-sm text-fg-muted">
            Grant a contractor a time-bounded scope; when it expires, access auto-revokes — no cleanup.
          </p>
        </div>
      </div>
    ),
  },
  {
    id: "agents",
    eyebrow: "Plan & hand off",
    title: "A team of agents",
    icon: <Bot {...ICON} />,
    body: (
      <div className="space-y-4">
        <p className="text-base leading-relaxed text-fg-muted">
          Three agents run on the same governed memory — each fenced to the scope you grant, every read audited. From
          the <strong className="text-fg">Agents</strong> page, open one and choose <em>Open workspace</em> to run it;
          the result is a reviewable Brief.
        </p>
        <div className="grid gap-2">
          {[
            {
              label: "Briefing",
              desc: "Onboards a builder from exactly their scope — a grounded brief with charts + diagrams. Access auto-revokes.",
            },
            {
              label: "Architecture",
              desc: "Turns confirmed decisions into a design with trade-offs, milestones, and risks — flags contradictions.",
            },
            {
              label: "QA",
              desc: "Black-box tests your running product against specs in memory — bugs by severity + a GO / NO-GO verdict.",
            },
          ].map(({ label, desc }) => (
            <div key={label} className="flex items-start gap-3 rounded-lg border border-divider bg-fg/[0.02] px-4 py-3">
              <span className="mt-0.5 w-24 shrink-0 text-sm font-semibold text-fg">{label}</span>
              <span className="text-sm text-fg-muted">{desc}</span>
            </div>
          ))}
        </div>
        <p className="text-sm text-fg-subtle">
          Create custom agents with their own prompts, tools, and models. Check{" "}
          <strong className="text-fg-muted">Fan out</strong> to split a large scope across parallel sub-agents that fold
          into one brief.
        </p>
      </div>
    ),
  },
  {
    id: "inbox",
    eyebrow: "Review",
    title: "The unified Inbox",
    icon: <Inbox {...ICON} />,
    body: (
      <div className="space-y-4">
        <p className="text-base leading-relaxed text-fg-muted">
          One feed for everything that needs you, tagged by source.
        </p>
        <div className="grid gap-2">
          {[
            {
              label: "AI Agent",
              desc: "Finished runs, questions a run is waiting on, dispute + failure alerts, and AI drafts awaiting approval.",
            },
            { label: "Person", desc: "Replies from people on outbound threads." },
          ].map(({ label, desc }) => (
            <div key={label} className="flex items-start gap-3 rounded-lg border border-divider bg-fg/[0.02] px-4 py-3">
              <span className="mt-0.5 w-20 shrink-0 text-sm font-semibold text-fg">{label}</span>
              <span className="text-sm text-fg-muted">{desc}</span>
            </div>
          ))}
        </div>
        <p className="text-base leading-relaxed text-fg-muted">
          Answer a paused run&apos;s question inline to resume it, reply to a person on a thread, or approve / reject a
          draft — all without leaving the feed.
        </p>
        <div className="flex items-start gap-2.5 rounded-lg border border-divider bg-fg/[0.03] px-4 py-3">
          <Zap size={14} className="mt-0.5 shrink-0 text-accent" />
          <p className="text-sm text-fg-muted">
            The human-in-the-loop step is intentional — agents propose, you command.
          </p>
        </div>
      </div>
    ),
  },
  {
    id: "governance",
    eyebrow: "Correct",
    title: "Corrections & disputes",
    icon: <GitPullRequest {...ICON} />,
    body: (
      <div className="space-y-4">
        <p className="text-base leading-relaxed text-fg-muted">
          When a brief gets a fact wrong, correct it right there. What happens next depends on provenance — Willder
          never silently overwrites.
        </p>
        <div className="grid gap-2">
          {[
            {
              label: "Auto-merge",
              desc: "Correcting a lower-tier (extracted / agent) fact applies straight to memory.",
            },
            {
              label: "Dispute",
              desc: "Contradicting a same-tier human fact opens a dispute — a pull request for memory.",
            },
            {
              label: "Resolve",
              desc: "The scope admin sees the dispute and picks proposer, existing, or a reconciled fact.",
            },
          ].map(({ label, desc }) => (
            <div key={label} className="flex items-start gap-3 rounded-lg border border-divider bg-fg/[0.02] px-4 py-3">
              <span className="mt-0.5 w-24 shrink-0 text-sm font-semibold text-fg">{label}</span>
              <span className="text-sm text-fg-muted">{desc}</span>
            </div>
          ))}
        </div>
        <p className="text-sm text-fg-subtle">
          Accept a good brief with <strong className="text-fg-muted">Save to memory</strong> — each section is written
          back as agent-tier facts at the brief&apos;s scope.
        </p>
      </div>
    ),
  },
  {
    id: "mcp",
    eyebrow: "Extend",
    title: "Connect your own AI",
    icon: <Plug {...ICON} />,
    body: (
      <div className="space-y-4">
        <p className="text-base leading-relaxed text-fg-muted">
          Willder ships an <strong className="text-fg">MCP server</strong> so you can plug your existing AI — Claude or
          ChatGPT — straight into governed memory.
        </p>
        <p className="text-base leading-relaxed text-fg-muted">
          Your AI connects as an <strong className="text-fg">agent</strong> holding a scoped capability token, so the
          same default-deny{" "}
          <code className="rounded bg-fg/[0.06] px-1.5 py-0.5 font-mono text-xs text-fg">check()</code> gate and audit
          apply. It gets tools to query memory and look up entities — reads it&apos;s allowed to see, and nothing beyond
          the granted scope.
        </p>
        <div className="flex items-start gap-2.5 rounded-lg border border-divider bg-fg/[0.03] px-4 py-3">
          <Zap size={14} className="mt-0.5 shrink-0 text-accent" />
          <p className="text-sm text-fg-muted">
            Bring your own agent — Willder becomes the trust substrate for your whole AI stack.
          </p>
        </div>
      </div>
    ),
  },
  {
    id: "audit",
    eyebrow: "Governance",
    title: "Audit log",
    icon: <ScrollText {...ICON} />,
    body: (
      <div className="space-y-4">
        <p className="text-base leading-relaxed text-fg-muted">
          Every memory access attempt — allowed or denied — is written to the audit log with a timestamp, actor, action,
          scope, and outcome.
        </p>
        <p className="text-base leading-relaxed text-fg-muted">
          Use Audit to investigate unexpected denials, verify that agent tokens are used as expected, and produce
          compliance evidence.
        </p>
        <div className="flex items-start gap-2.5 rounded-lg border border-divider bg-fg/[0.03] px-4 py-3">
          <Zap size={14} className="mt-0.5 shrink-0 text-accent" />
          <p className="text-sm text-fg-muted">
            Denied entries are not errors — they mean the access control system is working.
          </p>
        </div>
      </div>
    ),
  },
  {
    id: "outbound",
    eyebrow: "Optional workflow",
    title: "Outbound",
    icon: <Megaphone {...ICON} />,
    body: (
      <div className="space-y-4">
        <p className="text-base leading-relaxed text-fg-muted">
          Willder also runs outbound on the same governed memory. It&apos;s a secondary path — the governed memory loop
          above is the main event.
        </p>
        <ol className="space-y-3">
          {[
            "Add Contacts (people) and Accounts (companies).",
            "Create a campaign with an ICP and add prospects.",
            "The agent researches each prospect and drafts from memory.",
            "Review, edit, and approve drafts in the Inbox.",
            "Approved drafts send from your own mailbox; replies come back as threads.",
          ].map((step, i) => (
            <li key={i} className="flex items-start gap-3">
              <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-accent/30 bg-accent/10 text-sm font-semibold text-fg dark:text-accent">
                {i + 1}
              </span>
              <span className="text-base text-fg-muted">{step}</span>
            </li>
          ))}
        </ol>
      </div>
    ),
  },
  {
    id: "integrations",
    eyebrow: "Account",
    title: "Integrations",
    icon: <Link2 {...ICON} />,
    body: (
      <div className="space-y-4">
        <p className="text-base leading-relaxed text-fg-muted">
          Everything that connects to Willder, on one page: the tools knowledge comes from, and the AI that reads and
          writes it.
        </p>
        <SettingsRows
          rows={[
            { label: "Sources", desc: "Connect a Google Drive folder, choose its scope, and check each sync." },
            { label: "Connectors", desc: "Connect GitHub, Slack, Figma or PostHog, check each sync, and disconnect." },
            { label: "Mailboxes", desc: "Connect Gmail or Outlook accounts, one row per account." },
            { label: "Connect AI", desc: "Issue the token your AI client connects with." },
            {
              label: "Connected apps",
              desc: "Once sign-in with Willder is turned on: the apps you signed in with, and a way to disconnect each.",
            },
          ]}
        />
      </div>
    ),
  },
  {
    id: "settings",
    eyebrow: "Account",
    title: "Settings",
    icon: <Settings {...ICON} />,
    body: (
      <div className="space-y-4">
        <p className="text-base leading-relaxed text-fg-muted">
          Your organization itself. The memory chat name is set under Memory, on the Ask page.
        </p>
        <SettingsRows
          rows={[
            { label: "Members", desc: "Invite team members and manage roles." },
            {
              label: "Org roles",
              desc: "Map titles (CEO, Sales Lead) to members so the graph resolves them correctly.",
            },
            { label: "Aliases", desc: 'Teach the resolver that "J. Doe" and "Jane" are the same person.' },
          ]}
        />
      </div>
    ),
  },
];

/** Label and one-line description per row, as on the Integrations and Settings cards. */
function SettingsRows({ rows }: { rows: { label: string; desc: string }[] }) {
  return (
    <div className="grid gap-2">
      {rows.map(({ label, desc }) => (
        <div key={label} className="flex items-start gap-3 rounded-lg border border-divider bg-fg/[0.02] px-4 py-3">
          <span className="mt-0.5 w-28 shrink-0 text-sm font-semibold text-fg">{label}</span>
          <span className="text-sm text-fg-muted">{desc}</span>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

const STEP_BUTTON =
  "flex h-11 w-11 items-center justify-center rounded-full border border-divider text-fg-subtle transition-colors hover:border-accent/35 hover:text-fg";

export default function HowToUsePage() {
  const [current, setCurrent] = useState(0);
  const [dir, setDir] = useState<"left" | "right">("right");
  const [animating, setAnimating] = useState(false);

  const total = CARDS.length;
  const card = CARDS[current];

  const go = useCallback(
    (next: number, direction: "left" | "right") => {
      if (animating) return;
      setDir(direction);
      setAnimating(true);
      setTimeout(() => {
        setCurrent(next);
        setAnimating(false);
      }, 280);
    },
    [animating],
  );

  const prev = () => go((current - 1 + total) % total, "left");
  const next = () => go((current + 1) % total, "right");
  const jump = (i: number) => go(i, i > current ? "right" : "left");

  // Keyboard navigation
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "ArrowRight" || e.key === "ArrowDown") next();
      if (e.key === "ArrowLeft" || e.key === "ArrowUp") prev();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const slideOut = dir === "right" ? "-translate-x-8 opacity-0" : "translate-x-8 opacity-0";

  return (
    <div className="flex min-h-screen flex-col items-center justify-center px-4 py-12">
      {/* Header */}
      <div className="mb-10 text-center">
        <p className="mb-3 inline-flex items-center gap-2 text-eyebrow font-semibold uppercase text-fg-subtle">
          <BookOpen size={12} />
          Documentation
        </p>
        <h1 className="font-display text-display-sm font-semibold tracking-[-0.02em] text-fg sm:text-display-md">
          How to use Willder
        </h1>
        <p className="mt-3 text-base text-fg-muted">
          {current + 1} / {total} — use arrow keys or the buttons below
        </p>
      </div>

      {/* Card stage */}
      <div className="relative w-full max-w-xl">
        {/* Card */}
        <div
          key={card.id}
          className={`relative overflow-hidden rounded-2xl border border-divider bg-fg/[0.025] transition-all duration-[280ms] ease-out
            ${animating ? slideOut : "translate-x-0 opacity-100"}`}
          style={{ minHeight: 420 }}
        >
          <div className="relative px-8 py-8">
            {/* eyebrow */}
            <p className="mb-3 text-eyebrow font-semibold uppercase text-fg-subtle">{card.eyebrow}</p>

            {/* title */}
            <div className="mb-6 flex items-center gap-3">
              <span className="text-accent">{card.icon}</span>
              <h2 className="font-display text-3xl font-semibold tracking-tight text-fg">{card.title}</h2>
            </div>

            {/* body */}
            <div>{card.body}</div>
          </div>
        </div>
      </div>

      {/* Step buttons around the dot progress */}
      <div className="mt-8 flex items-center gap-2">
        <button type="button" onClick={prev} aria-label="Previous" className={`mr-2 ${STEP_BUTTON}`}>
          <ChevronLeft size={18} />
        </button>
        {CARDS.map((c, i) => (
          <button
            key={c.id}
            type="button"
            onClick={() => jump(i)}
            aria-label={`Go to ${c.title}`}
            className={`rounded-full transition-all duration-200 ${
              i === current ? "h-2 w-6 bg-accent" : "h-2 w-2 bg-fg/20 hover:bg-fg/40"
            }`}
          />
        ))}
        <button type="button" onClick={next} aria-label="Next" className={`ml-2 ${STEP_BUTTON}`}>
          <ChevronRight size={18} />
        </button>
      </div>

      {/* Chapter list at bottom */}
      <div className="mt-10 flex max-w-xl flex-wrap justify-center gap-2">
        {CARDS.map((c, i) => (
          <button
            key={c.id}
            type="button"
            onClick={() => jump(i)}
            className={`min-h-8 rounded-full border px-3 py-1 text-sm transition-all ${
              i === current
                ? "border-accent/40 bg-accent/10 text-fg dark:text-accent"
                : "border-divider text-fg-subtle hover:border-accent/35 hover:text-fg"
            }`}
          >
            {c.title}
          </button>
        ))}
      </div>

      {/* Keyboard hint */}
      <p className="mt-6 text-sm text-fg-subtle">← → to navigate</p>
    </div>
  );
}
