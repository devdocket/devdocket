// @vitest-environment jsdom
import { h, render } from 'preact';
import { act } from 'preact/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PRWatchData, RunWatchData } from '../views/mainTypes';

describe('WatchApp PR watch rendering', () => {
  let container: HTMLDivElement | undefined;

  afterEach(() => {
    if (container) {
      render(null, container);
      container.remove();
      container = undefined;
    }
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('renders one top-level PR card with a roll-up and expands passing/running runs on demand', async () => {
    await mountWatchApp();
    await sendUpdate([
      makePRWatch({
        runs: [
          makeRunWatch({ id: 'run-unit', name: 'Unit tests', state: 'completed', conclusion: 'success' }),
          makeRunWatch({ id: 'run-lint', name: 'Lint', state: 'in_progress' }),
        ],
      }),
    ]);

    const prSection = getSection('PR Watches');
    expect(prSection.querySelectorAll('.tier-items > .item-card')).toHaveLength(1);
    expect(prSection.textContent).toContain('Checks: ✓ 1 passed · ✗ 0 failed · ⏳ 1 running (2 total)');
    expect(prSection.textContent).not.toContain('Unit tests');
    expect(prSection.textContent).not.toContain('Lint');

    const expandButton = prSection.querySelector<HTMLButtonElement>('button[aria-label="Expand runs for Add grouped PR watches"]');
    expect(expandButton).toBeInstanceOf(HTMLButtonElement);

    await act(async () => {
      expandButton!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });

    expect(prSection.querySelectorAll('.tier-items > .item-card')).toHaveLength(1);
    expect(prSection.querySelectorAll('.watch-card-details .item-card')).toHaveLength(2);
    expect(prSection.textContent).toContain('Unit tests');
    expect(prSection.textContent).toContain('Lint');
    expect(findButton(prSection, label => label.startsWith('Dismiss Unit tests'))).toBeUndefined();
    expect(findButton(prSection, label => label.startsWith('Dismiss Lint'))).toBeUndefined();
  });

  it('auto-expands failing runs and previews the child failure on the PR card', async () => {
    await mountWatchApp();
    await sendUpdate([
      makePRWatch({
        runs: [
          makeRunWatch({ id: 'run-unit', name: 'Unit tests', state: 'completed', conclusion: 'success' }),
          makeRunWatch({
            id: 'run-e2e',
            name: 'E2E tests',
            state: 'completed',
            conclusion: 'failure',
            failurePreview: 'Failed job: e2e',
          }),
        ],
      }),
    ]);

    const prSection = getSection('PR Watches');
    const prCard = prSection.querySelector('.tier-items > .item-card');
    expect(prCard).toBeInstanceOf(HTMLDivElement);
    expect(prCard!.classList.contains('item-card--urgent')).toBe(true);
    expect(prCard!.querySelector('.watch-row-preview')?.textContent).toBe('Failed job: e2e');
    expect(prSection.textContent).toContain('Checks: ✓ 1 passed · ✗ 1 failed · ⏳ 0 running (2 total)');
    expect(prSection.querySelectorAll('.watch-card-details .item-card')).toHaveLength(2);
    expect(prSection.textContent).toContain('E2E tests');
  });

  it('hides roll-up and disclosure controls for PR watches without runs', async () => {
    await mountWatchApp();
    await sendUpdate([makePRWatch()]);

    const prSection = getSection('PR Watches');
    expect(prSection.querySelectorAll('.tier-items > .item-card')).toHaveLength(1);
    expect(prSection.querySelector('.watch-run-summary')).toBeNull();
    expect(findButton(prSection, label => label === 'Expand runs for Add grouped PR watches')).toBeUndefined();
    expect(prSection.querySelector('.watch-card-details')).toBeNull();
  });

  it('keeps standalone run watches as flat cards', async () => {
    await mountWatchApp();
    await sendUpdate([], [
      makeRunWatch({ id: 'run-deploy', name: 'Deploy', state: 'in_progress' }),
      makeRunWatch({ id: 'run-smoke', name: 'Smoke tests', state: 'completed', conclusion: 'success' }),
    ]);

    const runSection = getSection('Run Watches');
    expect(runSection.querySelectorAll('.tier-items > .item-card')).toHaveLength(2);
    expect(runSection.querySelectorAll('.watch-card-details .item-card')).toHaveLength(0);
    expect(runSection.textContent).toContain('Deploy');
    expect(runSection.textContent).toContain('Smoke tests');
  });

  async function mountWatchApp() {
    vi.stubGlobal('acquireVsCodeApi', () => ({
      postMessage: vi.fn(),
      getState: vi.fn(),
      setState: vi.fn(),
    }));
    const { WatchApp } = await import('../webview/watchPanel/WatchApp');
    container = document.createElement('div');
    document.body.appendChild(container);
    await act(async () => {
      render(h(WatchApp, {}), container!);
    });
  }

  async function sendUpdate(prWatches: PRWatchData[], runWatches: RunWatchData[] = []) {
    await act(async () => {
      window.dispatchEvent(new MessageEvent('message', {
        data: {
          type: 'updateWatchPanel',
          prWatches,
          runWatches,
        },
      }));
    });
  }

  function getSection(name: string): HTMLElement {
    const section = Array.from(container!.querySelectorAll<HTMLElement>('.tier-section'))
      .find(candidate => candidate.textContent?.includes(name));
    expect(section).toBeInstanceOf(HTMLElement);
    return section!;
  }

  function findButton(root: HTMLElement, predicate: (ariaLabel: string) => boolean): HTMLButtonElement | undefined {
    return Array.from(root.querySelectorAll<HTMLButtonElement>('button'))
      .find(button => predicate(button.getAttribute('aria-label') ?? ''));
  }
});

function makePRWatch(overrides: Partial<PRWatchData> = {}): PRWatchData {
  return {
    id: 'pr:github-pr:owner/repo:42',
    title: 'Add grouped PR watches',
    repo: 'owner/repo',
    state: 'open',
    url: 'https://github.com/owner/repo/pull/42',
    runs: [],
    ...overrides,
  };
}

function makeRunWatch(overrides: Partial<RunWatchData> = {}): RunWatchData {
  return {
    id: 'run-ci',
    name: 'CI',
    repo: 'owner/repo',
    state: 'queued',
    url: 'https://github.com/owner/repo/actions/runs/100',
    ...overrides,
  };
}
