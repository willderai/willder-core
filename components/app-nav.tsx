"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { UserButton, OrganizationSwitcher } from "@clerk/nextjs";
import { useNavBadges } from "@/hooks/use-nav-badges";
import { LayoutDashboard, Brain, Bot, Lock, ScrollText, Settings, BookOpen, Plug } from "lucide-react";
import { WillderMark, Wordmark } from "@/components/marks";
import { ThemeToggle } from "@/components/theme-toggle";
import { HelpToggle, HelpTip } from "@/components/help";
import { NavSearch } from "@/components/access-search/nav-search";
import type { NavBadges } from "@/hooks/use-nav-badges";
import styles from "./app-nav.module.css";

// `badgeKey` decouples the badge counter from the link target, so a link can show a
// count that is not named after its own route.
type Item = {
  href: string;
  label: string;
  icon: React.ReactNode;
  tip: string;
  badgeKey?: keyof NavBadges;
};
type Group = { heading: string; items: Item[] };

const ICON_PROPS = { size: 18, strokeWidth: 1.6 } as const;

// Shared groups — identical in both modes.
const KNOWLEDGE_GROUP: Group = {
  heading: "Knowledge",
  items: [
    {
      href: "/memory",
      label: "Memory",
      icon: <Brain {...ICON_PROPS} />,
      tip: "Ask questions of shared memory, and explore what each store holds.",
      badgeKey: "/memory",
    },
    {
      href: "/agents",
      label: "Agents",
      icon: <Bot {...ICON_PROPS} />,
      tip: "Configure agents, scope them to a grant, and view run history.",
      badgeKey: "/agents",
    },
    {
      href: "/integrations",
      label: "Integrations",
      icon: <Plug {...ICON_PROPS} />,
      tip: "Connect sources, connectors, mailboxes and your AI; check each sync, or disconnect.",
    },
  ],
};

const GOVERNANCE_GROUP: Group = {
  heading: "Governance",
  items: [
    {
      href: "/access",
      label: "Access",
      icon: <Lock {...ICON_PROPS} />,
      tip: "Manage who can read and write each memory scope.",
    },
    {
      href: "/audit",
      label: "Audit log",
      icon: <ScrollText {...ICON_PROPS} />,
      tip: "Full log of every memory access attempt, allowed or denied.",
    },
  ],
};

const ACCOUNT_GROUP: Group = {
  heading: "Account",
  items: [
    {
      href: "/settings",
      label: "Settings",
      icon: <Settings {...ICON_PROPS} />,
      tip: "Your organization: members, invitations, org roles and entity aliases.",
    },
    {
      href: "/how-to-use",
      label: "How to use",
      icon: <BookOpen {...ICON_PROPS} />,
      tip: "Full guide to every feature in Willder.",
    },
  ],
};

// One nav. Inbox, Campaigns and Contacts are removed along with the
// outbound-sales surfaces they pointed at.
const NAV_GROUPS: Group[] = [
  {
    heading: "Workspace",
    items: [
      {
        href: "/dashboard",
        label: "Dashboard",
        icon: <LayoutDashboard {...ICON_PROPS} />,
        tip: "Start here: capture memory, scope it, run an agent, and check the audit log.",
      },
    ],
  },
  KNOWLEDGE_GROUP,
  GOVERNANCE_GROUP,
  ACCOUNT_GROUP,
];

// Below Tailwind's `md` breakpoint the full 240px sidebar leaves a phone only ~150px
// for page content, so the sidebar starts as its icon rail there. An explicit
// Expand/Collapse click always wins over the viewport default.
const NARROW_VIEWPORT_QUERY = "(max-width: 767px)";

function subscribeToNarrowViewport(onChange: () => void) {
  const query = window.matchMedia(NARROW_VIEWPORT_QUERY);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

function useIsNarrowViewport() {
  return useSyncExternalStore(
    subscribeToNarrowViewport,
    () => window.matchMedia(NARROW_VIEWPORT_QUERY).matches,
    () => false,
  );
}

function NavBadge({ count }: { count: number }) {
  if (count === 0) return null;
  return (
    <span className="ml-auto flex h-4 min-w-4 items-center justify-center rounded-full bg-info px-1 font-mono text-[10px] font-semibold leading-none text-info-foreground">
      {count > 99 ? "99+" : count}
    </span>
  );
}

export function AppNav() {
  const pathname = usePathname();
  const isNarrowViewport = useIsNarrowViewport();
  // null until the user toggles: follow the viewport. After that, their choice sticks.
  const [collapsedByUser, setCollapsedByUser] = useState<boolean | null>(null);
  const collapsed = collapsedByUser ?? isNarrowViewport;
  const mobileOpen = isNarrowViewport && collapsedByUser === false;
  const toggleRef = useRef<HTMLButtonElement>(null);
  const badges = useNavBadges();
  const groups = NAV_GROUPS;

  useEffect(() => {
    if (!mobileOpen) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setCollapsedByUser(true);
        toggleRef.current?.focus();
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [mobileOpen]);

  return (
    <div className={styles.host}>
      {mobileOpen && (
        <button
          type="button"
          aria-label="Close navigation"
          className="fixed inset-0 z-40 bg-black/40 backdrop-blur-sm md:hidden"
          onClick={() => {
            setCollapsedByUser(true);
            toggleRef.current?.focus();
          }}
        />
      )}
      <aside
        data-mode={collapsedByUser === null ? "auto" : collapsed ? "collapsed" : "expanded"}
        className={`${styles.sidebar} flex shrink-0 flex-col border-r border-divider bg-ink ${
          // Animate only a user's toggle, not the first narrow-viewport render
          // settling from the server's full-width markup to the rail.
          collapsedByUser === null ? "" : "transition-[width] duration-300 ease-in-out"
        } ${collapsed ? "w-[4.5rem]" : "w-60"}`}
      >
        <Link
          href="/dashboard"
          aria-label="Willder dashboard"
          data-nav-logo
          onClick={() => {
            if (isNarrowViewport) setCollapsedByUser(true);
          }}
          className={`flex h-16 items-center border-b border-divider ${
            collapsed ? "justify-center px-0" : "gap-2.5 px-5"
          }`}
        >
          {collapsed ? (
            <WillderMark className="h-6 w-6 shrink-0" />
          ) : (
            <>
              <span data-nav-compact className="hidden">
                <WillderMark className="h-6 w-6 shrink-0" />
              </span>
              <span data-nav-full>
                <Wordmark className="h-7" />
              </span>
            </>
          )}
        </Link>

        {!collapsed && (
          <div data-nav-full className="border-b border-divider px-3 py-3">
            <OrganizationSwitcher
              hidePersonal
              afterCreateOrganizationUrl="/settings"
              afterSelectOrganizationUrl="/dashboard"
              appearance={{
                elements: {
                  rootBox: "w-full",
                  organizationSwitcherTrigger: "w-full justify-between rounded-md px-3 py-2 text-fg hover:bg-fg/[0.04]",
                },
              }}
            />
          </div>
        )}

        <div
          data-nav-full={collapsed ? undefined : ""}
          className={`border-b border-divider ${collapsed ? "px-2 py-2" : "px-3 py-3"}`}
        >
          <NavSearch
            collapsed={collapsed}
            onExpand={() => setCollapsedByUser(false)}
            onNavigate={() => {
              if (isNarrowViewport) setCollapsedByUser(true);
            }}
          />
        </div>

        <nav
          id="app-sidebar-navigation"
          data-nav-scroll
          className={`flex-1 overflow-y-auto py-3 ${collapsed ? "px-2" : "px-3"}`}
        >
          {groups.map((group) => (
            <div key={group.heading} className="mb-4 last:mb-0">
              {collapsed ? (
                <div className="mx-2 mb-2 border-t border-divider" />
              ) : (
                <>
                  <div data-nav-compact className="hidden mx-2 mb-2 border-t border-divider" />
                  <p data-nav-full className="px-3 pb-2 text-eyebrow font-semibold uppercase text-fg-subtle">
                    {group.heading}
                  </p>
                </>
              )}
              <ul className="space-y-0.5">
                {group.items.map((item) => {
                  const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
                  // An unknown count (null) shows no badge, the same as none.
                  const badgeCount = (item.badgeKey ? badges[item.badgeKey] : null) ?? 0;
                  return (
                    <li key={item.href}>
                      <HelpTip tip={item.tip}>
                        <Link
                          href={item.href}
                          data-nav-link
                          onClick={() => {
                            if (isNarrowViewport) setCollapsedByUser(true);
                          }}
                          aria-label={
                            badgeCount > 0 ? `${item.label}, ${badgeCount > 99 ? "99+" : badgeCount} new` : item.label
                          }
                          aria-current={pathname === item.href ? "page" : active ? "true" : undefined}
                          title={collapsed ? item.label : undefined}
                          className={`group relative flex items-center overflow-hidden rounded-xl py-2.5 text-sm transition-colors ${
                            collapsed ? "justify-center px-0" : "gap-3 px-3"
                          } ${active ? "bg-accent/10 text-fg" : "text-fg-muted hover:bg-fg/[0.04] hover:text-fg"}`}
                        >
                          {active && <span className="absolute inset-y-1 left-0 w-0.5 rounded-full bg-accent" />}
                          <span className="relative shrink-0">
                            <span
                              className={
                                active ? "text-accent" : "text-fg-subtle transition-colors group-hover:text-accent"
                              }
                            >
                              {item.icon}
                            </span>
                            {collapsed && badgeCount > 0 && (
                              <span className="absolute -right-1 -top-1 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-info px-0.5 font-mono text-[9px] font-semibold leading-none text-info-foreground">
                                {badgeCount > 99 ? "99" : badgeCount}
                              </span>
                            )}
                          </span>
                          {!collapsed && <span data-nav-full>{item.label}</span>}
                          {!collapsed && (
                            <span data-nav-full className="ml-auto">
                              <NavBadge count={badgeCount} />
                            </span>
                          )}
                        </Link>
                      </HelpTip>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </nav>

        {/* Help, theme and collapse controls: icon buttons (each keeps its name as aria-label
          and title). Expanded, they share one row so the Account group still fits above
          the fold at 1440x900; the rail stacks them. */}
        <div
          data-nav-controls
          className={`flex gap-0.5 border-t border-divider py-2 ${collapsed ? "flex-col px-2" : "flex-row px-3"}`}
        >
          <HelpToggle collapsed />
          <ThemeToggle className="flex w-full items-center justify-center rounded-md px-0 py-2.5 text-sm text-fg-muted transition-colors hover:bg-fg/[0.04] hover:text-fg" />
          <button
            ref={toggleRef}
            type="button"
            onClick={() => setCollapsedByUser(!collapsed)}
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            aria-expanded={!collapsed}
            aria-controls="app-sidebar-navigation"
            title={collapsed ? "Expand" : "Collapse"}
            className="flex w-full items-center justify-center rounded-md px-0 py-2.5 text-sm text-fg-muted transition-colors hover:bg-fg/[0.04] hover:text-fg"
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
              className={`h-[18px] w-[18px] shrink-0 transition-transform duration-300 ${
                collapsed ? "rotate-180" : ""
              }`}
              aria-hidden
            >
              <path d="M15 6l-6 6 6 6" />
            </svg>
          </button>
        </div>

        <div
          data-nav-user
          className={`flex items-center border-t border-divider py-3 ${collapsed ? "justify-center px-0" : "px-5"}`}
        >
          <UserButton
            showName={!collapsed}
            appearance={{
              elements: {
                userButtonBox: "flex-row-reverse gap-2",
              },
            }}
          />
        </div>
      </aside>
    </div>
  );
}
