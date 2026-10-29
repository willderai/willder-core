// Route-level skeleton for the run workspace — the calm pre-stream state
// (no chrome flash) while the client mounts and the SSE subscription attaches.
export default function RunWorkspaceLoading() {
  return (
    <div className="mx-auto flex h-full max-w-[1400px] flex-col px-5 py-6 sm:px-8">
      <div className="flex items-center justify-between gap-4 border-b border-divider pb-4">
        <div className="h-4 w-56 max-w-[55%] rounded-full bg-fg/[0.06] motion-safe:animate-pulse" />
        <div className="h-10 w-40 max-w-[35%] rounded-xl bg-fg/[0.06] motion-safe:animate-pulse" />
      </div>
      <div className="mt-4 h-[52px] rounded-2xl border border-divider bg-fg/[0.03] motion-safe:animate-pulse" />
      <div className="mt-4 flex min-h-0 flex-1 gap-6">
        <div className="hidden w-[380px] shrink-0 rounded-2xl border border-divider bg-fg/[0.03] motion-safe:animate-pulse lg:block" />
        <div className="flex-1 rounded-2xl border border-divider bg-fg/[0.03] motion-safe:animate-pulse" />
      </div>
    </div>
  );
}
