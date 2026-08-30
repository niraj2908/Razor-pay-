import type { InputHTMLAttributes } from "react";

/**
 * Labeled text input primitive (Phase 26 Phase C). Establishes the form
 * pattern used by Login now and any future filter/search input: visible
 * label (never placeholder-only), error text rendered directly beneath the
 * field and associated via `aria-describedby`, restrained border/radius
 * matching the rest of the system.
 */
export type TextFieldProps = InputHTMLAttributes<HTMLInputElement> & {
  label: string;
  error?: string;
};

export function TextField({ label, error, id, className, ...rest }: TextFieldProps) {
  const fieldId = id ?? rest.name;
  const errorId = error ? `${fieldId}-error` : undefined;

  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={fieldId} className="text-fg-secondary text-sm font-medium">
        {label}
      </label>
      <input
        id={fieldId}
        aria-invalid={error ? true : undefined}
        aria-describedby={errorId}
        className={[
          "border-border bg-surface text-fg h-10 rounded-md border px-3 text-sm",
          "focus-visible:border-info",
          error ? "border-danger" : "",
          className ?? "",
        ].join(" ")}
        {...rest}
      />
      {error ? (
        <p id={errorId} className="text-danger text-sm">
          {error}
        </p>
      ) : null}
    </div>
  );
}
