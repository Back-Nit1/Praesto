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
 * WHY THIS SCREEN COVERS THE WHOLE SCHEMA
 * It used to expose identity, contact, three links and four authorization
 * questions - about a third of the profile. Everything else (education,
 * employment, projects, skills, salary, availability, preferred locations,
 * demographics, additional links) existed in the schema, was mapped by the
 * form engine, and could only be populated by hand-editing an imported JSON
 * file. A field the user cannot enter is a field the extension can never fill,
 * so the gap was not cosmetic: it silently capped what the product could do at
 * whatever the resume parser happened to extract.
 *
 * WHAT THIS SCREEN DELIBERATELY DOES NOT DO
 * It does not pre-fill demographic or work-authorization answers, and it does
 * not offer a "guess these for me" affordance. Spec section 21.3: those may
 * only ever come from an explicit user statement. Demographics are also
 * explicitly optional here, and saying nothing is a first-class answer.
 */
import { type ReactNode } from 'react';
import { Field, Section, StateBadge, type FieldState } from '@/components/ui';
import { parsePhone } from '@profile/normalizers/phone';
import { userValue, type ApplicantProfile } from '@profile/schema';
import { type ValueFormat } from '@profile/validation';
import {
  AddButton,
  CommaListField,
  DateField,
  EducationEntry,
  EmploymentEntry,
  ProjectEntry,
  dateValue,
  emptyEducation,
  emptyEmployment,
  emptyProject,
  hintFor,
  hintProp,
  list,
  parseList,
  stateOf,
  text,
  typedList,
  typedValue,
} from './profile-entries';

interface ProfileEditorProps {
  profile: ApplicantProfile;
  edit: (mutate: (profile: ApplicantProfile) => ApplicantProfile) => void;
}

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
      identity: { ...current.identity, [field]: typedValue(next) },
    }));
  }

  /**
   * Contact fields, each validated as the shape it claims to be.
   *
   * The email case is the one that mattered: `contact.email` is declared in the
   * schema as `z.string().email()`, so a malformed address typed here was
   * stored happily and then failed VALIDATION ON RELOAD - the whole profile
   * refusing to load with "Stored profile failed validation". Catching it at
   * the keystroke turns a corrupted profile into a "needs review" badge.
   */
  const CONTACT_FORMATS: Partial<Record<keyof ApplicantProfile['contact'], ValueFormat>> = {
    email: 'email',
    postalCode: 'postal_code',
  };

  function setContactString(
    field: Exclude<keyof ApplicantProfile['contact'], 'phone'>,
    next: string,
  ): void {
    edit((current) => ({
      ...current,
      contact: { ...current.contact, [field]: typedValue(next, CONTACT_FORMATS[field] ?? 'text') },
    }));
  }

  function setLink(field: keyof Omit<ApplicantProfile['links'], 'other'>, next: string): void {
    edit((current) => ({
      ...current,
      links: { ...current.links, [field]: typedValue(next, 'url') },
    }));
  }

  /** Anything else the user wants available: Twitter, Scholar, Dribbble. */
  function setOtherLinks(raw: string): void {
    edit((current) => ({
      ...current,
      links: {
        ...current.links,
        // Each link validated on its own: one mistyped entry marks itself for
        // review instead of discrediting the whole line.
        other: parseList(raw).map((link) => typedValue(link, 'url')),
      },
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

  /**
   * Desired salary, stored as a number.
   *
   * Non-numeric input clears the value rather than storing something we cannot
   * render: a salary field on an application usually rejects "£90k-ish", and a
   * blank field the user completes is better than a rejected submission.
   */
  function setDesiredSalary(raw: string): void {
    const digits = raw.replace(/[^0-9.]/g, '');
    const parsed = digits.length === 0 ? null : Number(digits);
    edit((current) => ({
      ...current,
      applicationPreferences: {
        ...current.applicationPreferences,
        desiredSalary:
          parsed === null || Number.isNaN(parsed)
            ? { value: null, raw, evidence: [] }
            : userValue(parsed, raw),
      },
    }));
  }

  function setAvailableStartDate(raw: string): void {
    edit((current) => ({
      ...current,
      applicationPreferences: {
        ...current.applicationPreferences,
        availableStartDate: dateValue(raw),
      },
    }));
  }

  function setPreferredLocations(raw: string): void {
    edit((current) => ({
      ...current,
      applicationPreferences: {
        ...current.applicationPreferences,
        preferredLocations: typedList(raw),
      },
    }));
  }

  function setSkills(raw: string): void {
    edit((current) => ({ ...current, skills: typedList(raw) }));
  }

  function setDemographicString(
    field: 'gender' | 'veteranStatus' | 'disabilityStatus',
    next: string,
  ): void {
    edit((current) => ({
      ...current,
      demographics: {
        ...current.demographics,
        // An emptied field clears the answer rather than storing "", so
        // "I have not answered" survives a typo-and-delete.
        [field]: typedValue(next),
      },
    }));
  }

  function setRaceEthnicity(raw: string): void {
    edit((current) => ({
      ...current,
      demographics: {
        ...current.demographics,
        raceEthnicity: typedList(raw),
      },
    }));
  }

  // --- repeated collections -------------------------------------------------
  //
  // One generic pair of helpers rather than three copies. The collections
  // differ in their FIELDS, which the entry components below own, and not in
  // how a list is added to or removed from.

  function updateEntry<K extends 'education' | 'employment' | 'projects'>(
    collection: K,
    index: number,
    mutate: (entry: ApplicantProfile[K][number]) => ApplicantProfile[K][number],
  ): void {
    edit((current) => {
      const entries = [...current[collection]];
      const entry = entries[index];
      if (entry === undefined) return current;
      entries[index] = mutate(entry) as (typeof entries)[number];
      return { ...current, [collection]: entries };
    });
  }

  function addEntry(collection: 'education' | 'employment' | 'projects'): void {
    edit((current) => ({
      ...current,
      [collection]: [
        ...current[collection],
        collection === 'education'
          ? emptyEducation()
          : collection === 'employment'
            ? emptyEmployment()
            : emptyProject(),
      ],
    }));
  }

  function removeEntry(collection: 'education' | 'employment' | 'projects', index: number): void {
    edit((current) => ({
      ...current,
      [collection]: current[collection].filter((_entry, position) => position !== index),
    }));
  }

  return (
    <div className="profile-grid">
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
          value={profile.contact.email.raw ?? text(profile.contact.email)}
          state={stateOf(profile.contact.email)}
          onChange={(next) => setContactString('email', next)}
          {...hintProp(
            hintFor(
              profile.contact.email,
              'That is not a shape we recognise as an email address, so it will not be filled.',
            ),
          )}
        />
        <Field
          label="Phone"
          value={profile.contact.phone.raw ?? profile.contact.phone.value?.raw ?? ''}
          state={stateOf(profile.contact.phone)}
          onChange={setPhone}
          hint={
            hintFor(
              profile.contact.phone,
              'We could not read that as a phone number, so it will not be filled.',
              'Stored once, then rendered in whatever format each application asks for.',
            ) ?? ''
          }
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
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
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
            value={profile.contact.postalCode.raw ?? text(profile.contact.postalCode)}
            state={stateOf(profile.contact.postalCode)}
            onChange={(next) => setContactString('postalCode', next)}
            {...hintProp(
              hintFor(profile.contact.postalCode, 'That does not look like a postal code.'),
            )}
          />
        </div>
        <Field
          label="Country"
          value={text(profile.contact.country)}
          state={stateOf(profile.contact.country)}
          onChange={(next) => setContactString('country', next)}
        />
      </Section>

      <Section title="Links" wide>
        <Field
          label="LinkedIn"
          value={profile.links.linkedin.raw ?? text(profile.links.linkedin)}
          state={stateOf(profile.links.linkedin)}
          onChange={(next) => setLink('linkedin', next)}
          {...hintProp(
            hintFor(
              profile.links.linkedin,
              'That does not look like a web address, so it will not be filled.',
            ),
          )}
          placeholder="https://www.linkedin.com/in/..."
        />
        <Field
          label="GitHub"
          value={profile.links.github.raw ?? text(profile.links.github)}
          state={stateOf(profile.links.github)}
          onChange={(next) => setLink('github', next)}
          {...hintProp(
            hintFor(
              profile.links.github,
              'That does not look like a web address, so it will not be filled.',
            ),
          )}
        />
        <Field
          label="Portfolio / website"
          value={profile.links.portfolio.raw ?? text(profile.links.portfolio)}
          state={stateOf(profile.links.portfolio)}
          onChange={(next) => setLink('portfolio', next)}
          {...hintProp(
            hintFor(
              profile.links.portfolio,
              'That does not look like a web address, so it will not be filled.',
            ),
          )}
        />
        <CommaListField
          label="Other links"
          value={profile.links.other.map((link) => link.value ?? '').join(', ')}
          state={profile.links.other.length > 0 ? 'verified' : 'missing'}
          onChange={setOtherLinks}
          hint="Anything else worth sending: Scholar, Dribbble, a personal blog. Separate them with commas."
        />
      </Section>

      <Section title="Education" wide>
        <p className="text-xs leading-relaxed text-[var(--ink-2)]">
          Most applications ask about one school. The one with the most recent graduation date is
          the one offered first, so list them in whatever order suits you.
        </p>
        {profile.education.map((entry, index) => (
          <EducationEntry
            key={entry.id}
            entry={entry}
            position={index + 1}
            onChange={(mutate) => updateEntry('education', index, mutate)}
            onRemove={() => removeEntry('education', index)}
          />
        ))}
        <AddButton label="Add a school" onClick={() => addEntry('education')} />
      </Section>

      <Section title="Work experience" wide>
        {profile.employment.map((entry, index) => (
          <EmploymentEntry
            key={entry.id}
            entry={entry}
            position={index + 1}
            onChange={(mutate) => updateEntry('employment', index, mutate)}
            onRemove={() => removeEntry('employment', index)}
          />
        ))}
        <AddButton label="Add a job" onClick={() => addEntry('employment')} />
      </Section>

      <Section title="Projects" wide>
        {profile.projects.map((entry, index) => (
          <ProjectEntry
            key={entry.id}
            entry={entry}
            position={index + 1}
            onChange={(mutate) => updateEntry('projects', index, mutate)}
            onRemove={() => removeEntry('projects', index)}
          />
        ))}
        <AddButton label="Add a project" onClick={() => addEntry('projects')} />
      </Section>

      <Section title="Skills" wide>
        <CommaListField
          label="Skills"
          value={list(profile.skills)}
          state={stateOf(profile.skills)}
          onChange={setSkills}
          hint="Comma separated. Written into a skills box as one line, in this order."
        />
      </Section>

      <Section title="Salary, availability and location" wide>
        <Field
          label="Desired salary"
          value={
            profile.applicationPreferences.desiredSalary.raw ??
            (profile.applicationPreferences.desiredSalary.value?.toString() ?? '')
          }
          state={stateOf(profile.applicationPreferences.desiredSalary)}
          onChange={setDesiredSalary}
          hint="A number. Stored as one so it can be written into a numeric field without being rejected."
        />
        <DateField
          label="Available start date"
          value={profile.applicationPreferences.availableStartDate}
          onChange={setAvailableStartDate}
          hint='Anything readable: "June 2026", "2026-06-01", "Immediately".'
        />
        <CommaListField
          label="Preferred locations"
          value={list(profile.applicationPreferences.preferredLocations)}
          state={stateOf(profile.applicationPreferences.preferredLocations)}
          onChange={setPreferredLocations}
          hint="Comma separated, most preferred first."
        />
      </Section>

      <Section title="Work authorization" wide>
        {/*
          These four are the highest-stakes values in the profile. A wrong answer
          is a false statement to an employer, so they are answered ONLY here,
          explicitly, and the confidence policy refuses to autofill them from
          anything but a value the user set on this screen.
        */}
        <p className="text-xs leading-relaxed text-[var(--ink-2)]">
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

      <Section title="Voluntary self-identification" wide>
        {/*
          Stored as free text rather than a fixed vocabulary, because every ATS
          words its options differently and translating the user's answer into
          our wording would mean guessing about a protected characteristic.
          "Decline to self-identify" is a legitimate answer and is stored,
          matched and filled like any other.
        */}
        <p className="text-xs leading-relaxed text-[var(--ink-2)]">
          Entirely optional, and never inferred from anything. Leave any of these blank and the
          extension will leave the matching question on an application blank too. Write your answer
          the way you want it to appear - including "Decline to self-identify".
        </p>
        <Field
          label="Gender"
          value={text(profile.demographics.gender)}
          state={stateOf(profile.demographics.gender)}
          onChange={(next) => setDemographicString('gender', next)}
        />
        <CommaListField
          label="Race / ethnicity"
          value={list(profile.demographics.raceEthnicity)}
          state={stateOf(profile.demographics.raceEthnicity)}
          onChange={setRaceEthnicity}
          hint="Comma separated, because these questions frequently allow more than one answer."
        />
        <Field
          label="Veteran status"
          value={text(profile.demographics.veteranStatus)}
          state={stateOf(profile.demographics.veteranStatus)}
          onChange={(next) => setDemographicString('veteranStatus', next)}
        />
        <Field
          label="Disability status"
          value={text(profile.demographics.disabilityStatus)}
          state={stateOf(profile.demographics.disabilityStatus)}
          onChange={(next) => setDemographicString('disabilityStatus', next)}
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
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-[var(--rule)] bg-[var(--paper-2)] px-3 py-2.5">
      <span className="flex items-center gap-2 text-sm font-medium text-[var(--ink)]">
        <StateBadge state={state} />
        {label}
      </span>
      <div className="flex rounded-lg border border-[var(--rule)] bg-[var(--paper)] p-0.5">
        {options.map((option) => (
          <button
            key={String(option.value)}
            type="button"
            onClick={() => onChange(option.value)}
            className={`rounded-md px-2.5 py-1.5 text-xs font-semibold transition ${
              value === option.value
                ? 'bg-[var(--ink)] text-white shadow-sm'
                : 'text-[var(--ink-2)] hover:bg-[var(--paper-2)] hover:text-[var(--ink)]'
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
