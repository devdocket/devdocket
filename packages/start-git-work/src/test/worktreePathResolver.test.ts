import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as path from 'path';

vi.mock('fs', () => ({ existsSync: vi.fn(() => false) }));

import * as fs from 'fs';
import {
  getDefaultWorktreePath,
  repoBaseNameFromCloneUrl,
  sourceRepoBaseName,
  toWorktreePathSuffix,
  validateWorktreePath,
  workItemNumber,
} from '../worktreePathResolver';

function workItem(overrides: Partial<any> = {}) {
  return {
    id: 'wc-test-1',
    title: 'Test item',
    state: 'InProgress',
    providerId: 'provider',
    externalId: 'item-1',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
}

describe('worktreePathResolver', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(fs.existsSync).mockReturnValue(false);
  });

  it('uses source repo label and issue number for numbered issue worktree names', () => {
    const item = workItem({ externalId: 'dotnet/sdk#53921' });

    expect(getDefaultWorktreePath('/mock/sdk', 'issue-53921-fix-foo', item, {
      kind: 'issue',
      cloneUrl: 'https://example.com/dotnet/sdk.git',
      repoLabel: 'dotnet/sdk',
    })).toBe(path.join('/mock', 'sdk-issue-53921'));
  });

  it('uses source repo label and PR number for numbered PR worktree names', () => {
    const item = workItem({ externalId: 'org/project/repo!42' });

    expect(getDefaultWorktreePath('/mock/workspace', 'feature/topic', item, {
      kind: 'pr',
      cloneUrl: 'https://dev.azure.com/org/project/_git/repo',
      repoLabel: 'org/project/repo',
    })).toBe(path.join('/mock', 'repo-pr-42'));
  });

  it('falls back to local repo, ref slug, and stable identity when no item number exists', () => {
    const item = workItem({ externalId: 'work-item' });
    const defaultPath = getDefaultWorktreePath('/mock/workspace', 'feature/topic', item, {
      kind: 'pr',
      cloneUrl: 'https://example.com/acme/repo.git',
    });

    expect(path.basename(defaultPath)).toMatch(/^workspace-feature-topic-[a-z0-9]{6}$/);
    expect(getDefaultWorktreePath('/mock/workspace', 'feature/topic', item, {
      kind: 'pr',
      cloneUrl: 'https://example.com/acme/repo.git',
    })).toBe(defaultPath);
  });

  it('extracts work item numbers from hash, bang, slash, underscore, and hyphen forms', () => {
    expect(workItemNumber('owner/repo#123')).toBe('123');
    expect(workItemNumber('org/project/repo!42')).toBe('42');
    expect(workItemNumber('work/55')).toBe('55');
    expect(workItemNumber('work_66')).toBe('66');
    expect(workItemNumber('work-77')).toBe('77');
    expect(workItemNumber('work-item')).toBeUndefined();
  });

  it('derives sanitized repo base names from labels and clone URLs', () => {
    expect(sourceRepoBaseName({ kind: 'issue', cloneUrl: 'https://example.com/acme/repo.git', repoLabel: 'Vendor Repo' }, '/local/repo')).toBe('Vendor-Repo');
    expect(repoBaseNameFromCloneUrl('https://example.com/acme/repo.git')).toBe('repo');
    expect(repoBaseNameFromCloneUrl('git@example.com:acme/repo.git')).toBe('repo');
    expect(toWorktreePathSuffix('feature/topic with spaces')).toBe('feature-topic-with-spaces');
    expect(toWorktreePathSuffix('///')).toBe('branch');
  });

  it('validates worktree paths with the same messages used by prompts', () => {
    const outsideTarget = path.join(path.parse(process.cwd()).root, 'devdocket-test-worktrees', 'target');
    const outsideParent = path.dirname(outsideTarget);

    expect(validateWorktreePath('', '/mock/workspace')).toBe('Worktree path is required.');
    expect(validateWorktreePath('relative-worktree', '/mock/workspace')).toBe('Worktree path must be absolute.');

    vi.mocked(fs.existsSync).mockReturnValue(false);
    expect(validateWorktreePath(outsideTarget, '/mock/workspace')).toContain('does not exist');

    vi.mocked(fs.existsSync).mockImplementation((p: any) => path.resolve(p.toString()) === path.resolve(outsideParent));
    expect(validateWorktreePath(outsideTarget, '/mock/workspace')).toBeUndefined();
    expect(validateWorktreePath(`  ${outsideTarget}  `, '/mock/workspace')).toBeUndefined();

    vi.mocked(fs.existsSync).mockImplementation((p: any) => {
      const resolved = path.resolve(p.toString());
      return resolved === path.resolve(outsideParent) || resolved === path.resolve(outsideTarget);
    });
    expect(validateWorktreePath(outsideTarget, '/mock/workspace')).toContain('already exists');

    const nestedTarget = path.join('/mock', 'workspace', 'nested-parent', 'target');
    const nestedParent = path.dirname(nestedTarget);
    vi.mocked(fs.existsSync).mockImplementation((p: any) => path.resolve(p.toString()) === path.resolve(nestedParent));
    expect(validateWorktreePath(nestedTarget, '/mock/workspace')).toBe('Worktree parent directory must not be inside the source repository.');
  });
});
