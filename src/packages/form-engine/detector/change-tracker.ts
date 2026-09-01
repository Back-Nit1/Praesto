/**
 * Which parts of the page changed since the last scan.
 * ---------------------------------------------------------------------------
 * A conditional question ("Do you require sponsorship?" reveals three more
 * fields) should cost a scan of the block it appeared in, not a pass over the
 * whole form (spec section 16). To do that, something has to remember WHERE the
 * page changed - and doing that badly is how a content script comes to hold a
 * growing set of DOM nodes for as long as a tab is open.
 *
 * So the tracking lives here, out of the content script, for two reasons:
 *
 *   - it is the part with rules in it, and rules should be testable without a
 *     browser, an extension host or a MutationObserver;
 *   - its failure mode is a memory leak on a page that re-renders forever,
 *     which is exactly the kind of bug that never shows up in a manual test.
 *
 * THE DESIGN IS "KNOW WHERE, OR ADMIT YOU DO NOT".
 * Past a small number of distinct subtrees the tracker stops tracking and says
 * so, and the caller does a full scan. A full scan is always correct and merely
 * slower; a partial scan built on half-remembered roots would silently miss
 * questions, which is the one outcome this product must not produce.
 */

/**
 * Distinct subtrees worth tracking before a full scan is cheaper anyway.
 *
 * A framework re-rendering a long list produces hundreds of mutation targets.
 * Sixteen is a guess - it has never been measured against a real application
 * form (`gaps.md` section 11) - chosen so that a form revealing a conditional
 * block or three stays on the cheap path.
 */
export const MAX_CHANGED_ROOTS = 16;

export class ChangedSubtrees {
  private readonly roots = new Set<Element>();
  private overflowed = false;

  constructor(private readonly maxRoots: number = MAX_CHANGED_ROOTS) {}

  /**
   * Record a batch of mutations.
   *
   * Returns whether any of them added an ELEMENT. Text changes, attribute
   * flips and spinner updates cannot have introduced a form control, and the
   * caller uses the answer to decide whether the panel is worth notifying at
   * all - so the filter is here rather than duplicated at the call site.
   */
  note(mutations: readonly MutationRecord[]): boolean {
    let addedElements = false;

    for (const mutation of mutations) {
      let addedHere = false;
      for (const node of mutation.addedNodes) {
        if (node.nodeType === Node.ELEMENT_NODE) {
          addedHere = true;
          break;
        }
      }
      if (!addedHere) continue;
      addedElements = true;

      // Once we have given up on tracking WHERE, keep giving up. Continuing to
      // add would hold a growing set of live nodes for a scan already decided
      // to be a full one - on a page that re-renders every second for an hour,
      // that is unbounded retention of subtrees the page itself has discarded.
      if (this.overflowed) continue;

      // The TARGET, not the added node: a control can arrive as the added node
      // itself or as one of its descendants, and the container covers both.
      // Anything that is not an element - a fragment being populated - is an
      // admission of not knowing, not a guess.
      if (mutation.target instanceof Element) this.roots.add(mutation.target);
      else this.overflow();

      if (this.roots.size > this.maxRoots) this.overflow();
    }

    return addedElements;
  }

  /** Is there a known, bounded set of places to look? */
  get trackable(): boolean {
    return this.roots.size > 0 && !this.overflowed;
  }

  /**
   * The subtrees to scan, and forget them.
   *
   * Empty when nothing changed OR when tracking was given up, and the caller
   * cannot tell those apart from the return value alone - deliberately, because
   * the correct response to both is the same: scan everything. `trackable` is
   * the question to ask BEFORE deciding.
   */
  take(): Element[] {
    const roots = this.trackable ? [...this.roots] : [];
    this.reset();
    return roots;
  }

  /** Forget everything. Called by every scan: after one, the panel is current. */
  reset(): void {
    this.roots.clear();
    this.overflowed = false;
  }

  private overflow(): void {
    this.overflowed = true;
    // Release immediately rather than at the next scan. The set will not be
    // used, and every entry pins a subtree.
    this.roots.clear();
  }
}

/**
 * Forget fields whose elements have left the document.
 *
 * An incremental scan adds to the id map instead of clearing it, so without
 * this the entries for removed controls accumulate for as long as the tab is
 * open - each one pinning a detached DOM subtree in memory.
 *
 * `isConnected` is the cheap, exact test: no layout, no style resolution. The
 * map is capped by the runtime budget, so this costs the same on a Chromebook
 * as on a workstation.
 *
 * Mutates the map and returns the descriptors that still have an element,
 * because the two have to stay in step: a descriptor whose element is gone
 * would be offered to the worker and then fail to fill for a reason nobody
 * could diagnose.
 */
export function forgetDetachedFields<T extends { localId: string }>(
  elementsById: Map<string, HTMLElement>,
  descriptors: readonly T[],
): T[] {
  for (const [localId, element] of elementsById) {
    if (!element.isConnected) elementsById.delete(localId);
  }

  return descriptors.filter((descriptor) => elementsById.has(descriptor.localId));
}
