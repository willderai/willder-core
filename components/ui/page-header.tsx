// The masthead every (app) page shares: a small eyebrow naming the area, a
// restrained display title, an optional one-line description and an optional
// action on the right. Adopt it instead of hand-rolling a header so titles keep
// one size and one rhythm across the product.
export function PageHeader({
  eyebrow,
  title,
  actions,
  children,
}: {
  eyebrow: string;
  title: React.ReactNode;
  /** The page's primary action, aligned with the title on wide screens. */
  actions?: React.ReactNode;
  children?: React.ReactNode;
}) {
  return (
    <header className="flex flex-col gap-5 border-b border-divider pb-6 sm:pb-8 lg:flex-row lg:items-end lg:justify-between">
      <div className="min-w-0">
        <p className="mb-3 text-eyebrow font-semibold uppercase text-fg-subtle">{eyebrow}</p>
        <h1 className="font-display text-display-sm font-semibold tracking-[-0.02em] text-fg sm:text-display-md">
          {title}
        </h1>
        {children && <p className="mt-3 max-w-xl text-base leading-relaxed text-fg-muted">{children}</p>}
      </div>
      {actions && <div className="shrink-0">{actions}</div>}
    </header>
  );
}
