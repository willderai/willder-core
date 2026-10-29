// Shared types for the copy agent's structured draft output (used by
// services/agents/runner.ts's runCopyAgent and services/langfuse.ts's shared
// tracing helpers). Originally lived in services/drafting/draft.ts alongside
// generateDraft() — the raw Groq-based drafting path that served the Era-1
// campaign/prospect loop and was removed with it (Era 1 outbound-sales
// removal). runCopyAgent itself now drafts via the Mastra agent's structured
// `output` (see runner.ts), not generateDraft(), but it — and the "Test run"
// button every agent role uses (app/api/agents/[id]/run/route.ts) — still
// needs these three type shapes, so they're kept here rather than deleted
// with the rest of services/drafting/*.
import type { MemoryFact } from "@/types/memory";

export interface DraftPreferences {
  toneOverride?: string | null;
  forbiddenTopics?: string | null;
  customInstruction?: string | null;
  preferredOpener?: string | null;
  signOffName?: string | null;
}

export interface DraftContext {
  /** The person we're writing to. */
  contactName: string;
  contactTitle?: string | null;
  contactEmail?: string | null;
  /** The company they're at. */
  accountName?: string | null;
  accountDomain?: string | null;
  /** Campaign conditioning. */
  icp?: string;
  tone?: string;
  campaignName?: string;
  /** Who the email is from (the customer's name / org), for the sign-off. */
  senderName?: string;
  orgName?: string;
  /** Facts retrieved from memory about this prospect/account (the grounding). */
  facts: MemoryFact[];
  /** Org-level structured preferences that condition the draft. */
  preferences?: DraftPreferences;
}

export interface GeneratedDraft {
  subject: string;
  body: string;
  /** The model that produced it (provenance). */
  model: string;
  /** Whether any memory facts grounded the draft (vs. cold from profile only). */
  grounded: boolean;
}
