/**
 * The shared editing vocabulary for profile values and repeated entries.
 * ---------------------------------------------------------------------------
 * Extracted from ProfileEditor, which had grown to hold both the profile
 * screen AND every building block it was made of. Two screens need these now:
 *
 *   ProfileEditor - edit what the profile already holds
 *   ResumeImport  - edit what a parse PROPOSES, before it is committed
 *
 * That second use is the reason for the extraction. Reviewing a mis-parsed job
 * title is the same act as correcting it later, and doing it with a second,
 * parallel set of inputs would have let the two screens disagree about what a
 * date is, when a value counts as verified, or how a blank field reads back.
 *
 * The trust model lives here as a result: `typedValue`, `typedList` and
 * `dateValue` are the only things in the options UI that mint a user-verified
 * value, and they refuse to do it for a blank or unparseable field.
 */
import { useEffect, useState, type ReactNode } from 'react';
import { Field, StateBadge, type FieldState } from '@/components/ui';
import { newId } from '@shared/ids';
import { formatDate, parseDate, type NormalizedDate } from '@profile/normalizers/date';
import { isBlank, matchesFormat, trimValue, type ValueFormat } from '@profile/validation';
import {
  emptyValue,
  userValue,
  valueState,
  type Education,
  type Employment,
  type Project,
  type ProfileValue,
} from '@profile/schema';

/**
 * Read a wrapped string value for display.
 * Returns '' rather than 'null' so an empty field looks empty.
 */
export const text = (value: ProfileValue<string>): string => value.value ?? '';

/**
 * Map a stored value onto the four display states.
 *
 * One case is decided here rather than in `valueState`: a value that is null
 * but still carries the text the user typed is something we could not READ,
 * not something they never provided. The schema cannot tell those apart - both
 * are `value: null` - but this screen can, and the difference is exactly what
 * the user needs to see. "Not provided" next to a box containing
 * "nitu@@example" would be nonsense.
 */
export const stateOf = (value: ProfileValue<unknown>): FieldState => {
  if (value.value === null && value.raw !== undefined && !isBlank(value.raw)) {
    return 'needs_review';
  }
  return valueState(value) as FieldState;
};

/**
 * Wrap what the user typed, refusing to call it verified unless it is.
 *
 * THE RULE THIS ENFORCES. `userValue()` stamps `verifiedByUser: true,
 * confidence: 1` on anything handed to it, and that flag is what unlocks
 * autofilling a legal question. So it must not be reachable from an empty
 * field or from a half-typed address:
 *
 *   blank    -> a missing value, with no evidence at all. The user clearing a
 *               field means "I do not have this", and it must read back as
 *               that rather than as a value they vouched for.
 *   invalid  -> value null, raw KEPT. Nothing they typed is thrown away, and
 *               the badge says "needs review" instead of claiming certainty.
 *   valid    -> verified, stored trimmed.
 *
 * The trimmed form is what gets stored: a trailing space in an email is the
 * kind of thing that fails an ATS's own validation and looks, to the
 * applicant, like the extension typed it wrong.
 */
/**
 * The message for a value we could not read, or the field's normal hint.
 *
 * Says what is wrong AND what the consequence is. "That does not look like an
 * email address" on its own reads as pedantry; "...so it will not be filled"
 * is the part that tells the user whether to care.
 */
export function hintFor(
  value: ProfileValue<unknown>,
  problem: string,
  normal?: string,
): string | undefined {
  const unreadable = value.value === null && value.raw !== undefined && !isBlank(value.raw);
  return unreadable ? problem : normal;
}

export function typedValue(raw: string, format: ValueFormat = 'text'): ProfileValue<string> {
  if (isBlank(raw)) return emptyValue<string>();
  if (!matchesFormat(raw, format)) return { value: null, raw, evidence: [] };
  return userValue(trimValue(raw), raw);
}

/**
 * A list, rendered for editing as one comma-separated line.
 *
 * Skills, preferred locations and technologies are all short flat lists, and a
 * comma-separated line is how people already write them. A row-per-item editor
 * would be more "correct" and considerably more tedious for a forty-item skills
 * list.
 */
export const list = (value: ProfileValue<string[]>): string =>
  // The raw text the user typed wins over the parsed list, for the same reason
  // it does for dates and phones: re-rendering the parse while they are still
  // typing makes the field impossible to type in.
  value.raw ?? (value.value ?? []).join(', ');

/**
 * Split a comma-separated line into its items.
 *
 * Hand-rolled rather than `split().map().filter()`, which allocates three
 * arrays and a trimmed string per item to produce one array. This walks the
 * line once and allocates only the items it actually keeps - which matters
 * because it runs on every keystroke of a forty-item skills list.
 */
export const parseList = (input: string): string[] => {
  const items: string[] = [];
  let start = 0;

  for (let index = 0; index <= input.length; index++) {
    // The end of the string closes the final item, so the loop runs one past.
    if (index !== input.length && input.charCodeAt(index) !== 0x2c) continue;
    const item = trimValue(input.slice(start, index));
    if (item.length > 0) items.push(item);
    start = index + 1;
  }

  return items;
};

/** A list the user typed. Empty means missing, never a verified empty list. */
export function typedList(raw: string): ProfileValue<string[]> {
  const items = parseList(raw);
  return items.length === 0 ? emptyValue<string[]>() : userValue(items, raw);
}

/**
 * Display a stored date as text the user can edit.
 *
 * The `raw` text is preferred over the parsed value: it is what they typed, and
 * re-rendering "May 2025" as "2025-05" while they are still editing is the kind
 * of helpfulness that makes a field impossible to type in.
 */
export const dateText = (value: ProfileValue<NormalizedDate>): string => {
  if (value.raw !== undefined) return value.raw;
  const parsed = value.value;
  if (parsed === null) return '';
  if (parsed.isPresent === true) return 'Present';
  return formatDate(parsed, 'MONTH_NAME_YEAR') ?? formatDate(parsed, 'YEAR') ?? '';
};

// ---------------------------------------------------------------------------
// Repeated entries
// ---------------------------------------------------------------------------

/**
 * The parts of an entry card that differ between the two screens that use it.
 *
 * The profile editor passes a removal control; the resume review screen passes
 * a checkbox and a duplicate note instead. Keeping this as one forwarded bag
 * means the FIELDS - which are the part that must not diverge - stay identical
 * in both places.
 */
export interface EntryChrome {
  onRemove?: () => void;
  lead?: ReactNode;
  note?: ReactNode;
  defaultOpen?: boolean;
}

/** Spread the chrome onto an EntryCard, omitting what was not provided. */
function chromeProps(chrome: EntryChrome): EntryChrome {
  const props: EntryChrome = {};
  if (chrome.onRemove !== undefined) props.onRemove = chrome.onRemove;
  if (chrome.lead !== undefined) props.lead = chrome.lead;
  if (chrome.note !== undefined) props.note = chrome.note;
  if (chrome.defaultOpen !== undefined) props.defaultOpen = chrome.defaultOpen;
  return props;
}

export function EducationEntry({
  entry,
  position,
  onChange,
  ...chrome
}: {
  entry: Education;
  position: number;
  onChange: (mutate: (entry: Education) => Education) => void;
} & EntryChrome): ReactNode {
  const set = <K extends keyof Education>(field: K, value: Education[K]): void =>
    onChange((current) => ({ ...current, [field]: value }));

  return (
    <EntryCard
      title={entry.institution.value ?? `School ${position}`}
      removeLabel="Remove this school"
      {...chromeProps(chrome)}
    >
      <Field
        label="School"
        value={text(entry.institution)}
        state={stateOf(entry.institution)}
        onChange={(next) => set('institution', typedValue(next))}
      />
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field
          label="Degree"
          value={text(entry.degree)}
          state={stateOf(entry.degree)}
          onChange={(next) => set('degree', typedValue(next))}
          placeholder="Bachelor of Science"
        />
        <Field
          label="Field of study"
          value={text(entry.fieldOfStudy)}
          state={stateOf(entry.fieldOfStudy)}
          onChange={(next) => set('fieldOfStudy', typedValue(next))}
        />
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <DateField
          label="Started"
          value={entry.startDate}
          onChange={(raw) => set('startDate', dateValue(raw))}
        />
        <DateField
          label="Graduated"
          value={entry.graduationDate}
          onChange={(raw) => set('graduationDate', dateValue(raw))}
        />
        <Field
          label="GPA"
          value={text(entry.gpa)}
          state={stateOf(entry.gpa)}
          onChange={(next) => set('gpa', typedValue(next))}
          /* Stored exactly as written: "3.8/4.0" and "First Class Honours" are
             both real answers, and parsing either into a number would destroy
             the scale the institution actually issued. */
          placeholder="3.8"
        />
      </div>
    </EntryCard>
  );
}

export function EmploymentEntry({
  entry,
  position,
  onChange,
  ...chrome
}: {
  entry: Employment;
  position: number;
  onChange: (mutate: (entry: Employment) => Employment) => void;
} & EntryChrome): ReactNode {
  const set = <K extends keyof Employment>(field: K, value: Employment[K]): void =>
    onChange((current) => ({ ...current, [field]: value }));

  const current = entry.currentlyEmployed.value === true;

  return (
    <EntryCard
      title={entry.company.value ?? `Job ${position}`}
      removeLabel="Remove this job"
      {...chromeProps(chrome)}
    >
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field
          label="Employer"
          value={text(entry.company)}
          state={stateOf(entry.company)}
          onChange={(next) => set('company', typedValue(next))}
        />
        <Field
          label="Job title"
          value={text(entry.title)}
          state={stateOf(entry.title)}
          onChange={(next) => set('title', typedValue(next))}
        />
      </div>
      <Field
        label="Location"
        value={text(entry.location)}
        state={stateOf(entry.location)}
        onChange={(next) => set('location', typedValue(next))}
      />
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <DateField
          label="Started"
          value={entry.startDate}
          onChange={(raw) => set('startDate', dateValue(raw))}
        />
        <DateField
          label="Ended"
          value={entry.endDate}
          onChange={(raw) => set('endDate', dateValue(raw))}
          hint='Leave blank, or write "Present", if you still work here.'
        />
      </div>

      {/*
        A checkbox rather than a date, because "I still work here" is what the
        applicant knows and what forms ask. It also drives which job is offered
        as "current employer", which is a stronger signal than any date parse.
      */}
      <label className="flex cursor-pointer items-center gap-3 rounded-xl border border-[var(--app-border)] bg-[var(--app-panel-soft)] px-3 py-2.5 text-sm text-[--app-text] transition hover:border-[var(--app-border-strong)]">
        <input
          type="checkbox"
          checked={current}
          onChange={(event) =>
            set('currentlyEmployed', userValue(event.target.checked))
          }
        />
        <span className="font-medium">I currently work here</span>
      </label>

      <TextAreaField
        label="What you did"
        value={text(entry.description)}
        state={stateOf(entry.description)}
        onChange={(next) => set('description', typedValue(next))}
        hint="Used for a free-text 'describe your experience' box. Nothing is ever generated for you."
      />
    </EntryCard>
  );
}

export function ProjectEntry({
  entry,
  position,
  onChange,
  ...chrome
}: {
  entry: Project;
  position: number;
  onChange: (mutate: (entry: Project) => Project) => void;
} & EntryChrome): ReactNode {
  const set = <K extends keyof Project>(field: K, value: Project[K]): void =>
    onChange((current) => ({ ...current, [field]: value }));

  return (
    <EntryCard
      title={entry.name.value ?? `Project ${position}`}
      removeLabel="Remove this project"
      {...chromeProps(chrome)}
    >
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field
          label="Project name"
          value={text(entry.name)}
          state={stateOf(entry.name)}
          onChange={(next) => set('name', typedValue(next))}
        />
        <Field
          label="Link"
          value={text(entry.url)}
          state={stateOf(entry.url)}
          onChange={(next) => set('url', typedValue(next, 'url'))}
        />
      </div>
      <CommaListField
        label="Technologies"
        value={list(entry.technologies)}
        state={stateOf(entry.technologies)}
        onChange={(next) => set('technologies', typedList(next))}
        hint="Comma separated."
      />
      <TextAreaField
        label="Description"
        value={text(entry.description)}
        state={stateOf(entry.description)}
        onChange={(next) => set('description', typedValue(next))}
      />
    </EntryCard>
  );
}

// ---------------------------------------------------------------------------
// Small building blocks
// ---------------------------------------------------------------------------

/**
 * A date the user types in whatever form they think in.
 *
 * The raw text is stored ALONGSIDE the parse, and the parse is shown back
 * underneath ("read as May 2025"). That read-back is the whole point: a date is
 * the value most likely to be misunderstood, and the failure - a graduation
 * date silently parsed as 2005 - is invisible until an employer reads it.
 */
export function DateField({
  label,
  value,
  onChange,
  hint,
}: {
  label: string;
  value: ProfileValue<NormalizedDate>;
  onChange: (raw: string) => void;
  hint?: string;
}): ReactNode {
  const parsed = value.value;
  const readback =
    parsed === null
      ? undefined
      : parsed.isPresent === true
        ? 'read as: still ongoing'
        : `read as: ${formatDate(parsed, 'MONTH_NAME_YEAR') ?? formatDate(parsed, 'YEAR') ?? '?'}`;

  return (
    <div>
      <Field
        label={label}
        value={dateText(value)}
        state={stateOf(value)}
        onChange={onChange}
        placeholder="May 2025"
        {...(hint !== undefined ? { hint } : {})}
      />
      {readback !== undefined && (
        <span className="mt-1.5 block text-[11px] text-[--app-muted]">
          {readback}
          {parsed?.ambiguousDayMonth === true && ' - this could be read two ways; add the month name'}
        </span>
      )}
    </div>
  );
}

/**
 * A comma-separated list, typed as one line.
 *
 * THE BUG THIS EXISTS TO FIX. The stored value is a parsed array, so rendering
 * it back as `items.join(', ')` on every keystroke deleted the separator the
 * user had just typed: "react," re-rendered as "react", and a second item
 * could not be started at all. Four fields on this screen had it.
 *
 * The draft is local, and resyncs from storage only when the two genuinely
 * disagree - an import or a reload - rather than on the echo of our own
 * keystroke. Comparing the PARSED forms is what makes that distinction: "a,"
 * and "a" are the same list, so a resync would be pure interference.
 */
export function CommaListField({
  label,
  value,
  state,
  onChange,
  hint,
}: {
  label: string;
  value: string;
  state: FieldState;
  onChange: (raw: string) => void;
  hint?: string;
}): ReactNode {
  const [draft, setDraft] = useState(value);

  useEffect(() => {
    const same = parseList(value).join('\u0000') === parseList(draft).join('\u0000');
    if (!same) setDraft(value);
    // `draft` is deliberately not a dependency: this reacts to the STORED value
    // changing underneath the field, not to the user typing in it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  return (
    <Field
      label={label}
      value={draft}
      state={state}
      onChange={(next) => {
        setDraft(next);
        onChange(next);
      }}
      {...(hint !== undefined ? { hint } : {})}
    />
  );
}

/**
 * Spread a hint prop only when there is a hint.
 *
 * `exactOptionalPropertyTypes` makes `hint={undefined}` a type error on a
 * `hint?: string` prop - the property may be absent, not present-and-undefined
 * - so the choice has to be made at the spread rather than at the value.
 */
export function hintProp(hint: string | undefined): { hint?: string } {
  return hint === undefined ? {} : { hint };
}

/** A multi-line field, for the two places a paragraph is the right answer. */
export function TextAreaField({
  label,
  value,
  state,
  onChange,
  hint,
}: {
  label: string;
  value: string;
  state: FieldState;
  onChange: (value: string) => void;
  hint?: string;
}): ReactNode {
  return (
    <label className="block">
      <span className="mb-1 flex items-center gap-2 text-sm text-[--app-text]">
        <StateBadge state={state} />
        <span className="font-medium">{label}</span>
      </span>
      <textarea
        value={value}
        rows={3}
        onChange={(event) => onChange(event.target.value)}
        className="w-full resize-y rounded-xl border border-[var(--app-border)] bg-[var(--app-panel-soft)] px-3 py-2.5 text-sm text-[--app-text] outline-none transition placeholder:text-[--app-faint] hover:border-[var(--app-border-strong)] focus:border-[var(--app-accent)] focus:bg-[var(--app-panel)] focus:ring-4 focus:ring-indigo-500/8"
      />
      {hint !== undefined && (
        <span className="mt-1.5 block text-[11px] leading-relaxed text-[--app-muted]">{hint}</span>
      )}
    </label>
  );
}

/**
 * One entry in a repeated list, with its own removal control.
 *
 * Collapsible, and titled by the school or employer rather than by an index,
 * because a profile with four jobs and three schools is otherwise a long page
 * to scroll past to reach the work-authorization questions. It opens expanded:
 * a newly added entry the user has to click to fill in would be a puzzle.
 */
export function EntryCard({
  title,
  removeLabel,
  onRemove,
  lead,
  note,
  defaultOpen = true,
  children,
}: {
  title: string;
  /**
   * Removal is OPTIONAL. On the profile screen an entry is something the user
   * owns and can delete; on the resume review screen it is a proposal that has
   * not been committed to anything yet, so there is nothing to remove - the
   * checkbox in `lead` decides whether it is ever kept at all.
   */
  removeLabel?: string;
  onRemove?: () => void;
  /** Rendered before the expand control - a checkbox, on the review screen. */
  lead?: ReactNode;
  /** A row under the header that stays visible while the card is collapsed. */
  note?: ReactNode;
  defaultOpen?: boolean;
  children: ReactNode;
}): ReactNode {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <div className="rounded-2xl border border-[var(--app-border)] bg-[var(--app-panel-soft)] p-3.5 transition hover:border-[var(--app-border-strong)]">
      <div className="flex items-center justify-between gap-2">
        {lead}
        <button
          type="button"
          onClick={() => setOpen((current) => !current)}
          className="flex min-w-0 flex-1 items-center gap-3 text-left text-sm font-semibold text-[--app-text]"
          aria-expanded={open}
        >
          <span className="grid h-7 w-7 flex-none place-items-center rounded-lg bg-[var(--app-accent-soft)] text-xs text-[--app-accent]" aria-hidden="true">
            {open ? '−' : '+'}
          </span>
          <span className="truncate">{title}</span>
        </button>
        {onRemove !== undefined && (
          <button
            type="button"
            onClick={onRemove}
            className="shrink-0 rounded-lg px-2 py-1.5 text-xs font-medium text-[--app-danger] transition hover:bg-red-500/8"
          >
            {removeLabel}
          </button>
        )}
      </div>
      {note}
      {open && <div className="mt-4 space-y-3.5 border-t border-[var(--app-border)] pt-4">{children}</div>}
    </div>
  );
}

export function AddButton({ label, onClick }: { label: string; onClick: () => void }): ReactNode {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center justify-center gap-2 rounded-xl border border-dashed border-[var(--app-border-strong)] bg-[var(--app-panel-soft)] px-3 py-2.5 text-sm font-semibold text-[--app-accent] transition hover:border-[var(--app-accent)] hover:bg-[var(--app-accent-soft)]"
    >
      <span className="text-base leading-none" aria-hidden="true">+</span>
      {label}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Value construction
// ---------------------------------------------------------------------------

/**
 * Wrap a typed date, keeping what the user actually wrote.
 *
 * An unparseable string is stored with `value: null` and the raw text intact,
 * so the badge reports "needs review" and nothing the user typed is thrown
 * away. Inventing a date we could not read would be the worst option available.
 */
export function dateValue(raw: string): ProfileValue<NormalizedDate> {
  if (raw.trim().length === 0) return emptyValue<NormalizedDate>();
  const parsed = parseDate(raw);
  return parsed === null ? { value: null, raw, evidence: [] } : userValue(parsed, raw);
}

/**
 * A new, empty entry.
 *
 * Every field is present and empty rather than absent, for the same reason
 * `createEmptyProfile` does it: downstream code reads
 * `entry.institution.value` without optional chaining, and a missing branch
 * could never be told apart from a missing value.
 */
export function emptyEducation(): Education {
  return {
    id: newId('edu'),
    institution: emptyValue<string>(),
    degree: emptyValue<string>(),
    fieldOfStudy: emptyValue<string>(),
    startDate: emptyValue<NormalizedDate>(),
    graduationDate: emptyValue<NormalizedDate>(),
    gpa: emptyValue<string>(),
  };
}

export function emptyEmployment(): Employment {
  return {
    id: newId('job'),
    company: emptyValue<string>(),
    title: emptyValue<string>(),
    location: emptyValue<string>(),
    startDate: emptyValue<NormalizedDate>(),
    endDate: emptyValue<NormalizedDate>(),
    currentlyEmployed: emptyValue<boolean>(),
    description: emptyValue<string>(),
    bullets: emptyValue<string[]>(),
  };
}

export function emptyProject(): Project {
  return {
    id: newId('proj'),
    name: emptyValue<string>(),
    description: emptyValue<string>(),
    technologies: emptyValue<string[]>(),
    url: emptyValue<string>(),
  };
}

