"use client";

import { CircleHelp } from "lucide-react";
import { useHelpMode } from "./help-mode-provider";

export function HelpToggle({ showLabel = true, collapsed = false }: { showLabel?: boolean; collapsed?: boolean }) {
  const { isHelpMode, toggleHelpMode } = useHelpMode();

  return (
    <button
      type="button"
      onClick={toggleHelpMode}
      aria-label={isHelpMode ? "Exit help mode" : "Enter help mode"}
      title={isHelpMode ? "Exit help mode" : "What does this do?"}
      className={`flex w-full items-center rounded-md py-2 text-base transition-colors ${
        collapsed ? "justify-center px-0" : "gap-3 px-3"
      } ${isHelpMode ? "bg-accent/10 text-fg hover:bg-accent/15" : "text-fg-muted hover:bg-fg/[0.04] hover:text-fg"}`}
    >
      <CircleHelp size={18} strokeWidth={1.6} className={isHelpMode ? "text-accent" : ""} />
      {!collapsed && showLabel && <span>{isHelpMode ? "Exit help" : "Help"}</span>}
    </button>
  );
}
