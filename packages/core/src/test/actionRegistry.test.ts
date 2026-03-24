import { describe, it, expect, beforeEach, vi } from 'vitest';
import { WorkCenterAction } from '../api/types';
import { WorkItem, WorkItemState } from '../models/workItem';
import { ActionRegistry } from '../services/actionRegistry';

function createMockAction(id: string, canRunFn: (item: WorkItem) => boolean = () => true): WorkCenterAction {
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
});
