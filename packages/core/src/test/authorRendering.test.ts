// @vitest-environment jsdom
import { h, render } from 'preact';
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
    {} as any,
  );
}

afterEach(() => {
  render(null, document.body);
  document.body.innerHTML = '';
  delete window.__DEVDOCKET_EDITOR_BOOTSTRAP__;
  vi.unstubAllGlobals();
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

    const card = (provider as any).buildIncomingCardData('github', providerItem, new Map()) as ItemCardData;

    expect(card.author).toEqual({ displayName: 'Octocat', handle: 'octocat' });
  });

  it('copies provider author onto editor data for linked work items', () => {
    const providerItem: ProviderItem = {
      externalId: 'owner/repo#1',
      title: '#1: Fix bug',
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

  it('suppresses the author annotation for self-authored items', () => {
    const container = renderCard(makeCardItem({ author: { displayName: 'Octocat', handle: 'octocat' }, authored: true }));

    expect(container.querySelector('.item-repo-annotation')?.textContent).toBe('owner/repo');
  });
});

describe('EditorApp author details', () => {
  async function renderEditor(item: EditorItemData): Promise<HTMLDivElement> {
    vi.stubGlobal('acquireVsCodeApi', () => ({
      postMessage: vi.fn(),
      getState: vi.fn(),
      setState: vi.fn(),
    }));
    window.__DEVDOCKET_EDITOR_BOOTSTRAP__ = item;
    const { EditorApp } = await import('../webview/editor/EditorApp');
    const container = document.createElement('div');
    document.body.appendChild(container);
    render(h(EditorApp, {}), container);
    return container;
  }

  it('renders a read-only Author row when author is present', async () => {
    const container = await renderEditor(makeEditorItem({ author: { displayName: 'Octocat', handle: 'octocat' } }));

    expect(container.textContent).toContain('Author');
    expect(container.querySelector('.editor-readonly-value')?.textContent).toContain('Octocat');
    expect(container.querySelector('.editor-readonly-value')?.textContent).toContain('@octocat');
    expect(container.querySelector('a[href="https://github.com/octocat"]')).toBeNull();
  });

  it('omits the Author row when author is missing', async () => {
    const container = await renderEditor(makeEditorItem());

    expect(container.textContent).not.toContain('Author');
  });
});
