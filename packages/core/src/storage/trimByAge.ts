import { logger } from '../services/logger';

export function trimByAge<T>(
  records: T[],
  options: {
    maxEntries: number;
    getTimestamp: (record: T) => number;
    getKey: (record: T) => string;
    /** Records for which this returns true are NEVER evicted. */
    isProtected?: (record: T) => boolean;
  },
): T[] {
  if (records.length <= options.maxEntries) {
    return records;
  }

  const metadata = records.map((record, index) => {
    const key = options.getKey(record);
    return {
      record,
      index,
      key,
      evictionId: `${key}\u0000${index}`,
      timestamp: options.getTimestamp(record),
      isProtected: options.isProtected?.(record) ?? false,
    };
  });

  const protectedCount = metadata.filter(entry => entry.isProtected).length;
  if (protectedCount > options.maxEntries) {
    logger.warn(
      `trimByAge retained ${protectedCount} protected records, exceeding the ${options.maxEntries}-entry cap because protected records cannot be evicted`,
    );
    return metadata
      .filter(entry => entry.isProtected)
      .map(entry => entry.record);
  }

  const unprotectedToEvict = records.length - options.maxEntries;
  const recordsToEvict = new Set(
    metadata
      .filter(entry => !entry.isProtected)
      .sort((a, b) => a.timestamp - b.timestamp || a.index - b.index)
      .slice(0, unprotectedToEvict)
      .map(entry => entry.evictionId),
  );

  return metadata
    .filter(entry => !recordsToEvict.has(entry.evictionId))
    .map(entry => entry.record);
}
