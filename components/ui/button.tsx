import type { ButtonHTMLAttributes, Ref } from "react";

// The product's one button. Primary is the only filled style: ice with forest
// text in dark mode, deep teal with ivory text in light. Secondary and ghost are
// bordered, never filled; ghost uses the quieter supporting text. Danger is a
// destructive action in red. claude/design.md section 4: one filled action per
// screen, 44px tall at the default size, no shimmer, glow or lift on hover.
// `aria-disabled` dims a button the same way `disabled` does but keeps it
// focusable, for a control that pauses while its own work runs (Refresh).
type Variant = "primary" | "secondary" | "ghost" | "danger";
type Size = "sm" | "md" | "lg";

const VARIANTS: Record<Variant, string> = {
  primary: "border border-transparent bg-action text-action-foreground hover:bg-action/90",
  secondary: "border border-divider text-fg hover:border-accent/40 hover:bg-fg/5",
  ghost: "border border-divider text-fg-muted hover:border-accent/40 hover:text-fg",
  danger: "border border-danger/40 text-danger hover:bg-danger/10",
};

const SIZES: Record<Size, string> = {
  sm: "min-h-9 px-4 py-1.5 text-sm",
  md: "min-h-11 px-5 py-2 text-sm",
  lg: "min-h-12 px-6 py-2.5 text-base",
};

export function Button({
  variant = "primary",
  size = "md",
  className = "",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: Size; ref?: Ref<HTMLButtonElement> }) {
  return (
    <button
      className={`inline-flex items-center justify-center rounded-xl font-semibold transition-colors duration-200 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-info disabled:cursor-not-allowed disabled:opacity-40 aria-disabled:cursor-not-allowed aria-disabled:opacity-40 ${VARIANTS[variant]} ${SIZES[size]} ${className}`}
      {...props}
    />
  );
}
