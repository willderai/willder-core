"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
// HandleSSOCallback is the Future-API callback handler; @clerk/nextjs doesn't
// re-export it at the top level, so import from @clerk/react (the same instance
// @clerk/nextjs is built on — useSignIn/useSignUp come from here too).
import { HandleSSOCallback } from "@clerk/react";
import { Backdrop } from "@/components/backdrop";
import { Spinner } from "@heroui/react";
import { takeRememberedReturnPath } from "@/lib/return-path";

export default function SSOCallbackPage() {
  const router = useRouter();

  function go(path: string) {
    router.push(path);
  }

  // useState's lazy initializer runs exactly once and is React's documented
  // escape hatch for a one-time impure read -- calling performance.now()
  // directly in the render body (the prior shape here) is impure: a
  // re-render before the callback fires would reset the elapsed-time
  // baseline it's meant to measure.
  const [mountedAt] = useState(() => (typeof performance !== "undefined" ? performance.now() : 0));

  return (
    <div className="relative flex min-h-screen flex-col items-center justify-center gap-4 bg-ink px-6">
      <Backdrop />
      <div className="relative z-10 flex flex-col items-center gap-4 text-fg-muted">
        <Spinner size="lg" color="accent" />
        <p className="text-sm">Finishing sign-in…</p>
      </div>
      <HandleSSOCallback
        navigateToApp={({ decorateUrl }) => {
          console.log(`[sso-callback] navigateToApp fired after ${(performance.now() - mountedAt).toFixed(0)}ms`);
          const url = decorateUrl(takeRememberedReturnPath());
          console.log("[sso-callback] navigate →", url);
          if (url.startsWith("http")) window.location.href = url;
          else go(url);
        }}
        navigateToSignIn={() => go("/sign-in")}
        navigateToSignUp={() => go("/sign-up")}
      />
    </div>
  );
}
