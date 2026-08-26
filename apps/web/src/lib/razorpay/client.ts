const RAZORPAY_API_BASE = "https://api.razorpay.com/v1";

// A request that hangs longer than this is treated as a timeout - i.e. an
// AMBIGUOUS outcome, never a confirmed failure (see executionErrors.ts).
const REQUEST_TIMEOUT_MS = 10_000;

export type CreatePaymentLinkInput = {
  amount: number; // paise
  currency?: string;
  description?: string;
  customer?: { name?: string; email?: string; contact?: string };
  referenceId?: string;
};

export type CreatePaymentLinkResult = {
  id: string;
  shortUrl: string;
  status: string;
};

export type FetchPaymentResult = {
  id: string;
  status: string; // "created" | "authorized" | "captured" | "failed" | "refunded"
  amount: number;
  currency: string;
  method: string | null;
};

export type CapturePaymentResult = {
  id: string;
  status: string;
  amount: number;
  currency: string;
};

/** A definitive (non-ambiguous) error response from Razorpay - we know the
 * request was received and rejected/failed with this status. */
export class RazorpayApiError extends Error {
  readonly httpStatus: number;
  readonly description: string;

  constructor(httpStatus: number, description: string) {
    super(`Razorpay API error ${httpStatus}: ${description}`);
    this.name = "RazorpayApiError";
    this.httpStatus = httpStatus;
    this.description = description;
  }
}

/** No definitive response was received (timeout or network failure) - the
 * request may or may not have been processed by Razorpay. Never treat this
 * as a confirmed failure. */
export class RazorpayTimeoutError extends Error {
  constructor(message = "Razorpay API request timed out or the network failed") {
    super(message);
    this.name = "RazorpayTimeoutError";
  }
}

function authHeader(): string {
  const keyId = process.env.RAZORPAY_KEY_ID;
  const keySecret = process.env.RAZORPAY_KEY_SECRET;
  if (!keyId || !keySecret) {
    throw new Error("RAZORPAY_KEY_ID/RAZORPAY_KEY_SECRET are not configured");
  }
  return "Basic " + Buffer.from(`${keyId}:${keySecret}`).toString("base64");
}

async function razorpayFetch(path: string, init: RequestInit): Promise<Response> {
  // Resolved BEFORE the try block: a missing-credentials configuration
  // error must propagate as-is, not get misclassified as a network
  // timeout, and must never attempt the network call at all.
  const headers = { ...init.headers, Authorization: authHeader() };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(`${RAZORPAY_API_BASE}${path}`, { ...init, headers, signal: controller.signal });
  } catch (error) {
    // fetch() rejects on abort (timeout) and on network failure - both are
    // ambiguous, not a confirmed failure.
    throw new RazorpayTimeoutError(error instanceof Error ? error.message : undefined);
  } finally {
    clearTimeout(timeout);
  }
}

async function assertOk(response: Response, context: string): Promise<void> {
  if (!response.ok) {
    const body = await response.text();
    throw new RazorpayApiError(response.status, `${context}: ${body}`);
  }
}

/**
 * Thin server-side adapter over Razorpay's REST API. Reads
 * RAZORPAY_KEY_ID/RAZORPAY_KEY_SECRET from the server environment only -
 * this module must never be imported from a "use client" component, or the
 * credentials would be bundled into client-side JS.
 *
 * Errors are structured (`RazorpayApiError` vs `RazorpayTimeoutError`) so
 * callers (executionService.ts) can classify a definitive failure
 * differently from an ambiguous one - see executionErrors.ts.
 */
export const RazorpayClient = {
  paymentLinks: {
    async create(input: CreatePaymentLinkInput): Promise<CreatePaymentLinkResult> {
      const response = await razorpayFetch("/payment_links", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          amount: input.amount,
          currency: input.currency ?? "INR",
          description: input.description,
          customer: input.customer,
          reference_id: input.referenceId,
        }),
      });
      await assertOk(response, "payment_links.create");

      const data = await response.json();
      return { id: data.id, shortUrl: data.short_url, status: data.status };
    },
  },

  payments: {
    async fetch(paymentId: string): Promise<FetchPaymentResult> {
      const response = await razorpayFetch(`/payments/${paymentId}`, { method: "GET" });
      await assertOk(response, "payments.fetch");

      const data = await response.json();
      return {
        id: data.id,
        status: data.status,
        amount: data.amount,
        currency: data.currency,
        method: data.method ?? null,
      };
    },

    async capture(
      paymentId: string,
      amount: number,
      currency: string = "INR"
    ): Promise<CapturePaymentResult> {
      const response = await razorpayFetch(`/payments/${paymentId}/capture`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ amount, currency }),
      });
      await assertOk(response, "payments.capture");

      const data = await response.json();
      return { id: data.id, status: data.status, amount: data.amount, currency: data.currency };
    },
  },
};
