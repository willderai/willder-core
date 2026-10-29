"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import NextLink from "next/link";
import { useSignUp } from "@clerk/nextjs";
import { Button, FieldError, Input, InputOTP, Label, Separator, Spinner, TextField } from "@heroui/react";
import { rememberReturnPath, returnPathFromLocation } from "@/lib/return-path";
import { AuthShell, GoogleIcon } from "./auth-shell";
import { EyeIcon, EyeOffIcon } from "./icons";

export function SignUpForm() {
  const { signUp, errors, fetchStatus } = useSignUp();
  const router = useRouter();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [code, setCode] = useState("");
  const [pendingCode, setPendingCode] = useState(false);

  const busy = fetchStatus === "fetching";
  const globalError = errors?.global?.[0]?.message;

  function finish() {
    console.log("[sign-up] finalize() start");
    return signUp.finalize({
      navigate: ({ decorateUrl }) => {
        const url = decorateUrl(returnPathFromLocation());
        console.log("[sign-up] navigate →", url);
        if (url.startsWith("http")) window.location.href = url;
        else router.push(url);
      },
    });
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    console.log("[sign-up] password() start");
    const t0 = performance.now();
    const { error } = await signUp.password({ emailAddress: email, password });
    console.log(
      `[sign-up] password() done in ${(performance.now() - t0).toFixed(0)}ms — status: ${signUp.status}`,
      error ?? "",
    );
    if (error) return;
    if (signUp.status === "complete") return finish();
    if (signUp.unverifiedFields.includes("email_address")) {
      console.log("[sign-up] sending email verification code");
      const t1 = performance.now();
      await signUp.verifications.sendEmailCode();
      console.log(`[sign-up] email code sent in ${(performance.now() - t1).toFixed(0)}ms`);
      setPendingCode(true);
    }
  }

  async function handleVerify(e: React.FormEvent) {
    e.preventDefault();
    console.log("[sign-up] verifyEmailCode() start");
    const t0 = performance.now();
    const { error } = await signUp.verifications.verifyEmailCode({ code });
    console.log(
      `[sign-up] verifyEmailCode() done in ${(performance.now() - t0).toFixed(0)}ms — status: ${signUp.status}`,
      error ?? "",
    );
    if (error) return;
    if (signUp.status === "complete") return finish();
  }

  function handleGoogle() {
    rememberReturnPath();
    return signUp.sso({
      strategy: "oauth_google",
      redirectUrl: returnPathFromLocation(),
      redirectCallbackUrl: "/sso-callback",
    });
  }

  // ── Step 2: email verification code ────────────────────────────────────────
  if (pendingCode) {
    return (
      <AuthShell
        title="Check your email"
        description={`Enter the 6-digit code we sent to ${email}.`}
        footer={
          <button
            type="button"
            onClick={() => signUp.verifications.sendEmailCode()}
            className="inline-flex min-h-11 items-center text-fg-muted transition-colors hover:text-accent"
          >
            Resend code
          </button>
        }
      >
        <form onSubmit={handleVerify} className="flex flex-col gap-5">
          <InputOTP
            maxLength={6}
            value={code}
            onChange={setCode}
            isInvalid={!!errors?.fields?.code}
            className="justify-center"
          >
            <InputOTP.Group>
              {[0, 1, 2, 3, 4, 5].map((i) => (
                <InputOTP.Slot key={i} index={i} />
              ))}
            </InputOTP.Group>
          </InputOTP>
          {errors?.fields?.code ? (
            <p className="text-center text-base text-danger">{errors.fields.code.message}</p>
          ) : null}
          <Button type="submit" variant="primary" fullWidth isDisabled={busy || code.length < 6} className="min-h-11">
            {busy ? <Spinner size="sm" color="current" /> : "Verify email"}
          </Button>
        </form>
      </AuthShell>
    );
  }

  // ── Step 1: email + password ───────────────────────────────────────────────
  return (
    <AuthShell
      title="Create your account"
      description="Start your trial. No card required."
      footer={
        <span className="flex flex-col items-center gap-2 text-center">
          <span>
            Already have an account?{" "}
            <NextLink href="/sign-in" className="font-medium text-accent underline-offset-4 hover:underline">
              Sign in
            </NextLink>
          </span>
          <span>
            Using Claude Code?{" "}
            <NextLink href="/docs/claude-code" className="font-medium text-accent underline-offset-4 hover:underline">
              See the setup after sign-up
            </NextLink>
          </span>
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
        <TextField type="email" value={email} onChange={setEmail} isRequired isInvalid={!!errors?.fields?.emailAddress}>
          <Label>Email</Label>
          <Input placeholder="you@company.com" autoComplete="email" />
          {errors?.fields?.emailAddress ? <FieldError>{errors.fields.emailAddress.message}</FieldError> : null}
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
            <Input placeholder="Create a password" autoComplete="new-password" className="w-full pr-11" />
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

        {/* Clerk bot-protection mounts here when required */}
        <div id="clerk-captcha" />

        <Button type="submit" variant="primary" fullWidth isDisabled={busy} className="min-h-11">
          {busy ? <Spinner size="sm" color="current" /> : "Continue"}
        </Button>
      </form>
    </AuthShell>
  );
}
