const RAZORPAY_API_BASE = "https://api.razorpay.com/v1";

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

function authHeader(): string {
  const keyId = process.env.RAZORPAY_KEY_ID;
  const keySecret = process.env.RAZORPAY_KEY_SECRET;
  if (!keyId || !keySecret) {
    throw new Error("RAZORPAY_KEY_ID/RAZORPAY_KEY_SECRET are not configured");
  }
  return "Basic " + Buffer.from(`${keyId}:${keySecret}`).toString("base64");
}

/**
 * Thin server-side adapter over Razorpay's REST API. Reads
 * RAZORPAY_KEY_ID/RAZORPAY_KEY_SECRET from the server environment only -
 * this module must never be imported from a "use client" component, or the
 * credentials would be bundled into client-side JS.
 *
 * This is an integration BOUNDARY, not a feature: nothing in this codebase
 * calls it yet, since no recovery/decision engine exists to decide when a
 * payment link should be sent (see services/*\/README.md - that layer is
 * still "Planned"). It exists so that future logic has one clean place to
 * call instead of scattering ad hoc fetch() calls to Razorpay's API.
 */
export const RazorpayClient = {
  paymentLinks: {
    async create(input: CreatePaymentLinkInput): Promise<CreatePaymentLinkResult> {
      const response = await fetch(`${RAZORPAY_API_BASE}/payment_links`, {
        method: "POST",
        headers: {
          Authorization: authHeader(),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          amount: input.amount,
          currency: input.currency ?? "INR",
          description: input.description,
          customer: input.customer,
          reference_id: input.referenceId,
        }),
      });

      if (!response.ok) {
        const body = await response.text();
        throw new Error(`Razorpay payment_links.create failed: ${response.status} ${body}`);
      }

      const data = await response.json();
      return { id: data.id, shortUrl: data.short_url, status: data.status };
    },
  },
};
