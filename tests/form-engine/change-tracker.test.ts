// @vitest-environment jsdom
/**
 * Where the page changed, and when to stop trying to remember.
 *
 * These tests exist because the failure they guard against is invisible in a
 * manual test: a content script that keeps adding DOM nodes to a Set on a page
 * that re-renders forever holds the whole discarded document alive, and the
 * only symptom is a tab that gets slower over an hour.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  ChangedSubtrees,
  forgetDetachedFields,
  MAX_CHANGED_ROOTS,
} from '@form-engine/detector/change-tracker';

/** A mutation record, as the browser would report one. */
function mutation(target: Node, added: Node[]): MutationRecord {
  return { target, addedNodes: added as unknown as NodeList } as unknown as MutationRecord;
}

function block(id: string): HTMLElement {
  const element = document.createElement('div');
  element.id = id;
  document.body.append(element);
  return element;
}

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('ChangedSubtrees', () => {
  it('ignores a mutation that added no element', () => {
    const tracker = new ChangedSubtrees();

    // A spinner's text changing, or an attribute flip. Neither can have
    // introduced a form control, and neither should cost a rescan.
    const added = tracker.note([mutation(block('a'), [document.createTextNode('loading')])]);

    expect(added).toBe(false);
    expect(tracker.trackable).toBe(false);
  });

  it('remembers the container a revealed field appeared in', () => {
    const tracker = new ChangedSubtrees();
    const container = block('visa-details');

    expect(tracker.note([mutation(container, [document.createElement('input')])])).toBe(true);
    expect(tracker.trackable).toBe(true);
    expect(tracker.take()).toEqual([container]);
  });

  it('gives up, and lets go, when too many places change', () => {
    const tracker = new ChangedSubtrees();

    for (let index = 0; index <= MAX_CHANGED_ROOTS; index++) {
      tracker.note([mutation(block(`b${index}`), [document.createElement('span')])]);
    }

    // Past the threshold a full scan is cheaper anyway, and a partial scan
    // built on half the roots would silently miss questions.
    expect(tracker.trackable).toBe(false);
    expect(tracker.take()).toEqual([]);
  });

  it('stops accumulating nodes once it has given up', () => {
    const tracker = new ChangedSubtrees(2);
    const seen = new Set<Element>();

    // The leak this guards: a page that re-renders every second for an hour.
    for (let index = 0; index < 500; index++) {
      const container = block(`c${index}`);
      seen.add(container);
      tracker.note([mutation(container, [document.createElement('input')])]);
    }

    expect(tracker.trackable).toBe(false);
    // Nothing retained: `take` on an overflowed tracker returns nothing, and
    // the set behind it was cleared at the moment it overflowed.
    expect(tracker.take()).toHaveLength(0);
    expect(seen.size).toBe(500);
  });

  it('treats a non-element mutation target as not knowing, rather than guessing', () => {
    const tracker = new ChangedSubtrees();
    const fragment = document.createDocumentFragment();

    tracker.note([mutation(fragment, [document.createElement('input')])]);

    expect(tracker.trackable).toBe(false);
  });

  it('forgets everything a scan consumed', () => {
    const tracker = new ChangedSubtrees();
    tracker.note([mutation(block('a'), [document.createElement('input')])]);

    tracker.take();

    // After a scan the panel's list is current, so the next reveal is news and
    // the previous one must not be scanned twice.
    expect(tracker.trackable).toBe(false);
  });
});

describe('forgetDetachedFields', () => {
  it('drops fields the page has removed, and the descriptors that named them', () => {
    const kept = document.createElement('input');
    const removed = document.createElement('input');
    document.body.append(kept, removed);

    const elements = new Map([
      ['f_kept', kept],
      ['f_removed', removed],
    ]);
    removed.remove();

    const descriptors = forgetDetachedFields(elements, [
      { localId: 'f_kept' },
      { localId: 'f_removed' },
    ]);

    expect([...elements.keys()]).toEqual(['f_kept']);
    // The two have to stay in step: a descriptor whose element is gone would be
    // sent to the worker and then fail to fill for a reason nobody could
    // diagnose from the panel.
    expect(descriptors.map((field) => field.localId)).toEqual(['f_kept']);
  });

  it('keeps everything on a page that has not changed', () => {
    const input = document.createElement('input');
    document.body.append(input);
    const elements = new Map([['f_1', input]]);

    expect(forgetDetachedFields(elements, [{ localId: 'f_1' }])).toHaveLength(1);
  });
});
