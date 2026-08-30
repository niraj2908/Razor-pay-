import { describe, expect, it } from "vitest";
import { formatPercent, formatPercentOrUnavailable } from "./percent";

describe("formatPercent", () => {
  it("formats a 0-1 rate as a percentage with one fraction digit by default", () => {
    expect(formatPercent(0.4316)).toBe("43.2%");
  });

  it("formats zero as a real, distinct rate - never confused with unavailable", () => {
    expect(formatPercent(0)).toBe("0.0%");
  });

  it("formats 1 as a full 100%", () => {
    expect(formatPercent(1)).toBe("100.0%");
  });

  it("respects a custom fractionDigits argument", () => {
    expect(formatPercent(0.4316, 0)).toBe("43%");
  });
});

describe("formatPercentOrUnavailable", () => {
  it("a real zero rate displays as a genuine 0%, not 'Not available'", () => {
    expect(formatPercentOrUnavailable(0)).toBe("0.0%");
  });

  it("null renders as an honest unavailable state, never a fabricated 0%", () => {
    expect(formatPercentOrUnavailable(null)).toBe("Not available");
  });

  it("a real rate round-trips exactly like formatPercent", () => {
    expect(formatPercentOrUnavailable(0.32)).toBe(formatPercent(0.32));
  });
});
