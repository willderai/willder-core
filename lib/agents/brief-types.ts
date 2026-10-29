// The Brief a generated handoff, architecture plan or QA review renders as.
//
// The one rule this file enforces: a field an older brief or another brief type
// may lack is optional or nullable here, so no reader assumes it is present.
import type { ChartSpec } from "@/types/agent-run";

export type BriefType = "handoff" | "architecture_plan" | "qa_review";
type Milestone = { label: string; dueDate: string };
type Contradiction = { factA: string; factB: string; note: string };

export type Brief = {
  id: string;
  orgId: string;
  type: BriefType;
  granteeName: string | null;
  granteeRole: string | null;
  scopePath: string;
  scopeLabel?: string | null;
  title: string;
  summary: string;
  sections: { heading: string; content: string }[];
  diagram: string | null;
  diagramUrl: string | null;
  googleDocUrl: string | null;
  milestones: Milestone[] | null;
  contradictions?: Contradiction[] | null;
  charts?: ChartSpec[] | null;
  createdAt: string;
  /// Persisted at generation time; null for a brief generated before this
  /// column existed, or a non-handoff type that never sets it.
  backend?: "single" | "manager" | null;
};
