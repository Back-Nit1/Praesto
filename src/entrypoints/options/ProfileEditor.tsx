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
import { useEffect, useState, type ReactNode } from 'react';
import { Field, Section, StateBadge, type FieldState } from '@/components/ui';
import { newId } from '@shared/ids';
import { formatDate, parseDate, type NormalizedDate } from '@profile/normalizers/date';
import { parsePhone } from '@profile/normalizers/phone';
import {
  emptyValue,
  userValue,
  valueState,
  type ApplicantProfile,
  type Education,
  type Employment,
  type Project,
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

/**
 * A list, rendered for editing as one comma-separated line.
 *
 * Skills, preferred locations and technologies are all short flat lists, and a
 * comma-separated line is how people already write them. A row-per-item editor
 * would be more "correct" and considerably more tedious for a forty-item skills
 * list.
 */
const list = (value: ProfileValue<string[]>): string =>
  // The raw text the user typed wins over the parsed list, for the same reason
  // it does for dates and phones: re-rendering the parse while they are still
  // typing makes the field impossible to type in.
  value.raw ?? (value.value ?? []).join(', ');

const parseList = (input: string): string[] =>
  input
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);

/**
 * Display a stored date as text the user can edit.
 *
 * The `raw` text is preferred over the parsed value: it is what they typed, and
 * re-rendering "May 2025" as "2025-05" while they are still editing is the kind
 * of helpfulness that makes a field impossible to type in.
 */
const dateText = (value: ProfileValue<NormalizedDate>): string => {
  if (value.raw !== undefined) return value.raw;
  const parsed = value.value;
  if (parsed === null) return '';
  if (parsed.isPresent === true) return 'Present';
  return formatDate(parsed, 'MONTH_NAME_YEAR') ?? formatDate(parsed, 'YEAR') ?? '';
};

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

  /** Anything else the user wants available: Twitter, Scholar, Dribbble. */
  function setOtherLinks(next: string[]): void {
    edit((current) => ({
      ...current,
      links: { ...current.links, other: next.map((link) => userValue(link)) },
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
        preferredLocations: userValue(parseList(raw), raw),
      },
    }));
  }

  function setSkills(raw: string): void {
    edit((current) => ({ ...current, skills: userValue(parseList(raw), raw) }));
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
        [field]: next.trim().length === 0 ? emptyValue<string>() : userValue(next),
      },
    }));
  }

  function setRaceEthnicity(raw: string): void {
    edit((current) => ({
      ...current,
      demographics: {
        ...current.demographics,
        raceEthnicity:
          raw.trim().length === 0 ? emptyValue<string[]>() : userValue(parseList(raw), raw),
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
        <CommaListField
          label="Other links"
          value={profile.links.other.map((link) => link.value ?? '').join(', ')}
          state={profile.links.other.length > 0 ? 'verified' : 'missing'}
          onChange={(next) => setOtherLinks(parseList(next))}
          hint="Anything else worth sending: Scholar, Dribbble, a personal blog. Separate them with commas."
        />
      </Section>

      <Section title="Education">
        <p className="text-xs text-zinc-500">
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

      <Section title="Work experience">
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

      <Section title="Projects">
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

      <Section title="Skills">
        <CommaListField
          label="Skills"
          value={list(profile.skills)}
          state={stateOf(profile.skills)}
          onChange={setSkills}
          hint="Comma separated. Written into a skills box as one line, in this order."
        />
      </Section>

      <Section title="Salary, availability and location">
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

      <Section title="Voluntary self-identification">
        {/*
          Stored as free text rather than a fixed vocabulary, because every ATS
          words its options differently and translating the user's answer into
          our wording would mean guessing about a protected characteristic.
          "Decline to self-identify" is a legitimate answer and is stored,
          matched and filled like any other.
        */}
        <p className="text-xs text-zinc-500">
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

// ---------------------------------------------------------------------------
// Repeated entries
// ---------------------------------------------------------------------------

function EducationEntry({
  entry,
  position,
  onChange,
  onRemove,
}: {
  entry: Education;
  position: number;
  onChange: (mutate: (entry: Education) => Education) => void;
  onRemove: () => void;
}): ReactNode {
  const set = <K extends keyof Education>(field: K, value: Education[K]): void =>
    onChange((current) => ({ ...current, [field]: value }));

  return (
    <EntryCard
      title={entry.institution.value ?? `School ${position}`}
      onRemove={onRemove}
      removeLabel="Remove this school"
    >
      <Field
        label="School"
        value={text(entry.institution)}
        state={stateOf(entry.institution)}
        onChange={(next) => set('institution', userValue(next))}
      />
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field
          label="Degree"
          value={text(entry.degree)}
          state={stateOf(entry.degree)}
          onChange={(next) => set('degree', userValue(next))}
          placeholder="Bachelor of Science"
        />
        <Field
          label="Field of study"
          value={text(entry.fieldOfStudy)}
          state={stateOf(entry.fieldOfStudy)}
          onChange={(next) => set('fieldOfStudy', userValue(next))}
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
          onChange={(next) => set('gpa', userValue(next))}
          /* Stored exactly as written: "3.8/4.0" and "First Class Honours" are
             both real answers, and parsing either into a number would destroy
             the scale the institution actually issued. */
          placeholder="3.8"
        />
      </div>
    </EntryCard>
  );
}

function EmploymentEntry({
  entry,
  position,
  onChange,
  onRemove,
}: {
  entry: Employment;
  position: number;
  onChange: (mutate: (entry: Employment) => Employment) => void;
  onRemove: () => void;
}): ReactNode {
  const set = <K extends keyof Employment>(field: K, value: Employment[K]): void =>
    onChange((current) => ({ ...current, [field]: value }));

  const current = entry.currentlyEmployed.value === true;

  return (
    <EntryCard
      title={entry.company.value ?? `Job ${position}`}
      onRemove={onRemove}
      removeLabel="Remove this job"
    >
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field
          label="Employer"
          value={text(entry.company)}
          state={stateOf(entry.company)}
          onChange={(next) => set('company', userValue(next))}
        />
        <Field
          label="Job title"
          value={text(entry.title)}
          state={stateOf(entry.title)}
          onChange={(next) => set('title', userValue(next))}
        />
      </div>
      <Field
        label="Location"
        value={text(entry.location)}
        state={stateOf(entry.location)}
        onChange={(next) => set('location', userValue(next))}
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
      <label className="flex cursor-pointer items-center gap-3 rounded-xl border border-[--app-border] bg-[--app-panel-soft] px-3 py-2.5 text-sm text-[--app-text] transition hover:border-[--app-border-strong]">
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
        onChange={(next) => set('description', userValue(next))}
        hint="Used for a free-text 'describe your experience' box. Nothing is ever generated for you."
      />
    </EntryCard>
  );
}

function ProjectEntry({
  entry,
  position,
  onChange,
  onRemove,
}: {
  entry: Project;
  position: number;
  onChange: (mutate: (entry: Project) => Project) => void;
  onRemove: () => void;
}): ReactNode {
  const set = <K extends keyof Project>(field: K, value: Project[K]): void =>
    onChange((current) => ({ ...current, [field]: value }));

  return (
    <EntryCard
      title={entry.name.value ?? `Project ${position}`}
      onRemove={onRemove}
      removeLabel="Remove this project"
    >
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field
          label="Project name"
          value={text(entry.name)}
          state={stateOf(entry.name)}
          onChange={(next) => set('name', userValue(next))}
        />
        <Field
          label="Link"
          value={text(entry.url)}
          state={stateOf(entry.url)}
          onChange={(next) => set('url', userValue(next))}
        />
      </div>
      <CommaListField
        label="Technologies"
        value={list(entry.technologies)}
        state={stateOf(entry.technologies)}
        onChange={(next) => set('technologies', userValue(parseList(next), next))}
        hint="Comma separated."
      />
      <TextAreaField
        label="Description"
        value={text(entry.description)}
        state={stateOf(entry.description)}
        onChange={(next) => set('description', userValue(next))}
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
function DateField({
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
        <span className="mt-1 block text-xs text-zinc-500">
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
function CommaListField({
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

/** A multi-line field, for the two places a paragraph is the right answer. */
function TextAreaField({
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
        className="w-full resize-y rounded-xl border border-[--app-border] bg-[--app-panel-soft] px-3 py-2.5 text-sm text-[--app-text] outline-none transition placeholder:text-[--app-faint] hover:border-[--app-border-strong] focus:border-[--app-accent] focus:bg-[--app-panel] focus:ring-4 focus:ring-indigo-500/8"
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
function EntryCard({
  title,
  removeLabel,
  onRemove,
  children,
}: {
  title: string;
  removeLabel: string;
  onRemove: () => void;
  children: ReactNode;
}): ReactNode {
  const [open, setOpen] = useState(true);

  return (
    <div className="rounded-2xl border border-[--app-border] bg-[--app-panel-soft] p-3.5 transition hover:border-[--app-border-strong]">
      <div className="flex items-center justify-between gap-2">
        <button
          type="button"
          onClick={() => setOpen((current) => !current)}
          className="flex min-w-0 flex-1 items-center gap-3 text-left text-sm font-semibold text-[--app-text]"
          aria-expanded={open}
        >
          <span className="grid h-7 w-7 flex-none place-items-center rounded-lg bg-[--app-accent-soft] text-xs text-[--app-accent]" aria-hidden="true">
            {open ? '−' : '+'}
          </span>
          <span className="truncate">{title}</span>
        </button>
        <button
          type="button"
          onClick={onRemove}
          className="shrink-0 rounded-lg px-2 py-1.5 text-xs font-medium text-[--app-danger] transition hover:bg-red-500/8"
        >
          {removeLabel}
        </button>
      </div>
      {open && <div className="mt-4 space-y-3.5 border-t border-[--app-border] pt-4">{children}</div>}
    </div>
  );
}

function AddButton({ label, onClick }: { label: string; onClick: () => void }): ReactNode {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center justify-center gap-2 rounded-xl border border-dashed border-[--app-border-strong] bg-[--app-panel-soft] px-3 py-2.5 text-sm font-semibold text-[--app-accent] transition hover:border-[--app-accent] hover:bg-[--app-accent-soft]"
    >
      <span className="text-base leading-none" aria-hidden="true">+</span>
      {label}
    </button>
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
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-[--app-border] bg-[--app-panel-soft] px-3 py-2.5">
      <span className="flex items-center gap-2 text-sm font-medium text-[--app-text]">
        <StateBadge state={state} />
        {label}
      </span>
      <div className="flex rounded-lg border border-[--app-border] bg-[--app-panel] p-0.5">
        {options.map((option) => (
          <button
            key={String(option.value)}
            type="button"
            onClick={() => onChange(option.value)}
            className={`rounded-md px-2.5 py-1.5 text-xs font-semibold transition ${
              value === option.value
                ? 'bg-[--app-accent] text-white shadow-sm'
                : 'text-[--app-muted] hover:bg-[--app-panel-soft] hover:text-[--app-text]'
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
function dateValue(raw: string): ProfileValue<NormalizedDate> {
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
function emptyEducation(): Education {
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

function emptyEmployment(): Employment {
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

function emptyProject(): Project {
  return {
    id: newId('proj'),
    name: emptyValue<string>(),
    description: emptyValue<string>(),
    technologies: emptyValue<string[]>(),
    url: emptyValue<string>(),
  };
}
