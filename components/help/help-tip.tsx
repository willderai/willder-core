"use client";

import { useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useIsClient } from "@/hooks/use-is-client";
import { useHelpMode } from "./help-mode-provider";

type HelpTipProps = {
  tip: string;
  children: React.ReactNode;
  asChild?: boolean;
  className?: string;
};

export function HelpTip({ tip, children, className }: HelpTipProps) {
  const { isHelpMode } = useHelpMode();
  const [visible, setVisible] = useState(false);
  const [pos, setPos] = useState({ x: 0, y: 0 });
  const wrapRef = useRef<HTMLDivElement>(null);

  // Hide tooltip when help mode is turned off (adjusted during render, so the
  // stale tooltip never paints when help mode comes back on).
  if (!isHelpMode && visible) setVisible(false);

  if (!isHelpMode) {
    return <>{children}</>;
  }

  function handleMouseEnter(e: React.MouseEvent) {
    setPos({ x: e.clientX, y: e.clientY });
    setVisible(true);
  }

  function handleMouseMove(e: React.MouseEvent) {
    setPos({ x: e.clientX, y: e.clientY });
  }

  function handleMouseLeave() {
    setVisible(false);
  }

  // Clicking while in help mode shows tip and consumes the click (prevents nav etc.)
  function handleClick(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    // Keep visible so user can read, they must exit help mode to click normally
  }

  return (
    <>
      <div
        ref={wrapRef}
        className={`relative cursor-help ${className ?? ""}`}
        onMouseEnter={handleMouseEnter}
        onMouseMove={handleMouseMove}
        onMouseLeave={handleMouseLeave}
        onClick={handleClick}
        // Highlight elements in help mode
        style={{
          outline: visible
            ? "1px solid color-mix(in srgb, var(--color-gold) 45%, transparent)"
            : "1px solid transparent",
          outlineOffset: 3,
          borderRadius: 6,
          transition: "outline-color 0.12s",
        }}
      >
        {children}
      </div>

      {visible && <HelpTooltipPortal x={pos.x} y={pos.y} tip={tip} />}
    </>
  );
}

function HelpTooltipPortal({ x, y, tip }: { x: number; y: number; tip: string }) {
  const mounted = useIsClient();

  if (!mounted) return null;

  // Offset so tooltip doesn't cover cursor
  const offsetX = 16;
  const offsetY = 20;

  // Keep inside viewport
  const maxW = 280;
  const viewportW = typeof window !== "undefined" ? window.innerWidth : 1200;
  const left = x + offsetX + maxW > viewportW ? x - maxW - 8 : x + offsetX;
  const top = y + offsetY;

  if (typeof document === "undefined") return null;

  return createPortal(
    <div className="pointer-events-none fixed z-[9999]" style={{ left, top }}>
      <div className="rounded-lg border border-divider bg-overlay px-3.5 py-2.5 shadow-xl" style={{ maxWidth: maxW }}>
        <p className="mb-1 text-eyebrow font-semibold uppercase text-fg-subtle">Help</p>
        <p className="text-sm leading-relaxed text-fg">{tip}</p>
      </div>
    </div>,
    document.body,
  );
}
