import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import { logger } from '../logger';
import {
  encodeWorkStartedDetail,
  decodeWorkStartedDetail,
  renderWorkStartedActivityDetail,
  WORK_STARTED_DETAIL_VERSION,
} from '../workStartedDetail';

describe('encodeWorkStartedDetail', () => {
  it('stamps the current schema version', () => {
    const encoded = encodeWorkStartedDetail({ branchName: 'feature/x', repoPath: '/r' });
    const parsed = JSON.parse(encoded);
    expect(parsed.v).toBe(WORK_STARTED_DETAIL_VERSION);
    expect(parsed.branchName).toBe('feature/x');
    expect(parsed.repoPath).toBe('/r');
  });

  it('omits undefined optional fields', () => {
    const encoded = encodeWorkStartedDetail({ repoPath: '/r' });
    const parsed = JSON.parse(encoded);
    expect(parsed).not.toHaveProperty('branchName');
    expect(parsed).not.toHaveProperty('worktreePath');
    expect(parsed.repoPath).toBe('/r');
  });

  it('round-trips through decode', () => {
    const original = { branchName: 'b', worktreePath: '/w', repoPath: '/r' };
    const decoded = decodeWorkStartedDetail(encodeWorkStartedDetail(original));
    expect(decoded).toEqual({ v: 1, ...original });
  });
});

describe('decodeWorkStartedDetail', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns undefined for missing detail', () => {
    expect(decodeWorkStartedDetail(undefined)).toBeUndefined();
    expect(decodeWorkStartedDetail('')).toBeUndefined();
  });

  it('returns undefined and warns for malformed JSON', () => {
    expect(decodeWorkStartedDetail('not json')).toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('Failed to parse'));
  });

  it('returns undefined for non-object payloads', () => {
    expect(decodeWorkStartedDetail(JSON.stringify('a string'))).toBeUndefined();
    expect(decodeWorkStartedDetail(JSON.stringify(42))).toBeUndefined();
    expect(decodeWorkStartedDetail(JSON.stringify(null))).toBeUndefined();
    expect(decodeWorkStartedDetail(JSON.stringify(['a']))).toBeUndefined();
  });

  it('accepts legacy unversioned payloads (no v field)', () => {
    const legacy = JSON.stringify({ branchName: 'feature/x', worktreePath: '/w', repoPath: '/r' });
    const decoded = decodeWorkStartedDetail(legacy);
    expect(decoded).toEqual({ v: 1, branchName: 'feature/x', worktreePath: '/w', repoPath: '/r' });
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('parses current v1 payloads', () => {
    const v1 = JSON.stringify({ v: 1, branchName: 'b', repoPath: '/r' });
    const decoded = decodeWorkStartedDetail(v1);
    expect(decoded).toEqual({ v: 1, branchName: 'b', repoPath: '/r' });
  });

  it('returns undefined and warns for unknown version', () => {
    const future = JSON.stringify({ v: 2, branchName: 'b', repoPath: '/r' });
    expect(decodeWorkStartedDetail(future)).toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('Unknown work-started activity detail version'));
  });

  it('drops non-string field values silently', () => {
    const mixed = JSON.stringify({ v: 1, branchName: 42, worktreePath: null, repoPath: '/r' });
    const decoded = decodeWorkStartedDetail(mixed);
    expect(decoded).toEqual({ v: 1, repoPath: '/r' });
  });

  it('treats a string version "1" as unknown (strict equality)', () => {
    const stringVersion = JSON.stringify({ v: '1', branchName: 'b', repoPath: '/r' });
    expect(decodeWorkStartedDetail(stringVersion)).toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('Unknown work-started activity detail version'));
  });

  it('returns undefined for v1 payloads missing required repoPath', () => {
    const noRepoPath = JSON.stringify({ v: 1, branchName: 'feature/x', worktreePath: '/w' });
    expect(decodeWorkStartedDetail(noRepoPath)).toBeUndefined();
  });

  it('returns undefined for legacy unversioned payloads missing repoPath', () => {
    const legacyNoRepoPath = JSON.stringify({ branchName: 'feature/x', worktreePath: '/w' });
    expect(decodeWorkStartedDetail(legacyNoRepoPath)).toBeUndefined();
  });

  it('returns undefined when repoPath has a non-string value', () => {
    const nonStringRepoPath = JSON.stringify({ v: 1, repoPath: 42, branchName: 'b' });
    expect(decodeWorkStartedDetail(nonStringRepoPath)).toBeUndefined();
  });
});

describe('renderWorkStartedActivityDetail', () => {
  it('renders all known fields as labelled rows', () => {
    const encoded = encodeWorkStartedDetail({
      branchName: 'feature/x',
      worktreePath: '/path/to/worktree',
      repoPath: '/path/to/repo',
    });
    expect(renderWorkStartedActivityDetail(encoded)).toEqual({
      kind: 'fields',
      rows: [
        { label: 'Branch', value: 'feature/x' },
        { label: 'Worktree', value: '/path/to/worktree' },
        { label: 'Repo', value: '/path/to/repo' },
      ],
    });
  });

  it('omits rows whose underlying field is absent', () => {
    const encoded = encodeWorkStartedDetail({ repoPath: '/path/to/repo' });
    expect(renderWorkStartedActivityDetail(encoded)).toEqual({
      kind: 'fields',
      rows: [{ label: 'Repo', value: '/path/to/repo' }],
    });
  });

  it('returns undefined for undecodable detail (lets core fall back to plain text)', () => {
    expect(renderWorkStartedActivityDetail(undefined)).toBeUndefined();
    expect(renderWorkStartedActivityDetail('not json')).toBeUndefined();
    expect(renderWorkStartedActivityDetail(JSON.stringify({ v: 99 }))).toBeUndefined();
  });

  it('renders legacy unversioned entries (backward compatibility)', () => {
    const legacy = JSON.stringify({ branchName: 'feature/x', repoPath: '/r' });
    expect(renderWorkStartedActivityDetail(legacy)).toEqual({
      kind: 'fields',
      rows: [
        { label: 'Branch', value: 'feature/x' },
        { label: 'Repo', value: '/r' },
      ],
    });
  });
});

describe('encodeWorkStartedDetail (extra invariants)', () => {
  it('round-trips when only repoPath is set', () => {
    const encoded = encodeWorkStartedDetail({ repoPath: '/r' });
    expect(decodeWorkStartedDetail(encoded)).toEqual({ v: 1, repoPath: '/r' });
  });

  it('always stamps v: 1 even if the caller tries to pass v', () => {
    // Compile-time `Omit<…, 'v'>` blocks this; the cast simulates a runtime
    // refactor that loosens the type. The encoder must still write v: 1.
    const encoded = encodeWorkStartedDetail({ repoPath: '/r', v: 99 } as unknown as Parameters<typeof encodeWorkStartedDetail>[0]);
    expect(JSON.parse(encoded).v).toBe(1);
  });
});
