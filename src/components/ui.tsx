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

/** The product mark shared by the workspace and the side panel. */
export function BrandMark({ small = false }: { small?: boolean }): ReactNode {
  return <span className={`brand-mark${small ? ' brand-mark--small' : ''}`} aria-hidden="true" />;
}

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
      className:
        'border-emerald-500/25 bg-emerald-500/10 text-[--color-state-verified] shadow-[inset_0_0_0_1px_rgba(16,185,129,0.04)]',
    },
    high_confidence: {
      glyph: '●',
      label: 'High confidence, not yet verified',
      className: 'border-indigo-500/25 bg-indigo-500/10 text-[--color-state-confident]',
    },
    needs_review: {
      glyph: '?',
      label: 'Needs your review',
      className: 'border-amber-500/25 bg-amber-500/10 text-[--color-state-review]',
    },
    missing: {
      glyph: '·',
      label: 'Not provided',
      className: 'border-zinc-500/15 bg-zinc-500/7 text-[--color-state-missing]',
    },
  };

  const { glyph, label, className } = config[state];

  return (
    <span
      className={`inline-flex h-[18px] w-[18px] items-center justify-center rounded-md border text-[10px] font-bold ${className}`}
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
  className = '',
}: {
  children: ReactNode;
  onClick?: () => void;
  variant?: 'primary' | 'secondary' | 'danger' | 'ghost';
  disabled?: boolean;
  className?: string;
}): ReactNode {
  const variants = {
    primary:
      'border border-transparent bg-[--app-accent] text-white shadow-[0_8px_22px_rgba(81,65,210,0.2)] hover:bg-[--app-accent-strong] hover:-translate-y-px',
    secondary:
      'border border-[--app-border] bg-[--app-panel-soft] text-[--app-text] hover:border-[--app-border-strong] hover:bg-[--app-panel]',
    danger:
      'border border-red-500/20 bg-red-500/10 text-[--app-danger] hover:bg-red-500/15',
    ghost: 'border border-transparent bg-transparent text-[--app-muted] hover:bg-[--app-panel-soft] hover:text-[--app-text]',
  } as const;

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`inline-flex min-h-9 items-center justify-center gap-2 rounded-xl px-3.5 py-2 text-sm font-semibold transition-all duration-150 disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:translate-y-0 ${variants[variant]} ${className}`}
    >
      {children}
    </button>
  );
}

export function Section({ title, children }: { title: string; children: ReactNode }): ReactNode {
  const sigil = title
    .split(/\s+/)
    .map((word) => word[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();

  return (
    <section className="profile-section surface-card">
      <div className="section-heading">
        <span className="section-sigil" aria-hidden="true">
          {sigil}
        </span>
        <h2 className="section-title">{title}</h2>
      </div>
      <div className="space-y-3.5">{children}</div>
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
        <span className="font-medium text-[--app-text]">{label}</span>
      </span>
      <input
        type="text"
        value={value}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
        className="w-full rounded-xl border border-[--app-border] bg-[--app-panel-soft] px-3 py-2.5 text-sm text-[--app-text] outline-none transition placeholder:text-[--app-faint] hover:border-[--app-border-strong] focus:border-[--app-accent] focus:bg-[--app-panel] focus:ring-4 focus:ring-indigo-500/8"
      />
      {hint !== undefined && (
        <span className="mt-1.5 block text-[11px] leading-relaxed text-[--app-muted]">{hint}</span>
      )}
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
  const success = status.kind === 'ok';
  return (
    <div
      className={`my-3 flex items-start gap-2.5 rounded-xl border px-3 py-2.5 text-xs leading-relaxed ${
        success
          ? 'border-emerald-500/20 bg-emerald-500/8 text-[--app-success]'
          : 'border-red-500/20 bg-red-500/8 text-[--app-danger]'
      }`}
      // `role="status"` announces the message to a screen reader without
      // stealing focus, which is the correct behaviour for a save confirmation.
      role="status"
    >
      <span
        className="mt-0.5 inline-grid h-4 w-4 flex-none place-items-center rounded-full border border-current text-[9px] font-bold"
        aria-hidden="true"
      >
        {success ? '✓' : '!'}
      </span>
      <span>{status.message}</span>
    </div>
  );
}
