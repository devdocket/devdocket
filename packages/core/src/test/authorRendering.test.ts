// @vitest-environment jsdom
import { h, render } from 'preact';
import { act } from 'preact/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProviderItem } from '../api/types';
import { WorkItemState, type WorkItem } from '../models/workItem';
import { MainViewProvider } from '../views/mainViewProvider';
import type { EditorItemData, ItemCardData } from '../views/mainTypes';
import { WorkItemEditorPanel } from '../views/workItemEditorPanel';
import { ItemCard } from '../webview/sidebar/components/ItemCard';

declare global {
  interface Window {
    __DEVDOCKET_EDITOR_BOOTSTRAP__?: EditorItemData;
  }
}

const badge = { label: 'GitHub', type: 'provider' as const, variant: 'github' };

function makeCardItem(overrides: Partial<ItemCardData> = {}): ItemCardData {
  return {
    id: 'item-1',
    title: 'Fix bug',
    badges: [badge],
    repoAnnotation: 'owner/repo',
    tierType: 'incoming',
    ...overrides,
  };
}

function makeEditorItem(overrides: Partial<EditorItemData> = {}): EditorItemData {
  const now = Date.now();
  return {
    id: 'item-1',
    title: 'Fix bug',
    state: 'New',
    notes: '',
    createdAt: now,
    updatedAt: now,
    badges: [],
    isProviderManaged: true,
    validTransitions: [],
    hasActions: false,
    activityLog: [],
    relatedItems: [],
    ...overrides,
  };
}

function renderCard(item: ItemCardData): HTMLDivElement {
  const container = document.createElement('div');
  document.body.appendChild(container);
  render(h(ItemCard, { item, tabIndex: 0, onClick: vi.fn() }), container);
  return container;
}

function createMainViewProvider(): MainViewProvider {
  return new MainViewProvider(
    {} as any,
    {} as any,
    { getProviderLabel: () => 'GitHub' } as any,
    {} as any,
    { has: () => false } as any,
    { getActiveWatches: () => [], getActivePRWatches: () => [] } as any,
  );
}

afterEach(() => {
  render(null, document.body);
  document.body.innerHTML = '';
  delete window.__DEVDOCKET_EDITOR_BOOTSTRAP__;
  delete (window as any).__DEVDOCKET_VSCODE_API__;
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.resetModules();
});

describe('author view-model plumbing', () => {
  it('copies provider author onto incoming card data', () => {
    const provider = createMainViewProvider();
    const providerItem: ProviderItem = {
      externalId: 'owner/repo#1',
      title: '#1: Fix bug',
      group: 'owner/repo',
      author: { displayName: 'Octocat', handle: 'octocat', avatarUrl: 'https://example.test/avatar.png' },
    };

    const card = (provider as any).buildIncomingCardData('github', providerItem, new Map(), undefined, { byWorkItemId: new Map(), byProviderItemKey: new Map() }) as ItemCardData;

    expect(card.author).toEqual({ displayName: 'Octocat', handle: 'octocat' });
  });

  it('copies provider author onto editor data for linked work items', () => {
    const providerItem: ProviderItem = {
      externalId: 'owner/repo#1',
      title: '#1: Fix bug',
      authored: true,
      author: { displayName: 'Octocat', handle: 'octocat' },
    };
    const panel = Object.create(WorkItemEditorPanel.prototype) as any;
    panel.getProviderItem = () => providerItem;
    panel.providerRegistry = { getProviderLabel: () => 'GitHub', getProvider: () => ({}), getAllProviderItems: () => new Map() };
    panel.actionRegistry = { hasActionsFor: () => false };
    panel.workGraph = {};
    panel.buildCIWatchData = () => undefined;

    const workItem: WorkItem = {
      id: 'item-1',
      title: 'Fix bug',
      state: WorkItemState.New,
      createdAt: 1,
      updatedAt: 2,
      providerId: 'github',
      externalId: 'owner/repo#1',
      activityLog: [],
    };

    const editorItem = panel.buildEditorItemData(workItem, new Map()) as EditorItemData;

    expect(editorItem.author).toEqual({ displayName: 'Octocat', handle: 'octocat' });
    expect(editorItem.authored).toBe(true);
  });
});

describe('ItemCard author annotation', () => {
  it('renders author inline with the repo annotation', () => {
    const container = renderCard(makeCardItem({ author: { displayName: 'Octocat', handle: 'octocat' } }));

    expect(container.querySelector('.item-repo-annotation')?.textContent).toBe('owner/repo · @octocat');
  });

  it('renders unchanged when author is missing', () => {
    const container = renderCard(makeCardItem());

    expect(container.querySelector('.item-repo-annotation')?.textContent).toBe('owner/repo');
  });

  it('prefers display name when the handle is an email address', () => {
    const container = renderCard(makeCardItem({ author: { displayName: 'Jane Example', handle: 'jane@example.com' } }));

    expect(container.querySelector('.item-repo-annotation')?.textContent).toBe('owner/repo · Jane Example');
  });

  it('suppresses the author annotation for self-authored items', () => {
    const container = renderCard(makeCardItem({ author: { displayName: 'Octocat', handle: 'octocat' }, authored: true }));

    expect(container.querySelector('.item-repo-annotation')?.textContent).toBe('owner/repo');
  });

});

describe('EditorApp author annotation', () => {
  async function renderEditorWithPostMessage(item: EditorItemData): Promise<{ container: HTMLDivElement; postMessage: ReturnType<typeof vi.fn> }> {
    const postMessage = vi.fn();
    delete (window as any).__DEVDOCKET_VSCODE_API__;
    vi.stubGlobal('acquireVsCodeApi', () => ({
      postMessage,
      getState: vi.fn(),
      setState: vi.fn(),
    }));
    window.__DEVDOCKET_EDITOR_BOOTSTRAP__ = item;
    const { EditorApp } = await import('../webview/editor/EditorApp');
    const container = document.createElement('div');
    document.body.appendChild(container);
    render(h(EditorApp, {}), container);
    return { container, postMessage };
  }

  async function renderEditor(item: EditorItemData): Promise<HTMLDivElement> {
    return (await renderEditorWithPostMessage(item)).container;
  }

  it('renders author inline with the repo annotation', async () => {
    const container = await renderEditor(makeEditorItem({
      group: 'owner/repo',
      author: { displayName: 'Octocat', handle: 'octocat' },
    }));

    expect(container.querySelector('.editor-repo-annotation')?.textContent).toBe('owner/repo · @octocat');
    expect(container.textContent).not.toContain('Author');
  });

  it('renders unchanged when author is missing', async () => {
    const container = await renderEditor(makeEditorItem({ group: 'owner/repo' }));

    expect(container.querySelector('.editor-repo-annotation')?.textContent).toBe('owner/repo');
    expect(container.textContent).not.toContain('Author');
  });

  it('suppresses the author annotation for self-authored items', async () => {
    const container = await renderEditor(makeEditorItem({
      group: 'owner/repo',
      author: { displayName: 'Octocat', handle: 'octocat' },
      authored: true,
    }));

    expect(container.querySelector('.editor-repo-annotation')?.textContent).toBe('owner/repo');
    expect(container.textContent).not.toContain('@octocat');
  });

  it('does not render a Details section for manual items', async () => {
    const container = await renderEditor(makeEditorItem({
      isProviderManaged: false,
      url: 'https://example.com/work/1',
    }));

    expect(container.querySelector('#editor-details-heading')).toBeNull();
    expect(container.textContent).not.toContain('Details');
    expect(container.querySelector<HTMLInputElement>('input.editor-title-input')?.value).toBe('Fix bug');
    expect(container.querySelector<HTMLInputElement>('input.editor-url-input')?.value).toBe('https://example.com/work/1');
    expect(container.querySelector('a.editor-url-link')?.getAttribute('href')).toBe('https://example.com/work/1');
    expect(container.querySelector('h1.editor-title input')).toBeNull();
    expect(container.querySelector('h1.editor-title')?.textContent).toBe('Fix bug');
  });

  it('autosaves manual notes and surfaces the empty title to the host', async () => {
    vi.useFakeTimers();
    const { container, postMessage } = await renderEditorWithPostMessage(makeEditorItem({
      isProviderManaged: false,
      notes: 'Existing note',
    }));
    const titleInput = container.querySelector<HTMLInputElement>('input.editor-title-input');
    const notesInput = container.querySelector<HTMLTextAreaElement>('textarea.editor-textarea');

    expect(titleInput).not.toBeNull();
    expect(notesInput).not.toBeNull();

    await act(async () => {
      titleInput!.value = '';
      titleInput!.dispatchEvent(new Event('input', { bubbles: true }));
      notesInput!.value = 'Draft note';
      notesInput!.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });

    expect(postMessage).toHaveBeenLastCalledWith({
      type: 'autosave',
      requestId: 'autosave-1',
      data: { notes: 'Draft note', title: '', url: '' },
    });
  });

  it('posts acceptAndRunAction for incoming preview inline actions', async () => {
    const { container, postMessage } = await renderEditorWithPostMessage(makeEditorItem({
      isIncoming: true,
      providerId: 'github',
      externalId: 'owner/repo#1',
      inlineActions: [{ id: 'startGitWork', label: 'Start Git Work' }],
    }));

    const button = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find(candidate => candidate.textContent === 'Start Git Work');
    expect(button).not.toBeUndefined();
    await act(async () => button?.click());

    expect(postMessage).toHaveBeenCalledWith({
      type: 'acceptAndRunAction',
      providerId: 'github',
      externalId: 'owner/repo#1',
      actionId: 'startGitWork',
    });
  });
});
