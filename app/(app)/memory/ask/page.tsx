import { PageHeader } from "@/components/ui";
import { MemoryWorkbench } from "@/components/memory/memory-workbench";
import { MemorySubnav } from "@/components/memory/memory-subnav";
import { FirstUseTips } from "@/components/onboarding/first-use-tips";
import { MemoryChatPanel } from "@/components/settings/memory-chat-panel";
import { loadMemoryPageAccess } from "../memory-page-access";

// Ask: questions and notes against memory, with the facts and sources behind each answer.
// Below the chat sits the one setting it has, the name it uses for the person asking
// (#memory-chat). An old Settings link to it is forwarded here (components/settings/legacy-settings-redirect.tsx). Every member can
// read it; only an org owner or admin can save it, which the route enforces.
export default async function MemoryAskPage({
  searchParams,
}: {
  searchParams: Promise<{ scope?: string | string[] }>;
}) {
  const access = await loadMemoryPageAccess((await searchParams).scope);

  return (
    <div className="mx-auto max-w-6xl px-5 py-8 sm:px-8 sm:py-12">
      <PageHeader eyebrow="Memory" title="Ask memory">
        Get answers from the memory you can access, and inspect the facts and sources behind each one.
      </PageHeader>
      <MemorySubnav active="ask" />
      {access ? (
        <>
          <FirstUseTips />
          {/* canDelete=true: the API enforces scope-level delete permission via check() */}
          <MemoryWorkbench
            key={access.initialScope ?? access.rootScope}
            initialScope={access.initialScope}
            canWrite={access.canWrite}
            canDelete={true}
            canManageScopes={access.canManageScopes}
          />
          <section
            id="memory-chat"
            className="mt-10 scroll-mt-24 border-t border-divider pt-8 sm:mt-12"
            aria-label="Memory chat name"
          >
            <MemoryChatPanel />
          </section>
        </>
      ) : (
        <p className="mt-6 text-base text-fg-muted sm:mt-8">Create or select an organization to use memory.</p>
      )}
    </div>
  );
}
