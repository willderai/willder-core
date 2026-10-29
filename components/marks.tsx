// Mark only — the 4-arm symbol, works on any background
export function WillderMark({ className = "" }: { className?: string }) {
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img src="/logo.svg" alt="Willder" aria-hidden="true" className={className} />
  );
}

// Full lockup — mark + wordmark. Swaps between white (dark bg) and dark (light bg) versions.
// className controls the image height (e.g. "h-8", "h-7").
export function Wordmark({ className = "h-8" }: { className?: string }) {
  return (
    <span className="inline-flex items-center">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src="/logo_full_dark.svg" alt="Willder" className={`hidden dark:block ${className}`} />
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src="/logo_full_light.svg" alt="Willder" className={`block dark:hidden ${className}`} />
    </span>
  );
}
