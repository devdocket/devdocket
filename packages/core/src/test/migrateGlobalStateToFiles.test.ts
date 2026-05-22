import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as vscode from 'vscode';
import { MockMemento } from 'vscode';
import { migrateGlobalStateToFiles, FILE_MIGRATED_KEY } from '../storage/migration';
import { useMockFileSystem, type MockFileSystem } from './testFileSystem';

vi.mock('../services/logger', () => ({
  logger: {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

describe('migrateGlobalStateToFiles', () => {
  const globalStorageUri = vscode.Uri.file('C:\\test\\global-storage');
  let memento: InstanceType<typeof MockMemento>;
  let fileSystem: MockFileSystem;

  beforeEach(() => {
    vi.clearAllMocks();
    memento = new MockMemento();
    fileSystem = useMockFileSystem();
  });

  it('migrates user-intent globalState keys into files and sets the migrated flag', async () => {
    await memento.update('devdocket.workitems', [{ id: 'w1' }]);
    await memento.update('devdocket.inbox-state', [{ providerId: 'gh', externalId: '1', inboxState: 'accepted' }]);
    await memento.update('devdocket.read-state', ['gh::1']);
    await memento.update('devdocket.watches', { runs: [], prs: [] });
    await memento.update('devdocket.provider-labels', { gh: 'GitHub' });

    await migrateGlobalStateToFiles(memento, globalStorageUri);

    expect(fileSystem.readJson(vscode.Uri.joinPath(globalStorageUri, 'workitems.json'))).toEqual([{ id: 'w1' }]);
    expect(fileSystem.readJson(vscode.Uri.joinPath(globalStorageUri, 'inbox-state.json'))).toEqual([{ providerId: 'gh', externalId: '1', inboxState: 'accepted' }]);
    expect(fileSystem.readJson(vscode.Uri.joinPath(globalStorageUri, 'read-state.json'))).toEqual(['gh::1']);
    expect(fileSystem.readJson(vscode.Uri.joinPath(globalStorageUri, 'watches.json'))).toEqual({ runs: [], prs: [] });
    expect(fileSystem.readJson(vscode.Uri.joinPath(globalStorageUri, 'provider-labels.json'))).toBeUndefined();
    expect(memento.get(FILE_MIGRATED_KEY)).toBe(true);
  });

  it('is idempotent when the migrated flag is already set', async () => {
    await memento.update(FILE_MIGRATED_KEY, true);
    await migrateGlobalStateToFiles(memento, globalStorageUri);
    expect(vscode.workspace.fs.writeFile).not.toHaveBeenCalled();
  });

  it('does not overwrite an existing file when no legacy file migration ran', async () => {
    await memento.update('devdocket.workitems', [{ id: 'stale-global-state' }]);
    fileSystem.writeJson(vscode.Uri.joinPath(globalStorageUri, 'workitems.json'), [{ id: 'fresh-file-data' }]);

    await migrateGlobalStateToFiles(memento, globalStorageUri);

    expect(fileSystem.readJson(vscode.Uri.joinPath(globalStorageUri, 'workitems.json'))).toEqual([{ id: 'fresh-file-data' }]);
    expect(memento.get(FILE_MIGRATED_KEY)).toBe(true);
  });

  it('overwrites stale legacy files when the old file-to-globalState migration already ran', async () => {
    await memento.update('devdocket.migrated', true);
    await memento.update('devdocket.workitems', [{ id: 'fresh-global-state' }]);
    fileSystem.writeJson(vscode.Uri.joinPath(globalStorageUri, 'workitems.json'), [{ id: 'stale-legacy-file' }]);

    await migrateGlobalStateToFiles(memento, globalStorageUri);

    expect(fileSystem.readJson(vscode.Uri.joinPath(globalStorageUri, 'workitems.json'))).toEqual([{ id: 'fresh-global-state' }]);
    expect(memento.get(FILE_MIGRATED_KEY)).toBe(true);
  });

  it('does not set the migrated flag when a file write fails', async () => {
    await memento.update('devdocket.workitems', [{ id: 'w1' }]);
    (vscode.workspace.fs.writeFile as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('disk full'));

    await migrateGlobalStateToFiles(memento, globalStorageUri);

    expect(memento.get(FILE_MIGRATED_KEY)).toBeUndefined();
  });
});
