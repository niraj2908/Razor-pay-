import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RazorpayClient } from "./client";

describe("RazorpayClient.paymentLinks.create", () => {
  const originalKeyId = process.env.RAZORPAY_KEY_ID;
  const originalKeySecret = process.env.RAZORPAY_KEY_SECRET;
  const fetchMock = vi.fn();

  beforeEach(() => {
    process.env.RAZORPAY_KEY_ID = "rzp_test_fake_key_id";
    process.env.RAZORPAY_KEY_SECRET = "fake_key_secret";
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockReset();
  });

  afterEach(() => {
    process.env.RAZORPAY_KEY_ID = originalKeyId;
    process.env.RAZORPAY_KEY_SECRET = originalKeySecret;
    vi.unstubAllGlobals();
  });

  it("sends Basic auth built from server-side env vars, never client-exposed", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ id: "plink_123", short_url: "https://rzp.io/i/abc", status: "created" }),
    });

    const result = await RazorpayClient.paymentLinks.create({ amount: 10000 });

    expect(result).toEqual({ id: "plink_123", shortUrl: "https://rzp.io/i/abc", status: "created" });
    const [, requestInit] = fetchMock.mock.calls[0];
    const expectedAuth =
      "Basic " + Buffer.from("rzp_test_fake_key_id:fake_key_secret").toString("base64");
    expect(requestInit.headers.Authorization).toBe(expectedAuth);
  });

  it("throws when the credentials are not configured, rather than calling the API unauthenticated", async () => {
    delete process.env.RAZORPAY_KEY_ID;

    await expect(RazorpayClient.paymentLinks.create({ amount: 10000 })).rejects.toThrow(
      /not configured/
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("throws with the response body when Razorpay rejects the request", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 400,
      text: async () => '{"error":{"description":"bad request"}}',
    });

    await expect(RazorpayClient.paymentLinks.create({ amount: 10000 })).rejects.toThrow(
      /400/
    );
  });
});
