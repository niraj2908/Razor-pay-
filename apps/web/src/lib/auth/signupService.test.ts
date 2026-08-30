import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `vi.mock` factories are hoisted above top-level `const` declarations -
 * the mock store must be created inside `vi.hoisted()`, the same pattern
 * already established in `authService.test.ts`.
 *
 * `$transaction` here just invokes its callback with a `tx` object backed
 * by the same in-memory maps as the top-level mocked client - this is
 * sufficient to unit-test signupService's OWN logic (validation order,
 * error-code mapping, the returned shape) but does NOT prove real
 * Postgres rollback semantics, which is exactly why atomicity itself
 * (does a duplicate-email race leave zero orphaned Merchants?) is proven
 * separately against a real database in signupService.integration.test.ts,
 * not asserted here.
 */
const mocks = vi.hoisted(() => {
  type MerchantRow = { id: string; name: string };
  type OperatorRow = { id: string; merchantId: string; email: string; passwordHash: string };

  const merchants = new Map<string, MerchantRow>();
  const operators = new Map<string, OperatorRow>(); // keyed by email
  let idCounter = 0;

  function makeUniqueConstraintError() {
    const error = new Error("Unique constraint failed on the fields: (`email`)") as Error & { code: string };
    error.code = "P2002";
    return error;
  }

  const merchantCreate = vi.fn(async ({ data }: { data: { name: string } }) => {
    const row: MerchantRow = { id: `merchant_${++idCounter}`, name: data.name };
    merchants.set(row.id, row);
    return row;
  });

  const operatorCreate = vi.fn(async ({ data }: { data: { email: string; passwordHash: string; merchantId: string } }) => {
    if (operators.has(data.email)) throw makeUniqueConstraintError();
    const row: OperatorRow = { id: `operator_${++idCounter}`, merchantId: data.merchantId, email: data.email, passwordHash: data.passwordHash };
    operators.set(data.email, row);
    return row;
  });

  const transaction = vi.fn(async (callback: (tx: { merchant: { create: typeof merchantCreate }; operator: { create: typeof operatorCreate } }) => Promise<unknown>) => {
    return callback({ merchant: { create: merchantCreate }, operator: { create: operatorCreate } });
  });

  return {
    merchants,
    operators,
    reset: () => {
      merchants.clear();
      operators.clear();
      idCounter = 0;
    },
    merchantCreate,
    operatorCreate,
    transaction,
  };
});

vi.mock("@/lib/db", () => ({
  prisma: {
    $transaction: mocks.transaction,
  },
}));

const { signUpNewWorkspace } = await import("./signupService");

describe("signUpNewWorkspace", () => {
  beforeEach(() => {
    mocks.reset();
    vi.clearAllMocks();
  });

  it("creates a new Merchant and its first Operator, returning the merchant id", async () => {
    const result = await signUpNewWorkspace("New.Operator@Example.com", "a-real-password", "  Acme Recovery  ");

    expect(result.status).toBe("created");
    if (result.status !== "created") return;
    expect(result.operator.email).toBe("new.operator@example.com");
    expect(mocks.merchants.get(result.merchantId)?.name).toBe("Acme Recovery");
    // the created operator really is scoped to the just-created merchant
    expect(mocks.operators.get("new.operator@example.com")?.merchantId).toBe(result.merchantId);
  });

  it("normalizes email the same way authService does (trim + lowercase)", async () => {
    const result = await signUpNewWorkspace("  Mixed.Case@Example.COM  ", "a-real-password", "Workspace");
    expect(result.status).toBe("created");
    if (result.status !== "created") return;
    expect(result.operator.email).toBe("mixed.case@example.com");
  });

  it("rejects a too-short password before ever touching the database", async () => {
    const result = await signUpNewWorkspace("ops@example.com", "short", "Workspace");
    expect(result).toEqual({ status: "invalid_password" });
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it("rejects an empty/whitespace-only workspace name before ever touching the database", async () => {
    const result = await signUpNewWorkspace("ops@example.com", "a-real-password", "   ");
    expect(result).toEqual({ status: "invalid_workspace_name" });
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it("maps a duplicate email (P2002) to email_already_exists, never a raw database error", async () => {
    const first = await signUpNewWorkspace("duplicate@example.com", "a-real-password", "First Workspace");
    expect(first.status).toBe("created");

    const second = await signUpNewWorkspace("duplicate@example.com", "a-different-password", "Second Workspace");
    expect(second).toEqual({ status: "email_already_exists" });
  });

  it("never includes the password or its hash in a returned result", async () => {
    const result = await signUpNewWorkspace("ops@example.com", "a-very-specific-password-value", "Workspace");
    expect(result.status).toBe("created");
    expect(JSON.stringify(result)).not.toContain("a-very-specific-password-value");
  });

  it("re-throws an unexpected, non-P2002 database error rather than swallowing it", async () => {
    mocks.transaction.mockRejectedValueOnce(new Error("connection refused"));
    await expect(signUpNewWorkspace("ops@example.com", "a-real-password", "Workspace")).rejects.toThrow("connection refused");
  });
});
