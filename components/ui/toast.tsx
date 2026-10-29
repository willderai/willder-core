"use client";

import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { createPortal } from "react-dom";

// Short-lived notices in the corner. Each sits on the opaque overlay surface so
// its words stay readable over any page, with the variant carried by the icon and
// the edge, not by tinting the text. The stack is a polite live region, so a
// screen reader announces each notice as it appears. Like Modal, the portal root
// carries `data-product-shell` for the shell's focus and reduced-motion rules.
type ToastVariant = "error" | "success" | "info";

type Toast = {
  id: number;
  message: string;
  variant: ToastVariant;
};

type ToastContextValue = {
  toast: (message: string, variant?: ToastVariant) => void;
};

const ToastContext = createContext<ToastContextValue>({ toast: () => {} });

const EDGE: Record<ToastVariant, string> = {
  error: "border-danger/50",
  success: "border-success/45",
  info: "border-divider",
};

const ICON: Record<ToastVariant, string> = {
  error: "text-danger",
  success: "text-success",
  info: "text-fg-subtle",
};

let _id = 0;

function ToastItem({ t, onRemove }: { t: Toast; onRemove: (id: number) => void }) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const show = setTimeout(() => setVisible(true), 10);
    const hide = setTimeout(() => setVisible(false), 3500);
    const remove = setTimeout(() => onRemove(t.id), 3800);
    return () => {
      clearTimeout(show);
      clearTimeout(hide);
      clearTimeout(remove);
    };
  }, [t.id, onRemove]);

  return (
    <div
      className={`pointer-events-auto w-full rounded-xl border bg-overlay px-4 py-3 text-sm text-fg shadow-xl transition-all duration-300 sm:w-auto sm:min-w-[260px] sm:max-w-[380px] ${EDGE[t.variant]} ${
        visible ? "translate-y-0 opacity-100" : "translate-y-2 opacity-0"
      }`}
    >
      <div className="flex items-start gap-3">
        <span aria-hidden className={`mt-0.5 shrink-0 text-base leading-none ${ICON[t.variant]}`}>
          {t.variant === "error" ? "✕" : t.variant === "success" ? "✓" : "·"}
        </span>
        <p className="min-w-0 leading-snug">{t.message}</p>
        <button
          type="button"
          onClick={() => onRemove(t.id)}
          className="-my-1.5 -mr-2 ml-auto flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-fg-subtle transition-colors hover:bg-fg/[0.06] hover:text-fg"
          aria-label="Dismiss"
        >
          ✕
        </button>
      </div>
    </div>
  );
}

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  const remove = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const toast = useCallback((message: string, variant: ToastVariant = "info") => {
    setToasts((prev) => [...prev, { id: ++_id, message, variant }]);
  }, []);

  return (
    <ToastContext.Provider value={{ toast }}>
      {children}
      {mounted &&
        createPortal(
          <div data-product-shell>
            <div
              role="status"
              aria-live="polite"
              className="pointer-events-none fixed inset-x-4 bottom-4 z-[9999] flex flex-col items-end gap-2 sm:inset-x-auto sm:bottom-6 sm:right-6"
            >
              {toasts.map((t) => (
                <ToastItem key={t.id} t={t} onRemove={remove} />
              ))}
            </div>
          </div>,
          document.body,
        )}
    </ToastContext.Provider>
  );
}

export function useToast() {
  return useContext(ToastContext);
}
