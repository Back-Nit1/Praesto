/**
 * ATS detection tests.
 *
 * The spoofing case is the important one. Misidentifying a page applies another
 * platform's quirk rules to controls they were not written for, which is
 * strictly worse than the `unknown` path - `unknown` uses the generic engine
 * and works fine.
 */
import { describe, expect, it } from 'vitest';
import { atsDisplayName, detectATSFromUrl } from '@ats/detector';

const context = (hostname: string, url = `https://${hostname}/apply`) => ({ hostname, url });

describe('detectATSFromUrl', () => {
  it('recognises the hosted boards', () => {
    expect(detectATSFromUrl(context('boards.greenhouse.io'))).toBe('greenhouse');
    expect(detectATSFromUrl(context('jobs.lever.co'))).toBe('lever');
    expect(detectATSFromUrl(context('acme.wd1.myworkdayjobs.com'))).toBe('workday');
    expect(detectATSFromUrl(context('jobs.ashbyhq.com'))).toBe('ashby');
    expect(detectATSFromUrl(context('careers.smartrecruiters.com'))).toBe('smartrecruiters');
  });

  it('matches on a domain suffix boundary, never a substring', () => {
    // A page that could talk us into believing it is Greenhouse would get
    // Greenhouse's control handling applied to its inputs.
    expect(detectATSFromUrl(context('greenhouse.io.evil.example'))).toBe('unknown');
    expect(detectATSFromUrl(context('notgreenhouse.io'))).toBe('unknown');
    expect(detectATSFromUrl(context('lever.co.attacker.test'))).toBe('unknown');
  });

  it('recognises an embedded board by its path', () => {
    expect(
      detectATSFromUrl({
        hostname: 'careers.acme.example',
        url: 'https://careers.acme.example/embed/job_app?token=1',
      }),
    ).toBe('greenhouse');
  });

  it('returns unknown for an ordinary careers page', () => {
    // Not a failure. The generic engine is designed to work without knowing the
    // platform, so admitting ignorance costs nothing.
    expect(detectATSFromUrl(context('careers.acme.example'))).toBe('unknown');
  });
});

describe('atsDisplayName', () => {
  it('calls the unknown case "Generic" rather than showing an error-ish word', () => {
    expect(atsDisplayName('unknown')).toBe('Generic');
    expect(atsDisplayName('greenhouse')).toBe('Greenhouse');
  });
});
