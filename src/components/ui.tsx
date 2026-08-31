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
 *
 * COLOUR DISCIPLINE. See the header of `assets/tailwind.css`: colour in this
 * product is a claim about how much we know, and nothing else. So there are no
 * palette utilities (`bg-[var(--s-verified-wash)]`, `text-[var(--ink)]`) anywhere in here.
 * Every colour comes from a token whose name says what it MEANS, which is also
 * what makes the four states restyleable from one place.
 */
import type { ReactNode } from 'react';

/** The product mark shared by the workspace and the side panel. */
export function BrandMark({ small = false }: { small?: boolean }): ReactNode {
  return <span className={`brand-mark${small ? ' brand-mark--small' : ''}`} aria-hidden="true" />;
}

/** The four states a profile value can be in (spec section 9). */
export type FieldState = 'verified' | 'high_confidence' | 'needs_review' | 'missing';

/** Token trio for one state. Kept next to the badge so the ledger, the row
 *  rails and the badge cannot disagree about what "review" looks like. */
export const STATE_STYLE: Record<
  FieldState,
  { glyph: string; label: string; fg: string; wash: string; line: string }
> = {
  verified: {
    glyph: '✓',
    label: 'Filled and verified on the page',
    fg: 'var(--s-verified)',
    wash: 'var(--s-verified-wash)',
    line: 'var(--s-verified-line)',
  },
  high_confidence: {
    glyph: '●',
    label: 'Ready to fill, not yet written',
    fg: 'var(--s-confident)',
    wash: 'var(--s-confident-wash)',
    line: 'var(--s-confident-line)',
  },
  needs_review: {
    glyph: '?',
    label: 'Needs your review',
    fg: 'var(--s-review)',
    wash: 'var(--s-review-wash)',
    line: 'var(--s-review-line)',
  },
  missing: {
    glyph: '–',
    label: 'Not provided',
    fg: 'var(--s-unknown)',
    wash: 'var(--s-unknown-wash)',
    line: 'var(--s-unknown-line)',
  },
};

/**
 * State badge.
 *
 * Uses a GLYPH as well as a colour. Colour alone would exclude colour-blind
 * users from the single most important signal in the interface - whether a
 * value can be trusted - and this is the one place we cannot afford ambiguity.
 */
export function StateBadge({ state }: { state: FieldState }): ReactNode {
  const { glyph, label, fg, wash, line } = STATE_STYLE[state];

  return (
    <span
      className="inline-flex h-[17px] w-[17px] flex-none items-center justify-center rounded-[5px] border text-[10px] font-bold leading-none"
      style={{ color: fg, background: wash, borderColor: line }}
      // The visual glyph is decorative; the accessible name carries the meaning.
      role="img"
      aria-label={label}
      title={label}
    >
      {glyph}
    </span>
  );
}

/**
 * Buttons.
 *
 * `primary` is ink, not a brand colour, for the reason set out in the CSS
 * header: a coloured button next to a coloured trust badge teaches the user
 * that colour is decoration.
 */
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
      'border border-transparent bg-[var(--action)] text-[var(--on-action)] hover:bg-[var(--action-hover)]',
    secondary:
      'border border-[var(--rule)] bg-[var(--paper)] text-[var(--ink)] hover:border-[var(--rule-2)] hover:bg-[var(--paper-2)]',
    danger:
      'border border-[var(--danger-line)] bg-[var(--danger-wash)] text-[var(--danger)] hover:brightness-105',
    ghost:
      'border border-transparent bg-transparent text-[var(--ink-2)] hover:bg-[var(--paper-2)] hover:text-[var(--ink)]',
  } as const;

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`inline-flex min-h-9 items-center justify-center gap-2 rounded-lg px-3.5 py-2 text-[13px] font-semibold tracking-[-0.005em] transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-40 ${variants[variant]} ${className}`}
    >
      {children}
    </button>
  );
}

/**
 * One panel of the profile editor.
 *
 * `wide` is a prop rather than a CSS `nth-child` rule. The stylesheet used to
 * name sections 4, 5, 6, 8, 9 and 10 as full width, which meant inserting a
 * section re-laid out every section after it - and it had already drifted:
 * "Skills" sat half-width beside an empty column.
 */
export function Section({
  title,
  wide = false,
  children,
}: {
  title: string;
  wide?: boolean;
  children: ReactNode;
}): ReactNode {
  return (
    <section className={`profile-section surface-card${wide ? ' profile-section--wide' : ''}`}>
      <div className="section-heading">
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
 *
 * The input itself is set in the data face. What you type here is what gets
 * sent to an employer verbatim, so it is shown the same way everywhere in the
 * product: monospaced, so a doubled space or a stray character is visible.
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
      <span className="mb-1.5 flex items-center gap-2">
        <StateBadge state={state} />
        <span className="text-[12px] font-medium text-[var(--ink-2)]">{label}</span>
      </span>
      <input
        type="text"
        value={value}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
        className="data w-full rounded-lg border border-[var(--rule)] bg-[var(--paper-2)] px-2.5 py-2 text-[13px] text-[var(--ink)] outline-none transition-colors placeholder:font-sans placeholder:text-[var(--ink-3)] hover:border-[var(--rule-2)] focus:border-[var(--ink)] focus:bg-[var(--paper)]"
      />
      {hint !== undefined && (
        <span className="mt-1.5 block text-[11px] leading-relaxed text-[var(--ink-2)]">{hint}</span>
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
      className="my-3 flex items-start gap-2.5 rounded-lg border px-3 py-2.5 text-xs leading-relaxed"
      style={
        success
          ? {
              color: 'var(--s-verified)',
              background: 'var(--s-verified-wash)',
              borderColor: 'var(--s-verified-line)',
            }
          : {
              color: 'var(--danger)',
              background: 'var(--danger-wash)',
              borderColor: 'var(--danger-line)',
            }
      }
      // `role="status"` announces the message to a screen reader without
      // stealing focus, which is the correct behaviour for a save confirmation.
      role="status"
    >
      <span
        className="mt-px inline-grid h-4 w-4 flex-none place-items-center rounded-full border border-current text-[9px] font-bold"
        aria-hidden="true"
      >
        {success ? '✓' : '!'}
      </span>
      <span>{status.message}</span>
    </div>
  );
}
