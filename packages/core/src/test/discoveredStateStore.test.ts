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

  it('should handle corrupted JSON gracefully by loading empty and backing up', async () => {
    const filePath = path.join(tmpDir, 'discovered-state.json');
    await fs.writeFile(filePath, 'not valid json', 'utf-8');

    await store.load();
    const records = await store.loadAll();
    expect(records).toEqual([]);

    // Verify the corrupted file was backed up
    const files = await fs.readdir(tmpDir);
    const backupFiles = files.filter(f => f.startsWith('discovered-state.json.corrupt.'));
    expect(backupFiles).toHaveLength(1);
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

  describe('schema validation', () => {
    it('should skip records missing providerId', async () => {
      const filePath = path.join(tmpDir, 'discovered-state.json');
      const data = [
        { externalId: 'issue-1', inboxState: 'unseen' },
        { providerId: 'gh', externalId: 'issue-2', inboxState: 'accepted' },
      ];
      await fs.writeFile(filePath, JSON.stringify(data), 'utf-8');

      const records = await store.loadAll();
      expect(records).toHaveLength(1);
      expect(records[0].externalId).toBe('issue-2');
    });

    it('should skip records missing externalId', async () => {
      const filePath = path.join(tmpDir, 'discovered-state.json');
      const data = [
        { providerId: 'gh', inboxState: 'unseen' },
        { providerId: 'gh', externalId: 'issue-2', inboxState: 'accepted' },
      ];
      await fs.writeFile(filePath, JSON.stringify(data), 'utf-8');

      const records = await store.loadAll();
      expect(records).toHaveLength(1);
      expect(records[0].externalId).toBe('issue-2');
    });

    it('should skip records with invalid inboxState', async () => {
      const filePath = path.join(tmpDir, 'discovered-state.json');
      const data = [
        { providerId: 'gh', externalId: 'issue-1', inboxState: 'bogus' },
        { providerId: 'gh', externalId: 'issue-2', inboxState: 'accepted' },
      ];
      await fs.writeFile(filePath, JSON.stringify(data), 'utf-8');

      const records = await store.loadAll();
      expect(records).toHaveLength(1);
      expect(records[0].externalId).toBe('issue-2');
    });

    it('should return empty for non-array JSON', async () => {
      const filePath = path.join(tmpDir, 'discovered-state.json');
      await fs.writeFile(filePath, JSON.stringify({ not: 'an array' }), 'utf-8');

      const records = await store.loadAll();
      expect(records).toEqual([]);
    });

    it('should skip non-object entries', async () => {
      const filePath = path.join(tmpDir, 'discovered-state.json');
      const data = [
        'a string',
        42,
        null,
        { providerId: 'gh', externalId: 'issue-1', inboxState: 'accepted' },
      ];
      await fs.writeFile(filePath, JSON.stringify(data), 'utf-8');

      const records = await store.loadAll();
      expect(records).toHaveLength(1);
      expect(records[0].externalId).toBe('issue-1');
    });
  });
});
