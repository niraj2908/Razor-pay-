/**
 * Displays an ISO timestamp precisely (Phase 26 Phase B). Financial
 * operations screens default to an absolute, unambiguous format - a
 * relative "2h ago" reading is easy to misjudge for anything audit-related,
 * where exactly when something happened matters. Always renders a
 * semantic `<time>` element with a machine-readable `dateTime` for
 * accessibility and correctness regardless of the visible format.
 */

const ABSOLUTE_FORMATTER = new Intl.DateTimeFormat("en-IN", {
  day: "2-digit",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hour12: true,
});

export type TimestampProps = {
  iso: string;
  className?: string;
};

export function Timestamp({ iso, className }: TimestampProps) {
  const date = new Date(iso);
  const isValid = !Number.isNaN(date.getTime());
  const text = isValid ? ABSOLUTE_FORMATTER.format(date) : "Invalid date";

  return (
    <time dateTime={isValid ? iso : undefined} className={className ?? "text-fg-secondary text-sm"}>
      {text}
    </time>
  );
}
