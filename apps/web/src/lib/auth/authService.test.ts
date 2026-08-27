import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `vi.mock` factories are hoisted above top-level `const` declarations, so
 * the mock store must be created inside `vi.hoisted()` - the same pattern
 * already established throughout this codebase (e.g.
 * experimentMeasurementResultService.test.ts).
 */
const mocks = vi.hoisted(() => {
  type OperatorRow = { id: string; merchantId: string; email: string; passwordHash: string; createdAt: Date; updatedAt: Date };
  type SessionRow = { id: string; operatorId: string; tokenHash: string; createdAt: Date; expiresAt: Date; revokedAt: Date | null };

  const operators = new Map<string, OperatorRow>(); // keyed by email
  const sessions = new Map<string, SessionRow>(); // keyed by tokenHash
  // Simulates the real Operator.merchantId foreign key: only ids in this
  // set are "real" merchants, matching real Postgres's FK enforcement.
  const knownMerchantIds = new Set<string>(["merchant_1"]);
  let idCounter = 0;

  function makeUniqueConstraintError() {
    const error = new Error("Unique constraint failed on the fields: (`email`)") as Error & { code: string; meta: { target: string[] } };
    error.code = "P2002";
    error.meta = { target: ["email"] };
    return error;
  }

  function makeForeignKeyConstraintError() {
    const error = new Error("Foreign key constraint failed on the field: `operators_merchantId_fkey (index)`") as Error & { code: string };
    error.code = "P2003";
    return error;
  }

  const operatorCreate = vi.fn(async ({ data }: { data: { email: string; passwordHash: string; merchantId: string } }) => {
    if (!knownMerchantIds.has(data.merchantId)) throw makeForeignKeyConstraintError();
    if (operators.has(data.email)) throw makeUniqueConstraintError();
    const row: OperatorRow = {
      id: `operator_${++idCounter}`,
      merchantId: data.merchantId,
      email: data.email,
      passwordHash: data.passwordHash,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    operators.set(data.email, row);
    return row;
  });

  const operatorFindUnique = vi.fn(async ({ where }: { where: { email?: string; id?: string } }) => {
    if (where.email !== undefined) return operators.get(where.email) ?? null;
    return [...operators.values()].find((o) => o.id === where.id) ?? null;
  });

  const operatorSessionCreate = vi.fn(async ({ data }: { data: { operatorId: string; tokenHash: string; expiresAt: Date } }) => {
    const row: SessionRow = { id: `session_${++idCounter}`, operatorId: data.operatorId, tokenHash: data.tokenHash, createdAt: new Date(), expiresAt: data.expiresAt, revokedAt: null };
    sessions.set(row.tokenHash, row);
    return row;
  });

  const operatorSessionFindUnique = vi.fn(async ({ where }: { where: { tokenHash: string } }) => {
    const row = sessions.get(where.tokenHash);
    if (!row) return null;
    const operator = [...operators.values()].find((o) => o.id === row.operatorId) ?? null;
    return { ...row, operator };
  });

  const operatorSessionUpdateMany = vi.fn(async ({ where, data }: { where: { tokenHash: string; revokedAt: null }; data: { revokedAt: Date } }) => {
    const row = sessions.get(where.tokenHash);
    if (!row || row.revokedAt !== null) return { count: 0 };
    row.revokedAt = data.revokedAt;
    return { count: 1 };
  });

  return {
    operators,
    sessions,
    reset: () => {
      operators.clear();
      sessions.clear();
      idCounter = 0;
    },
    operatorCreate,
    operatorFindUnique,
    operatorSessionCreate,
    operatorSessionFindUnique,
    operatorSessionUpdateMany,
  };
});

vi.mock("@/lib/db", () => ({
  prisma: {
    operator: { create: mocks.operatorCreate, findUnique: mocks.operatorFindUnique },
    operatorSession: {
      create: mocks.operatorSessionCreate,
      findUnique: mocks.operatorSessionFindUnique,
      updateMany: mocks.operatorSessionUpdateMany,
    },
  },
}));

const { createOperator, verifyOperatorCredentials, createOperatorSession, resolveOperatorSession, revokeOperatorSession } = await import("./authService");

const MERCHANT_ID = "merchant_1";

describe("authService", () => {
  beforeEach(() => {
    mocks.reset();
    vi.clearAllMocks();
  });

  describe("createOperator", () => {
    it("creates an operator with a hashed password, never returning the hash", async () => {
      const result = await createOperator("Ops@Example.com", "a-real-password", MERCHANT_ID);
      expect(result.status).toBe("created");
      if (result.status !== "created") return;
      expect(result.operator.email).toBe("ops@example.com"); // normalized to lowercase
      expect(Object.keys(result.operator)).toEqual(["id", "email"]); // never passwordHash, never merchantId
    });

    it("rejects a too-short password before ever hashing or touching the database", async () => {
      const result = await createOperator("ops@example.com", "short", MERCHANT_ID);
      expect(result).toEqual({ status: "invalid_password" });
      expect(mocks.operatorCreate).not.toHaveBeenCalled();
    });

    it("rejects a duplicate email via the database's own unique constraint, not a check-then-insert", async () => {
      await createOperator("dup@example.com", "a-real-password", MERCHANT_ID);
      const second = await createOperator("dup@example.com", "a-different-password", MERCHANT_ID);
      expect(second).toEqual({ status: "email_already_exists" });
    });

    it("rejects a nonexistent merchant via the database's own foreign key constraint, not a check-then-insert", async () => {
      const result = await createOperator("ops@example.com", "a-real-password", "merchant_does_not_exist");
      expect(result).toEqual({ status: "merchant_not_found" });
    });
  });

  describe("verifyOperatorCredentials", () => {
    it("6. malformed/invalid input: an unknown email and a wrong password both return the SAME invalid_credentials result", async () => {
      await createOperator("real@example.com", "correct-password", MERCHANT_ID);

      const unknownEmail = await verifyOperatorCredentials("nobody@example.com", "anything");
      const wrongPassword = await verifyOperatorCredentials("real@example.com", "wrong-password");

      expect(unknownEmail).toEqual({ status: "invalid_credentials" });
      expect(wrongPassword).toEqual({ status: "invalid_credentials" });
    });

    it("returns the operator identity on correct credentials", async () => {
      await createOperator("real@example.com", "correct-password", MERCHANT_ID);
      const result = await verifyOperatorCredentials("real@example.com", "correct-password");
      expect(result.status).toBe("valid");
      if (result.status !== "valid") return;
      expect(result.operator.email).toBe("real@example.com");
    });

    it("is case-insensitive on email but case-sensitive on password", async () => {
      await createOperator("real@example.com", "Correct-Password", MERCHANT_ID);
      expect((await verifyOperatorCredentials("REAL@EXAMPLE.com", "Correct-Password")).status).toBe("valid");
      expect((await verifyOperatorCredentials("real@example.com", "correct-password")).status).toBe("invalid_credentials");
    });
  });

  describe("createOperatorSession / resolveOperatorSession", () => {
    it("1. a freshly created session resolves to the correct authenticated operator", async () => {
      const created = await createOperator("ops@example.com", "a-real-password", MERCHANT_ID);
      if (created.status !== "created") throw new Error("setup failed");

      const session = await createOperatorSession(created.operator.id);
      const resolved = await resolveOperatorSession(session.token);

      expect(resolved).not.toBeNull();
      expect(resolved?.operator.email).toBe("ops@example.com");
    });

    it("2. a missing session (undefined/no cookie) resolves to null", async () => {
      expect(await resolveOperatorSession(undefined)).toBeNull();
    });

    it("3. an expired session resolves to null", async () => {
      const created = await createOperator("ops@example.com", "a-real-password", MERCHANT_ID);
      if (created.status !== "created") throw new Error("setup failed");
      const session = await createOperatorSession(created.operator.id);

      // Directly age the row past expiry - simulating real time passing,
      // without needing to wait or fake system time.
      const stored = [...mocks.sessions.values()][0];
      stored.expiresAt = new Date(Date.now() - 1000);

      expect(await resolveOperatorSession(session.token)).toBeNull();
    });

    it("4. an unknown/invalid token (well-formed but never issued) resolves to null", async () => {
      const { generateSessionToken } = await import("./sessionToken");
      expect(await resolveOperatorSession(generateSessionToken())).toBeNull();
    });

    it("6. a malformed token (garbage string) resolves to null without ever querying the database", async () => {
      expect(await resolveOperatorSession("not-a-real-token")).toBeNull();
      expect(mocks.operatorSessionFindUnique).not.toHaveBeenCalled();
    });

    it("5. logout: a revoked session resolves to null afterward, but resolved correctly before revocation", async () => {
      const created = await createOperator("ops@example.com", "a-real-password", MERCHANT_ID);
      if (created.status !== "created") throw new Error("setup failed");
      const session = await createOperatorSession(created.operator.id);

      expect(await resolveOperatorSession(session.token)).not.toBeNull();

      await revokeOperatorSession(session.token);

      expect(await resolveOperatorSession(session.token)).toBeNull();
    });

    it("revocation is idempotent - revoking twice, or revoking an unknown token, never throws", async () => {
      const created = await createOperator("ops@example.com", "a-real-password", MERCHANT_ID);
      if (created.status !== "created") throw new Error("setup failed");
      const session = await createOperatorSession(created.operator.id);

      await revokeOperatorSession(session.token);
      await expect(revokeOperatorSession(session.token)).resolves.toBeUndefined();
      await expect(revokeOperatorSession("never-issued-token-value-xx")).resolves.toBeUndefined();
    });

    it("two sessions for the same operator are independent - revoking one leaves the other valid", async () => {
      const created = await createOperator("ops@example.com", "a-real-password", MERCHANT_ID);
      if (created.status !== "created") throw new Error("setup failed");
      const sessionA = await createOperatorSession(created.operator.id);
      const sessionB = await createOperatorSession(created.operator.id);

      await revokeOperatorSession(sessionA.token);

      expect(await resolveOperatorSession(sessionA.token)).toBeNull();
      expect(await resolveOperatorSession(sessionB.token)).not.toBeNull();
    });
  });
});
