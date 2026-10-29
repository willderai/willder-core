"use client";

import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";

// A modal dialog on the opaque overlay surface (claude/design.md section 4:
// dialogs use the stronger overlay so dense content stays readable). The parent
// mounts it only while open; Escape and a click on the backdrop both call
// onClose.
//
// Keyboard focus belongs to the dialog while it is open: it moves to the first
// control inside on open, Tab and Shift+Tab wrap within the dialog, and on close
// it returns to the element that had it before. That is what makes
// `aria-modal` true.
//
// It renders into document.body, outside the product shell's DOM, so the portal
// root carries `data-product-shell` itself: everything inside gets the shell's
// visible keyboard focus and reduced-motion rules from app/globals.css.
//
// `glow` names a quiet accent line along the top edge; true means the action
// colour. It is a hairline, never a wash.
type GlowColor = "gold" | "ember" | "brick";

const EDGE: Record<GlowColor, string> = {
  gold: "bg-accent/60",
  ember: "bg-ember/60",
  brick: "bg-danger/60",
};

const SIZE: Record<"lg" | "xl" | "2xl" | "3xl" | "wide", string> = {
  lg: "max-w-lg",
  xl: "max-w-xl",
  "2xl": "max-w-2xl",
  "3xl": "max-w-3xl",
  wide: "max-w-[78vw]",
};

const TABBABLE = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled]):not([type='hidden'])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "summary",
  "[contenteditable='true']",
  "[tabindex]:not([tabindex='-1'])",
].join(", ");

/** The elements inside `root` that Tab can reach, in document order. */
function tabbables(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(TABBABLE)].filter(
    (el) => !el.closest("[hidden], [inert], [aria-hidden='true']"),
  );
}

export function Modal({
  title,
  glow = false,
  onClose,
  children,
  footer,
  size = "lg",
}: {
  title: string;
  glow?: boolean | GlowColor;
  onClose: () => void;
  children: React.ReactNode;
  footer?: React.ReactNode;
  size?: "lg" | "xl" | "2xl" | "3xl" | "wide";
}) {
  const color: GlowColor | null = glow === true ? "gold" : glow === false ? null : glow;
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  // Read during the first render, before anything inside can take focus.
  const [opener] = useState<HTMLElement | null>(() =>
    typeof document === "undefined" ? null : (document.activeElement as HTMLElement | null),
  );

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.contains(document.activeElement)) {
      // The first control in the body or footer; the close button when there is none.
      const target = (contentRef.current && tabbables(contentRef.current)[0]) ?? tabbables(dialog)[0] ?? dialog;
      target.focus();
    }
    return () => {
      if (opener && opener !== document.body && opener.isConnected) opener.focus();
    };
  }, [opener]);

  function keepFocusInside(e: React.KeyboardEvent<HTMLDivElement>) {
    if (e.key !== "Tab") return;
    const dialog = e.currentTarget;
    const items = tabbables(dialog);
    if (items.length === 0) {
      e.preventDefault();
      dialog.focus();
      return;
    }
    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement;
    if (e.shiftKey && (active === first || active === dialog)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
  }

  return createPortal(
    <div data-product-shell>
      <div className="fixed inset-0 z-50 bg-ink/70 backdrop-blur-sm" onClick={onClose} />

      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className={`fixed left-1/2 top-1/2 z-50 flex max-h-[85vh] w-[calc(100%-2rem)] ${SIZE[size]} -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-2xl border border-divider bg-overlay text-fg shadow-2xl focus:outline-none`}
        style={{ maxHeight: "90vh" }}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={keepFocusInside}
      >
        {color && (
          <div aria-hidden className={`pointer-events-none absolute inset-x-0 top-0 z-10 h-px ${EDGE[color]}`} />
        )}

        <div className="relative flex shrink-0 items-start justify-between gap-4 border-b border-divider px-6 py-4">
          <h2 id={titleId} className="min-w-0 pt-1 text-lg font-semibold text-fg wrap-anywhere">
            {title}
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="-mr-2 flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-sm text-fg-subtle transition-colors hover:bg-fg/[0.06] hover:text-fg"
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        <div ref={contentRef} className="flex min-h-0 flex-1 flex-col">
          {/* Body: scrolls when the content overflows. */}
          <div className="relative flex-1 overflow-y-auto px-6 py-5">{children}</div>

          {footer && (
            <div className="relative flex shrink-0 flex-wrap items-center justify-end gap-3 border-t border-divider px-6 py-4">
              {footer}
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
