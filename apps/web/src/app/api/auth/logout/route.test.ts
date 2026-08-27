import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const revokeOperatorSession = vi.fn();

vi.mock("@/lib/auth/authService", () => ({ revokeOperatorSession }));

const { POST } = await import("./route");

function requestWithCookie(cookieValue?: string) {
  const headers = new Headers();
  if (cookieValue !== undefined) {
    headers.set("cookie", `operator_session=${cookieValue}`);
  }
  return new NextRequest("http://localhost/api/auth/logout", { method: "POST", headers });
}

describe("POST /api/auth/logout", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("revokes the session found in the cookie and clears the cookie", async () => {
    revokeOperatorSession.mockResolvedValue(undefined);

    const response = await POST(requestWithCookie("some-token-value"));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "logged_out" });
    expect(revokeOperatorSession).toHaveBeenCalledWith("some-token-value");

    const setCookie = response.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("operator_session=");
    expect(setCookie.toLowerCase()).toContain("max-age=0");
  });

  it("is idempotent - logging out with no session cookie still succeeds", async () => {
    revokeOperatorSession.mockResolvedValue(undefined);

    const response = await POST(requestWithCookie(undefined));

    expect(response.status).toBe(200);
    expect(revokeOperatorSession).toHaveBeenCalledWith(undefined);
  });
});
