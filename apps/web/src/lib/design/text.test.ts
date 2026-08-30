import { describe, expect, it } from "vitest";
import { humanizeAuditAction, humanizeEnumValue } from "./text";

describe("humanizeEnumValue", () => {
  it("converts a SCREAMING_SNAKE_CASE enum into title case words", () => {
    expect(humanizeEnumValue("CONFIRMED_FAILURE")).toBe("Confirmed Failure");
  });

  it("handles a single-word enum with no underscores", () => {
    expect(humanizeEnumValue("SIMULATED")).toBe("Simulated");
  });

  it("handles an already-lowercase value the same way", () => {
    expect(humanizeEnumValue("payment_link")).toBe("Payment Link");
  });
});

describe("humanizeAuditAction", () => {
  it("splits an entity.verb audit action into 'Entity: Verb'", () => {
    expect(humanizeAuditAction("decision.act")).toBe("Decision: Act");
  });

  it("humanizes a multi-word verb after the dot", () => {
    expect(humanizeAuditAction("outcome.created")).toBe("Outcome: Created");
  });

  it("falls back to a plain humanized value when there is no dot", () => {
    expect(humanizeAuditAction("SIMULATED")).toBe("Simulated");
  });
});
