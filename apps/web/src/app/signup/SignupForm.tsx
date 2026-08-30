"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Button } from "@/components/ui/Button";
import { TextField } from "@/components/ui/TextField";

/**
 * Signup form (Phase 26, Public Onboarding). Talks to the existing
 * POST /api/auth/signup contract only - {email, password, workspaceName}
 * in, a Set-Cookie session on success (201), or one of a small set of
 * honest, specific failures. Unlike login, a duplicate-email response
 * here is deliberately specific ("this email is already registered") -
 * see signupService.ts's own doc comment for why signup and login differ
 * here on purpose.
 *
 * There is no merchant/workspace picker anywhere in this form - the
 * workspace name field creates a brand-new Merchant every time; joining
 * an existing one is a different, unbuilt capability (invitation-based),
 * not something this form could ever be pointed at.
 */
export function SignupForm() {
  const router = useRouter();
  const [workspaceName, setWorkspaceName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [fieldErrors, setFieldErrors] = useState<{ workspaceName?: string; email?: string; password?: string }>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormError(null);

    const nextFieldErrors: typeof fieldErrors = {};
    if (workspaceName.trim().length === 0) nextFieldErrors.workspaceName = "Enter a name for your workspace.";
    if (email.trim().length === 0) nextFieldErrors.email = "Enter your email address.";
    if (password.length === 0) nextFieldErrors.password = "Enter a password.";
    else if (password.length < 8) nextFieldErrors.password = "Use at least 8 characters.";
    setFieldErrors(nextFieldErrors);
    if (Object.keys(nextFieldErrors).length > 0) return;

    setSubmitting(true);
    try {
      const response = await fetch("/api/auth/signup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password, workspaceName }),
      });

      if (response.status === 201) {
        router.push("/overview");
        router.refresh();
        return;
      }

      if (response.status === 409) {
        setFormError("An account with this email already exists. Sign in instead.");
      } else if (response.status === 429) {
        setFormError("Too many attempts. Please wait a few minutes and try again.");
      } else if (response.status === 400) {
        setFormError("Check your workspace name, email, and password, then try again.");
      } else {
        setFormError("Something went wrong. Try again.");
      }
    } catch {
      setFormError("Could not reach the server. Check your connection and try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} noValidate className="flex flex-col gap-4">
      <TextField
        label="Workspace name"
        name="workspaceName"
        type="text"
        autoComplete="organization"
        value={workspaceName}
        onChange={(e) => setWorkspaceName(e.target.value)}
        error={fieldErrors.workspaceName}
        disabled={submitting}
      />
      <TextField
        label="Email"
        name="email"
        type="email"
        autoComplete="email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        error={fieldErrors.email}
        disabled={submitting}
      />
      <TextField
        label="Password"
        name="password"
        type="password"
        autoComplete="new-password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        error={fieldErrors.password}
        disabled={submitting}
      />

      {formError ? (
        <p role="alert" className="text-danger text-sm">
          {formError}
        </p>
      ) : null}

      <Button type="submit" loading={submitting} className="mt-2 w-full">
        Create workspace
      </Button>

      <p className="text-fg-muted text-center text-sm">
        Already have an account?{" "}
        <Link href="/login" className="text-info font-medium hover:underline">
          Sign in
        </Link>
      </p>
    </form>
  );
}
