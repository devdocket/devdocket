// @vitest-environment jsdom
import { h, render } from 'preact';
import { act } from 'preact/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TierData } from '../views/mainTypes';

describe('sidebar Accept All payload', () => {
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

  it('posts the rendered incoming provider/external ids when Accept All is clicked', async () => {
    const postMessage = vi.fn();
    vi.stubGlobal('acquireVsCodeApi', () => ({
      postMessage,
      getState: vi.fn(),
      setState: vi.fn(),
    }));

    const { App } = await import('../webview/sidebar/App');
    container = document.createElement('div');
    document.body.appendChild(container);

    await act(async () => {
      render(h(App, {}), container!);
    });

    await act(async () => {
      window.dispatchEvent(new MessageEvent('message', {
        data: {
          type: 'updateItems',
          tiers: [makeIncomingTier()],
        },
      }));
    });

    const acceptAll = Array.from(container.querySelectorAll('button'))
      .find(button => button.textContent?.trim() === 'Accept All');
    expect(acceptAll).toBeInstanceOf(HTMLButtonElement);

    acceptAll!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));

    expect(postMessage).toHaveBeenCalledWith({
      type: 'acceptAll',
      items: [
        { providerId: 'github', externalId: 'visible-1' },
        { providerId: 'ado', externalId: 'visible-2' },
      ],
    });
  });
});

function makeIncomingTier(): TierData {
  return {
    id: 'incoming',
    name: 'Incoming',
    icon: '↓',
    collapsed: false,
    items: [
      {
        id: 'github::visible-1',
        title: 'Visible GitHub item',
        badges: [],
        tierType: 'incoming',
        providerId: 'github',
        externalId: 'visible-1',
      },
      {
        id: 'ado::visible-2',
        title: 'Visible ADO item',
        badges: [],
        tierType: 'incoming',
        providerId: 'ado',
        externalId: 'visible-2',
      },
    ],
  };
}
