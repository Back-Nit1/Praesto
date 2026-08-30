/**
 * Profile editor - where the applicant becomes the source of truth.
 * ---------------------------------------------------------------------------
 * Spec section 9. This screen exists so the user can look at every value the
 * system holds, correct it, and personally vouch for it. Nothing else in the
 * product can produce a verified value.
 *
 * THE INTERACTION THAT MATTERS
 * Typing into a field marks it `source: 'user'`, `confidence: 1`,
 * `verifiedByUser: true`. That is not a convenience - it is the entire trust
 * model. A value the user typed is the highest authority in the system, and
 * from that moment no resume parse and no heuristic may overwrite it (enforced
 * in ProfileRepository.mergeCandidates, not here).
 *
 * WHAT THIS SCREEN DELIBERATELY DOES NOT DO
 * It does not pre-fill demographic or work-authorization answers, and it does
 * not offer a "guess these for me" affordance. Spec section 21.3: those may
 * only ever come from an explicit user statement.
 */
import type { ReactNode } from 'react';
import { Field, Section, StateBadge, type FieldState } from '@/components/ui';
import { parsePhone } from '@profile/normalizers/phone';
import {
  userValue,
  valueState,
  type ApplicantProfile,
  type ProfileValue,
} from '@profile/schema';

interface ProfileEditorProps {
  profile: ApplicantProfile;
  edit: (mutate: (profile: ApplicantProfile) => ApplicantProfile) => void;
}

/**
 * Read a wrapped string value for display.
 * Returns '' rather than 'null' so an empty field looks empty.
 */
const text = (value: ProfileValue<string>): string => value.value ?? '';

/** Map a stored value onto the four display states. */
const stateOf = (value: ProfileValue<unknown>): FieldState => valueState(value) as FieldState;

export function ProfileEditor({ profile, edit }: ProfileEditorProps): ReactNode {
  /**
   * Set a string value inside one top-level group.
   *
   * Typed against the actual profile shape rather than taking a path string, so
   * a mistyped field name is a compile error here instead of a value that
   * silently writes nowhere.
   */
  function setIdentity(field: keyof ApplicantProfile['identity'], next: string): void {
    edit((current) => ({
      ...current,
      identity: { ...current.identity, [field]: userValue(next) },
    }));
  }

  function setContactString(
    field: Exclude<keyof ApplicantProfile['contact'], 'phone'>,
    next: string,
  ): void {
    edit((current) => ({
      ...current,
      contact: { ...current.contact, [field]: userValue(next) },
    }));
  }

  function setLink(field: keyof Omit<ApplicantProfile['links'], 'other'>, next: string): void {
    edit((current) => ({
      ...current,
      links: { ...current.links, [field]: userValue(next) },
    }));
  }

  /**
   * Phone gets its own setter because it is normalized on entry.
   *
   * Parsing here rather than at fill time means the user sees immediately
   * whether we understood their number - the field shows "needs review" if we
   * could not parse it, instead of failing silently on an application later.
   */
  function setPhone(raw: string): void {
    edit((current) => {
      const parsed = parsePhone(raw);
      return {
        ...current,
        contact: {
          ...current.contact,
          // A number we cannot parse is stored as null with the raw text kept,
          // so nothing is lost and the state badge reports it honestly.
          phone:
            parsed === null
              ? { value: null, raw, evidence: [] }
              : userValue(parsed, raw),
        },
      };
    });
  }

  /** Tri-state control for the legal yes/no questions. */
  function setPreferenceBoolean(
    field: 'authorizedToWorkUS' | 'requiresSponsorshipNow' | 'requiresSponsorshipFuture' | 'willingToRelocate',
    next: boolean | null,
  ): void {
    edit((current) => ({
      ...current,
      applicationPreferences: {
        ...current.applicationPreferences,
        // null clears the answer entirely - "I have not answered this" is a
        // legitimate and important state, distinct from "no".
        [field]: next === null ? { value: null, evidence: [] } : userValue(next),
      },
    }));
  }

  return (
    <div className="max-w-2xl">
      <Section title="Identity">
        <Field
          label="Legal first name"
          value={text(profile.identity.legalFirstName)}
          state={stateOf(profile.identity.legalFirstName)}
          onChange={(next) => setIdentity('legalFirstName', next)}
          hint="As it appears on official documents. Used for background-check and I-9 questions."
        />
        <Field
          label="Preferred first name"
          value={text(profile.identity.preferredFirstName)}
          state={stateOf(profile.identity.preferredFirstName)}
          onChange={(next) => setIdentity('preferredFirstName', next)}
          hint="What you want to be called. Kept separate from your legal name on purpose."
        />
        <Field
          label="Middle name"
          value={text(profile.identity.middleName)}
          state={stateOf(profile.identity.middleName)}
          onChange={(next) => setIdentity('middleName', next)}
        />
        <Field
          label="Last name"
          value={text(profile.identity.lastName)}
          state={stateOf(profile.identity.lastName)}
          onChange={(next) => setIdentity('lastName', next)}
        />
      </Section>

      <Section title="Contact">
        <Field
          label="Email"
          value={text(profile.contact.email)}
          state={stateOf(profile.contact.email)}
          onChange={(next) => setContactString('email', next)}
        />
        <Field
          label="Phone"
          value={profile.contact.phone.raw ?? profile.contact.phone.value?.raw ?? ''}
          state={stateOf(profile.contact.phone)}
          onChange={setPhone}
          hint="Stored once, then rendered in whatever format each application asks for."
        />
        <Field
          label="Address line 1"
          value={text(profile.contact.addressLine1)}
          state={stateOf(profile.contact.addressLine1)}
          onChange={(next) => setContactString('addressLine1', next)}
        />
        <Field
          label="Address line 2"
          value={text(profile.contact.addressLine2)}
          state={stateOf(profile.contact.addressLine2)}
          onChange={(next) => setContactString('addressLine2', next)}
        />
        <div className="grid grid-cols-3 gap-2">
          <Field
            label="City"
            value={text(profile.contact.city)}
            state={stateOf(profile.contact.city)}
            onChange={(next) => setContactString('city', next)}
          />
          <Field
            label="State"
            value={text(profile.contact.state)}
            state={stateOf(profile.contact.state)}
            onChange={(next) => setContactString('state', next)}
          />
          <Field
            label="Postal code"
            value={text(profile.contact.postalCode)}
            state={stateOf(profile.contact.postalCode)}
            onChange={(next) => setContactString('postalCode', next)}
          />
        </div>
        <Field
          label="Country"
          value={text(profile.contact.country)}
          state={stateOf(profile.contact.country)}
          onChange={(next) => setContactString('country', next)}
        />
      </Section>

      <Section title="Links">
        <Field
          label="LinkedIn"
          value={text(profile.links.linkedin)}
          state={stateOf(profile.links.linkedin)}
          onChange={(next) => setLink('linkedin', next)}
          placeholder="https://www.linkedin.com/in/..."
        />
        <Field
          label="GitHub"
          value={text(profile.links.github)}
          state={stateOf(profile.links.github)}
          onChange={(next) => setLink('github', next)}
        />
        <Field
          label="Portfolio / website"
          value={text(profile.links.portfolio)}
          state={stateOf(profile.links.portfolio)}
          onChange={(next) => setLink('portfolio', next)}
        />
      </Section>

      <Section title="Work authorization">
        {/*
          These four are the highest-stakes values in the profile. A wrong answer
          is a false statement to an employer, so they are answered ONLY here,
          explicitly, and the confidence policy refuses to autofill them from
          anything but a value the user set on this screen.
        */}
        <p className="text-xs text-zinc-500">
          These are never guessed from your resume, your name, or where you live. The extension will
          leave them blank on an application until you answer them here.
        </p>
        <TriStateQuestion
          label="Authorized to work in the US"
          value={profile.applicationPreferences.authorizedToWorkUS.value}
          state={stateOf(profile.applicationPreferences.authorizedToWorkUS)}
          onChange={(next) => setPreferenceBoolean('authorizedToWorkUS', next)}
        />
        <TriStateQuestion
          label="Require sponsorship now"
          value={profile.applicationPreferences.requiresSponsorshipNow.value}
          state={stateOf(profile.applicationPreferences.requiresSponsorshipNow)}
          onChange={(next) => setPreferenceBoolean('requiresSponsorshipNow', next)}
        />
        <TriStateQuestion
          label="Will require sponsorship in the future"
          value={profile.applicationPreferences.requiresSponsorshipFuture.value}
          state={stateOf(profile.applicationPreferences.requiresSponsorshipFuture)}
          onChange={(next) => setPreferenceBoolean('requiresSponsorshipFuture', next)}
        />
        <TriStateQuestion
          label="Willing to relocate"
          value={profile.applicationPreferences.willingToRelocate.value}
          state={stateOf(profile.applicationPreferences.willingToRelocate)}
          onChange={(next) => setPreferenceBoolean('willingToRelocate', next)}
        />
      </Section>
    </div>
  );
}

/**
 * Yes / No / Not answered.
 *
 * Three states, not a checkbox. A checkbox has no way to express "I have not
 * answered this", so an unchecked box would be indistinguishable from an
 * explicit "no" - and the extension would then confidently answer a sponsorship
 * question the user never touched.
 */
function TriStateQuestion({
  label,
  value,
  state,
  onChange,
}: {
  label: string;
  value: boolean | null;
  state: FieldState;
  onChange: (next: boolean | null) => void;
}): ReactNode {
  const options: Array<{ label: string; value: boolean | null }> = [
    { label: 'Yes', value: true },
    { label: 'No', value: false },
    { label: 'Not answered', value: null },
  ];

  return (
    <div className="flex items-center justify-between gap-4 rounded border border-zinc-200 px-3 py-2 dark:border-zinc-700">
      <span className="flex items-center gap-2 text-sm">
        <StateBadge state={state} />
        {label}
      </span>
      <div className="flex gap-1">
        {options.map((option) => (
          <button
            key={String(option.value)}
            type="button"
            onClick={() => onChange(option.value)}
            className={`rounded px-2 py-1 text-xs ${
              value === option.value
                ? 'bg-blue-600 text-white'
                : 'bg-zinc-100 text-zinc-700 dark:bg-zinc-700 dark:text-zinc-200'
            }`}
            aria-pressed={value === option.value}
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  );
}
