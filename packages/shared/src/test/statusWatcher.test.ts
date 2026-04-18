import { describe, it, expect, beforeEach } from 'vitest';
import { StatusWatcher } from '../statusWatcher';

describe('StatusWatcher', () => {
  let watcher: StatusWatcher<string>;

  beforeEach(() => {
    watcher = new StatusWatcher<string>();
  });

  it('starts with zero tracked items', () => {
    expect(watcher.size).toBe(0);
  });

  it('returns no changes on first update (new items are silently added)', () => {
    const current = new Map([
      ['run-1', 'in_progress'],
      ['run-2', 'queued'],
    ]);

    const changes = watcher.update(current);

    expect(changes).toHaveLength(0);
    expect(watcher.size).toBe(2);
  });

  it('detects a status change for an existing item', () => {
    watcher.update(new Map([['run-1', 'in_progress']]));

    const changes = watcher.update(new Map([['run-1', 'completed:success']]));

    expect(changes).toHaveLength(1);
    expect(changes[0]).toEqual({
      id: 'run-1',
      previousStatus: 'in_progress',
      currentStatus: 'completed:success',
    });
  });

  it('does not report a change when status is unchanged', () => {
    watcher.update(new Map([['run-1', 'in_progress']]));

    const changes = watcher.update(new Map([['run-1', 'in_progress']]));

    expect(changes).toHaveLength(0);
  });

  it('detects multiple changes in a single update', () => {
    watcher.update(new Map([
      ['run-1', 'in_progress'],
      ['run-2', 'queued'],
    ]));

    const changes = watcher.update(new Map([
      ['run-1', 'completed:failure'],
      ['run-2', 'in_progress'],
    ]));

    expect(changes).toHaveLength(2);
    expect(changes).toContainEqual({
      id: 'run-1',
      previousStatus: 'in_progress',
      currentStatus: 'completed:failure',
    });
    expect(changes).toContainEqual({
      id: 'run-2',
      previousStatus: 'queued',
      currentStatus: 'in_progress',
    });
  });

  it('removes items no longer present in the current map', () => {
    watcher.update(new Map([
      ['run-1', 'in_progress'],
      ['run-2', 'queued'],
    ]));
    expect(watcher.size).toBe(2);

    watcher.update(new Map([['run-1', 'in_progress']]));

    expect(watcher.size).toBe(1);
  });

  it('does not report changes for items removed between updates', () => {
    watcher.update(new Map([['run-1', 'in_progress']]));

    // run-1 disappears
    const changes = watcher.update(new Map());

    expect(changes).toHaveLength(0);
    expect(watcher.size).toBe(0);
  });

  it('treats a previously removed item as new (no change emitted) when it reappears', () => {
    watcher.update(new Map([['run-1', 'in_progress']]));
    watcher.update(new Map()); // removed

    // Reappears with a different status
    const changes = watcher.update(new Map([['run-1', 'completed:success']]));

    expect(changes).toHaveLength(0); // treated as new
    expect(watcher.size).toBe(1);
  });

  it('handles a mix of new, changed, unchanged, and removed items', () => {
    watcher.update(new Map([
      ['run-1', 'in_progress'],
      ['run-2', 'queued'],
      ['run-3', 'in_progress'],
    ]));

    const changes = watcher.update(new Map([
      ['run-1', 'completed:success'], // changed
      ['run-2', 'queued'],            // unchanged
      ['run-4', 'queued'],            // new
      // run-3 removed
    ]));

    expect(changes).toHaveLength(1);
    expect(changes[0]).toEqual({
      id: 'run-1',
      previousStatus: 'in_progress',
      currentStatus: 'completed:success',
    });
    expect(watcher.size).toBe(3); // run-1, run-2, run-4
  });

  it('clear() removes all tracked items', () => {
    watcher.update(new Map([['run-1', 'in_progress']]));
    expect(watcher.size).toBe(1);

    watcher.clear();

    expect(watcher.size).toBe(0);
  });

  it('works with non-string status types', () => {
    const numWatcher = new StatusWatcher<number>();
    numWatcher.update(new Map([['item-1', 1]]));

    const changes = numWatcher.update(new Map([['item-1', 2]]));

    expect(changes).toHaveLength(1);
    expect(changes[0]).toEqual({
      id: 'item-1',
      previousStatus: 1,
      currentStatus: 2,
    });
  });
});
