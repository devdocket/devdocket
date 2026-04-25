import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MockMemento } from 'vscode';
import { migrateToGlobalState, MIGRATED_KEY, FILE_KEY_MAP } from '../storage/migration';

// Mock fs/promises — each test configures per-file behaviour via readFileMock
const readFileMock = vi.fn();
vi.mock('fs/promises', () => ({
  readFile: (...args: unknown[]) => readFileMock(...args),
}));

// Suppress logger output during tests
vi.mock('../services/logger', () => ({
  logger: {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

describe('migrateToGlobalState', () => {
  let memento: InstanceType<typeof MockMemento>;
  const storagePath = '/fake/storage';

  beforeEach(() => {
    vi.clearAllMocks();
    memento = new MockMemento();
  });

  it('migrates all files into globalState and sets migrated flag', async () => {
    const fileContents: Record<string, unknown> = {
      'workitems.json': [{ id: 'w1', title: 'Task 1' }],
      'discovered-state.json': [{ providerId: 'gh', externalId: '1', inboxState: 'unseen' }],
      'read-state.json': ['gh::1'],
      'provider-labels.json': { gh: 'GitHub' },
      'watches.json': { runs: [], prs: [] },
    };

    readFileMock.mockImplementation(async (filePath: string) => {
      for (const [name, data] of Object.entries(fileContents)) {
        if (filePath.endsWith(name)) {
          return JSON.stringify(data);
        }
      }
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });

    await migrateToGlobalState(memento, storagePath);

    for (const [fileName, stateKey] of Object.entries(FILE_KEY_MAP)) {
      expect(memento.get(stateKey)).toEqual(fileContents[fileName]);
    }
    expect(memento.get(MIGRATED_KEY)).toBe(true);
  });

  it('skips absent files (ENOENT) and still marks complete', async () => {
    readFileMock.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));

    await migrateToGlobalState(memento, storagePath);

    for (const stateKey of Object.values(FILE_KEY_MAP)) {
      expect(memento.get(stateKey)).toBeUndefined();
    }
    expect(memento.get(MIGRATED_KEY)).toBe(true);
  });

  it('is idempotent — no-ops if already migrated', async () => {
    await memento.update(MIGRATED_KEY, true);

    await migrateToGlobalState(memento, storagePath);

    expect(readFileMock).not.toHaveBeenCalled();
  });

  it('handles partial migration — some files exist, some absent', async () => {
    readFileMock.mockImplementation(async (filePath: string) => {
      if (filePath.endsWith('workitems.json')) {
        return JSON.stringify([{ id: 'w1' }]);
      }
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });

    await migrateToGlobalState(memento, storagePath);

    expect(memento.get('devdocket.workitems')).toEqual([{ id: 'w1' }]);
    expect(memento.get('devdocket.discovered-state')).toBeUndefined();
    expect(memento.get(MIGRATED_KEY)).toBe(true);
  });

  it('does not mark migrated when a non-ENOENT error occurs', async () => {
    readFileMock.mockImplementation(async (filePath: string) => {
      if (filePath.endsWith('workitems.json')) {
        throw new Error('EACCES: permission denied');
      }
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });

    await migrateToGlobalState(memento, storagePath);

    expect(memento.get(MIGRATED_KEY)).toBeUndefined();
  });

  it('does not mark migrated when JSON.parse fails', async () => {
    readFileMock.mockImplementation(async (filePath: string) => {
      if (filePath.endsWith('workitems.json')) {
        return '{ invalid json !!!';
      }
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });

    await migrateToGlobalState(memento, storagePath);

    expect(memento.get(MIGRATED_KEY)).toBeUndefined();
    expect(memento.get('devdocket.workitems')).toBeUndefined();
  });

  it('retries migration on next call after a previous failure', async () => {
    // First attempt fails
    readFileMock.mockRejectedValue(new Error('disk error'));
    await migrateToGlobalState(memento, storagePath);
    expect(memento.get(MIGRATED_KEY)).toBeUndefined();

    // Second attempt succeeds
    readFileMock.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    await migrateToGlobalState(memento, storagePath);
    expect(memento.get(MIGRATED_KEY)).toBe(true);
  });
});
