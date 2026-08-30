/**
 * ATS identity types.
 * ---------------------------------------------------------------------------
 * Kept in its own dependency-free module because almost everything imports
 * `ATSKind` - the descriptor, the mapper, the learning store, the audit record.
 * If it lived alongside the detector (which needs DOM types) every one of those
 * modules would drag a DOM dependency into a context that does not have one.
 *
 * Spec section 18: there is ONE generic engine. ATS identity is a *hint* that
 * narrows and specialises it, never a parallel implementation.
 */

/**
 * Applicant Tracking Systems we can recognise.
 *
 * `unknown` is the expected default, not a failure. The generic engine is
 * designed to work without knowing the ATS; recognising one only unlocks
 * optional refinements.
 */
export type ATSKind =
  | 'greenhouse'
  | 'lever'
  | 'workday'
  | 'ashby'
  | 'smartrecruiters'
  | 'unknown';

/** What the detector and the mapper know about the page being filled. */
export interface PageContext {
  url: string;
  hostname: string;
  /** Document title, occasionally the only ATS signal on an embedded form. */
  title?: string;
}
