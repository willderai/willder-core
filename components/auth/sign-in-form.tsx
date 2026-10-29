"use client";

import { useState } from "react";
import NextLink from "next/link";
import { useSignIn } from "@clerk/nextjs";
import { Button, FieldError, Input, Label, Separator, Spinner, TextField } from "@heroui/react";
import { rememberReturnPath, returnPathFromLocation } from "@/lib/return-path";
import { AuthShell, GoogleIcon } from "./auth-shell";
import { EyeIcon, EyeOffIcon } from "./icons";

export function SignInForm() {
  const { signIn, errors, fetchStatus } = useSignIn();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  // Clerk accepted the password but wants a step this form has no screen for
  // (a second factor, or a code for a new device).
  const [incompleteStep, setIncompleteStep] = useState(false);

  const busy = fetchStatus === "fetching";
  const globalError = errors?.global?.[0]?.message;

  // Leave with a full page load, not router.push: this page and the product shell
  // each mount their own ClerkProvider, and a client-side push from inside
  // finalize() swaps them while Clerk is still activating the session, which
  // left a successful sign-in sitting on /sign-in.
  function finish() {
    return signIn.finalize({
      navigate: ({ decorateUrl }) => {
        window.location.assign(decorateUrl(returnPathFromLocation()));
      },
    });
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setIncompleteStep(false);
    const { error } = await signIn.password({ identifier: email, password });
    if (error) return;
    if (signIn.status === "complete") return finish();
    setIncompleteStep(true);
  }

  function handleGoogle() {
    rememberReturnPath();
    return signIn.sso({
      strategy: "oauth_google",
      redirectUrl: returnPathFromLocation(),
      redirectCallbackUrl: "/sso-callback",
    });
  }

  return (
    <AuthShell
      title="Welcome back"
      description="Sign in to your Willder workspace."
      footer={
        <span>
          New here?{" "}
          <NextLink href="/sign-up" className="font-medium text-accent underline-offset-4 hover:underline">
            Create an account
          </NextLink>
        </span>
      }
    >
      <Button variant="outline" fullWidth onPress={handleGoogle} isDisabled={busy} className="min-h-11">
        <GoogleIcon className="size-4" />
        Continue with Google
      </Button>

      <div className="flex items-center gap-3 text-base text-fg-muted">
        <Separator className="flex-1" />
        or
        <Separator className="flex-1" />
      </div>

      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        <TextField type="email" value={email} onChange={setEmail} isRequired isInvalid={!!errors?.fields?.identifier}>
          <Label>Email</Label>
          <Input placeholder="you@company.com" autoComplete="email" />
          {errors?.fields?.identifier ? <FieldError>{errors.fields.identifier.message}</FieldError> : null}
        </TextField>

        <TextField
          type={showPassword ? "text" : "password"}
          value={password}
          onChange={setPassword}
          isRequired
          isInvalid={!!errors?.fields?.password}
        >
          <Label>Password</Label>
          <div className="relative">
            <Input placeholder="Enter your password" autoComplete="current-password" className="w-full pr-11" />
            <button
              type="button"
              onClick={() => setShowPassword((s) => !s)}
              aria-label={showPassword ? "Hide password" : "Show password"}
              className="absolute inset-y-0 right-0 flex w-11 items-center justify-center rounded-xl text-fg-muted transition-colors hover:text-fg focus-visible:outline-2 focus-visible:-outline-offset-4 focus-visible:outline-info"
            >
              {showPassword ? <EyeOffIcon className="size-4" /> : <EyeIcon className="size-4" />}
            </button>
          </div>
          {errors?.fields?.password ? <FieldError>{errors.fields.password.message}</FieldError> : null}
        </TextField>

        {globalError ? <p className="text-base text-danger">{globalError}</p> : null}
        {incompleteStep ? (
          <p className="text-base text-danger">
            This account needs another verification step that this page can&apos;t complete yet, so you aren&apos;t
            signed in.
          </p>
        ) : null}

        <Button type="submit" variant="primary" fullWidth isDisabled={busy} className="min-h-11">
          {busy ? <Spinner size="sm" color="current" /> : "Sign in"}
        </Button>
      </form>
    </AuthShell>
  );
}
