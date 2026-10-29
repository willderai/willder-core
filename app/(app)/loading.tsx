export default function AppLoading() {
  return (
    <div className="mx-auto max-w-6xl px-5 py-8 motion-safe:animate-pulse sm:px-8 sm:py-12">
      {/* header skeleton */}
      <div className="border-b border-divider pb-8">
        <div className="mb-4 h-3 w-24 rounded-full bg-fg/[0.06]" />
        <div className="h-14 w-80 max-w-full rounded-xl bg-fg/[0.06]" />
        <div className="mt-5 h-4 w-96 max-w-full rounded-full bg-fg/[0.06]" />
      </div>

      {/* stat cards skeleton */}
      <div className="mt-10 grid grid-cols-2 gap-4 lg:grid-cols-4">
        {[...Array(4)].map((_, i) => (
          <div key={i} className="h-36 rounded-2xl border border-divider bg-fg/[0.03]" />
        ))}
      </div>

      {/* bottom panels skeleton */}
      <div className="mt-8 grid gap-6 lg:grid-cols-2">
        <div className="h-64 rounded-2xl border border-divider bg-fg/[0.03]" />
        <div className="h-64 rounded-2xl border border-divider bg-fg/[0.03]" />
      </div>
    </div>
  );
}
