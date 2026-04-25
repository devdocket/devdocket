import * as fs from 'fs/promises';
import * as path from 'path';
import type { Memento } from 'vscode';
import { logger } from '../services/logger';

export const MIGRATED_KEY = 'devdocket.migrated';

/** Warn when a JSON file exceeds this size (bytes) during migration. */
const SIZE_WARNING_THRESHOLD = 512 * 1024; // 512 KB

/** Maps each legacy JSON filename to its globalState key. */
export const FILE_KEY_MAP: Record<string, string> = {
  'workitems.json': 'devdocket.workitems',
  'discovered-state.json': 'devdocket.discovered-state',
  'read-state.json': 'devdocket.read-state',
  'provider-labels.json': 'devdocket.provider-labels',
  'watches.json': 'devdocket.watches',
};

function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && 'code' in err;
}

/**
 * One-time migration from JSON files in globalStorageUri to VS Code globalState.
 * Idempotent — safe to run multiple times. Only marks complete when every file
 * is either migrated successfully or confirmed absent (ENOENT).
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
