import * as fs from 'fs/promises';
import * as path from 'path';
import type { Memento } from 'vscode';
import { logger } from '../services/logger';

const MIGRATED_KEY = 'devdocket.migrated';

/** Maps each legacy JSON filename to its globalState key. */
const FILE_KEY_MAP: Record<string, string> = {
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
 * Idempotent — safe to run multiple times.
 */
export async function migrateToGlobalState(globalState: Memento, storagePath: string): Promise<void> {
  if (globalState.get<boolean>(MIGRATED_KEY)) {
    return;
  }

  logger.info('Starting one-time migration from JSON files to globalState...');

  for (const [fileName, stateKey] of Object.entries(FILE_KEY_MAP)) {
    const filePath = path.join(storagePath, fileName);
    try {
      const data = await fs.readFile(filePath, 'utf-8');
      const parsed = JSON.parse(data);
      await globalState.update(stateKey, parsed);
      logger.info(`Migrated ${fileName} → globalState key "${stateKey}"`);
    } catch (err: unknown) {
      if (isNodeError(err) && err.code === 'ENOENT') {
        logger.debug(`No ${fileName} to migrate (file not found)`);
      } else {
        logger.warn(`Failed to migrate ${fileName}: ${err}`);
      }
    }
  }

  await globalState.update(MIGRATED_KEY, true);
  logger.info('Migration to globalState complete');
}
