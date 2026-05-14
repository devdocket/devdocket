import { describe, expect, it, vi } from 'vitest';
import type { DevDocketPRWatcher, DevDocketRunWatcher } from '@devdocket/shared';
import { classifyWatchUrl, WATCH_URL_PLACEHOLDER } from '../commands/watchUrlClassifier';

function createRunWatcher(id: string, label: string): DevDocketRunWatcher {
  return {
    id,
    label,
    canWatch: vi.fn(),
    parseRunUrl: vi.fn(),
    getRunStatus: vi.fn(),
  };
}

function createPRWatcher(id: string, label: string): DevDocketPRWatcher {
  return {
    id,
    label,
    canWatch: vi.fn(),
    parsePRUrl: vi.fn(),
    getPRRunsSnapshot: vi.fn(),
  };
}

describe('classifyWatchUrl', () => {
  it('provides GitHub PR and run examples for the shared input placeholder', () => {
    expect(WATCH_URL_PLACEHOLDER).toContain('https://github.com/owner/repo/pull/123');
    expect(WATCH_URL_PLACEHOLDER).toContain('https://github.com/owner/repo/actions/runs/12345');
  });

  it('classifies pull request URLs before run URLs', () => {
    const prWatcher = createPRWatcher('github-pr', 'GitHub Pull Requests');
    const runWatcher = createRunWatcher('github-actions', 'GitHub Actions');
    const watcherRegistry = { findWatcherForUrl: vi.fn(() => runWatcher) };
    const prWatcherRegistry = { findWatcherForUrl: vi.fn(() => prWatcher) };

    const result = classifyWatchUrl(' https://github.com/owner/repo/pull/123 ', watcherRegistry, prWatcherRegistry);

    expect(result).toMatchObject({ ok: true, kind: 'pr', url: 'https://github.com/owner/repo/pull/123', watcher: prWatcher });
    if (result.ok) {
      expect(result.validationMessage).toBe('This looks like a GitHub PR — will be added as a PR watch.');
    }
    expect(watcherRegistry.findWatcherForUrl).not.toHaveBeenCalled();
  });

  it('classifies run URLs when no PR watcher recognizes the URL', () => {
    const runWatcher = createRunWatcher('github-actions', 'GitHub Actions');
    const watcherRegistry = { findWatcherForUrl: vi.fn(() => runWatcher) };
    const prWatcherRegistry = { findWatcherForUrl: vi.fn(() => undefined) };

    const result = classifyWatchUrl('https://github.com/owner/repo/actions/runs/12345', watcherRegistry, prWatcherRegistry);

    expect(result).toMatchObject({ ok: true, kind: 'run', watcher: runWatcher });
    if (result.ok) {
      expect(result.validationMessage).toBe('This looks like a GitHub Actions run — will be added as a run watch.');
    }
  });

  it('uses the watcher label for non-canonical watcher IDs', () => {
    const runWatcher = createRunWatcher('github-advanced-security', 'GitHub Advanced Security');
    const result = classifyWatchUrl(
      'https://github.com/owner/repo/security/code-scanning/123',
      { findWatcherForUrl: vi.fn(() => runWatcher) },
      { findWatcherForUrl: vi.fn(() => undefined) },
    );

    expect(result.ok && result.validationMessage).toBe('This looks like a GitHub Advanced Security run — will be added as a run watch.');
  });

  it('classifies Azure DevOps PR and pipeline URLs with specific feedback', () => {
    const adoPRWatcher = createPRWatcher('ado-pr', 'Azure DevOps Pull Requests');
    const adoRunWatcher = createRunWatcher('ado-pipelines', 'Azure DevOps Pipelines');

    const prResult = classifyWatchUrl(
      'https://dev.azure.com/org/project/_git/repo/pullrequest/42',
      { findWatcherForUrl: vi.fn(() => undefined) },
      { findWatcherForUrl: vi.fn(() => adoPRWatcher) },
    );
    const runResult = classifyWatchUrl(
      'https://dev.azure.com/org/project/_build/results?buildId=123',
      { findWatcherForUrl: vi.fn(() => adoRunWatcher) },
      { findWatcherForUrl: vi.fn(() => undefined) },
    );

    expect(prResult.ok && prResult.validationMessage).toBe('This looks like an Azure DevOps PR — will be added as a PR watch.');
    expect(runResult.ok && runResult.validationMessage).toBe('This looks like an Azure DevOps Pipeline run — will be added as a run watch.');
  });

  it('rejects empty, non-http, and unsupported URLs with actionable messages', () => {
    const watcherRegistry = { findWatcherForUrl: vi.fn(() => undefined) };
    const prWatcherRegistry = { findWatcherForUrl: vi.fn(() => undefined) };

    expect(classifyWatchUrl('   ', watcherRegistry, prWatcherRegistry)).toEqual({ ok: false, reason: 'empty', message: 'URL cannot be empty.' });
    expect(classifyWatchUrl('file:///repo', watcherRegistry, prWatcherRegistry)).toEqual({ ok: false, reason: 'unsafe', message: 'Only http(s) URLs are supported.' });
    expect(classifyWatchUrl('https://example.com/nope', watcherRegistry, prWatcherRegistry)).toEqual({
      ok: false,
      reason: 'unsupported',
      message: 'Unsupported URL. Paste a supported pull request or pipeline run URL (for example, a GitHub PR, GitHub Actions run, Azure DevOps PR, or Azure DevOps pipeline run URL).',
    });
  });
});
