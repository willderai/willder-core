// The page a confirm link opens: one rule an agent recorded, and the button that makes it
// the person's own. An agent that records a decision hands its person this link
// (mcp/tools/memory-ingest.ts), because until a person confirms it every session in the
// scope is served the decision as a lead to verify, not as a standing rule.
//
// The rule is read under memory.read on its own scope. Signed out, no organization, an id
// that matches nothing, a rule the person may not read and a rule naming an erased person
// all render the same not-found page, so the link cannot be used to learn a rule exists.
import { notFound } from "next/navigation";
import { requireAccessContext } from "@/lib/access-context";
import { can } from "@/services/access";
import { resolveAgentNames, resolveUserNames } from "@/services/audit/actor-names";
import { readRuleForConfirmation } from "@/services/memory/conventions";
import { loadScopeNames } from "@/services/memory/store-record-lists";
import { PageHeader } from "@/components/ui";
import { ConfirmRule } from "./confirm-rule";

// Auth and a per-request read: never prerendered.
export const dynamic = "force-dynamic";

export const metadata = { title: "Confirm a rule · Willder" };

export default async function ConfirmRulePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const rc = await requireAccessContext();
  if (!rc) notFound();

  const rule = await readRuleForConfirmation(rc.ctx, id);
  if (!rule) notFound();

  const [scopeNameOf, writerName, write] = await Promise.all([
    loadScopeNames(rc.org.id, [rule]),
    writerNameOf(rc.org.id, rule.recordedBy, rule.recordedById),
    // A non-auditing probe that only decides whether to offer the button; the POST decides again.
    can(rc.ctx, { action: "memory.write", scope: rule.scopePath }),
  ]);

  return (
    <div className="mx-auto max-w-3xl px-5 py-8 sm:px-8 sm:py-12">
      <PageHeader eyebrow="Memory" title={rule.kind === "decision" ? "Confirm a decision" : "Confirm a convention"}>
        {!rule.inForce
          ? "This version is no longer served to agents."
          : rule.recordedBy === "person"
            ? "A person recorded this, so agents starting work in this scope are served it as settled."
            : rule.kind === "decision"
              ? "Until a person confirms it, agents starting work in this scope are told it is a proposal to check, not a standing rule."
              : "Until a person confirms it, agents starting work in this scope are not served it as a person's rule."}
      </PageHeader>
      <ConfirmRule
        rule={{
          id: rule.id,
          kind: rule.kind,
          subject: rule.subject,
          text: rule.text,
          scopePath: rule.scopePath,
          scopeName: scopeNameOf(rule.scopePath),
          recordedBy: rule.recordedBy,
          writerName,
          inForce: rule.inForce,
        }}
        canWrite={write.allowed}
      />
    </div>
  );
}

/** The name the audit log gives the rule's writer, or null when no create event names one. */
async function writerNameOf(
  orgId: string,
  by: "person" | "agent" | "unknown",
  id: string | null,
): Promise<string | null> {
  if (id === null) return null;
  if (by === "person") return (await resolveUserNames([id]))[id] ?? null;
  if (by === "agent") return (await resolveAgentNames(orgId, [id]))[id] ?? null;
  return null;
}
