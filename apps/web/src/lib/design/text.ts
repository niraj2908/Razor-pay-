/**
 * Turns a backend enum/action string into readable label text (Phase 26
 * Phase C), e.g. "CONFIRMED_FAILURE" -> "Confirmed failure",
 * "decision.act" -> "Decision: Act". Display-only - never used to compare
 * against or branch on a real enum value.
 */
export function humanizeEnumValue(value: string): string {
  return value
    .toLowerCase()
    .split("_")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

export function humanizeAuditAction(action: string): string {
  const [entity, verb] = action.split(".");
  if (!verb) return humanizeEnumValue(action);
  return `${humanizeEnumValue(entity)}: ${humanizeEnumValue(verb)}`;
}
