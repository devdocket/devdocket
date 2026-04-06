import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { DiscoveredStateStore } from '../storage/discoveredStateStore';

describe('DiscoveredStateStore', () => {
  let tmpDir: string;
  let store: DiscoveredStateStore;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'workcenter-state-test-'));
    store = new DiscoveredStateStore(tmpDir);
  });

  afterEach(async () => {
    store.dispose();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('should return empty cache when file is missing on load', async () => {
    await store.load();
    const records = await store.loadAll();
    expect(records).toEqual([]);
  });

  it('should create a record and persist on setState', async () => {
    await store.setState('gh', 'issue-1', 'unseen');

    const filePath = path.join(tmpDir, 'discovered-state.json');
    const raw = await fs.readFile(filePath, 'utf-8');
    const parsed = JSON.parse(raw);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toEqual({
      providerId: 'gh',
      externalId: 'issue-1',
      inboxState: 'unseen',
    });
  });

  it('should return state for a known item from getState', async () => {
    await store.setState('gh', 'issue-1', 'accepted');
    expect(store.getState('gh', 'issue-1')).toBe('accepted');
  });

  it('should return undefined for an unknown item from getState', () => {
    expect(store.getState('gh', 'nonexistent')).toBeUndefined();
  });

  it('should update an existing record on setState', async () => {
    await store.setState('gh', 'issue-1', 'unseen');
    await store.setState('gh', 'issue-1', 'accepted');

    expect(store.getState('gh', 'issue-1')).toBe('accepted');

    const records = await store.loadAll();
    expect(records).toHaveLength(1);
    expect(records[0].inboxState).toBe('accepted');
  });

  it('should return all records from loadAll', async () => {
    await store.setState('gh', 'issue-1', 'unseen');
    await store.setState('gh', 'issue-2', 'accepted');
    await store.setState('jira', 'task-1', 'dismissed');

    const records = await store.loadAll();
    expect(records).toHaveLength(3);
    const ids = records.map((r) => r.externalId).sort();
    expect(ids).toEqual(['issue-1', 'issue-2', 'task-1']);
  });

  it('should treat same externalId from different providers as distinct', async () => {
    await store.setState('gh', 'id-1', 'unseen');
    await store.setState('jira', 'id-1', 'accepted');

    expect(store.getState('gh', 'id-1')).toBe('unseen');
    expect(store.getState('jira', 'id-1')).toBe('accepted');

    const records = await store.loadAll();
    expect(records).toHaveLength(2);
  });

  it('should fire onChange event when setState is called', async () => {
    const listener = vi.fn();
    store.onDidChange(listener);

    await store.setState('gh', 'issue-1', 'unseen');
    expect(listener).toHaveBeenCalledTimes(1);

    await store.setState('gh', 'issue-1', 'accepted');
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('should load persisted state from disk', async () => {
    await store.setState('gh', 'issue-1', 'accepted');
    await store.setState('gh', 'issue-2', 'dismissed');

    // Create a fresh store pointing at same directory
    const store2 = new DiscoveredStateStore(tmpDir);
    await store2.load();

    expect(store2.getState('gh', 'issue-1')).toBe('accepted');
    expect(store2.getState('gh', 'issue-2')).toBe('dismissed');
    store2.dispose();
  });

  it('should handle corrupted JSON by throwing', async () => {
    const filePath = path.join(tmpDir, 'discovered-state.json');
    await fs.writeFile(filePath, 'not valid json', 'utf-8');

    await expect(store.load()).rejects.toThrow();
  });

  it('should serialize concurrent setState calls without lost writes', async () => {
    const count = 20;
    const promises: Promise<void>[] = [];
    for (let i = 0; i < count; i++) {
      promises.push(store.setState('gh', `issue-${i}`, 'unseen'));
    }
    await Promise.all(promises);

    const records = await store.loadAll();
    expect(records).toHaveLength(count);

    const filePath = path.join(tmpDir, 'discovered-state.json');
    const raw = await fs.readFile(filePath, 'utf-8');
    const persisted = JSON.parse(raw);
    expect(persisted).toHaveLength(count);
  });

  it('should serialize concurrent setStates calls without corruption', async () => {
    const batch1 = [
      { providerId: 'gh', externalId: 'a1', state: 'unseen' as const },
      { providerId: 'gh', externalId: 'a2', state: 'accepted' as const },
    ];
    const batch2 = [
      { providerId: 'jira', externalId: 'b1', state: 'dismissed' as const },
      { providerId: 'jira', externalId: 'b2', state: 'unseen' as const },
    ];
    const batch3 = [
      { providerId: 'gh', externalId: 'a1', state: 'dismissed' as const },
    ];

    await Promise.all([
      store.setStates(batch1),
      store.setStates(batch2),
      store.setStates(batch3),
    ]);

    const records = await store.loadAll();
    // a1, a2, b1, b2 — four distinct keys
    expect(records).toHaveLength(4);

    const filePath = path.join(tmpDir, 'discovered-state.json');
    const raw = await fs.readFile(filePath, 'utf-8');
    const persisted = JSON.parse(raw);
    expect(persisted).toHaveLength(4);

    // a1 was set by both batch1 and batch3; the final value depends on
    // serialization order but must be one of the two, not corrupted
    const a1 = persisted.find((r: any) => r.externalId === 'a1');
    expect(['unseen', 'dismissed']).toContain(a1.inboxState);
  });

  it('should create storage directory if it does not exist', async () => {
    const nestedDir = path.join(tmpDir, 'nested', 'path');
    const nestedStore = new DiscoveredStateStore(nestedDir);

    await nestedStore.setState('gh', 'issue-1', 'unseen');

    const filePath = path.join(nestedDir, 'discovered-state.json');
    const raw = await fs.readFile(filePath, 'utf-8');
    expect(JSON.parse(raw)).toHaveLength(1);
    nestedStore.dispose();
  });
});
