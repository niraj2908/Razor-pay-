import { describe, expect, it } from "vitest";
import { formatPaiseAsInr, resolveMoneyDisplay } from "./money";

describe("formatPaiseAsInr", () => {
  it("formats a real paise amount using Indian digit grouping", () => {
    expect(formatPaiseAsInr(123456789)).toBe("₹12,34,567.89");
  });

  it("formats zero as a real, distinct amount - never confused with unavailable", () => {
    expect(formatPaiseAsInr(0)).toBe("₹0.00");
  });

  it("formats a negative paise amount (e.g. a signed incremental GMV) with its sign preserved", () => {
    expect(formatPaiseAsInr(-50050)).toBe("-₹500.50");
  });

  it("formats a sub-rupee amount correctly", () => {
    expect(formatPaiseAsInr(150)).toBe("₹1.50");
  });

  it("throws on a non-integer paise value rather than silently rounding", () => {
    expect(() => formatPaiseAsInr(100.5)).toThrow();
  });
});

describe("resolveMoneyDisplay - the unavailable/unknown/zero distinction", () => {
  it("a real zero amount displays as a genuine zero, not 'unavailable'", () => {
    const result = resolveMoneyDisplay({ kind: "amount", paise: 0 });
    expect(result.text).toBe("₹0.00");
    expect(result.isAmount).toBe(true);
  });

  it("an unavailable value never displays as any monetary figure, including 0", () => {
    const result = resolveMoneyDisplay({ kind: "unavailable", reason: "no_valid_effect_result" });
    expect(result.text).not.toContain("₹");
    expect(result.isAmount).toBe(false);
    expect(result.ariaLabel).toContain("no_valid_effect_result");
  });

  it("an unavailable value with no reason still renders honest text, not a fabricated number", () => {
    const result = resolveMoneyDisplay({ kind: "unavailable" });
    expect(result.text).toBe("Not available");
    expect(result.text).not.toContain("₹");
  });

  it("an unknown value is textually distinct from unavailable and from zero", () => {
    const result = resolveMoneyDisplay({ kind: "unknown" });
    expect(result.text).toBe("Unknown");
    expect(result.isAmount).toBe(false);
    expect(result.text).not.toBe("Not available");
    expect(result.text).not.toContain("₹");
  });

  it("a real non-zero amount round-trips through resolveMoneyDisplay exactly like formatPaiseAsInr", () => {
    const result = resolveMoneyDisplay({ kind: "amount", paise: 250000 });
    expect(result.text).toBe(formatPaiseAsInr(250000));
    expect(result.ariaLabel).toBe(result.text);
  });
});
