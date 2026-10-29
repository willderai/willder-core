import { ClerkProvider } from "@clerk/nextjs";
import { AppNav } from "@/components/app-nav";
import { Backdrop } from "@/components/backdrop";
import { HelpModeProvider } from "@/components/help";
import { ToastProvider } from "@/components/ui";
import { OnboardingGate } from "@/components/onboarding/onboarding-gate";
import { CLERK_APPEARANCE } from "@/components/clerk-appearance";
import type { Metadata } from "next";
import "../heroui.css";

export const metadata: Metadata = { robots: { index: false, follow: false } };

// Product shell — the dark "armor" surface. All product routes render inside it.
// ClerkProvider lives here, not the root layout: every route under this group
// is already gated by proxy.ts's middleware and genuinely needs a live Clerk
// session, unlike the marketing routes.
export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <ClerkProvider appearance={CLERK_APPEARANCE}>
      <ToastProvider>
        <HelpModeProvider>
          <div data-product-shell className="flex h-dvh overflow-hidden bg-ink text-fg">
            <a
              href="#workspace-content"
              className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-lg focus:bg-panel focus:px-4 focus:py-3"
            >
              Skip to content
            </a>
            <AppNav />
            <main
              data-app-shell
              id="workspace-content"
              className="relative min-w-0 flex-1 overflow-y-auto"
              tabIndex={-1}
            >
              <Backdrop className="opacity-90" />
              <div className="relative z-10">{children}</div>
              <OnboardingGate />
            </main>
          </div>
        </HelpModeProvider>
      </ToastProvider>
    </ClerkProvider>
  );
}
