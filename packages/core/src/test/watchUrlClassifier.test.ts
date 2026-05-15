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
  it('uses a short hint placeholder describing the accepted URL types', () => {
    expect(WATCH_URL_PLACEHOLDER).toBe('Pull request or pipeline run URL');
  });

  it('classifies pull request URLs before run URLs', () => {
    const prWatcher = createPRWatcher('github-pr', 'GitHub Pull Requests');
    const runWatcher = createRunWatcher('github-actions', 'GitHub Actions');
    const watcherRegistry = { findWatcherForUrl: vi.fn(() => runWatcher), getAll: vi.fn(() => [runWatcher]) };
    const prWatcherRegistry = { findWatcherForUrl: vi.fn(() => prWatcher), getAll: vi.fn(() => [prWatcher]) };

    const result = classifyWatchUrl(' https://github.com/owner/repo/pull/123 ', watcherRegistry, prWatcherRegistry);

    expect(result).toMatchObject({ ok: true, kind: 'pr', url: 'https://github.com/owner/repo/pull/123', watcher: prWatcher });
    if (result.ok) {
      expect(result.validationMessage).toBe('Recognized by GitHub Pull Requests — will be added as a PR watch.');
    }
    expect(watcherRegistry.findWatcherForUrl).not.toHaveBeenCalled();
  });

  it('classifies run URLs when no PR watcher recognizes the URL', () => {
    const runWatcher = createRunWatcher('github-actions', 'GitHub Actions');
    const watcherRegistry = { findWatcherForUrl: vi.fn(() => runWatcher), getAll: vi.fn(() => [runWatcher]) };
    const prWatcherRegistry = { findWatcherForUrl: vi.fn(() => undefined), getAll: vi.fn(() => []) };

    const result = classifyWatchUrl('https://github.com/owner/repo/actions/runs/12345', watcherRegistry, prWatcherRegistry);

    expect(result).toMatchObject({ ok: true, kind: 'run', watcher: runWatcher });
    if (result.ok) {
      expect(result.validationMessage).toBe('Recognized by GitHub Actions — will be added as a run watch.');
    }
  });

  it('uses the watcher label for any watcher (no hardcoded provider knowledge in core)', () => {
    const runWatcher = createRunWatcher('github-advanced-security', 'GitHub Advanced Security');
    const result = classifyWatchUrl(
      'https://github.com/owner/repo/security/code-scanning/123',
      { findWatcherForUrl: vi.fn(() => runWatcher), getAll: vi.fn(() => [runWatcher]) },
      { findWatcherForUrl: vi.fn(() => undefined), getAll: vi.fn(() => []) },
    );

    expect(result.ok && result.validationMessage).toBe('Recognized by GitHub Advanced Security — will be added as a run watch.');
  });

  it('classifies Azure DevOps PR and pipeline URLs using the watcher label', () => {
    const adoPRWatcher = createPRWatcher('ado-pr', 'Azure DevOps Pull Requests');
    const adoRunWatcher = createRunWatcher('ado-pipelines', 'Azure DevOps Pipelines');

    const prResult = classifyWatchUrl(
      'https://dev.azure.com/org/project/_git/repo/pullrequest/42',
      { findWatcherForUrl: vi.fn(() => undefined), getAll: vi.fn(() => []) },
      { findWatcherForUrl: vi.fn(() => adoPRWatcher), getAll: vi.fn(() => [adoPRWatcher]) },
    );
    const runResult = classifyWatchUrl(
      'https://dev.azure.com/org/project/_build/results?buildId=123',
      { findWatcherForUrl: vi.fn(() => adoRunWatcher), getAll: vi.fn(() => [adoRunWatcher]) },
      { findWatcherForUrl: vi.fn(() => undefined), getAll: vi.fn(() => []) },
    );

    expect(prResult.ok && prResult.validationMessage).toBe('Recognized by Azure DevOps Pull Requests — will be added as a PR watch.');
    expect(runResult.ok && runResult.validationMessage).toBe('Recognized by Azure DevOps Pipelines — will be added as a run watch.');
  });

  it('rejects empty, non-http, and unsupported URLs with actionable messages', () => {
    const prWatcher = createPRWatcher('github-pr', 'GitHub Pull Requests');
    const runWatcher = createRunWatcher('github-actions', 'GitHub Actions');
    const watcherRegistry = { findWatcherForUrl: vi.fn(() => undefined), getAll: vi.fn(() => [runWatcher]) };
    const prWatcherRegistry = { findWatcherForUrl: vi.fn(() => undefined), getAll: vi.fn(() => [prWatcher]) };

    expect(classifyWatchUrl('   ', watcherRegistry, prWatcherRegistry)).toEqual({ ok: false, reason: 'empty', message: 'URL cannot be empty.' });
    expect(classifyWatchUrl('file:///repo', watcherRegistry, prWatcherRegistry)).toEqual({ ok: false, reason: 'unsafe', message: 'Only http(s) URLs are supported.' });
    expect(classifyWatchUrl('https://example.com/nope', watcherRegistry, prWatcherRegistry)).toEqual({
      ok: false,
      reason: 'unsupported',
      message: 'Unsupported URL. Paste a URL recognized by one of: GitHub Pull Requests, GitHub Actions.',
    });
  });

  it('reports a helpful message when no watchers are registered', () => {
    const empty = { findWatcherForUrl: vi.fn(() => undefined), getAll: vi.fn(() => []) };
    const result = classifyWatchUrl('https://example.com/nope', empty, empty);
    expect(result).toEqual({
      ok: false,
      reason: 'unsupported',
      message: 'Unsupported URL. No pull request or pipeline run watchers are currently registered. Install a provider extension that contributes a watcher.',
    });
  });
});
