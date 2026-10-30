"use client";

import { useTheme } from "next-themes";
import { useIsClient } from "@/hooks/use-is-client";

function SunIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-[18px] w-[18px] shrink-0"
      aria-hidden
    >
      <circle cx="12" cy="12" r="4.5" />
      <path d="M12 2v2M12 20v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M2 12h2M20 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42" />
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-[18px] w-[18px] shrink-0"
      aria-hidden
    >
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
    </svg>
  );
}

interface ThemeToggleProps {
  className?: string;
  labelClassName?: string;
  showLabel?: boolean;
}

export function ThemeToggle({ className = "", labelClassName = "", showLabel = false }: ThemeToggleProps) {
  const { resolvedTheme, setTheme } = useTheme();
  const mounted = useIsClient();

  if (!mounted) return <div className="h-[18px] w-[18px] shrink-0" />;

  const isDark = resolvedTheme === "dark";

  return (
    <button
      type="button"
      onClick={() => setTheme(isDark ? "light" : "dark")}
      aria-label={isDark ? "Switch to light mode" : "Switch to dark mode"}
      title={isDark ? "Light mode" : "Dark mode"}
      className={className}
    >
      {isDark ? <SunIcon /> : <MoonIcon />}
      {showLabel && <span className={labelClassName}>{isDark ? "Light mode" : "Dark mode"}</span>}
    </button>
  );
}
