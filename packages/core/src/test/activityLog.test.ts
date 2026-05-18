// @vitest-environment jsdom
import { h, render } from 'preact';
import { act } from 'preact/test-utils';
import { afterEach, describe, expect, it } from 'vitest';
import { ActivityLog } from '../webview/editor/components/ActivityLog';
import type { ActivityDetailRender } from '../api/types';

interface TestActivityEntry {
  timestamp: number;
  type: string;
  detail?: string;
  displayDetail?: ActivityDetailRender;
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

  it('renders displayDetail.fields as a labelled definition list', () => {
    renderActivityLog([{
      timestamp: Date.now(),
      type: 'work-started',
      detail: 'raw payload (should not be rendered)',
      displayDetail: {
        kind: 'fields',
        rows: [
          { label: 'Branch', value: 'feature/activity-renderer' },
          { label: 'Worktree', value: 'C:\\repos\\devdocket-activity-renderer' },
          { label: 'Repo', value: 'C:\\repos\\devdocket' },
        ],
      },
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

  it('renders displayDetail.text in place of the raw detail', () => {
    renderActivityLog([{
      timestamp: Date.now(),
      type: 'work-started',
      detail: 'ignored raw payload',
      displayDetail: { kind: 'text', text: 'pretty text from renderer' },
    }]);

    expandActivityLog();

    const detail = container!.querySelector('.activity-entry-detail');
    expect(detail).toBeInstanceOf(HTMLSpanElement);
    expect(detail!.textContent).toBe('pretty text from renderer');
  });

  it('falls back to raw detail when no displayDetail is provided', () => {
    const rawDetail = '{"branchName": "feature/x"}';
    renderActivityLog([{ timestamp: Date.now(), type: 'work-started', detail: rawDetail }]);

    expandActivityLog();

    const detail = container!.querySelector('.activity-entry-detail');
    expect(detail).toBeInstanceOf(HTMLSpanElement);
    expect(detail!.textContent).toBe(rawDetail);
  });

  it('renders plain detail strings verbatim', () => {
    renderActivityLog([{ timestamp: Date.now(), type: 'state-changed', detail: 'New → InProgress' }]);

    expandActivityLog();

    const detail = container!.querySelector('.activity-entry-detail');
    expect(detail).toBeInstanceOf(HTMLSpanElement);
    expect(detail!.textContent).toBe('New → InProgress');
  });

  it('renders nothing for the detail slot when both detail and displayDetail are absent', () => {
    renderActivityLog([{ timestamp: Date.now(), type: 'created' }]);

    expandActivityLog();

    const detail = container!.querySelector('.activity-entry-detail');
    expect(detail).toBeNull();
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
