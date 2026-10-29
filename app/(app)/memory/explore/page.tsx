import { PageHeader } from "@/components/ui";
import { MemoryStores } from "@/components/memory/memory-stores";
import { MemorySubnav } from "@/components/memory/memory-subnav";
import { loadMemoryPageAccess } from "../memory-page-access";

// Explore: what memory holds in a scope, one tab per kind of stored memory, with a count for each.
export default async function MemoryExplorePage({
  searchParams,
}: {
  searchParams: Promise<{ scope?: string | string[] }>;
}) {
  const access = await loadMemoryPageAccess((await searchParams).scope);

  return (
    <div className="mx-auto max-w-6xl px-5 py-8 sm:px-8 sm:py-12">
      <PageHeader eyebrow="Memory" title="Explore memory">
        Willder keeps seven kinds of memory: rules and decisions, working notes, briefs, text passages, a graph of
        entities, synced files, and sources and contacts. See what each holds in the scopes you can read.
      </PageHeader>
      <MemorySubnav active="explore" />
      {access ? (
        <MemoryStores
          key={access.initialScope ?? access.rootScope}
          initialScope={access.initialScope}
          canWrite={access.canWrite}
          canDelete={true}
          canManageScopes={access.canManageScopes}
        />
      ) : (
        <p className="mt-6 text-base text-fg-muted sm:mt-8">Create or select an organization to use memory.</p>
      )}
    </div>
  );
}
