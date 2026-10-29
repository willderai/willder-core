import { dark } from "@clerk/themes";
import type { ClerkProvider } from "@clerk/nextjs";
import type { ComponentProps } from "react";

// Shared by every ClerkProvider in the app (product shell, auth routes, and
// the marketing pages' lazy auth widget) so the theme only lives in one
// place now that ClerkProvider is no longer a single root-layout instance.
export const CLERK_APPEARANCE: NonNullable<ComponentProps<typeof ClerkProvider>["appearance"]> = {
  baseTheme: dark,
  variables: {
    colorPrimary: "var(--color-gold)",
    colorPrimaryForeground: "var(--color-ink)",
    colorBackground: "var(--color-ink)",
    colorInput: "var(--field-background)",
    colorInputForeground: "var(--color-marble)",
    colorForeground: "var(--color-marble)",
    colorMutedForeground: "var(--brand-muted)",
    colorNeutral: "var(--color-marble)",
    fontFamily: "var(--font-manrope)",
  },
};
