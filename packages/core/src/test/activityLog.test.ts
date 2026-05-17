// @vitest-environment jsdom
import { h, render } from 'preact';
import { act } from 'preact/test-utils';
import { afterEach, describe, expect, it } from 'vitest';
import { ActivityLog } from '../webview/editor/components/ActivityLog';

interface TestActivityEntry {
  timestamp: number;
  type: string;
  detail?: string;
}

describe('ActivityLog', () => {
  let container: HTMLDivElement | undefined;

  afterEach(() => {
    if (container) {
      render(null, container);
      container.remove();
      container = undefined;
    }
  });

  it('renders work-started JSON detail as labelled fields', () => {
    renderActivityLog([{
      timestamp: Date.now(),
      type: 'work-started',
      detail: JSON.stringify({
        branchName: 'feature/activity-renderer',
        worktreePath: 'C:\\repos\\devdocket-activity-renderer',
        repoPath: 'C:\\repos\\devdocket',
      }),
    }]);

    expandActivityLog();

    const detail = container!.querySelector('.activity-entry-detail--structured');
    expect(detail).toBeInstanceOf(HTMLDListElement);
    expect(detail!.textContent).toContain('Branch:');
    expect(detail!.textContent).toContain('feature/activity-renderer');
    expect(detail!.textContent).toContain('Worktree:');
    expect(detail!.textContent).toContain('C:\\repos\\devdocket-activity-renderer');
    expect(detail!.textContent).toContain('Repo:');
    expect(detail!.textContent).toContain('C:\\repos\\devdocket');
  });

  it('falls back to raw detail when work-started JSON is invalid', () => {
    const rawDetail = '{"branchName":';
    renderActivityLog([{ timestamp: Date.now(), type: 'work-started', detail: rawDetail }]);

    expandActivityLog();

    const detail = container!.querySelector('.activity-entry-detail');
    expect(detail).toBeInstanceOf(HTMLSpanElement);
    expect(detail!.textContent).toBe(rawDetail);
  });

  it('renders other activity type details verbatim', () => {
    renderActivityLog([{ timestamp: Date.now(), type: 'state-changed', detail: 'New → InProgress' }]);

    expandActivityLog();

    const detail = container!.querySelector('.activity-entry-detail');
    expect(detail).toBeInstanceOf(HTMLSpanElement);
    expect(detail!.textContent).toBe('New → InProgress');
  });

  function renderActivityLog(entries: TestActivityEntry[]) {
    container = document.createElement('div');
    document.body.appendChild(container);
    render(h(ActivityLog, { entries }), container);
  }

  function expandActivityLog() {
    const toggle = container!.querySelector('button.editor-section-heading') as HTMLButtonElement | null;
    expect(toggle).toBeInstanceOf(HTMLButtonElement);
    act(() => {
      toggle!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });
  }
});
