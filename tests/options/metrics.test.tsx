// @vitest-environment jsdom
/**
 * The metrics screen, which is the one surface where a wrong number would make
 * every refusal elsewhere in the product a lie.
 *
 * These assertions are about honesty rather than layout: what the screen is
 * forbidden from printing matters more than what it prints.
 */
import { describe, expect, it } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { Metrics } from '@/entrypoints/options/Metrics';
import { AuditRepository, InMemoryAuditCollection } from '@audit/repository';
import { MIN_REVIEWED_FOR_A_NUMBER } from '@audit/metrics';
import type { FillAuditRecord } from '@audit/types';

function row(overrides: Partial<FillAuditRecord> & { id: string; runId: string }): FillAuditRecord {
  return {
    timestamp: new Date().toISOString(),
    pageUrl: 'https://boards.greenhouse.io/acme/jobs/1',
    hostname: 'boards.greenhouse.io',
    ats: 'greenhouse',
    fieldFingerprint: 'fp',
    mappedProfilePath: 'contact.email',
    mappingConfidence: 0.9,
    mappingSource: 'alias',
    decidedAction: 'fill',
    fillAttempted: true,
    fillVerified: true,
    outcome: 'unreviewed',
    ...overrides,
  };
}

async function renderWith(records: FillAuditRecord[]): Promise<void> {
  cleanup();
  const repository = new AuditRepository(new InMemoryAuditCollection());
  await repository.record(records);
  render(<Metrics repository={repository} />);
}

/** The card for one named rate, so an assertion cannot drift onto another. */
function card(label: string): HTMLElement {
  const heading = screen.getByText(label);
  const section = heading.closest('section');
  if (section === null) throw new Error(`No card rendered for ${label}`);
  return section;
}

describe('Metrics', () => {
  it('says "not enough evidence" rather than 0% when nobody has reviewed anything', async () => {
    await renderWith(
      Array.from({ length: 100 }, (_, index) => row({ id: `r1:${index}`, runId: 'r1' })),
    );

    await waitFor(() => expect(screen.getByText('Incorrect-fill rate')).toBeTruthy());

    // A hundred uncorrected fills is not a 0% error rate. It is no data, and
    // the screen has to say so in words rather than print a figure.
    const incorrectFill = card('Incorrect-fill rate');
    expect(within(incorrectFill).getByText('not enough evidence')).toBeTruthy();
    expect(within(incorrectFill).queryByText(/%/)).toBeNull();
    expect(within(incorrectFill).getByText(/0 of 0 reviewed · 100 unreviewed/)).toBeTruthy();
  });

  it('shows the unreviewed count beside a rate, never only the percentage', async () => {
    const reviewed = Array.from({ length: MIN_REVIEWED_FOR_A_NUMBER }, (_, index) =>
      row({
        id: `r1:reviewed-${index}`,
        runId: 'r1',
        fieldFingerprint: `fp-${index}`,
        outcome: index < 2 ? 'corrected_wrong_fill' : 'accepted_suggestion',
        decidedAction: index < 2 ? 'fill' : 'suggest',
      }),
    );
    const silent = Array.from({ length: 30 }, (_, index) =>
      row({ id: `r1:silent-${index}`, runId: 'r1', fieldFingerprint: `fps-${index}` }),
    );

    await renderWith([...reviewed, ...silent]);

    await waitFor(() => expect(screen.getByText('Incorrect-fill rate')).toBeTruthy());

    const incorrectFill = card('Incorrect-fill rate');
    // A floor, not an estimate: the 30 unreviewed rows can only push it up.
    expect(within(incorrectFill).getByText('≥ 10.0%')).toBeTruthy();
    expect(within(incorrectFill).getByText(/2 of 20 reviewed · 30 unreviewed/)).toBeTruthy();
  });

  it('drops the lower-bound marker on a rate where every row was observed', async () => {
    // Unknown-field rate is decided at scan time for every row - nobody has to
    // review anything - so it is reported as the figure it is.
    await renderWith(
      Array.from({ length: 40 }, (_, index) =>
        row({ id: `r1:${index}`, runId: 'r1', fieldFingerprint: `fp-${index}` }),
      ),
    );

    await waitFor(() => expect(screen.getByText('Unknown-field rate')).toBeTruthy());
    expect(within(card('Unknown-field rate')).getByText('0.0%')).toBeTruthy();
  });

  it('offers nothing to measure rather than a screen of zeroes on a fresh install', async () => {
    await renderWith([]);

    await waitFor(() => expect(screen.getByText(/Nothing to measure yet/)).toBeTruthy());
  });
});
