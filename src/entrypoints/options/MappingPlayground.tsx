/**
 * Mapping playground.
 * ---------------------------------------------------------------------------
 * Spec section 27, Phase 3: an internal surface where you type the signals a
 * form field would carry and immediately see what the engine concludes.
 *
 *     Label: Given Name          ->  Predicted:  identity.legalFirstName
 *     Name:  legal_first             Confidence: 0.99
 *     Autocomplete: given-name       Reasons:    autocomplete + exact alias
 *     Type:  text                    Resolved:   Nityanth
 *
 * WHY THIS IS BUILT EARLY, BEFORE ANY REAL ATS TESTING
 * Debugging a mapping against a live Greenhouse page means reloading a website,
 * re-navigating a multi-step form, and reading console output - a minute or
 * more per iteration, and the page can change under you. Here the loop is
 * instant and the inputs are exactly reproducible.
 *
 * It also functions as documentation. A new contributor can discover what the
 * engine does with an unfamiliar label without reading the mapper at all, and
 * anything surprising they find becomes a fixture.
 *
 * This screen is the ONE place the raw confidence arithmetic is exposed. Spec
 * section 22 is explicit that the side panel must not overwhelm the user with
 * debugging metadata; here it is the entire point.
 */
import { useMemo, useState, type ReactNode } from 'react';
import { Button } from '@/components/ui';
import { mapField } from '@form-engine/mapper/mapper';
import { resolveValue } from '@form-engine/resolver/resolver';
import { decideFill } from '@form-engine/confidence/policy';
import { computeSemanticFingerprint, computeSignature } from '@form-engine/fingerprints/fingerprint';
import type { ControlKind, FieldDescriptor } from '@form-engine/descriptor/types';
import { labelForPath } from '@profile/paths';
import type { ApplicantProfile } from '@profile/schema';

const CONTROL_KINDS: ControlKind[] = [
  'text',
  'email',
  'tel',
  'url',
  'number',
  'textarea',
  'select',
  'checkbox',
  'radio',
  'date',
  'combobox',
];

interface PlaygroundInputs {
  label: string;
  name: string;
  id: string;
  autocomplete: string;
  placeholder: string;
  kind: ControlKind;
  /** One option per line, so a dropdown can be pasted straight in. */
  optionsText: string;
  sectionHeading: string;
  hostname: string;
}

const EMPTY_INPUTS: PlaygroundInputs = {
  label: '',
  name: '',
  id: '',
  autocomplete: '',
  placeholder: '',
  kind: 'text',
  optionsText: '',
  sectionHeading: '',
  hostname: 'boards.example.com',
};

/** Worked examples, so the screen is useful the moment it opens. */
const PRESETS: Array<{ title: string; inputs: Partial<PlaygroundInputs> }> = [
  { title: 'Given name', inputs: { label: 'Given Name', name: 'legal_first', autocomplete: 'given-name' } },
  { title: 'Greenhouse email', inputs: { label: 'Email', name: 'job_application[email]', kind: 'email' } },
  { title: 'LinkedIn', inputs: { label: 'LinkedIn Profile URL', kind: 'url' } },
  {
    title: 'Sponsorship (sensitive)',
    inputs: {
      label: 'Will you now or in the future require sponsorship?',
      kind: 'radio',
      optionsText: 'Yes\nNo',
    },
  },
  {
    title: 'Ambiguous',
    inputs: { label: 'Start date', kind: 'text' },
  },
  {
    title: 'Unknown question',
    inputs: { label: 'Describe a technically challenging project', kind: 'textarea' },
  },
];

export function MappingPlayground({ profile }: { profile: ApplicantProfile | undefined }): ReactNode {
  const [inputs, setInputs] = useState<PlaygroundInputs>(EMPTY_INPUTS);

  const update = (patch: Partial<PlaygroundInputs>): void =>
    setInputs((current) => ({ ...current, ...patch }));

  /**
   * Build the descriptor and run the real pipeline.
   *
   * Memoised on the inputs so typing does not re-run the engine on every
   * render - and, more importantly, so what is displayed is provably the output
   * of the SAME functions the extension runs in production. A playground that
   * reimplemented any part of the pipeline would be worse than none at all.
   */
  const analysis = useMemo(() => {
    const options = inputs.optionsText
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => ({ value: line, label: line }));

    const base: Omit<FieldDescriptor, 'semanticFingerprint'> = {
      localId: 'playground',
      tag: inputs.kind === 'textarea' ? 'textarea' : inputs.kind === 'select' ? 'select' : 'input',
      kind: inputs.kind,
      required: false,
      disabled: false,
      pageUrl: `https://${inputs.hostname}/apply`,
      hostname: inputs.hostname,
      ats: 'unknown',
    };

    if (inputs.label.length > 0) base.label = inputs.label;
    if (inputs.name.length > 0) base.name = inputs.name;
    if (inputs.id.length > 0) base.id = inputs.id;
    if (inputs.autocomplete.length > 0) base.autocomplete = inputs.autocomplete;
    if (inputs.placeholder.length > 0) base.placeholder = inputs.placeholder;
    if (inputs.sectionHeading.length > 0) base.sectionHeading = inputs.sectionHeading;
    if (options.length > 0) base.options = options;

    const descriptor: FieldDescriptor = {
      ...base,
      semanticFingerprint: computeSemanticFingerprint(base),
    };

    const mapping = mapField(descriptor);
    const signature = computeSignature(descriptor);

    const resolution =
      profile !== undefined && mapping.profilePath !== null
        ? resolveValue(profile, mapping.profilePath, descriptor)
        : undefined;

    const decision =
      mapping.profilePath === null
        ? 'skip'
        : decideFill({
            mappingConfidence: mapping.confidence,
            valueConfidence: resolution?.ok === true ? resolution.resolved.confidence : 0,
            valueVerifiedByUser: resolution?.ok === true ? resolution.resolved.verifiedByUser : false,
            profilePath: mapping.profilePath,
            valueMissing: resolution?.ok !== true,
            controlHasValue: false,
          });

    return { descriptor, mapping, signature, resolution, decision };
  }, [inputs, profile]);

  const { mapping, signature, resolution, decision } = analysis;

  return (
    <div className="grid grid-cols-1 items-start gap-5 lg:grid-cols-2">
      {/* --- inputs -------------------------------------------------------- */}
      <div className="surface-card space-y-4 p-5">
        <div>
          <div className="mb-1 text-[10px] font-bold uppercase tracking-[0.14em] text-[--app-accent]">Field signals</div>
          <h2 className="text-base font-semibold tracking-[-0.02em] text-[--app-text]">Describe a form control</h2>
          <p className="mt-1 text-xs leading-relaxed text-[--app-muted]">Start with an example or enter the attributes you see on a real application.</p>
        </div>
        <div className="soft-divider" />
        <div className="flex flex-wrap gap-1.5">
          {PRESETS.map((preset) => (
            <button
              key={preset.title}
              type="button"
              onClick={() => setInputs({ ...EMPTY_INPUTS, ...preset.inputs })}
              className="rounded-lg border border-[var(--app-border)] bg-[var(--app-panel-soft)] px-2.5 py-1.5 text-[11px] font-medium text-[--app-muted] transition hover:border-[var(--app-border-strong)] hover:bg-[var(--app-panel)] hover:text-[--app-text]"
            >
              {preset.title}
            </button>
          ))}
          <Button className="!min-h-7 !rounded-lg !px-2.5 !py-1 !text-[11px]" variant="ghost" onClick={() => setInputs(EMPTY_INPUTS)}>
            Clear
          </Button>
        </div>

        <PlaygroundInput label="Label" value={inputs.label} onChange={(v) => update({ label: v })} />
        <PlaygroundInput label="name attribute" value={inputs.name} onChange={(v) => update({ name: v })} />
        <PlaygroundInput label="id attribute" value={inputs.id} onChange={(v) => update({ id: v })} />
        <PlaygroundInput
          label="autocomplete"
          value={inputs.autocomplete}
          onChange={(v) => update({ autocomplete: v })}
        />
        <PlaygroundInput
          label="placeholder"
          value={inputs.placeholder}
          onChange={(v) => update({ placeholder: v })}
        />
        <PlaygroundInput
          label="Section heading"
          value={inputs.sectionHeading}
          onChange={(v) => update({ sectionHeading: v })}
        />

        <label className="block">
          <span className="mb-1.5 block text-xs font-semibold text-[--app-text]">Control type</span>
          <select
            value={inputs.kind}
            onChange={(event) => update({ kind: event.target.value as ControlKind })}
            className="w-full rounded-xl border border-[var(--app-border)] bg-[var(--app-panel-soft)] px-3 py-2.5 text-sm text-[--app-text] outline-none transition hover:border-[var(--app-border-strong)] focus:border-[var(--app-accent)] focus:bg-[var(--app-panel)] focus:ring-4 focus:ring-indigo-500/8"
          >
            {CONTROL_KINDS.map((kind) => (
              <option key={kind} value={kind}>
                {kind}
              </option>
            ))}
          </select>
        </label>

        <label className="block">
          <span className="mb-1.5 block text-xs font-semibold text-[--app-text]">
            Options (one per line)
          </span>
          <textarea
            value={inputs.optionsText}
            onChange={(event) => update({ optionsText: event.target.value })}
            rows={4}
            className="w-full rounded-xl border border-[var(--app-border)] bg-[var(--app-panel-soft)] px-3 py-2.5 font-mono text-xs text-[--app-text] outline-none transition hover:border-[var(--app-border-strong)] focus:border-[var(--app-accent)] focus:bg-[var(--app-panel)] focus:ring-4 focus:ring-indigo-500/8"
          />
        </label>
      </div>

      {/* --- output -------------------------------------------------------- */}
      <div className="surface-card sticky top-5 space-y-4 overflow-hidden p-5 text-sm">
        <div className="flex items-center justify-between gap-3">
          <div>
            <div className="mb-1 text-[10px] font-bold uppercase tracking-[0.14em] text-[--app-teal]">Live interpretation</div>
            <h2 className="text-base font-semibold tracking-[-0.02em] text-[--app-text]">What the agent sees</h2>
          </div>
          <span className={`rounded-full border px-2.5 py-1 text-[10px] font-bold uppercase tracking-wide ${
            decision === 'autofill'
              ? 'border-emerald-500/20 bg-emerald-500/10 text-[--app-success]'
              : decision === 'suggest'
                ? 'border-amber-500/20 bg-amber-500/10 text-[--app-warning]'
                : 'border-zinc-500/15 bg-zinc-500/8 text-[--app-muted]'
          }`}>{decision}</span>
        </div>
        <div className="soft-divider" />
        <Row label="Predicted">
          {mapping.profilePath === null ? (
            <span className="text-[--app-muted]">unknown — the engine would leave this field alone</span>
          ) : (
            <span className="rounded-md bg-indigo-500/8 px-1.5 py-1 font-mono text-xs text-[--app-accent]">{mapping.profilePath}</span>
          )}
        </Row>

        {mapping.profilePath !== null && <Row label="Means">{labelForPath(mapping.profilePath)}</Row>}

        <Row label="Confidence">
          <span className="font-mono">{mapping.confidence.toFixed(3)}</span>
        </Row>
        <Row label="Knowledge state">{mapping.knowledgeState}</Row>
        <Row label="Source">{mapping.source}</Row>

        <Row label="Decision">
          <span
            className={
              decision === 'autofill'
                ? 'font-semibold text-[--app-success]'
                : decision === 'suggest'
                  ? 'font-semibold text-[--app-warning]'
                  : 'text-[--app-muted]'
            }
          >
            {decision}
          </span>
        </Row>

        <Row label="Resolved value">
          {resolution === undefined ? (
            <span className="text-[--app-muted]">no profile loaded</span>
          ) : resolution.ok ? (
            <span className="font-mono">{String(resolution.resolved.value)}</span>
          ) : (
            <span className="text-[--app-muted]">{resolution.reason}</span>
          )}
        </Row>

        <div className="rounded-xl border border-[var(--app-border)] bg-[var(--app-panel-soft)] p-3">
          <div className="mb-2 text-[10px] font-bold uppercase tracking-[0.12em] text-[--app-muted]">
            Reasons
          </div>
          <ul className="space-y-1">
            {mapping.reasons.map((reason, index) => (
              <li key={index} className="font-mono text-[11px] leading-relaxed text-[--app-text]">
                {reason.signal}
                {reason.matched !== undefined && ` -> "${reason.matched}"`}
                {reason.score !== undefined && ` (${reason.score.toFixed(3)})`}
                {reason.detail !== undefined && ` - ${reason.detail}`}
              </li>
            ))}
          </ul>
        </div>

        {mapping.alternatives !== undefined && mapping.alternatives.length > 0 && (
          <div className="rounded-xl border border-amber-500/15 bg-amber-500/5 p-3">
            <div className="mb-2 text-[10px] font-bold uppercase tracking-[0.12em] text-[--app-warning]">
              Competing interpretations
            </div>
            <ul className="space-y-1">
              {mapping.alternatives.map((alternative) => (
                <li key={alternative.profilePath} className="font-mono text-[11px] text-[--app-warning]">
                  {alternative.profilePath} ({alternative.confidence.toFixed(3)})
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="rounded-xl border border-[var(--app-border)] bg-[var(--app-panel-soft)] p-3">
          <div className="mb-2 text-[10px] font-bold uppercase tracking-[0.12em] text-[--app-muted]">
            Semantic fingerprint
          </div>
          {/* Shown because a learned mapping is keyed on this. When a correction
              fails to carry over between two pages, the first thing to check is
              whether their fingerprints actually match. */}
          <div className="space-y-1 break-all font-mono text-[10px] leading-relaxed text-[--app-muted]">
            <div>hash: {analysis.descriptor.semanticFingerprint}</div>
            <div>question: {signature.question || '(none)'}</div>
            <div>kind: {signature.kind}</div>
            <div>options: {signature.options.join(', ') || '(none)'}</div>
          </div>
        </div>
      </div>
    </div>
  );
}

function PlaygroundInput({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}): ReactNode {
  return (
    <label className="block">
      <span className="mb-1.5 block text-xs font-semibold text-[--app-text]">{label}</span>
      <input
        type="text"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="w-full rounded-xl border border-[var(--app-border)] bg-[var(--app-panel-soft)] px-3 py-2.5 font-mono text-xs text-[--app-text] outline-none transition hover:border-[var(--app-border-strong)] focus:border-[var(--app-accent)] focus:bg-[var(--app-panel)] focus:ring-4 focus:ring-indigo-500/8"
      />
    </label>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }): ReactNode {
  return (
    <div className="grid grid-cols-[112px_minmax(0,1fr)] gap-3">
      <span className="text-[10px] font-bold uppercase tracking-[0.1em] text-[--app-muted]">{label}</span>
      <span className="min-w-0 break-words text-[--app-text]">{children}</span>
    </div>
  );
}
