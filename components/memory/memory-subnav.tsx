import Link from "next/link";

const PAGES = [
  { key: "ask", href: "/memory/ask", label: "Ask" },
  { key: "explore", href: "/memory/explore", label: "Explore" },
] as const;

/** Links between the two memory pages, styled like the shared Tabs control. */
export function MemorySubnav({ active }: { active: (typeof PAGES)[number]["key"] }) {
  return (
    <nav
      aria-label="Memory pages"
      className="mt-4 inline-flex gap-1 rounded-full border border-divider bg-fg/[0.03] p-1 sm:mt-6"
    >
      {PAGES.map((page) => (
        <Link
          key={page.key}
          href={page.href}
          aria-current={page.key === active ? "page" : undefined}
          className={`inline-flex min-h-10 items-center rounded-full px-4 py-2 text-sm font-semibold transition-colors ${
            page.key === active ? "bg-accent/15 text-fg dark:text-accent" : "text-fg-subtle hover:text-fg"
          }`}
        >
          {page.label}
        </Link>
      ))}
    </nav>
  );
}
