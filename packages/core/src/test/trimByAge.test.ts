import { beforeEach, describe, expect, it, vi } from 'vitest';
import { logger } from '../services/logger';
import { trimByAge } from '../storage/trimByAge';

type RecordShape = {
  key: string;
  timestamp: number;
  protected?: boolean;
};

describe('trimByAge', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('passes records through unchanged when under the cap', () => {
    const records: RecordShape[] = [
      { key: 'a', timestamp: 1 },
      { key: 'b', timestamp: 2 },
    ];

    const trimmed = trimByAge(records, {
      maxEntries: 2,
      getTimestamp: record => record.timestamp,
      getKey: record => record.key,
    });

    expect(trimmed).toBe(records);
  });

  it('evicts the oldest records first when over the cap', () => {
    const trimmed = trimByAge([
      { key: 'a', timestamp: 1 },
      { key: 'b', timestamp: 2 },
      { key: 'c', timestamp: 3 },
      { key: 'd', timestamp: 4 },
    ], {
      maxEntries: 2,
      getTimestamp: record => record.timestamp,
      getKey: record => record.key,
    });

    expect(trimmed.map(record => record.key)).toEqual(['c', 'd']);
  });

  it('uses original index as a stable tiebreaker for equal timestamps', () => {
    const trimmed = trimByAge([
      { key: 'a', timestamp: 1 },
      { key: 'b', timestamp: 1 },
      { key: 'c', timestamp: 2 },
    ], {
      maxEntries: 2,
      getTimestamp: record => record.timestamp,
      getKey: record => record.key,
    });

    expect(trimmed.map(record => record.key)).toEqual(['b', 'c']);
  });

  it('never evicts protected records', () => {
    const trimmed = trimByAge([
      { key: 'protected-oldest', timestamp: 1, protected: true },
      { key: 'oldest-unprotected', timestamp: 2 },
      { key: 'newest', timestamp: 3 },
    ], {
      maxEntries: 2,
      getTimestamp: record => record.timestamp,
      getKey: record => record.key,
      isProtected: record => record.protected === true,
    });

    expect(trimmed.map(record => record.key)).toEqual(['protected-oldest', 'newest']);
  });

  it('returns all protected records and logs once when protected entries alone exceed the cap', () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);

    const trimmed = trimByAge([
      { key: 'a', timestamp: 1, protected: true },
      { key: 'b', timestamp: 2, protected: true },
      { key: 'c', timestamp: 3, protected: true },
      { key: 'd', timestamp: 4 },
    ], {
      maxEntries: 2,
      getTimestamp: record => record.timestamp,
      getKey: record => record.key,
      isProtected: record => record.protected === true,
    });

    expect(trimmed.map(record => record.key)).toEqual(['a', 'b', 'c']);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('protected records'));
  });
});
