"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

/**
 * Signs the operator out via the existing POST /api/auth/logout contract,
 * then sends them to /login. A small, self-contained client leaf - the
 * rest of the sidebar stays a plain client component only for nav
 * (Sidebar itself), never for this action.
 */
export function LogoutButton() {
  const router = useRouter();
  const [pending, setPending] = useState(false);

  async function handleLogout() {
    setPending(true);
    try {
      await fetch("/api/auth/logout", { method: "POST" });
    } finally {
      router.push("/login");
      router.refresh();
    }
  }

  return (
    <button
      type="button"
      onClick={handleLogout}
      disabled={pending}
      className="text-fg-muted hover:text-fg text-xs underline decoration-dotted underline-offset-2 disabled:opacity-50"
    >
      {pending ? "Signing out…" : "Sign out"}
    </button>
  );
}
