// A short inline label: a role, a status word, a provenance mark, an inline
// error. Set in Manrope at the 14px label size, because it carries information
// of its own (claude/design.md section 3: mono is for machine data, and nothing
// a reader needs goes below 14px). The tone colours the words; the default is
// the metadata role.
type Tone = "gold" | "ember" | "brick" | "muted";

const TONES: Record<Tone, string> = {
  gold: "text-accent",
  ember: "text-ember",
  brick: "text-danger",
  muted: "text-fg-subtle",
};

export function Chip({
  tone = "muted",
  className = "",
  children,
}: {
  tone?: Tone;
  className?: string;
  children: React.ReactNode;
}) {
  return <span className={`text-sm font-medium ${TONES[tone]} ${className}`}>{children}</span>;
}
