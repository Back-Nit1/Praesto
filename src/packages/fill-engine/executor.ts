/**
 * Fill executor - running fill instructions against the live page.
 * ---------------------------------------------------------------------------
 * Takes the actions the service worker computed and applies the ones marked
 * `fill`. Everything else is left alone, by design: `suggest` and `skip` exist
 * so the user can decide, and acting on them here would silently defeat the
 * entire confidence architecture.
 *
 * THE VERIFY STEP IS THE POINT OF THIS MODULE
 * Every fill is followed by a read-back, and the read-back is what gets
 * reported. A "filled" count that includes writes the page discarded is worse
 * than useless - it teaches the user the extension is reliable when it is not,
 * which is precisely the trust failure the product is built to avoid.
 *
 * NEVER SUBMITS
 * Spec section 21.4: no form submission, ever, without a deliberate user
 * action. There is no code path in this file that clicks a submit button, and
 * there must not be one added.
 */
import { createLogger } from '@shared/logging';
import { getRuntimeBudget } from '@shared/runtime-budget';
import type { ResolvedFieldAction } from '@shared/messages';
import { NATIVE_ADAPTERS } from './adapters/native-adapters';
import type { ControlAdapter, ControlContext, FillFailureReason } from './types';

const log = createLogger('fill:executor');

/** Outcome for one field, as reported back to the service worker. */
export interface FieldFillOutcome {
  localId: string;
  profilePath: string | null;
  attempted: boolean;
  /** True ONLY when a read-back confirmed the value landed. */
  verified: boolean;
  adapter?: string;
  failureReason?: FillFailureReason;
}

export interface ExecuteFillOptions {
  /** Resolve a localId to its live element. Supplied by the content script. */
  resolveElement: (localId: string) => HTMLElement | null;
  /** Adapter registry. Injectable so an ATS adapter set can be prepended. */
  adapters?: readonly ControlAdapter[];
}

/**
 * Apply every `fill` action.
 *
 * Sequential, not parallel. Filling one field frequently causes a form to
 * re-render or reveal another; running concurrently would race those updates
 * and produce failures that cannot be reproduced. Forms have tens of fields,
 * not thousands, so the sequential cost is imperceptible and the determinism is
 * worth far more.
 */
export async function executeFills(
  actions: readonly ResolvedFieldAction[],
  options: ExecuteFillOptions,
): Promise<FieldFillOutcome[]> {
  const adapters = options.adapters ?? NATIVE_ADAPTERS;
  const budget = getRuntimeBudget();
  const outcomes: FieldFillOutcome[] = [];

  let processed = 0;

  for (const action of actions) {
    // Only `fill`. `suggest` is the user's call and `skip` means we decided not
    // to act - honouring that here is what makes the policy meaningful.
    if (action.action !== 'fill' || action.value === undefined) {
      outcomes.push({
        localId: action.localId,
        profilePath: action.profilePath,
        attempted: false,
        verified: false,
      });
      continue;
    }

    outcomes.push(await fillOne(action, adapters, options.resolveElement));

    // Yield periodically so a long fill run does not block the page. The user
    // is watching this happen, and a frozen tab mid-fill looks like a crash.
    processed++;
    if (processed % budget.scanChunkSize === 0) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }

  return outcomes;
}

/** One field: find it, pick an adapter, fill, verify. */
async function fillOne(
  action: ResolvedFieldAction,
  adapters: readonly ControlAdapter[],
  resolveElement: ExecuteFillOptions['resolveElement'],
): Promise<FieldFillOutcome> {
  const base = { localId: action.localId, profilePath: action.profilePath };

  const element = resolveElement(action.localId);
  if (element === null) {
    // The page re-rendered between the scan and the fill. Expected on dynamic
    // forms; the MutationObserver rescan will pick the field up again.
    return { ...base, attempted: false, verified: false, failureReason: 'element_gone' };
  }

  const context: ControlContext = {
    element,
    kind: action.knowledgeState,
    ...(action.optionValue !== undefined ? { optionValue: action.optionValue } : {}),
  };

  const adapter = adapters.find((candidate) => candidate.canHandle(context));
  if (adapter === undefined) {
    return { ...base, attempted: false, verified: false, failureReason: 'no_adapter' };
  }

  // An adapter is not supposed to throw, but it runs against a page we do not
  // control. A defensive catch here is what keeps one hostile control from
  // aborting the rest of the fill run.
  let filled;
  try {
    filled = await adapter.fill(context, action.value as string | boolean);
  } catch (error) {
    log.warn('Adapter threw during fill', adapter.name, error);
    return {
      ...base,
      attempted: true,
      verified: false,
      adapter: adapter.name,
      failureReason: 'rejected',
    };
  }

  if (!filled.ok) {
    return {
      ...base,
      attempted: true,
      verified: false,
      adapter: adapter.name,
      failureReason: filled.reason,
    };
  }

  // THE READ-BACK. Nothing is reported as filled until this passes.
  const verified = await adapter.verify(context, action.value as string | boolean).catch(() => false);

  return {
    ...base,
    attempted: true,
    verified,
    adapter: adapter.name,
    ...(verified ? {} : { failureReason: 'verification_failed' as const }),
  };
}
