/**
 * Shared UI primitives.
 * ---------------------------------------------------------------------------
 * Small, presentational, and free of business logic - spec section 29: "Keep
 * business logic out of React components."
 *
 * The rule is not stylistic. The moment a confidence threshold or a mapping
 * rule lives inside a component, it can only be tested by rendering that
 * component, and the product's actual decisions become invisible to the fast
 * test suite. Everything here takes already-decided data and draws it.
 */
import type { ReactNode } from 'react';

/** The four states a profile value can be in (spec section 9). */
export type FieldState = 'verified' | 'high_confidence' | 'needs_review' | 'missing';

/**
 * State badge.
 *
 * Uses a GLYPH as well as a colour. Colour alone would exclude colour-blind
 * users from the single most important signal in the interface - whether a
 * value can be trusted - and this is the one place we cannot afford ambiguity.
 */
export function StateBadge({ state }: { state: FieldState }): ReactNode {
  const config: Record<FieldState, { glyph: string; label: string; className: string }> = {
    verified: {
      glyph: '✓',
      label: 'Verified by you',
      className: 'text-[--color-state-verified] border-[--color-state-verified]',
    },
    high_confidence: {
      glyph: '●',
      label: 'High confidence, not yet verified',
      className: 'text-[--color-state-confident] border-[--color-state-confident]',
    },
    needs_review: {
      glyph: '?',
      label: 'Needs your review',
      className: 'text-[--color-state-review] border-[--color-state-review]',
    },
    missing: {
      glyph: '—',
      label: 'Not provided',
      className: 'text-[--color-state-missing] border-[--color-state-missing]',
    },
  };

  const { glyph, label, className } = config[state];

  return (
    <span
      className={`inline-flex h-5 w-5 items-center justify-center rounded-full border text-xs ${className}`}
      // The visual glyph is decorative; the accessible name carries the meaning.
      role="img"
      aria-label={label}
      title={label}
    >
      {glyph}
    </span>
  );
}

export function Button({
  children,
  onClick,
  variant = 'primary',
  disabled = false,
}: {
  children: ReactNode;
  onClick?: () => void;
  variant?: 'primary' | 'secondary' | 'danger';
  disabled?: boolean;
}): ReactNode {
  const variants = {
    primary: 'bg-blue-600 text-white hover:bg-blue-700',
    secondary: 'bg-zinc-200 text-zinc-900 hover:bg-zinc-300 dark:bg-zinc-700 dark:text-zinc-100',
    danger: 'bg-red-600 text-white hover:bg-red-700',
  } as const;

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`rounded px-3 py-1.5 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${variants[variant]}`}
    >
      {children}
    </button>
  );
}

export function Section({ title, children }: { title: string; children: ReactNode }): ReactNode {
  return (
    <section className="mb-6">
      <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-zinc-500">{title}</h2>
      <div className="space-y-2">{children}</div>
    </section>
  );
}

/**
 * Labelled text field with its trust state.
 *
 * The state badge sits next to the label rather than the input on purpose: the
 * user is scanning down a column of labels looking for the ones that need
 * attention, and a badge attached to the input would be lost among the values.
 */
export function Field({
  label,
  value,
  state,
  onChange,
  placeholder,
  hint,
}: {
  label: string;
  value: string;
  state: FieldState;
  onChange: (value: string) => void;
  placeholder?: string;
  hint?: string;
}): ReactNode {
  return (
    <label className="block">
      <span className="mb-1 flex items-center gap-2 text-sm text-zinc-700 dark:text-zinc-300">
        <StateBadge state={state} />
        {label}
      </span>
      <input
        type="text"
        value={value}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
        className="w-full rounded border border-zinc-300 bg-white px-2 py-1.5 text-sm dark:border-zinc-600 dark:bg-zinc-800"
      />
      {hint !== undefined && <span className="mt-1 block text-xs text-zinc-500">{hint}</span>}
    </label>
  );
}

/** Non-blocking status line. Used for save confirmations and errors. */
export function StatusLine({
  status,
}: {
  status: { kind: 'idle' | 'ok' | 'error'; message?: string };
}): ReactNode {
  if (status.kind === 'idle' || status.message === undefined) return null;
  return (
    <p
      className={`text-sm ${status.kind === 'ok' ? 'text-green-600' : 'text-red-600'}`}
      // `role="status"` announces the message to a screen reader without
      // stealing focus, which is the correct behaviour for a save confirmation.
      role="status"
    >
      {status.message}
    </p>
  );
}
