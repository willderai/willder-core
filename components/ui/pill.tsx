// A rounded tag for a state or a kind: "active", "revoked", "read only". An
// optional leading dot repeats the state in colour; the word always carries it,
// so the dot is decorative to assistive technology. Hairline edge, text on the
// supporting role.
type Dot = "gold" | "ember" | "brick" | "marble" | "accent" | "info" | "success" | "danger";

const DOTS: Record<Dot, string> = {
  accent: "bg-accent",
  info: "bg-info",
  success: "bg-success",
  danger: "bg-danger",
  gold: "bg-accent",
  ember: "bg-ember",
  brick: "bg-danger",
  marble: "bg-fg-subtle",
};

export function Pill({ dot, className = "", children }: { dot?: Dot; className?: string; children: React.ReactNode }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border border-divider bg-fg/[0.04] px-2.5 py-1 text-xs font-medium text-fg-muted ${className}`}
    >
      {dot && <span aria-hidden className={`h-1.5 w-1.5 shrink-0 rounded-full ${DOTS[dot]}`} />}
      {children}
    </span>
  );
}
