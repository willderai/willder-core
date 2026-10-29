import { ClerkProvider } from "@clerk/nextjs";
import { CLERK_APPEARANCE } from "@/components/clerk-appearance";
import "../heroui.css";

// Sign in, sign up and the SSO callback are the only top-level routes
// outside the product shell that genuinely need a live Clerk session on
// first paint. Grouped here so ClerkProvider stays out of the root layout
// (see app/layout.tsx) without duplicating this wrapper across three
// separate route folders.
export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return <ClerkProvider appearance={CLERK_APPEARANCE}>{children}</ClerkProvider>;
}
