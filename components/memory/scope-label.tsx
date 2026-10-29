import { escapeBidiControls } from "@/lib/unicode/bidi";

/**
 * A readable name for a raw ltree scope segment: scopes are created as `slug_hexhash`,
 * so "acme_38b95e" reads "Acme". Used when no scope row names the path.
 */
export function scopeSegmentLabel(segment: string): string {
  const slug = segment.replace(/_[0-9a-f]{6}$/, "").replace(/_/g, " ");
  return slug.charAt(0).toUpperCase() + slug.slice(1);
}

/**
 * A row's scope in a memory list: its display name, with the full path on hover.
 * A path with no scope row reads as its last segment's label; null is org-wide. An
 * admin sets the name, so a bidi control in it is shown escaped, never applied.
 */
export function ScopeLabel({ path, name }: { path: string | null; name: string | null }) {
  if (path === null) return <span className="text-sm text-fg-subtle">Org-wide</span>;
  const segments = path.split(".");
  const label =
    segments.length === 1
      ? "Org root"
      : name === null
        ? scopeSegmentLabel(segments[segments.length - 1])
        : escapeBidiControls(name);
  return (
    <span title={path} className="max-w-[16rem] truncate text-sm text-fg-subtle">
      {label}
    </span>
  );
}
