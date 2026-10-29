// Shared glass card with an optional quiet accent along its top edge.
// glow: false (none) | true/"brick" | "gold" | "ember"
type GlowColor = "gold" | "ember" | "brick";

const BAR: Record<GlowColor, string> = {
  gold: "from-gold/0 via-gold/50 to-gold/0",
  ember: "from-ember/0 via-ember/50 to-ember/0",
  brick: "from-brick/0 via-brick/50 to-brick/0",
};

export function Card({
  glow = false,
  className = "",
  children,
}: {
  glow?: boolean | GlowColor;
  className?: string;
  children: React.ReactNode;
}) {
  const color: GlowColor | null = glow === true ? "gold" : glow === false ? null : glow;

  return (
    <div className={`glass-surface relative overflow-hidden rounded-2xl ${className}`}>
      {color && (
        <div
          aria-hidden
          className={`pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r ${BAR[color]}`}
        />
      )}
      <div className="relative">{children}</div>
    </div>
  );
}
