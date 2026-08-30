/**
 * Runtime budget - adapting the extension to the machine it is actually on.
 * ---------------------------------------------------------------------------
 * WHY THIS MODULE EXISTS
 *
 * This extension is meant to be installed by anyone, not just by the developer.
 * "Anyone" includes a 4 GB Chromebook a student is applying for internships on,
 * a shared library machine, and a corporate laptop with 40 tabs already open.
 *
 * Three of our subsystems have costs that scale badly if left unbounded:
 *
 *   1. DOM SCANNING. A Workday-style application can have several hundred
 *      controls. Building a descriptor for each one (which walks the DOM
 *      upward for labels and section headings) on the page's main thread will
 *      visibly jank a low-end machine and can trip Chrome's slow-script UI.
 *
 *   2. MUTATION OBSERVATION. Rich application forms mutate constantly. A
 *      naive observer that rescans on every mutation turns into a busy loop.
 *
 *   3. PDF PARSING (Phase 2). PDF.js holds a rendered page in memory. Parsing
 *      several pages concurrently multiplies peak RSS, and on a memory-
 *      constrained device that is the difference between "works" and "Chrome
 *      killed the tab".
 *
 * Rather than hard-coding constants tuned on a developer's 64 GB workstation,
 * every one of those limits is derived here from what the browser tells us
 * about the host machine. The rest of the codebase imports the budget instead
 * of inventing its own magic numbers - so a performance regression on low-end
 * hardware is fixed in ONE place.
 *
 * DEGRADATION IS ALWAYS SAFE
 * A smaller budget must only ever mean "slower / fewer fields per batch", never
 * "wrong answer". No mapping or confidence decision reads the budget.
 */

/**
 * Device capability tier. Deliberately coarse - three tiers are enough to make
 * the right order-of-magnitude decisions, and more tiers would be untestable.
 */
export type DeviceTier = 'low' | 'standard' | 'high';

export interface RuntimeBudget {
  readonly tier: DeviceTier;

  /** Approximate device RAM in GB, as reported by the browser. */
  readonly deviceMemoryGb: number;
  /** Logical CPU cores. */
  readonly cores: number;

  /**
   * Controls processed per synchronous chunk during a page scan. After each
   * chunk the scanner yields to the event loop so the host page stays
   * responsive. Smaller chunk = smoother page, slightly longer total scan.
   */
  readonly scanChunkSize: number;

  /**
   * Hard ceiling on controls examined in a single scan. Beyond this we stop and
   * report a truncated scan rather than freezing the tab. A real application
   * form has well under 300 fields; anything larger is a page we should not be
   * trying to process wholesale anyway.
   */
  readonly maxFieldsPerScan: number;

  /**
   * Debounce window (ms) for the MutationObserver that watches for
   * conditionally-revealed questions (spec section 16). Long enough that a
   * burst of framework re-renders collapses into one rescan.
   */
  readonly mutationDebounceMs: number;

  /**
   * Max characters of surrounding text harvested per field when building the
   * descriptor's `nearbyText`. Unbounded text harvesting is both a memory cost
   * and a privacy cost (we would be copying unrelated page content into
   * extension memory).
   */
  readonly maxNearbyTextChars: number;

  /**
   * Resume pages parsed concurrently by PDF.js (Phase 2). On a low-memory
   * device this drops to 1 so peak memory stays near a single page.
   */
  readonly pdfPageConcurrency: number;

  /**
   * How many resolved-value entries the content script may hold in memory at
   * once. Bounds the blast radius of the data-minimisation rule in spec 21.1:
   * even transiently, the page context never holds the whole profile.
   */
  readonly maxResolvedValuesInMemory: number;

  /**
   * Number of audit records kept in the in-memory ring buffer before they are
   * flushed to IndexedDB. Larger batches mean fewer writes (good for disk and
   * battery), smaller batches mean less loss if the service worker is evicted.
   */
  readonly auditFlushBatchSize: number;
}

/**
 * Read what the browser will tell us about the machine.
 *
 * `navigator.deviceMemory` is a Chromium-only hint, rounded down to a power of
 * two and capped at 8 for fingerprinting resistance - so 8 means "8 or more".
 * It is absent in workers on some versions and in non-Chromium browsers, hence
 * the guarded read and the conservative default.
 */
function probeDevice(): { deviceMemoryGb: number; cores: number } {
  // `navigator` is undefined in a plain Node test process, and deviceMemory is
  // not in the standard lib types, so both reads are defensive.
  const nav: Navigator | undefined = typeof navigator === 'undefined' ? undefined : navigator;

  const reportedMemory = (nav as (Navigator & { deviceMemory?: number }) | undefined)?.deviceMemory;
  const reportedCores = nav?.hardwareConcurrency;

  return {
    // Default of 4 GB when unknown: assuming a *small* machine is the safe
    // error. Over-budgeting an unknown device is how extensions get uninstalled.
    deviceMemoryGb: typeof reportedMemory === 'number' && reportedMemory > 0 ? reportedMemory : 4,
    cores: typeof reportedCores === 'number' && reportedCores > 0 ? reportedCores : 4,
  };
}

/** Classify a machine into a tier. Exported for direct unit testing. */
export function classifyDevice(deviceMemoryGb: number, cores: number): DeviceTier {
  // Memory is weighted more heavily than cores: our costs are dominated by
  // retained DOM descriptors and PDF page buffers, not by raw compute.
  if (deviceMemoryGb <= 2 || cores <= 2) return 'low';
  if (deviceMemoryGb >= 8 && cores >= 8) return 'high';
  return 'standard';
}

/**
 * Per-tier tuning table.
 *
 * Kept as one literal so the whole performance posture of the extension is
 * legible at a glance and reviewable in a diff, rather than scattered across
 * the modules that consume it.
 */
const TIER_BUDGETS: Record<DeviceTier, Omit<RuntimeBudget, 'tier' | 'deviceMemoryGb' | 'cores'>> = {
  low: {
    scanChunkSize: 15,
    maxFieldsPerScan: 200,
    mutationDebounceMs: 500,
    maxNearbyTextChars: 180,
    pdfPageConcurrency: 1,
    maxResolvedValuesInMemory: 40,
    auditFlushBatchSize: 10,
  },
  standard: {
    scanChunkSize: 40,
    maxFieldsPerScan: 350,
    mutationDebounceMs: 300,
    maxNearbyTextChars: 300,
    pdfPageConcurrency: 2,
    maxResolvedValuesInMemory: 100,
    auditFlushBatchSize: 25,
  },
  high: {
    scanChunkSize: 80,
    maxFieldsPerScan: 500,
    mutationDebounceMs: 200,
    maxNearbyTextChars: 400,
    pdfPageConcurrency: 4,
    maxResolvedValuesInMemory: 200,
    auditFlushBatchSize: 50,
  },
};

/** Build a budget from explicit numbers. Pure - the unit-testable core. */
export function budgetFor(deviceMemoryGb: number, cores: number): RuntimeBudget {
  const tier = classifyDevice(deviceMemoryGb, cores);
  return { tier, deviceMemoryGb, cores, ...TIER_BUDGETS[tier] };
}

/**
 * Cached budget for the current context.
 *
 * Cached because probing is cheap but the value is read inside hot loops, and
 * because a stable budget within one page session avoids the scanner changing
 * its chunk size mid-scan. Note this is per-context: the service worker, each
 * content script, and each extension page each compute their own. That is
 * correct - it is derived state, never persisted, so MV3 service-worker
 * eviction cannot corrupt it (spec section 10.2).
 */
let cached: RuntimeBudget | undefined;

export function getRuntimeBudget(): RuntimeBudget {
  if (cached === undefined) {
    const { deviceMemoryGb, cores } = probeDevice();
    cached = budgetFor(deviceMemoryGb, cores);
  }
  return cached;
}

/** Test seam: force a budget, or pass nothing to clear the cache. */
export function __setRuntimeBudgetForTesting(budget?: RuntimeBudget): void {
  cached = budget;
}
