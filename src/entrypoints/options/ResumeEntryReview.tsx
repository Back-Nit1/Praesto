/**
 * The repeated-entry half of the resume review screen.
 * ---------------------------------------------------------------------------
 * WHAT WAS WRONG
 * Scalar values (name, email, city) went through review: shown with their
 * source line, individually uncheckable, nothing committed without a click.
 * Education, employment and project entries did not. They were appended
 * wholesale with a sentence explaining that they had been, which meant:
 *
 *   - re-uploading a resume silently duplicated every job and every school
 *   - one mis-parsed job title could not be rejected without rejecting all of
 *     them, and could only be found and fixed after it was already stored
 *
 * That was the largest remaining gap in the acceptance criterion the whole
 * screen exists for (spec 25.4): every extracted value is either correct or
 * visibly uncertain, and nothing unsupported silently enters the profile.
 *
 * WHAT THIS DOES
 * Every entry gets its own checkbox and its own editable card - the SAME card
 * the profile editor uses, so correcting a title here and correcting it later
 * are the same act, producing an equally verified value.
 *
 * An entry that matches one the profile already holds is called out, with the
 * reason it was matched, and defaults to being skipped. The user can instead
 * merge the new details into the entry they already have, or - for the genuine
 * two-stints-at-one-employer case - add it separately anyway. All three are
 * offered because no rule can tell those apart reliably, and quietly picking
 * one would be guessing about someone's employment history.
 */
import { type ReactNode } from 'react';
import {
  applyEntryDecisions,
  findDuplicate,
  mergeGain,
  type DuplicateMatch,
  type EntryByKind,
  type EntryDecision,
  type EntryDecisionInput,
  type EntryKind,
} from '@profile/entry-matching';
import type { ApplicantProfile, Education, Employment, Project } from '@profile/schema';
import {
  EducationEntry,
  EmploymentEntry,
  ProjectEntry,
  type EntryChrome,
} from './profile-entries';

/** One parsed entry, plus everything the screen needs to decide about it. */
export interface EntryReview<T> {
  /** The user's copy: what the parser proposed, plus any correction they made. */
  entry: T;
  decision: EntryDecision;
  /** The entry in the profile this one appears to repeat, if any. */
  match: DuplicateMatch | null;
  /**
   * How many blank fields an update would fill in.
   *
   * Zero means "update existing" would be a control that does nothing, so it
   * is not offered - a choice that visibly changes nothing teaches the user
   * that none of the choices matter.
   */
  gain: number;
}

/**
 * Work out the starting state for a screen's worth of parsed entries.
 *
 * A duplicate starts SKIPPED. The user re-uploaded a resume; the safe reading
 * of that is "keep my profile current", not "give me two of everything", and
 * skipping is the only default that changes nothing at all.
 */
export function reviewEntries<K extends EntryKind>(
  kind: K,
  parsed: readonly EntryByKind[K][],
  existing: readonly EntryByKind[K][],
): EntryReview<EntryByKind[K]>[] {
  return parsed.map((entry) => {
    const match = findDuplicate(kind, entry, existing);
    const held = match === null ? undefined : existing[match.index];

    return {
      entry,
      match,
      decision: match === null ? 'add' : 'skip',
      gain: held === undefined ? 0 : mergeGain(held, entry),
    };
  });
}

// ---------------------------------------------------------------------------
// The section
// ---------------------------------------------------------------------------

interface SectionProps<T> {
  reviews: readonly EntryReview<T>[];
  onChange: (index: number, next: EntryReview<T>) => void;
}

interface InternalSectionProps<T extends { id: string }> extends SectionProps<T> {
  heading: string;
  /** Singular noun for the checkbox label: "job", "school", "project". */
  noun: string;
  renderEditor: (args: {
    entry: T;
    position: number;
    onChange: (mutate: (entry: T) => T) => void;
    chrome: EntryChrome;
  }) => ReactNode;
}

function ReviewSection<T extends { id: string }>({
  heading,
  noun,
  reviews,
  onChange,
  renderEditor,
}: InternalSectionProps<T>): ReactNode {
  // A section for something the resume did not contain is a heading over
  // nothing, which reads as a section that failed to load.
  if (reviews.length === 0) return null;

  const kept = reviews.filter((review) => review.decision !== 'skip').length;

  return (
    <section className="space-y-3">
      <div className="flex items-baseline justify-between gap-3">
        <h4 className="text-sm font-semibold text-[var(--ink)]">{heading}</h4>
        <span className="text-xs text-[var(--ink-2)]">
          {kept} of {reviews.length} selected
        </span>
      </div>

      {reviews.map((review, index) => {
        const set = (next: Partial<EntryReview<T>>): void =>
          onChange(index, { ...review, ...next });

        const chrome: EntryChrome = {
          // Collapsed when it is a duplicate: the decision is the interesting
          // part there, and it lives in the always-visible note below.
          defaultOpen: review.match === null,
          note:
            review.match === null ? undefined : (
              <DuplicateNote
                match={review.match}
                gain={review.gain}
                decision={review.decision}
                name={`decision-${review.entry.id}`}
                noun={noun}
                onDecide={(decision) => set({ decision })}
              />
            ),
          ...(review.match === null
            ? {
                lead: (
                  <input
                    type="checkbox"
                    className="ml-1 shrink-0"
                    checked={review.decision !== 'skip'}
                    onChange={(event) =>
                      set({ decision: event.target.checked ? 'add' : 'skip' })
                    }
                    aria-label={`Include this ${noun}`}
                  />
                ),
              }
            : {}),
        };

        return (
          <div key={review.entry.id} className={review.decision === 'skip' ? 'opacity-60' : ''}>
            {renderEditor({
              entry: review.entry,
              position: index + 1,
              // An edit implies the user wants the entry. Correcting a title on
              // an entry that then silently stays unchecked would be the most
              // annoying possible outcome of taking the trouble.
              onChange: (mutate) =>
                set({
                  entry: mutate(review.entry),
                  ...(review.decision === 'skip' && review.match === null
                    ? { decision: 'add' as const }
                    : {}),
                }),
              chrome,
            })}
          </div>
        );
      })}
    </section>
  );
}

/**
 * The three-way choice for an entry the profile already appears to hold.
 *
 * The match REASON is shown, not just the verdict. "Same company and title" is
 * something the user can check against their own memory in a second; "we think
 * this is a duplicate" is something they can only take on faith, and taking a
 * merge of their employment history on faith is not a reasonable ask.
 */
function DuplicateNote({
  match,
  gain,
  decision,
  name,
  noun,
  onDecide,
}: {
  match: DuplicateMatch;
  gain: number;
  decision: EntryDecision;
  name: string;
  noun: string;
  onDecide: (decision: EntryDecision) => void;
}): ReactNode {
  const choice = (value: EntryDecision, label: string): ReactNode => (
    <label className="flex cursor-pointer items-center gap-2 text-xs text-[var(--ink)]">
      <input
        type="radio"
        name={name}
        checked={decision === value}
        onChange={() => onDecide(value)}
      />
      <span>{label}</span>
    </label>
  );

  return (
    <div className="mt-3 rounded-xl border border-[var(--s-review-line)] bg-[var(--s-review-wash)] px-3 py-2.5">
      <p className="text-xs font-semibold text-[var(--ink)]">
        Already in your profile
        <span className="ml-2 font-normal text-[var(--ink-2)]">{match.reason}</span>
      </p>
      <div className="mt-2 flex flex-wrap gap-x-5 gap-y-1.5" role="radiogroup">
        {choice('skip', 'Skip - you already have it')}
        {/* Only offered when it would actually fill something in. */}
        {gain > 0 &&
          choice('update', `Update it - fills in ${gain} blank field${gain === 1 ? '' : 's'}`)}
        {choice('add', `Add as a separate ${noun}`)}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The three concrete sections
// ---------------------------------------------------------------------------

export function EducationReview(props: SectionProps<Education>): ReactNode {
  return (
    <ReviewSection
      heading="Schools we found"
      noun="school"
      {...props}
      renderEditor={({ entry, position, onChange, chrome }) => (
        <EducationEntry entry={entry} position={position} onChange={onChange} {...chrome} />
      )}
    />
  );
}

export function EmploymentReview(props: SectionProps<Employment>): ReactNode {
  return (
    <ReviewSection
      heading="Jobs we found"
      noun="job"
      {...props}
      renderEditor={({ entry, position, onChange, chrome }) => (
        <EmploymentEntry entry={entry} position={position} onChange={onChange} {...chrome} />
      )}
    />
  );
}

export function ProjectReview(props: SectionProps<Project>): ReactNode {
  return (
    <ReviewSection
      heading="Projects we found"
      noun="project"
      {...props}
      renderEditor={({ entry, position, onChange, chrome }) => (
        <ProjectEntry entry={entry} position={position} onChange={onChange} {...chrome} />
      )}
    />
  );
}

// ---------------------------------------------------------------------------
// Applying a screen's worth of reviews
// ---------------------------------------------------------------------------

/**
 * The parsed schools, jobs and projects, each with the user's decision about it.
 *
 * Held alongside the parse rather than derived from it, because it carries two
 * things the parse does not: the entries as the user has EDITED them, and what
 * they chose to do with each one.
 */
export interface EntryReviews {
  education: EntryReview<Education>[];
  employment: EntryReview<Employment>[];
  projects: EntryReview<Project>[];
}

export const NO_ENTRIES: EntryReviews = { education: [], employment: [], projects: [] };

/** Strip a review down to what `applyEntryDecisions` needs. */
function toDecision<T>({ entry, decision, match }: EntryReview<T>): EntryDecisionInput<T> {
  return { entry, decision, ...(match === null ? {} : { matchIndex: match.index }) };
}

/**
 * Apply every decision on the screen to a profile, and count what happened.
 *
 * Kept here, and pure, so "did unchecking that job actually keep it out of my
 * profile" is answerable by a test rather than only by clicking through an
 * upload. The import screen calls this inside its single atomic save; nothing
 * in this module ever writes to storage itself.
 */
export function applyReviews(
  profile: ApplicantProfile,
  reviews: EntryReviews,
): { profile: ApplicantProfile; added: number; updated: number; skipped: number } {
  const education = applyEntryDecisions(profile.education, reviews.education.map(toDecision));
  const employment = applyEntryDecisions(profile.employment, reviews.employment.map(toDecision));
  const projects = applyEntryDecisions(profile.projects, reviews.projects.map(toDecision));

  return {
    profile: {
      ...profile,
      education: education.entries,
      employment: employment.entries,
      projects: projects.entries,
    },
    added: education.added + employment.added + projects.added,
    updated: education.updated + employment.updated + projects.updated,
    skipped: education.skipped + employment.skipped + projects.skipped,
  };
}
