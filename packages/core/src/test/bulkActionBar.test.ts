// @vitest-environment jsdom
import { h, render } from 'preact';
import { act } from 'preact/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BulkActionBar } from '../webview/sidebar/components/BulkActionBar';
import type { BulkAction } from '../webview/sidebar/bulkActions';

const transitionAction: BulkAction = {
  id: 'start',
  label: 'Start',
  icon: '▶',
  kind: 'transition',
  targetState: 'InProgress' as never,
};

describe('BulkActionBar', () => {
  afterEach(() => {
    render(null, document.body);
    document.body.innerHTML = '';
  });

  async function mount(props: {
    onAction: (action: BulkAction) => boolean;
    onClear?: () => void;
  }): Promise<{ unmount: () => Promise<void>; action: HTMLElement; clear: HTMLElement }> {
    const container = document.createElement('div');
    document.body.appendChild(container);
    await act(async () => {
      render(
        h(BulkActionBar, {
          count: 2,
          actions: [transitionAction],
          onAction: props.onAction,
          onClear: props.onClear ?? vi.fn(),
        }),
        container,
      );
    });
    const action = container.querySelector('.bulk-action-btn:not(.bulk-action-clear)') as HTMLElement;
    const clear = container.querySelector('.bulk-action-clear') as HTMLElement;
    return {
      action,
      clear,
      unmount: async () => {
        await act(async () => {
          render(null, container);
        });
      },
    };
  }

  it('restores focus to the previously-focused element if onAction returns false', async () => {
    const originator = document.createElement('button');
    originator.textContent = 'Origin';
    document.body.appendChild(originator);
    originator.focus();
    expect(document.activeElement).toBe(originator);

    const { action, unmount } = await mount({ onAction: () => false });

    // Move focus into the bar so the focus-restore preconditions are met
    // (barReceivedFocus, focusStillInsideBar / focusLost).
    action.focus();
    expect(document.activeElement).toBe(action);

    // Simulate the user activating the action button on an empty selection:
    // onAction returns false (no real dispatch), so the bar must NOT
    // suppress its own focus restore on subsequent unmount.
    action.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    action.focus();

    await unmount();
    expect(document.activeElement).toBe(originator);
  });

  it('suppresses its own restore once onAction reports a successful dispatch', async () => {
    const originator = document.createElement('button');
    originator.textContent = 'Origin';
    document.body.appendChild(originator);
    originator.focus();

    const { action, unmount } = await mount({ onAction: () => true });
    action.focus();
    action.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    action.focus();

    await unmount();
    // Bar yielded to the App-level restore (not present in this isolated
    // test), so focus falls back to body. The critical assertion is that
    // the bar did NOT restore on its own — that would have re-focused
    // `originator`.
    expect(document.activeElement).not.toBe(originator);
  });
});
