/**
 * Financial-number display logic (Phase 26 Phase B).
 *
 * Every backend money field in this system is an integer number of paise
 * (see Payment/RevenueRiskEvent/Outcome/ExperimentMeasurementResult across
 * the API surface) - this module is the ONLY place that turns a paise
 * integer into a displayed Rupee string, so every screen formats money
 * identically.
 *
 * The critical rule this module exists to enforce (Section 7 of the design
 * brief): a real, reported ZERO amount, an UNAVAILABLE figure (the backend
 * computed nothing), and an UNKNOWN figure (no data exists to compute from)
 * are three genuinely different states and must never collapse into the
 * same "$0" display. Callers express this explicitly via `MoneyValue` -
 * there is no code path that can accidentally print "0" for a value that
 * was never actually zero.
 */

export type MoneyValue =
  | { kind: "amount"; paise: number }
  | { kind: "unavailable"; reason?: string }
  | { kind: "unknown" };

const INR_FORMATTER = new Intl.NumberFormat("en-IN", {
  style: "currency",
  currency: "INR",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/**
 * Formats an integer paise amount as an Indian-locale Rupee string (e.g.
 * 123456789 paise -> "₹12,34,567.89"). Negative amounts (e.g. a signed
 * incremental GMV) are formatted with the locale's own minus sign, never
 * hidden or re-signed.
 *
 * Throws on a non-integer input - a fractional paise value is a caller bug
 * (every backend money column is an integer), never something to silently
 * round.
 */
export function formatPaiseAsInr(paise: number): string {
  if (!Number.isInteger(paise)) {
    throw new Error(`formatPaiseAsInr: expected an integer paise value, got ${paise}`);
  }
  return INR_FORMATTER.format(paise / 100);
}

export type MoneyDisplay = {
  /** The text to render. */
  text: string;
  /** True only for `{kind: "amount"}` - callers use this to decide whether
   * tabular/monospace figure styling applies. */
  isAmount: boolean;
  /** An accessible, unambiguous label for screen readers - spells out
   * "unavailable"/"unknown" rather than relying on visual muting alone. */
  ariaLabel: string;
};

/**
 * Resolves a `MoneyValue` into exactly what should be displayed. Never
 * produces "₹0.00" for anything other than a genuine `{kind: "amount",
 * paise: 0}` - unavailable and unknown values get their own distinct,
 * honest text.
 */
export function resolveMoneyDisplay(value: MoneyValue): MoneyDisplay {
  switch (value.kind) {
    case "amount": {
      const text = formatPaiseAsInr(value.paise);
      return { text, isAmount: true, ariaLabel: text };
    }
    case "unavailable": {
      const text = "Not available";
      return {
        text,
        isAmount: false,
        ariaLabel: value.reason ? `Not available: ${value.reason}` : text,
      };
    }
    case "unknown":
      return { text: "Unknown", isAmount: false, ariaLabel: "Unknown" };
  }
}
