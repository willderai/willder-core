"use client";

import { createContext, useContext, useState, useCallback, useEffect } from "react";

type HelpModeContextValue = {
  isHelpMode: boolean;
  toggleHelpMode: () => void;
  disableHelpMode: () => void;
};

const HelpModeContext = createContext<HelpModeContextValue>({
  isHelpMode: false,
  toggleHelpMode: () => {},
  disableHelpMode: () => {},
});

export function HelpModeProvider({ children }: { children: React.ReactNode }) {
  const [isHelpMode, setIsHelpMode] = useState(false);

  const toggleHelpMode = useCallback(() => setIsHelpMode((v) => !v), []);
  const disableHelpMode = useCallback(() => setIsHelpMode(false), []);

  // Escape key exits help mode
  useEffect(() => {
    if (!isHelpMode) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") setIsHelpMode(false);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [isHelpMode]);

  return (
    <HelpModeContext.Provider value={{ isHelpMode, toggleHelpMode, disableHelpMode }}>
      <div data-help-mode={isHelpMode ? "true" : undefined} style={isHelpMode ? { cursor: "help" } : undefined}>
        {children}
      </div>
    </HelpModeContext.Provider>
  );
}

export function useHelpMode() {
  return useContext(HelpModeContext);
}
