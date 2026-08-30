/**
 * Runtime budget tests.
 *
 * The budget decides how hard the extension works on a given machine. These
 * tests assert the two properties that matter:
 *
 *   1. a weaker machine gets a smaller budget in every dimension,
 *   2. an UNKNOWN machine is treated as a weak one.
 *
 * Property 2 is the one worth defending. Over-budgeting a machine we cannot
 * measure is how an extension gets uninstalled - the user does not file a bug
 * about a janky form, they just remove the thing that made it janky.
 */
import { describe, expect, it } from 'vitest';
import {
  budgetFor,
  classifyDevice,
  getRuntimeBudget,
  __setRuntimeBudgetForTesting,
} from '@shared/runtime-budget';

describe('classifyDevice', () => {
  it('treats a low-memory or low-core machine as low tier', () => {
    expect(classifyDevice(2, 8)).toBe('low');
    expect(classifyDevice(16, 2)).toBe('low');
  });

  it('requires both memory and cores to reach the high tier', () => {
    expect(classifyDevice(8, 8)).toBe('high');
    expect(classifyDevice(8, 4)).toBe('standard');
    expect(classifyDevice(4, 16)).toBe('standard');
  });
});

describe('budgetFor', () => {
  it('scales every cost dimension monotonically with the tier', () => {
    const low = budgetFor(2, 2);
    const standard = budgetFor(4, 4);
    const high = budgetFor(8, 8);

    // Work per synchronous chunk grows with capability...
    expect(low.scanChunkSize).toBeLessThan(standard.scanChunkSize);
    expect(standard.scanChunkSize).toBeLessThan(high.scanChunkSize);

    expect(low.maxFieldsPerScan).toBeLessThan(high.maxFieldsPerScan);
    expect(low.pdfPageConcurrency).toBeLessThan(high.pdfPageConcurrency);
    expect(low.maxResolvedValuesInMemory).toBeLessThan(high.maxResolvedValuesInMemory);

    // ...and the debounce goes the other way: a weaker machine waits LONGER
    // between rescans so it does less work, not more.
    expect(low.mutationDebounceMs).toBeGreaterThan(high.mutationDebounceMs);
  });

  it('keeps a low-memory device to one PDF page at a time', () => {
    // Peak memory during resume parsing is roughly page size times concurrency.
    // On a 2 GB device that product is the difference between working and
    // having the tab killed.
    expect(budgetFor(2, 2).pdfPageConcurrency).toBe(1);
  });
});

describe('getRuntimeBudget', () => {
  it('assumes a modest machine when the browser will not say', () => {
    // `navigator` is absent in this Node process, exactly as it can be in a
    // service worker on some Chrome versions. The safe default is a SMALL
    // machine, never a large one.
    __setRuntimeBudgetForTesting(undefined);
    const budget = getRuntimeBudget();
    expect(budget.deviceMemoryGb).toBe(4);
    expect(budget.tier).toBe('standard');
  });

  it('caches, so a scan cannot change its chunk size mid-run', () => {
    __setRuntimeBudgetForTesting(undefined);
    expect(getRuntimeBudget()).toBe(getRuntimeBudget());
  });

  it('can be pinned, so tests do not depend on the machine running them', () => {
    const pinned = budgetFor(2, 2);
    __setRuntimeBudgetForTesting(pinned);
    expect(getRuntimeBudget()).toBe(pinned);
    __setRuntimeBudgetForTesting(undefined);
  });
});
