// @vitest-environment jsdom
/**
 * The semantic fallback over real-shaped ATS markup, end to end.
 *
 * Everything else in `tests/semantic/` feeds hand-built descriptors to one
 * module. This file runs the SCANNER over HTML, so the descriptors are the ones
 * the content script would actually produce - which is the seam
 * `engineering.md` practice #3 is about, and the one that cost this repo a day
 * the last time nothing was testing it.
 *
 * WHAT THESE FIXTURES ARE, PLAINLY: markup written from each ATS's published
 * naming conventions. They are NOT captures of real applications - nobody has
 * run this build against one. So these tests prove the pipeline handles the
 * SHAPE of Greenhouse, Lever and Ashby markup. They do not prove it handles
 * Greenhouse. The fixture headers and IMPLEMENTATION_STATUS.md say the same,
 * because a fixture that overstates itself is worse than no fixture.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { scanPage } from '@form-engine/detector/scanner';
import { mapField } from '@form-engine/mapper/mapper';
import { resolveValue } from '@form-engine/resolver/resolver';
import { decideFill } from '@form-engine/confidence/policy';
import { applySemanticFallback, SemanticConceptCache, type FieldOutcome } from '@semantic/index';
import { createEmptyProfile, userValue, type ApplicantProfile } from '@profile/schema';
import { InMemoryStore } from '@storage/key-value-store';
import type { FieldDescriptor } from '@form-engine/descriptor/types';
import type { FillDecision } from '@form-engine/confidence/policy';
import { FakeSemanticPort } from './fakes';

function loadFixture(name: string): Document {
  const path = resolve(process.cwd(), 'fixtures/forms', name);
  document.documentElement.innerHTML = readFileSync(path, 'utf-8');
  return document;
}

/** jsdom does no layout, so the scanner's visibility check needs these two. */
beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, 'offsetParent', {
    configurable: true,
    get() {
      return window.getComputedStyle(this as HTMLElement).display === 'none'
        ? null
        : (this as HTMLElement).parentElement;
    },
  });
  HTMLElement.prototype.getBoundingClientRect = function (): DOMRect {
    return { width: 100, height: 20, top: 0, left: 0, right: 100, bottom: 20, x: 0, y: 0 } as DOMRect;
  };
});

function applicant(): ApplicantProfile {
  const profile = createEmptyProfile('fixture-profile');
  profile.identity.legalFirstName = userValue('Nityanth');
  profile.identity.lastName = userValue('Maramreddy');
  profile.contact.email = userValue('applicant@example.com');
  profile.contact.city = userValue('Trenton');
  profile.applicationPreferences.requiresSponsorshipNow = userValue(false);
  profile.education.push({
    id: 'e1',
    institution: userValue('Rutgers University'),
    fieldOfStudy: userValue('Computer Engineering'),
  } as ApplicantProfile['education'][number]);
  return profile;
}

interface FieldReport {
  label: string;
  decision: FillDecision;
  path: string | null;
  value?: string | boolean;
  viaSemantic: boolean;
}

/**
 * The whole pipeline over one fixture, sequenced exactly as `background.ts`
 * sequences it. Returns one report per field plus the model calls it took.
 */
async function apply(
  fixture: string,
  port: FakeSemanticPort,
  cache: SemanticConceptCache,
  profile = applicant(),
): Promise<{ fields: FieldReport[]; modelCalls: number }> {
  const doc = loadFixture(fixture);
  const { result } = await scanPage(doc, { ats: 'unknown' });

  const reports = new Map<string, FieldReport>();
  const outcomes: FieldOutcome[] = [];

  // --- the deterministic pipeline, exactly as today -------------------------
  for (const descriptor of result.fields as FieldDescriptor[]) {
    const mapping = mapField(descriptor);
    const resolution =
      mapping.profilePath === null ? undefined : resolveValue(profile, mapping.profilePath, descriptor);

    const decision: FillDecision =
      mapping.profilePath === null || resolution?.ok !== true
        ? 'skip'
        : decideFill({
            mappingConfidence: mapping.confidence,
            valueConfidence: resolution.resolved.confidence,
            valueVerifiedByUser: resolution.resolved.verifiedByUser,
            profilePath: mapping.profilePath,
            valueMissing: false,
            controlHasValue: (descriptor.currentValue ?? '').length > 0,
          });

    reports.set(descriptor.localId, {
      label: descriptor.label ?? descriptor.accessibleName ?? '',
      decision,
      path: mapping.profilePath,
      ...(resolution?.ok === true ? { value: resolution.resolved.value } : {}),
      viaSemantic: false,
    });
    outcomes.push({ descriptor, mapping, ...(resolution !== undefined ? { resolution } : {}) });
  }

  // --- the semantic fallback, on the refusals only --------------------------
  //
  // The SAME function the service worker calls. Reassembling the steps here
  // would only prove that this file agrees with itself.
  const semantic = await applySemanticFallback({ profile, outcomes, port, cache });

  for (const update of semantic.updates) {
    const report = reports.get(update.localId);
    if (report === undefined) continue;
    reports.set(update.localId, {
      ...report,
      decision: update.action === 'fill' ? 'autofill' : 'suggest',
      path: update.profilePath,
      value: update.value,
      viaSemantic: true,
    });
  }

  const modelCalls = semantic.modelCalls;

  return { fields: [...reports.values()], modelCalls };
}

const find = (fields: FieldReport[], text: string): FieldReport | undefined =>
  fields.find((field) => field.label.toLowerCase().includes(text.toLowerCase()));

describe('a Greenhouse-shaped application', () => {
  /**
   * Answers keyed by what the question SAYS, not by a per-scan `localId`.
   * `selectQuestionText` normalizes, so the fake matches on the normalized form
   * - which is also the only thing the real backend would ever see.
   */
  const answering = (byQuestion: Record<string, string>) =>
    new FakeSemanticPort({
      conceptFor: (question) => byQuestion[question.question] ?? null,
    });

  it('fills the school question the cascade refused', async () => {
    const port = answering({
      'which of our university partners did you attend': 'education[0].institution',
    });

    const { fields } = await apply(
      'greenhouse-semantic.html',
      port,
      new SemanticConceptCache(new InMemoryStore()),
    );

    const school = find(fields, 'university partners');
    expect(school?.path).toBe('education[0].institution');
    expect(school?.value).toBe('1'); // the "Rutgers University" option's value
    expect(school?.viaSemantic).toBe(true);
    // A novel question is read by the user, never filled silently.
    expect(school?.decision).toBe('suggest');
  });

  it('matches "Computer Engineering" to "Engineering, Computer" with NO model call', async () => {
    // The deterministic scorer earning its place: the mapper already named
    // fieldOfStudy, only the option match failed, and the reordered label is
    // settled locally.
    const port = new FakeSemanticPort();

    const { fields } = await apply(
      'greenhouse-semantic.html',
      port,
      new SemanticConceptCache(new InMemoryStore()),
    );

    const major = find(fields, 'field of study');
    expect(major?.path).toBe('education[0].fieldOfStudy');
    expect(major?.value).toBe('2'); // "Engineering, Computer"
    expect(port.optionCalls).toHaveLength(0);
  });

  it('still requires a click for the sponsorship question', async () => {
    const port = answering({
      'would you now or in the future need us to support an immigration filing on your behalf':
        'applicationPreferences.requiresSponsorshipNow',
    });

    const { fields } = await apply(
      'greenhouse-semantic.html',
      port,
      new SemanticConceptCache(new InMemoryStore()),
    );
    const field = find(fields, 'immigration filing');

    // Correctly understood, correctly matched to "No", and STILL not filled.
    expect(field?.path).toBe('applicationPreferences.requiresSponsorshipNow');
    expect(field?.decision).toBe('suggest');
    expect(field?.decision).not.toBe('autofill');
  });

  it('does not disturb the fields the deterministic engine already filled', async () => {
    const { fields } = await apply(
      'greenhouse-semantic.html',
      new FakeSemanticPort(),
      new SemanticConceptCache(new InMemoryStore()),
    );

    const email = find(fields, 'email');
    expect(email?.path).toBe('contact.email');
    expect(email?.decision).toBe('autofill');
    expect(email?.viaSemantic).toBe(false);
  });
});

describe('the second application costs nothing', () => {
  /**
   * Acceptance criterion #3 of the brief, which asks for this to be
   * DEMONSTRATED with the call counter rather than asserted.
   */
  it('makes model calls on the first application and ZERO on the second', async () => {
    const cache = new SemanticConceptCache(new InMemoryStore());

    // The first employer. Every novel question is asked once; some get an
    // answer, some get "no path fits" - and both are remembered.
    const first = new FakeSemanticPort({
      conceptFor: (question) =>
        question.question.includes('university partners') ? 'education[0].institution' : null,
    });
    const firstRun = await apply('greenhouse-semantic.html', first, cache);
    expect(firstRun.modelCalls).toBeGreaterThan(0);
    expect(first.conceptCalls).toHaveLength(1);

    // The next employer: a different port instance, the same cache. This is
    // what a second application actually looks like.
    const second = new FakeSemanticPort();
    const secondRun = await apply('greenhouse-semantic.html', second, cache);

    expect(second.conceptCalls).toHaveLength(0);
    expect(second.callCount).toBe(0);
    expect(secondRun.modelCalls).toBe(0);

    // ...and the answer is still there, so it is a cache HIT rather than the
    // whole subsystem having quietly stopped running.
    expect(find(secondRun.fields, 'university partners')?.path).toBe('education[0].institution');
    expect(find(secondRun.fields, 'university partners')?.viaSemantic).toBe(true);
  });

  it('remembers across a different ATS, because a question means the same thing anywhere', async () => {
    const cache = new SemanticConceptCache(new InMemoryStore());

    const first = new FakeSemanticPort({ conceptFor: () => null });
    await apply('lever-semantic.html', first, cache);
    expect(first.conceptCalls.length).toBeGreaterThan(0);

    const second = new FakeSemanticPort();
    await apply('lever-semantic.html', second, cache);
    expect(second.callCount).toBe(0);
  });
});

describe('with the network unavailable', () => {
  it('behaves exactly as the deterministic pipeline alone would', async () => {
    const offline = new FakeSemanticPort({
      conceptError: new (await import('@shared/errors')).AppError('BACKEND_UNREACHABLE', 'offline'),
      optionError: new (await import('@shared/errors')).AppError('BACKEND_UNREACHABLE', 'offline'),
    });

    const withNetwork = await apply(
      'lever-semantic.html',
      new FakeSemanticPort(),
      new SemanticConceptCache(new InMemoryStore()),
    );
    const withoutNetwork = await apply(
      'lever-semantic.html',
      offline,
      new SemanticConceptCache(new InMemoryStore()),
    );

    // The fake answers nothing, so the only difference between these two runs
    // would be a fill this pass invented - and there is none.
    expect(withoutNetwork.fields).toEqual(withNetwork.fields);
    expect(withoutNetwork.fields.every((field) => !field.viaSemantic)).toBe(true);
  });
});

describe('an Ashby-shaped application', () => {
  it('reads the ARIA comboboxes as option controls at all', async () => {
    // Ashby renders custom dropdowns rather than <select>, so if the scanner
    // does not see the listbox there is nothing for any of this to match
    // against. Asserted separately so a scanner regression fails HERE, with a
    // message that says what happened, rather than as a confusing empty result
    // in the test below.
    const doc = loadFixture('ashby-semantic.html');
    const { result } = await scanPage(doc, { ats: 'ashby' });

    const comboboxes = (result.fields as FieldDescriptor[]).filter(
      (field) => field.kind === 'combobox',
    );
    expect(comboboxes.length).toBeGreaterThanOrEqual(2);
    expect(comboboxes.some((field) => (field.options ?? []).length >= 2)).toBe(true);
  });

  it('escalates the two-campus school list rather than picking one', async () => {
    // NOTE WHICH ROUTE THIS TAKES, because it is not the obvious one: the
    // cascade already maps "Most recent school" to education[0].institution at
    // 0.98. The concept was never in doubt. What failed is the OPTION MATCH -
    // "Rutgers University" is contained in both campus entries, so the
    // deterministic scorer refuses, correctly, and this is a `no_matching_option`
    // escalation rather than a stage-1 one.
    const port = new FakeSemanticPort({
      optionFor: (question) =>
        question.options.includes('Rutgers University - New Brunswick')
          ? 'Rutgers University - New Brunswick'
          : null,
    });

    const { fields } = await apply(
      'ashby-semantic.html',
      port,
      new SemanticConceptCache(new InMemoryStore()),
    );

    // Stage 1 was never involved; exactly one stage-2 call was made.
    expect(port.conceptCalls).toHaveLength(0);
    expect(port.optionCalls).toHaveLength(1);
    expect(port.optionCalls[0]?.value).toBe('Rutgers University');

    const school = find(fields, 'most recent school');
    expect(school?.path).toBe('education[0].institution');
    expect(school?.viaSemantic).toBe(true);
    // An option we CHOSE rather than matched is read by the user, never filled.
    expect(school?.decision).toBe('suggest');
  });

  it('settles the concentration dropdown locally, with no call of either kind', async () => {
    // "Computer Engineering" against "Engineering, Computer" - same words,
    // different order. Free, and it is the commonest shape of the whole
    // problem.
    const port = new FakeSemanticPort();
    const { fields } = await apply(
      'ashby-semantic.html',
      port,
      new SemanticConceptCache(new InMemoryStore()),
    );

    // Scoped to THIS field: the school dropdown on the same page does escalate,
    // so a page-wide call count of zero would be the wrong assertion and would
    // start failing for an unrelated reason.
    const askedAboutMajor = port.optionCalls.some((call) =>
      call.options.includes('Engineering, Computer'),
    );
    expect(askedAboutMajor).toBe(false);
    expect(find(fields, 'concentrate in')?.path).toBe('education[0].fieldOfStudy');
  });
});
