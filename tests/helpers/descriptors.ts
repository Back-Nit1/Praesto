/**
 * Test helper: build FieldDescriptors without a browser.
 *
 * This helper is itself an argument for the architecture. Because the mapper
 * consumes descriptors rather than DOM elements, the entire mapping intelligence
 * of the product is testable from plain objects - no jsdom, no fixture page, no
 * async setup. A mapping bug found on a real Greenhouse form becomes a
 * three-line regression test here.
 */
import { computeSemanticFingerprint } from '@form-engine/fingerprints/fingerprint';
import type { ControlKind, FieldDescriptor } from '@form-engine/descriptor/types';

let counter = 0;

/**
 * Build a descriptor with sensible defaults.
 *
 * The fingerprint is computed rather than stubbed, so tests exercise the real
 * fingerprint path - the thing the learning system depends on - instead of a
 * placeholder that could hide a mismatch.
 */
export function descriptor(overrides: Partial<FieldDescriptor> = {}): FieldDescriptor {
  const base: Omit<FieldDescriptor, 'semanticFingerprint'> = {
    localId: `field-${++counter}`,
    tag: 'input',
    kind: 'text' as ControlKind,
    type: 'text',
    required: false,
    disabled: false,
    pageUrl: 'https://boards.example.com/jobs/1/apply',
    hostname: 'boards.example.com',
    ats: 'unknown',
    ...overrides,
  };

  return { ...base, semanticFingerprint: computeSemanticFingerprint(base) };
}

/** Reset the id counter so ids are stable within a test file. */
export function resetDescriptorIds(): void {
  counter = 0;
}
