/**
 * Percentage display for probabilities/rates (Phase 26 Phase C). Every
 * backend probability/rate field (naturalRecoveryProbability, rate,
 * observedRecoveryRate, confidenceLevel) is a plain 0-1 float that can
 * legitimately be `null` (not yet scored / not computable) - this module
 * keeps that distinction explicit rather than letting `null` silently
 * become "0%".
 */
export function formatPercent(value: number, fractionDigits: number = 1): string {
  return new Intl.NumberFormat("en-IN", {
    style: "percent",
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  }).format(value);
}

export function formatPercentOrUnavailable(value: number | null, fractionDigits: number = 1): string {
  return value === null ? "Not available" : formatPercent(value, fractionDigits);
}
