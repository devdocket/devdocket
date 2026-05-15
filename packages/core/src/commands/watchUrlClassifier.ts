import type { DevDocketPRWatcher, DevDocketRunWatcher } from '@devdocket/shared';
import type { PRWatcherRegistry } from '../services/prWatcherRegistry';
import type { WatcherRegistry } from '../services/watcherRegistry';
import { isSafeUrl } from '../utils/url';

export const WATCH_URL_PLACEHOLDER = 'Pull request or pipeline run URL';

export type WatchUrlClassification =
  | {
    ok: true;
    kind: 'pr';
    url: string;
    watcher: DevDocketPRWatcher;
    validationMessage: string;
  }
  | {
    ok: true;
    kind: 'run';
    url: string;
    watcher: DevDocketRunWatcher;
    validationMessage: string;
  }
  | {
    ok: false;
    reason: 'empty' | 'unsafe' | 'unsupported';
    message: string;
  };

export function classifyWatchUrl(
  value: string,
  watcherRegistry: Pick<WatcherRegistry, 'findWatcherForUrl'>,
  prWatcherRegistry: Pick<PRWatcherRegistry, 'findWatcherForUrl'>,
): WatchUrlClassification {
  const trimmed = value.trim();
  if (!trimmed) {
    return { ok: false, reason: 'empty', message: 'URL cannot be empty.' };
  }

  if (!isSafeUrl(trimmed)) {
    return { ok: false, reason: 'unsafe', message: 'Only http(s) URLs are supported.' };
  }

  const prWatcher = prWatcherRegistry.findWatcherForUrl(trimmed);
  if (prWatcher) {
    const providerName = providerDisplayName(prWatcher);
    return {
      ok: true,
      kind: 'pr',
      url: trimmed,
      watcher: prWatcher,
      validationMessage: `This looks like ${indefiniteArticle(providerName)} ${providerName} PR — will be added as a PR watch.`,
    };
  }

  const runWatcher = watcherRegistry.findWatcherForUrl(trimmed);
  if (runWatcher) {
    const providerName = providerDisplayName(runWatcher);
    return {
      ok: true,
      kind: 'run',
      url: trimmed,
      watcher: runWatcher,
      validationMessage: `This looks like ${indefiniteArticle(providerName)} ${providerName} run — will be added as a run watch.`,
    };
  }

  return {
    ok: false,
    reason: 'unsupported',
    message: 'Unsupported URL. Paste a supported pull request or pipeline run URL (for example, a GitHub PR, GitHub Actions run, Azure DevOps PR, or Azure DevOps pipeline run URL).',
  };
}

function providerDisplayName(watcher: { id: string; label: string }): string {
  switch (watcher.id) {
    case 'github-pr':
      return 'GitHub';
    case 'github-actions':
      return 'GitHub Actions';
    case 'ado-pr':
      return 'Azure DevOps';
    case 'ado-pipelines':
      return 'Azure DevOps Pipeline';
    default:
      return watcher.label;
  }
}

function indefiniteArticle(value: string): 'a' | 'an' {
  return /^[aeiou]/i.test(value) ? 'an' : 'a';
}
