// Class strings the Agents pages share, so a label, field or button looks the same on
// the agents list, the configuration panel and the run workspace.
//
// The one rule: these follow the site UI roles in claude/design.md §2–3 (text roles
// instead of opacity steps of marble, hairline borders, one filled button style in
// ice). Change a treatment here, not in the components that use it.

/**
 * The 2px keyboard focus outline. The product shell draws it for its own controls, but a
 * dialog renders outside the shell (components/ui/modal.tsx portals to <body>), so every
 * control here carries it too.
 */
export const FOCUS = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-info";

/** A short area label above a title: 12px Manrope, uppercase, metadata colour. */
export const EYEBROW = "text-eyebrow font-semibold uppercase text-fg-subtle";

/**
 * The eyebrow for text set straight on the page, outside any card. In the light theme the
 * page backdrop darkens the stone enough that fg-subtle drops under 4.5:1, so this one
 * uses the supporting colour.
 */
export const EYEBROW_ON_PAGE = "text-eyebrow font-semibold uppercase text-fg-muted";

/** The label above a form control. */
export const FIELD_LABEL = "mb-1.5 block text-sm font-medium text-fg";

/** One line of help under a label or beside a control. */
export const FIELD_HELP = "text-sm text-fg-subtle";

/** A native input, select or textarea on the field tokens, with a visible focus outline. */
export const FIELD =
  "min-h-11 w-full rounded-xl border border-[var(--field-border)] bg-[var(--field-background)] px-4 py-2.5 text-sm text-fg placeholder:text-[var(--field-placeholder)] hover:border-[var(--field-border-hover)] focus-visible:border-[var(--field-border-focus)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-info";

/** The one filled button style: ice, 44px tall. It marks the main action of a form or view. */
export const BUTTON_PRIMARY = `inline-flex min-h-11 items-center justify-center gap-2 whitespace-nowrap rounded-xl bg-action px-5 py-2 text-sm font-semibold text-action-foreground transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40 ${FOCUS}`;

/** A bordered secondary action. */
export const BUTTON_SECONDARY = `inline-flex min-h-11 items-center justify-center gap-2 whitespace-nowrap rounded-xl border border-divider px-4 py-2 text-sm font-medium text-fg transition-colors hover:border-accent/35 hover:bg-fg/5 disabled:cursor-not-allowed disabled:opacity-40 ${FOCUS}`;

/** A text-only action: cancel, show more, reset. */
export const BUTTON_QUIET = `inline-flex min-h-10 items-center gap-1.5 rounded-lg px-2 text-sm text-fg-muted transition-colors hover:text-fg disabled:cursor-not-allowed disabled:opacity-40 ${FOCUS}`;

/** A block set off from the surface it sits on: one hairline, a faint fill. Never nest one in another. */
export const SUB_PANEL = "rounded-xl border border-divider bg-fg/[0.03]";

/** A heading inside a card or a generated brief: 16px semibold. */
export const BLOCK_TITLE = "text-base font-semibold text-fg";
