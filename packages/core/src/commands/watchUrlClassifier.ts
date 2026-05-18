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
  watcherRegistry: Pick<WatcherRegistry, 'findWatcherForUrl' | 'getAll'>,
  prWatcherRegistry: Pick<PRWatcherRegistry, 'findWatcherForUrl' | 'getAll'>,
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
    return {
      ok: true,
      kind: 'pr',
      url: trimmed,
      watcher: prWatcher,
      validationMessage: `Recognized by ${prWatcher.label} — will be added as a PR watch.`,
    };
  }

  const runWatcher = watcherRegistry.findWatcherForUrl(trimmed);
  if (runWatcher) {
    return {
      ok: true,
      kind: 'run',
      url: trimmed,
      watcher: runWatcher,
      validationMessage: `Recognized by ${runWatcher.label} — will be added as a run watch.`,
    };
  }

  return {
    ok: false,
    reason: 'unsupported',
    message: buildUnsupportedMessage(watcherRegistry, prWatcherRegistry),
  };
}

function buildUnsupportedMessage(
  watcherRegistry: Pick<WatcherRegistry, 'getAll'>,
  prWatcherRegistry: Pick<PRWatcherRegistry, 'getAll'>,
): string {
  const labels = [
    ...prWatcherRegistry.getAll().map(w => w.label),
    ...watcherRegistry.getAll().map(w => w.label),
  ];
  if (labels.length === 0) {
    return 'Unsupported URL. No pull request or pipeline run watchers are currently registered. Install a provider extension that contributes a watcher.';
  }
  return `Unsupported URL. Paste a URL recognized by one of: ${labels.join(', ')}.`;
}
