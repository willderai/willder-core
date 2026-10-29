"use client";

import { useEffect, useState } from "react";
import { useAuth } from "@clerk/nextjs";
import { OnboardingModal } from "./onboarding-modal";

// Shows the onboarding modal once the signed-in user has a workspace (a Clerk
// organization) whose onboarding is not done. Without an organization there is
// nowhere to save the answers, so the modal waits for one: it checks again when
// the active organization changes. Any status other than an explicit
// `done: false` (a 401, an error, a malformed body) keeps the modal closed.
export function OnboardingGate() {
  const { orgId } = useAuth();
  // The organization the modal is open for; a switch to another one closes it.
  const [openFor, setOpenFor] = useState<string | null>(null);

  useEffect(() => {
    if (!orgId) return;
    let current = true;
    fetch("/api/onboarding")
      .then(async (res) => {
        if (!res.ok) return;
        const data = (await res.json()) as { done?: unknown };
        if (current && data.done === false) setOpenFor(orgId);
      })
      .catch(() => {});
    return () => {
      current = false;
    };
  }, [orgId]);

  if (!orgId || openFor !== orgId) return null;
  return <OnboardingModal onDone={() => setOpenFor(null)} />;
}
