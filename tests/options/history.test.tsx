// @vitest-environment jsdom
/**
 * The application-history screen.
 *
 * What these assertions protect is honesty, not layout: a history that rounds
 * an unverified fill up to a success would recreate the exact failure the side
 * panel was rebuilt to stop, and a history that showed the applicant's answers
 * would break the promise made in audit/types.ts.
 */
import { describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { History } from '@/entrypoints/options/History';
import { AuditRepository, InMemoryAuditCollection } from '@audit/repository';
import type { FillAuditRecord } from '@audit/types';

function row(overrides: Partial<FillAuditRecord> & { id: string; runId: string }): FillAuditRecord {
  return {
    timestamp: new Date().toISOString(),
    pageUrl: 'https://boards.greenhouse.io/acme/jobs/1',
    hostname: 'boards.greenhouse.io',
    ats: 'greenhouse',
    fieldFingerprint: 'fp',
    mappingConfidence: 0.97,
    mappingSource: 'alias',
    decidedAction: 'fill',
    fillAttempted: true,
    fillVerified: true,
    userCorrected: false,
    ...overrides,
  };
}

async function renderWith(records: FillAuditRecord[]): Promise<AuditRepository> {
  cleanup();
  const repository = new AuditRepository(new InMemoryAuditCollection());
  await repository.record(records);
  render(<History repository={repository} />);
  return repository;
}

describe('application history', () => {
  it('invites a first-time user rather than showing an empty table', async () => {
    await renderWith([]);

    await screen.findByText(/no applications yet/i);
  });

  it('lists an application by employer with what happened to it', async () => {
    await renderWith([
      row({ id: 'r:1', runId: 'r', detectedLabel: 'email address', mappedProfilePath: 'identity.email' }),
      row({ id: 'r:2', runId: 'r', fillVerified: false, failureReason: 'READBACK_MISMATCH' }),
      row({ id: 'r:3', runId: 'r', fillAttempted: false, fillVerified: false, decidedAction: 'skip' }),
    ]);

    await screen.findByText('boards.greenhouse.io');
    expect(screen.getByText('filled')).toBeTruthy();
    expect(screen.getByText('failed')).toBeTruthy();
    expect(screen.getByText('left blank')).toBeTruthy();
  });

  it('never rounds an unverified fill up to a success', async () => {
    await renderWith([
      row({
        id: 'r:1',
        runId: 'r',
        detectedLabel: 'preferred start date',
        fillVerified: false,
        failureReason: 'READBACK_MISMATCH',
      }),
    ]);

    fireEvent.click(await screen.findByRole('button', { expanded: false }));

    await screen.findByText('preferred start date');
    expect(screen.getByText('READBACK_MISMATCH')).toBeTruthy();
    expect(screen.queryByText('Filled')).toBeNull();
  });

  it('shows the question a form asked and never an applicant value', async () => {
    await renderWith([
      row({ id: 'r:1', runId: 'r', detectedLabel: 'email address', mappedProfilePath: 'identity.email' }),
    ]);

    fireEvent.click(await screen.findByRole('button', { expanded: false }));

    await screen.findByText('email address');
    // The record type has no field that could hold one, so there is nothing to
    // render - this asserts the screen did not go looking for one elsewhere.
    expect(document.body.textContent).not.toMatch(/@/);
  });

  it('requires a second click before deleting everything', async () => {
    const repository = await renderWith([row({ id: 'r:1', runId: 'r' })]);

    fireEvent.click(await screen.findByRole('button', { name: /clear history/i }));
    // Nothing is gone yet - the first click only asks.
    expect((await repository.recentRuns()).ok).toBe(true);
    expect(((await repository.recentRuns()) as { value: unknown[] }).value).toHaveLength(1);

    fireEvent.click(screen.getByRole('button', { name: /delete all history/i }));

    await waitFor(async () => {
      const runs = await repository.recentRuns();
      expect(runs.ok && runs.value).toHaveLength(0);
    });
    await screen.findByText(/no applications yet/i);
  });

  it('lets the user back out of clearing', async () => {
    const repository = await renderWith([row({ id: 'r:1', runId: 'r' })]);

    fireEvent.click(await screen.findByRole('button', { name: /clear history/i }));
    fireEvent.click(screen.getByRole('button', { name: /keep it/i }));

    const runs = await repository.recentRuns();
    expect(runs.ok && runs.value).toHaveLength(1);
    expect(screen.getByRole('button', { name: /clear history/i })).toBeTruthy();
  });
});
