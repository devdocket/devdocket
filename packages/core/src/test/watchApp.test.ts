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

  it('renders completed runs without conclusions as neutral non-failures', async () => {
    await mountWatchApp();
    await sendUpdate([], [
      makeRunWatch({ id: 'run-completed', name: 'Completed run', state: 'completed' }),
    ]);

    const runSection = getSection('Run Watches');
    const runCard = runSection.querySelector('.tier-items > .item-card');
    expect(runCard).toBeInstanceOf(HTMLDivElement);
    expect(runCard!.classList.contains('item-card--done')).toBe(true);
    expect(runCard!.querySelector('.badge-pill')?.textContent).toBe('Completed');
    expect(runCard!.querySelector('.watch-row-preview')).toBeNull();
  });

  it('renders unknown completed conclusions as neutral non-failures', async () => {
    await mountWatchApp();
    await sendUpdate([], [
      makeRunWatch({ id: 'run-custom', name: 'Custom run', state: 'completed', conclusion: 'provider_future_value' }),
    ]);

    const runSection = getSection('Run Watches');
    const runCard = runSection.querySelector('.tier-items > .item-card');
    expect(runCard).toBeInstanceOf(HTMLDivElement);
    expect(runCard!.classList.contains('item-card--done')).toBe(true);
    expect(runCard!.classList.contains('item-card--urgent')).toBe(false);
    expect(runCard!.querySelector('.badge-pill')?.textContent).toBe('Provider future value');
  });

  it('renders partial-success runs as amber non-failures', async () => {
    await mountWatchApp();
    await sendUpdate([], [
      makeRunWatch({
        id: 'run-warn',
        name: 'Publish artifacts',
        state: 'completed',
        conclusion: 'partial_success',
        failurePreview: 'Conclusion: Succeeded with issues',
      }),
    ]);

    const runSection = getSection('Run Watches');
    const runCard = runSection.querySelector('.tier-items > .item-card');
    expect(runCard).toBeInstanceOf(HTMLDivElement);
    expect(runCard!.classList.contains('item-card--paused')).toBe(true);
    expect(runCard!.querySelector('.badge-pill')?.textContent).toBe('Succeeded with issues');
    expect((runCard!.querySelector('.badge-pill') as HTMLElement).style.color).toBe('rgb(204, 167, 0)');
    expect(runCard!.querySelector('.watch-row-preview')?.classList.contains('warning')).toBe(false);
  });

  it('does not auto-expand or show failure previews for partial-success PR child runs', async () => {
    await mountWatchApp();
    await sendUpdate([
      makePRWatch({
        runs: [
          makeRunWatch({ id: 'run-unit', name: 'Unit tests', state: 'completed', conclusion: 'success' }),
          makeRunWatch({
            id: 'run-publish',
            name: 'Publish artifacts',
            state: 'completed',
            conclusion: 'partial_success',
            failurePreview: 'Conclusion: Succeeded with issues',
          }),
        ],
      }),
    ]);

    const prSection = getSection('PR Watches');
    const prCard = prSection.querySelector('.tier-items > .item-card');
    expect(prCard).toBeInstanceOf(HTMLDivElement);
    expect(prCard!.classList.contains('item-card--urgent')).toBe(false);
    expect(prCard!.querySelector('.watch-row-preview')).toBeNull();
    expect(prSection.textContent).toContain('Checks: ✓ 1 passed · ✗ 0 failed · ⏳ 0 running · ⚠ 1 succeeded with issues (2 total)');
    expect(prSection.querySelector('.watch-card-details')).toBeNull();
  });

  it('title-cases conclusion badge labels', async () => {
    await mountWatchApp();
    await sendUpdate([], [
      makeRunWatch({ id: 'run-failure', name: 'Failure run', state: 'completed', conclusion: 'failure' }),
      makeRunWatch({ id: 'run-timeout', name: 'Timeout run', state: 'completed', conclusion: 'timed_out' }),
      makeRunWatch({ id: 'run-action', name: 'Action run', state: 'completed', conclusion: 'action_required' }),
      makeRunWatch({ id: 'run-neutral', name: 'Neutral run', state: 'completed', conclusion: 'neutral' }),
    ]);

    const runSection = getSection('Run Watches');
    expect(Array.from(runSection.querySelectorAll('.badge-pill')).map(badge => badge.textContent)).toEqual([
      'Failure',
      'Timed out',
      'Action required',
      'Neutral',
    ]);
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

  it('scrolls the matching watch row into view when focusWatch arrives', async () => {
    await mountWatchApp();
    await sendUpdate([
      makePRWatch({ id: 'pr:github-pr:owner/repo:1', title: 'PR one' }),
      makePRWatch({ id: 'pr:github-pr:owner/repo:2', title: 'PR two' }),
    ]);

    const targetCard = container!.querySelector<HTMLElement>('[data-watch-id="pr:github-pr:owner/repo:2"]');
    expect(targetCard).toBeInstanceOf(HTMLDivElement);
    const scrollIntoView = vi.fn();
    targetCard!.scrollIntoView = scrollIntoView;
    // jsdom doesn't implement requestAnimationFrame consistently — stub to run synchronously.
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { cb(0); return 0; });
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })));

    await act(async () => {
      window.dispatchEvent(new MessageEvent('message', {
        data: { type: 'focusWatch', watchId: 'pr:github-pr:owner/repo:2' },
      }));
    });

    expect(scrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth', block: 'center' });
    expect(targetCard!.classList.contains('watch-card-focused')).toBe(true);

    // Other rows are not highlighted.
    const otherCard = container!.querySelector<HTMLElement>('[data-watch-id="pr:github-pr:owner/repo:1"]');
    expect(otherCard!.classList.contains('watch-card-focused')).toBe(false);
  });

  it('uses non-smooth scrolling when prefers-reduced-motion is enabled', async () => {
    await mountWatchApp();
    await sendUpdate([makePRWatch({ id: 'pr:github-pr:owner/repo:9', title: 'PR nine' })]);

    const targetCard = container!.querySelector<HTMLElement>('[data-watch-id="pr:github-pr:owner/repo:9"]');
    const scrollIntoView = vi.fn();
    targetCard!.scrollIntoView = scrollIntoView;
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { cb(0); return 0; });
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() })));

    await act(async () => {
      window.dispatchEvent(new MessageEvent('message', {
        data: { type: 'focusWatch', watchId: 'pr:github-pr:owner/repo:9' },
      }));
    });

    expect(scrollIntoView).toHaveBeenCalledWith({ behavior: 'auto', block: 'center' });
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
