import * as fs from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';
import type { Memento } from 'vscode';
import { logger } from '../services/logger';
import { isFileMissingError, JsonFileStore } from './fileStore';

export const MIGRATED_KEY = 'devdocket.migrated';
export const FILE_MIGRATED_KEY = 'devdocket.migrated-to-files';

/** Warn when a JSON file exceeds this size (bytes) during migration. */
const SIZE_WARNING_THRESHOLD = 512 * 1024; // 512 KB

/** Maps each legacy JSON filename to its globalState key. */
export const FILE_KEY_MAP: Record<string, string> = {
  'workitems.json': 'devdocket.workitems',
  'discovered-state.json': 'devdocket.inbox-state',
  'read-state.json': 'devdocket.read-state',
  'provider-labels.json': 'devdocket.provider-labels',
  'watches.json': 'devdocket.watches',
};

export const GLOBAL_STATE_FILE_MAP: Array<{ key: string; filename: string }> = [
  { key: 'devdocket.workitems', filename: 'workitems.json' },
  { key: 'devdocket.inbox-state', filename: 'inbox-state.json' },
  { key: 'devdocket.read-state', filename: 'read-state.json' },
  { key: 'devdocket.watches', filename: 'watches.json' },
];

function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && 'code' in err;
}

/**
 * One-time migration from JSON files in globalStorageUri to VS Code globalState.
 * Idempotent — safe to run multiple times. Only marks complete when every file
 * is either migrated successfully, confirmed absent (ENOENT), or skipped because
 * its destination globalState key is already populated.
 */
export async function migrateToGlobalState(globalState: Memento, storagePath: string): Promise<void> {
  if (globalState.get<boolean>(MIGRATED_KEY)) {
    return;
  }

  logger.info('Starting one-time migration from JSON files to globalState...');

  let allSucceeded = true;

  for (const [fileName, stateKey] of Object.entries(FILE_KEY_MAP)) {
    // Skip keys that already have data — prevents overwriting newer
    // globalState values when migration retries after a partial failure.
    if (globalState.get(stateKey) !== undefined) {
      logger.debug(`Skipping ${fileName} — globalState key "${stateKey}" already populated`);
      continue;
    }
    const filePath = path.join(storagePath, fileName);
    try {
      const data = await fs.readFile(filePath, 'utf-8');
      const dataSizeBytes = Buffer.byteLength(data, 'utf-8');
      if (dataSizeBytes > SIZE_WARNING_THRESHOLD) {
        logger.warn(
          `${fileName} is ${(dataSizeBytes / 1024).toFixed(0)} KB — large values in globalState may degrade performance`,
        );
      }
      const parsed = JSON.parse(data);
      await globalState.update(stateKey, parsed);
      logger.info(`Migrated ${fileName} → globalState key "${stateKey}"`);
    } catch (err: unknown) {
      if (isNodeError(err) && err.code === 'ENOENT') {
        logger.debug(`No ${fileName} to migrate (file not found)`);
      } else {
        logger.error(`Failed to migrate ${fileName}`, err);
        allSucceeded = false;
      }
    }
  }

  if (allSucceeded) {
    await globalState.update(MIGRATED_KEY, true);
    logger.info('Migration to globalState complete');
  } else {
    logger.warn('Migration incomplete — will retry on next activation');
  }
}

/**
 * One-time migration from globalState to file-backed storage. Idempotent and
 * rollback-safe: existing files are left untouched so a partial migration can
 * retry later without clobbering newer file-backed data.
 */
export async function migrateGlobalStateToFiles(
  globalState: Memento,
  globalStorageUri: vscode.Uri,
): Promise<boolean> {
  if (globalState.get<boolean>(FILE_MIGRATED_KEY)) {
    return true;
  }

  logger.info('Starting one-time migration from globalState to JSON files...');

  const legacyFilesWereAlreadyMigrated = globalState.get<boolean>(MIGRATED_KEY) === true;
  let allSucceeded = true;

  try {
    await vscode.workspace.fs.createDirectory(globalStorageUri);
  } catch (err) {
    logger.warn('Failed to create global storage directory for file migration', err);
    return false;
  }

  for (const { key, filename } of GLOBAL_STATE_FILE_MAP) {
    const data = globalState.get(key);
    if (data === undefined) {
      continue;
    }

    const fileUri = vscode.Uri.joinPath(globalStorageUri, filename);
    let fileExists = false;
    try {
      await vscode.workspace.fs.readFile(fileUri);
      fileExists = true;
    } catch (err) {
      if (!isFileMissingError(err)) {
        logger.warn(`Failed to inspect existing file for ${key}`, err);
        allSucceeded = false;
        continue;
      }
    }

    if (fileExists && !legacyFilesWereAlreadyMigrated) {
      logger.debug(`Skipping globalState key "${key}" — ${filename} already exists`);
      continue;
    }

    if (fileExists) {
      logger.debug(`Overwriting legacy ${filename} from globalState key "${key}"`);
    }

    try {
      await new JsonFileStore(fileUri, filename).write(data);
      logger.info(`Migrated globalState key "${key}" → ${filename}`);
    } catch (err) {
      logger.warn(`Failed to migrate ${key} to ${filename}`, err);
      allSucceeded = false;
    }
  }

  if (allSucceeded) {
    await globalState.update(FILE_MIGRATED_KEY, true);
    logger.info('Migration to file-backed storage complete');
    return true;
  }

  logger.warn('File-backed migration incomplete — will retry on next activation');
  return false;
}
