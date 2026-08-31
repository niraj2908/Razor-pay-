"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Button } from "@/components/ui/Button";
import { TextField } from "@/components/ui/TextField";

/**
 * Login form (Phase 26 Phase C). Talks to the existing
 * POST /api/auth/login contract only - {email, password} in, a Set-Cookie
 * session on success, or a uniform `invalid_credentials` 401 (this form
 * never distinguishes "wrong email" from "wrong password", matching the
 * backend's own enumeration-resistant design).
 *
 * "Explore Demo" (Phase 28C reliability fix) is a plain link to GET /demo,
 * not a client-fetch button - it must work even if this component's own
 * JS never finishes loading, and must be reachable as a bookmarkable URL
 * on its own. `demoErrorMessage` is passed down from the server-rendered
 * page after GET /demo redirects back here having failed.
 */
export function LoginForm({ demoErrorMessage = null }: { demoErrorMessage?: string | null }) {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [fieldErrors, setFieldErrors] = useState<{ email?: string; password?: string }>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormError(null);

    const nextFieldErrors: { email?: string; password?: string } = {};
    if (email.trim().length === 0) nextFieldErrors.email = "Enter your email address.";
    if (password.length === 0) nextFieldErrors.password = "Enter your password.";
    setFieldErrors(nextFieldErrors);
    if (Object.keys(nextFieldErrors).length > 0) return;

    setSubmitting(true);
    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });

      if (response.status === 200) {
        router.push("/overview");
        router.refresh();
        return;
      }

      if (response.status === 401) {
        setFormError("Incorrect email or password.");
      } else if (response.status === 400) {
        setFormError("Enter both an email and a password.");
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
        autoComplete="current-password"
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
        Sign in
      </Button>

      <p className="text-fg-muted text-center text-sm">
        New here?{" "}
        <Link href="/signup" className="text-info font-medium hover:underline">
          Create a workspace
        </Link>
      </p>

      {/* Evaluating is the most likely reason someone is on this page, and
          it is the one path that needs no credentials - so it reads as a
          real action rather than as fine print under the form. Sign-in stays
          the primary-styled control for the operators who actually have an
          account. */}
      <div className="border-border mt-1 flex flex-col gap-2 border-t pt-4">
        <p className="text-fg-secondary text-sm">Evaluating the product? No account needed.</p>
        <Link
          href="/demo"
          className="border-border bg-surface text-fg hover:bg-surface-subtle flex h-10 w-full items-center justify-center rounded-md border text-sm font-medium"
        >
          Explore the demo workspace
        </Link>
        <p className="text-fg-muted text-xs">
          Opens a populated, clearly-labelled synthetic workspace. No real customer payments.
        </p>
        {demoErrorMessage ? (
          <p role="alert" className="text-danger text-xs">
            {demoErrorMessage}
          </p>
        ) : null}
      </div>
    </form>
  );
}
