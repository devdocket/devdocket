import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { ReadStateStore } from '../storage/readStateStore';

describe('ReadStateStore', () => {
  let tmpDir: string;
  let store: ReadStateStore;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'workcenter-readstate-test-'));
    store = new ReadStateStore(tmpDir);
  });

  afterEach(async () => {
    await store.flush();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('should return false for has() when file is missing on load', async () => {
    await store.load();
    expect(store.has('gh::1')).toBe(false);
  });

  it('should add a key and persist to disk', async () => {
    await store.load();
    expect(await store.add('gh::issue-1')).toBe(true);
    await store.flush();

    const filePath = path.join(tmpDir, 'read-state.json');
    const raw = await fs.readFile(filePath, 'utf-8');
    expect(JSON.parse(raw)).toEqual(['gh::issue-1']);
  });

  it('should return false when adding a duplicate key', async () => {
    await store.load();
    expect(await store.add('gh::1')).toBe(true);
    expect(await store.add('gh::1')).toBe(false);
  });

  it('should report has() correctly after add', async () => {
    await store.load();
    expect(store.has('gh::1')).toBe(false);
    await store.add('gh::1');
    expect(store.has('gh::1')).toBe(true);
  });

  it('should delete a key', async () => {
    await store.load();
    await store.add('gh::1');
    expect(store.delete('gh::1')).toBe(true);
    expect(store.has('gh::1')).toBe(false);
  });

  it('should return false when deleting a non-existent key', async () => {
    await store.load();
    expect(store.delete('gh::nonexistent')).toBe(false);
  });

  it('should iterate keys', async () => {
    await store.load();
    await store.add('gh::1');
    await store.add('gh::2');
    const keys = [...store.keys()];
    expect(keys.sort()).toEqual(['gh::1', 'gh::2']);
  });

  it('should persist after save()', async () => {
    await store.load();
    await store.add('gh::1');
    await store.add('gh::2');
    store.delete('gh::1');
    store.save();
    await store.flush();

    const filePath = path.join(tmpDir, 'read-state.json');
    const raw = await fs.readFile(filePath, 'utf-8');
    expect(JSON.parse(raw)).toEqual(['gh::2']);
  });

  it('should load persisted state from a fresh instance', async () => {
    await store.load();
    await store.add('gh::1');
    await store.add('jira::2');
    await store.flush();

    const store2 = new ReadStateStore(tmpDir);
    await store2.load();
    expect(store2.has('gh::1')).toBe(true);
    expect(store2.has('jira::2')).toBe(true);
    expect(store2.has('gh::3')).toBe(false);
  });

  it('should handle corrupted JSON by throwing', async () => {
    const filePath = path.join(tmpDir, 'read-state.json');
    await fs.writeFile(filePath, 'not valid json', 'utf-8');

    await expect(store.load()).rejects.toThrow();
  });

  it('should create storage directory if it does not exist', async () => {
    const nestedDir = path.join(tmpDir, 'nested', 'path');
    const nestedStore = new ReadStateStore(nestedDir);
    await nestedStore.load();
    await nestedStore.add('gh::1');
    await nestedStore.flush();

    const filePath = path.join(nestedDir, 'read-state.json');
    const raw = await fs.readFile(filePath, 'utf-8');
    expect(JSON.parse(raw)).toEqual(['gh::1']);
  });

  it('should only load once (idempotent)', async () => {
    await store.load();
    await store.add('gh::1');
    await store.flush();

    // Second load should be a no-op
    await store.load();
    expect(store.has('gh::1')).toBe(true);
  });

  it('should rollback in-memory state when write fails', async () => {
    await store.load();

    // Point the store at an invalid path to trigger a write error.
    const originalPath = (store as any).filePath;
    (store as any).filePath = path.join(tmpDir, '\0invalid');

    await expect(store.add('gh::fail')).rejects.toThrow();
    expect(store.has('gh::fail')).toBe(false);

    // Restore path and reset write queue so afterEach cleanup succeeds
    (store as any).filePath = originalPath;
    (store as any).writeQueue = Promise.resolve();
  });

  it('should auto-load when add() is called before load()', async () => {
    // Write existing state to disk first
    const filePath = path.join(tmpDir, 'read-state.json');
    await fs.writeFile(filePath, JSON.stringify(['gh::existing']), 'utf-8');

    const freshStore = new ReadStateStore(tmpDir);
    // Call add() without calling load() first
    await freshStore.add('gh::new');

    expect(freshStore.has('gh::existing')).toBe(true);
    expect(freshStore.has('gh::new')).toBe(true);
  });
});
