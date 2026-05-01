import { describe, it, expect, beforeEach, vi } from 'vitest';
import { DevDocketAction } from '../api/types';
import { WorkItem, WorkItemState } from '../models/workItem';
import { ActionRegistry } from '../services/actionRegistry';

function createMockAction(id: string, canRunFn: (item: WorkItem) => boolean = () => true): DevDocketAction {
  return {
    id,
    label: `Action ${id}`,
    canRun: vi.fn(canRunFn),
    run: vi.fn(async () => {}),
  };
}

function createWorkItem(overrides: Partial<WorkItem> = {}): WorkItem {
  return {
    id: 'wc-test-1',
    title: 'Test Item',
    state: WorkItemState.New,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
}

describe('ActionRegistry', () => {
  let registry: ActionRegistry;

  beforeEach(() => {
    registry = new ActionRegistry();
  });

  it('stores the action and returns a Disposable on register', () => {
    const action = createMockAction('act1');
    const disposable = registry.register(action);

    expect(registry.getAction('act1')).toBe(action);
    expect(disposable).toBeDefined();
    expect(typeof disposable.dispose).toBe('function');
  });

  it('throws on duplicate action id', () => {
    const action1 = createMockAction('dup');
    const action2 = createMockAction('dup');

    registry.register(action1);
    expect(() => registry.register(action2)).toThrow('Action already registered: dup');
  });

  it('removes the action when the returned Disposable is disposed', () => {
    const action = createMockAction('removable');
    const disposable = registry.register(action);

    expect(registry.getAction('removable')).toBe(action);
    disposable.dispose();
    expect(registry.getAction('removable')).toBeUndefined();
  });

  it('fires onDidChangeRegistrations when actions are registered and unregistered', () => {
    const listener = vi.fn();
    registry.onDidChangeRegistrations(listener);

    const disposable = registry.register(createMockAction('eventful'));
    expect(listener).toHaveBeenCalledTimes(1);

    disposable.dispose();
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('returns registered action from getAction', () => {
    const action = createMockAction('findme');
    registry.register(action);

    expect(registry.getAction('findme')).toBe(action);
  });

  it('returns undefined from getAction for unknown id', () => {
    expect(registry.getAction('nonexistent')).toBeUndefined();
  });

  it('returns only actions where canRun() returns true from getActionsFor', () => {
    const item = createWorkItem({ providerId: 'github' });

    const githubAction = createMockAction('github-action', (i) => i.providerId === 'github');
    const jiraAction = createMockAction('jira-action', (i) => i.providerId === 'jira');
    const universalAction = createMockAction('universal', () => true);

    registry.register(githubAction);
    registry.register(jiraAction);
    registry.register(universalAction);

    const actions = registry.getActionsFor(item);

    expect(actions).toHaveLength(2);
    expect(actions).toContain(githubAction);
    expect(actions).toContain(universalAction);
    expect(actions).not.toContain(jiraAction);
  });

  it('returns empty array from getActionsFor when no actions match', () => {
    const item = createWorkItem({ providerId: 'gitlab' });
    const action = createMockAction('github-only', (i) => i.providerId === 'github');
    registry.register(action);

    const actions = registry.getActionsFor(item);

    expect(actions).toHaveLength(0);
  });

  it('clears all actions on dispose', () => {
    registry.register(createMockAction('a1'));
    registry.register(createMockAction('a2'));

    registry.dispose();

    expect(registry.getAction('a1')).toBeUndefined();
    expect(registry.getAction('a2')).toBeUndefined();
  });

  it('fires onDidChangeRegistrations when dispose clears registrations', () => {
    const listener = vi.fn();
    registry.onDidChangeRegistrations(listener);

    registry.register(createMockAction('a1'));
    listener.mockClear();

    registry.dispose();

    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('getActionsFor returns empty array when registry is empty', () => {
    const item = createWorkItem();
    const actions = registry.getActionsFor(item);

    expect(actions).toHaveLength(0);
  });

  it('allows re-registering an action after its Disposable is disposed', () => {
    const action1 = createMockAction('reuse');
    const disposable = registry.register(action1);
    disposable.dispose();

    const action2 = createMockAction('reuse');
    const disposable2 = registry.register(action2);

    expect(registry.getAction('reuse')).toBe(action2);
    disposable2.dispose();
  });

  it('canRun receives the correct work item', () => {
    const canRunSpy = vi.fn(() => true);
    const action: DevDocketAction = {
      id: 'spy-action',
      label: 'Spy Action',
      canRun: canRunSpy,
      run: vi.fn(async () => {}),
    };
    registry.register(action);

    const item = createWorkItem({ id: 'specific-item', title: 'Specific' });
    registry.getActionsFor(item);

    expect(canRunSpy).toHaveBeenCalledWith(item);
  });

  it('getActionsFor filters by work item state', () => {
    const inProgressOnly = createMockAction(
      'ip-action',
      (i) => i.state === WorkItemState.InProgress,
    );
    const pausedOnly = createMockAction(
      'paused-action',
      (i) => i.state === WorkItemState.Paused,
    );
    registry.register(inProgressOnly);
    registry.register(pausedOnly);

    const ipItem = createWorkItem({ state: WorkItemState.InProgress });
    const pausedItem = createWorkItem({ state: WorkItemState.Paused });

    expect(registry.getActionsFor(ipItem)).toEqual([inProgressOnly]);
    expect(registry.getActionsFor(pausedItem)).toEqual([pausedOnly]);
  });

  it('dispose makes getActionsFor return empty for previously matching actions', () => {
    registry.register(createMockAction('will-clear'));
    registry.dispose();

    const item = createWorkItem();
    expect(registry.getActionsFor(item)).toHaveLength(0);
  });
});
