import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { WorkItemState, type WorkItem } from '../models/workItem';
import { MainViewProvider } from '../views/mainViewProvider';

type MessageHandler = (message: unknown) => void | Promise<void>;

type TestDiscoveredItem = {
  externalId: string;
  title: string;
  description?: string;
  state?: string;
  reason?: string;
  url?: string;
  group?: string;
  canonicalId?: string;
  itemType?: 'issue' | 'pr';
  relatedItems?: Array<{ externalId: string; relation: 'closes' | 'linked'; itemType: 'issue' | 'pr' }>;
  badges?: Array<{ label: string; variant: 'neutral' | 'info' | 'success' | 'warning' | 'danger'; show?: 'sidebar' | 'editor' | 'both' }>;
};

function makeWorkItem(overrides: Partial<WorkItem> = {}): WorkItem {
  const now = Date.now();
  return {
    id: 'item-1',
    title: 'Test item',
    state: WorkItemState.New,
    createdAt: now,
    updatedAt: now,
    activityLog: [],
    ...overrides,
  };
}

function createMockWebviewView() {
  let messageHandler: MessageHandler | undefined;
  const webview = {
    html: '',
    options: undefined,
    cspSource: 'mock-csp',
    asWebviewUri: vi.fn((uri: { fsPath?: string; path?: string; toString?: () => string }) => ({
      toString: () => `webview-resource:${uri.fsPath ?? uri.path ?? uri.toString?.() ?? ''}`,
    })),
    onDidReceiveMessage: vi.fn((handler: MessageHandler) => {
      messageHandler = handler;
      return { dispose: vi.fn(() => { messageHandler = undefined; }) };
    }),
    postMessage: vi.fn(async () => true),
  };

  return {
    view: { webview, badge: undefined } as any,
    webview,
    simulateMessage: (message: unknown) => messageHandler?.(message) ?? Promise.resolve(),
    getMessages: () => webview.postMessage.mock.calls.map(([message]) => message),
  };
}

function findPostedMessage(mockView: ReturnType<typeof createMockWebviewView>, type: string) {
  const messages = mockView.getMessages().slice().reverse();
  return messages.find(message => message?.type === type);
}

function createMockWorkGraph(initialItems: WorkItem[] = []) {
  const items = new Map(initialItems.map(item => [item.id, { ...item }]));
  let nextId = 1;

  const getReadyItems = () => Array.from(items.values())
    .filter(item => item.state === WorkItemState.New)
    .sort((a, b) => (a.sortOrder ?? Number.MAX_SAFE_INTEGER) - (b.sortOrder ?? Number.MAX_SAFE_INTEGER)
      || b.updatedAt - a.updatedAt);

  const applyReadyOrder = (orderedIds: string[]) => {
    orderedIds.forEach((id, index) => {
      const item = items.get(id);
      if (item) {
        item.sortOrder = index;
      }
    });
  };

  return {
    getAll: vi.fn(() => Array.from(items.values())),
    getItemsByState: vi.fn((...states: WorkItemState[]) => Array.from(items.values()).filter(item => states.includes(item.state))),
    getItem: vi.fn((id: string) => items.get(id)),
    findItemByProvenance: vi.fn((providerId: string, externalId: string) => Array.from(items.values()).find(
      item => item.providerId === providerId && item.externalId === externalId,
    )),
    createItem: vi.fn(async (input: { title: string; description?: string }, provenance?: { providerId: string; externalId: string; url?: string; group?: string }) => {
      const created = makeWorkItem({
        id: `created-${nextId++}`,
        title: input.title,
        description: input.description,
        providerId: provenance?.providerId,
        externalId: provenance?.externalId,
        url: provenance?.url,
        group: provenance?.group,
        sortOrder: getReadyItems().length,
      });
      items.set(created.id, created);
      return created;
    }),
    transitionState: vi.fn(async (id: string, state: WorkItemState) => {
      const item = items.get(id);
      if (item) {
        item.state = state;
      }
    }),
    reorderItem: vi.fn(async (draggedId: string, beforeId: string) => {
      const orderedIds = getReadyItems().map(item => item.id).filter(id => id !== draggedId);
      const beforeIndex = orderedIds.indexOf(beforeId);
      orderedIds.splice(beforeIndex, 0, draggedId);
      applyReadyOrder(orderedIds);
    }),
    moveToEnd: vi.fn(async (id: string) => {
      const orderedIds = getReadyItems().map(item => item.id).filter(existingId => existingId !== id);
      orderedIds.push(id);
      applyReadyOrder(orderedIds);
    }),
    getReadyOrder: () => getReadyItems().map(item => item.id),
  };
}

function createProviderRegistry(
  itemsByProvider: Record<string, TestDiscoveredItem[]>,
  labels: Record<string, string> = {},
  health: Record<string, { status: string }> = {},
) {
  const discovered = new Map<string, TestDiscoveredItem[]>(Object.entries(itemsByProvider));
  return {
    getAllDiscoveredItems: vi.fn(() => discovered),
    getDiscoveredItems: vi.fn((providerId: string) => discovered.get(providerId) ?? []),
    getProviderLabel: vi.fn((providerId: string) => labels[providerId] ?? providerId),
    getProviderHealth: vi.fn((providerId: string) => health[providerId] ?? { status: 'healthy' }),
  };
}

function createStateStore(initialStates: Record<string, string> = {}) {
  const states = new Map(Object.entries(initialStates));
  return {
    getState: vi.fn((providerId: string, externalId: string) => states.get(`${providerId}::${externalId}`)),
    setState: vi.fn(async (providerId: string, externalId: string, state: string) => {
      states.set(`${providerId}::${externalId}`, state);
    }),
  };
}

function createWatcherService(options: {
  runs?: any[];
  prs?: any[];
  childRuns?: Record<string, any[]>;
} = {}) {
  const prKey = (identifier: { providerId: string; repo: string; prId: string }) => `pr:${identifier.providerId}:${identifier.repo}:${identifier.prId}`;
  return {
    getActiveWatches: vi.fn(() => options.runs ?? []),
    getActivePRWatches: vi.fn(() => options.prs ?? []),
    getPRWatchKey: vi.fn((identifier: { providerId: string; repo: string; prId: string }) => prKey(identifier)),
    getChildRuns: vi.fn((key: string) => options.childRuns?.[key] ?? []),
  };
}

function createProvider(
  workGraph: ReturnType<typeof createMockWorkGraph>,
  providerRegistry: ReturnType<typeof createProviderRegistry>,
  stateStore: ReturnType<typeof createStateStore>,
  watcherService: ReturnType<typeof createWatcherService> = createWatcherService(),
) {
  return new MainViewProvider(
    vscode.Uri.file('C:\\repos\\devdocket-mission-control-454\\packages\\core'),
    workGraph as any,
    providerRegistry as any,
    stateStore as any,
    { has: () => false, add: vi.fn().mockResolvedValue(true), keys: () => [][Symbol.iterator]() } as any,
    watcherService as any,
    {} as any,
  );
}

describe('MainViewProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  it('assembles tier data with filtering, sorting, collapsing, and badges', async () => {
    vi.useFakeTimers();
    const workGraph = createMockWorkGraph([
      makeWorkItem({ id: 'urgent-ready', title: 'Urgent ready', state: WorkItemState.New, sortOrder: 20, updatedAt: 40, providerId: 'github', externalId: 'ready-urgent', url: 'https://github.com/org/repo/pull/20' }),
      makeWorkItem({ id: 'ordinary-ready', title: 'Ordinary ready', state: WorkItemState.New, sortOrder: 10, updatedAt: 60, providerId: 'ado', externalId: 'ready-ordinary', url: 'https://dev.azure.com/org/project/_git/repo/pullrequest/10' }),
      makeWorkItem({ id: 'manual-ready', title: 'Manual ready', state: WorkItemState.New, sortOrder: 30, updatedAt: 50 }),
      makeWorkItem({ id: 'urgent-newer', title: 'Urgent newer', state: WorkItemState.InProgress, updatedAt: 200, providerId: 'github', externalId: 'ip-urgent-newer' }),
      makeWorkItem({ id: 'urgent-older', title: 'Urgent older', state: WorkItemState.InProgress, updatedAt: 100, providerId: 'github', externalId: 'ip-urgent-older' }),
      makeWorkItem({ id: 'ordinary-newest', title: 'Ordinary newest', state: WorkItemState.InProgress, updatedAt: 300, providerId: 'ado', externalId: 'ip-ordinary' }),
      makeWorkItem({ id: 'paused-old', title: 'Paused old', state: WorkItemState.Paused, updatedAt: 10, providerId: 'github', externalId: 'paused-old' }),
      makeWorkItem({ id: 'paused-new', title: 'Paused new', state: WorkItemState.Paused, updatedAt: 20, providerId: 'github', externalId: 'paused-new' }),
      makeWorkItem({ id: 'done-new', title: 'Done new', state: WorkItemState.Done, updatedAt: 500, providerId: 'github', externalId: 'done-new', url: 'https://github.com/org/repo/actions/runs/500' }),
      makeWorkItem({ id: 'done-old', title: 'Done old', state: WorkItemState.Archived, updatedAt: 400 }),
    ]);
    const providerRegistry = createProviderRegistry({
      github: [
        { externalId: 'incoming-1', title: 'Incoming keep', reason: 'review requested', url: 'https://github.com/org/repo/pull/1', canonicalId: 'shared-incoming', badges: [{ label: 'Review requested', variant: 'warning' }] },
        { externalId: 'incoming-2', title: 'Incoming duplicate', state: 'open', url: 'https://github.com/org/repo/issues/2', canonicalId: 'shared-incoming' },
        { externalId: 'incoming-accepted', title: 'Accepted incoming', state: 'open' },
        { externalId: 'incoming-dismissed', title: 'Dismissed incoming', state: 'open' },
        { externalId: 'ready-urgent', title: 'Urgent ready', state: 'changes requested', url: 'https://github.com/org/repo/pull/20', badges: [{ label: 'Changes requested', variant: 'danger' }] },
        { externalId: 'ip-urgent-newer', title: 'Urgent newer', state: 'changes requested', badges: [{ label: 'Changes requested', variant: 'danger' }] },
        { externalId: 'ip-urgent-older', title: 'Urgent older', state: 'changes requested', badges: [{ label: 'Changes requested', variant: 'danger' }] },
        { externalId: 'paused-old', title: 'Paused old', state: 'open' },
        { externalId: 'paused-new', title: 'Paused new', state: 'open' },
        { externalId: 'done-new', title: 'Done new', state: 'merged', url: 'https://github.com/org/repo/actions/runs/500' },
      ],
      ado: [
        { externalId: 'ready-ordinary', title: 'Ordinary ready', state: 'approved', url: 'https://dev.azure.com/org/project/_git/repo/pullrequest/10', badges: [{ label: 'Approved', variant: 'success' }] },
        { externalId: 'ip-ordinary', title: 'Ordinary newest', state: 'open' },
      ],
    });
    const stateStore = createStateStore({
      'github::incoming-accepted': 'accepted',
      'github::incoming-dismissed': 'dismissed',
      'github::ready-urgent': 'accepted',
      'ado::ready-ordinary': 'accepted',
      'github::ip-urgent-newer': 'accepted',
      'github::ip-urgent-older': 'accepted',
      'ado::ip-ordinary': 'accepted',
      'github::paused-old': 'accepted',
      'github::paused-new': 'accepted',
      'github::done-new': 'accepted',
    });
    const prWatchKey = 'pr:github-pr:org/repo:1';
    const watcherService = createWatcherService({
      runs: [
        {
          identifier: { providerId: 'ado-runs', runId: '10', url: 'https://dev.azure.com/org/project/_git/repo/pullrequest/10' },
          status: { overallState: 'running' },
        },
        {
          identifier: { providerId: 'github-actions', runId: '500', url: 'https://github.com/org/repo/actions/runs/500' },
          status: { overallState: 'completed', conclusion: 'success' },
        },
      ],
      prs: [{
        identifier: { providerId: 'github-pr', repo: 'org/repo', prId: '1', displayName: 'PR #1', url: 'https://github.com/org/repo/pull/1' },
        prState: 'open',
      }],
      childRuns: {
        [prWatchKey]: [{
          identifier: { providerId: 'github-actions', repo: 'org/repo', runId: '111', displayName: 'CI', url: 'https://github.com/org/repo/actions/runs/111' },
          status: { overallState: 'completed', conclusion: 'failure', jobs: [] },
        }],
      },
    });
    const provider = createProvider(workGraph, providerRegistry, stateStore, watcherService);
    const mockView = createMockWebviewView();

    provider.resolveWebviewView(mockView.view, {} as any, {} as any);
    await vi.advanceTimersByTimeAsync(50);

    const updateItems = findPostedMessage(mockView, 'updateItems');
    expect(updateItems.tiers.map((tier: { id: string }) => tier.id)).toEqual([
      'incoming',
      'in-progress',
      'ready-to-start',
      'paused',
      'done',
    ]);

    const incomingTier = updateItems.tiers.find((tier: { id: string }) => tier.id === 'incoming');
    expect(incomingTier.items.map((item: { title: string }) => item.title)).toEqual(['Incoming keep']);
    expect(incomingTier.items[0].badges).toEqual(expect.arrayContaining([
      { label: 'GitHub', type: 'provider', variant: 'github' },
      { label: 'Review requested', type: 'provider-supplied', variant: 'review-requested' },
      { label: 'CI failed', type: 'ci', variant: 'ci-fail' },
    ]));

    const inProgressTier = updateItems.tiers.find((tier: { id: string }) => tier.id === 'in-progress');
    expect(inProgressTier.items.map((item: { id: string }) => item.id)).toEqual([
      'urgent-newer',
      'urgent-older',
      'ordinary-newest',
    ]);

    const readyTier = updateItems.tiers.find((tier: { id: string }) => tier.id === 'ready-to-start');
    expect(readyTier.items.map((item: { id: string }) => item.id)).toEqual([
      'urgent-ready',
      'ordinary-ready',
      'manual-ready',
    ]);
    expect(readyTier.items.find((item: { id: string }) => item.id === 'urgent-ready').badges).toEqual(expect.arrayContaining([
      { label: 'GitHub', type: 'provider', variant: 'github' },
      { label: 'Changes requested', type: 'provider-supplied', variant: 'changes-requested' },
    ]));
    expect(readyTier.items.find((item: { id: string }) => item.id === 'ordinary-ready').badges).toEqual(expect.arrayContaining([
      { label: 'ADO', type: 'provider', variant: 'ado' },
      { label: 'Approved', type: 'provider-supplied', variant: 'approved' },
      { label: 'CI running', type: 'ci', variant: 'ci-running' },
    ]));
    expect(readyTier.items.find((item: { id: string }) => item.id === 'manual-ready').badges).toContainEqual(
      { label: 'Manual', type: 'provider', variant: 'manual' },
    );

    const pausedTier = updateItems.tiers.find((tier: { id: string }) => tier.id === 'paused');
    expect(pausedTier.items.map((item: { id: string }) => item.id)).toEqual(['paused-old', 'paused-new']);

    const doneTier = updateItems.tiers.find((tier: { id: string }) => tier.id === 'done');
    expect(doneTier.collapsed).toBe(true);
    expect(doneTier.items.map((item: { id: string }) => item.id)).toEqual(['done-new', 'done-old']);
    expect(doneTier.items[0].badges).toContainEqual({ label: 'CI passed', type: 'ci', variant: 'ci-pass' });
  });

  it('filters empty tiers out of the refresh payload', async () => {
    vi.useFakeTimers();
    const provider = createProvider(
      createMockWorkGraph(),
      createProviderRegistry({}),
      createStateStore(),
    );
    const mockView = createMockWebviewView();

    provider.resolveWebviewView(mockView.view, {} as any, {} as any);
    await vi.advanceTimersByTimeAsync(50);

    const updateItems = findPostedMessage(mockView, 'updateItems');
    expect(updateItems.tiers).toEqual([]);
  });

  it('assembles sources data by provider, group, item, and health state', async () => {
    vi.useFakeTimers();
    const provider = createProvider(
      createMockWorkGraph(),
      createProviderRegistry(
        {
          github: [
            { externalId: 'g-2', title: 'Zulu', group: 'Beta', state: 'open' },
            { externalId: 'g-1', title: 'Alpha', group: 'Alpha', state: 'open' },
            { externalId: 'g-3', title: 'Gamma', group: 'Alpha', reason: 'review requested', badges: [{ label: 'Review requested', variant: 'warning' }] },
          ],
          ado: [
            { externalId: 'a-1', title: 'ADO Item', group: 'Backlog', state: 'approved', badges: [{ label: 'Approved', variant: 'success' }] },
          ],
        },
        { github: 'GitHub', ado: 'Azure DevOps' },
        { ado: { status: 'unhealthy' } },
      ),
      createStateStore({
        'github::g-1': 'accepted',
        'github::g-3': 'dismissed',
      }),
    );
    const mockView = createMockWebviewView();

    provider.resolveWebviewView(mockView.view, {} as any, {} as any);
    await vi.advanceTimersByTimeAsync(50);

    const updateSources = findPostedMessage(mockView, 'updateSources');
    expect(updateSources.providers.map((providerData: { label: string }) => providerData.label)).toEqual([
      'Azure DevOps',
      'GitHub',
    ]);

    const adoProvider = updateSources.providers[0];
    expect(adoProvider.isHealthy).toBe(false);
    expect(adoProvider.groups).toEqual([
      {
        name: 'Backlog',
        items: [expect.objectContaining({
          title: 'ADO Item',
          isAccepted: false,
          isDismissed: false,
          badges: expect.arrayContaining([
            { label: 'ADO', type: 'provider', variant: 'ado' },
            { label: 'Approved', type: 'provider-supplied', variant: 'approved' },
          ]),
        })],
      },
    ]);

    const githubProvider = updateSources.providers[1];
    expect(githubProvider.isHealthy).toBe(true);
    expect(githubProvider.groups.map((group: { name: string }) => group.name)).toEqual(['Alpha', 'Beta']);
    expect(githubProvider.groups[0].items.map((item: { title: string }) => item.title)).toEqual(['Alpha', 'Gamma']);
    expect(githubProvider.groups[0].items[0]).toEqual(expect.objectContaining({
      title: 'Alpha',
      isAccepted: true,
      isDismissed: false,
    }));
    expect(githubProvider.groups[0].items[1]).toEqual(expect.objectContaining({
      title: 'Gamma',
      isAccepted: false,
      isDismissed: true,
      badges: expect.arrayContaining([
        { label: 'Review requested', type: 'provider-supplied', variant: 'review-requested' },
      ]),
    }));
  });

  it('marks sidebar and source rows that have resolved related items', async () => {
    vi.useFakeTimers();
    const workGraph = createMockWorkGraph([
      makeWorkItem({ id: 'pr-item', title: 'PR', state: WorkItemState.New, providerId: 'github-my-prs', externalId: 'owner/repo#10' }),
      makeWorkItem({ id: 'issue-item', title: 'Issue', state: WorkItemState.InProgress, providerId: 'github-issues', externalId: 'owner/repo#2' }),
      makeWorkItem({ id: 'manual', title: 'Manual', state: WorkItemState.New }),
    ]);
    const providerRegistry = createProviderRegistry({
      'github-my-prs': [{
        externalId: 'owner/repo#10',
        title: 'PR',
        itemType: 'pr',
        relatedItems: [{ externalId: 'owner/repo#2', itemType: 'issue', relation: 'closes' }],
      }],
    });
    const stateStore = createStateStore({
      'github-my-prs::owner/repo#10': 'accepted',
      'github-issues::owner/repo#2': 'accepted',
    });
    const provider = createProvider(workGraph, providerRegistry, stateStore);
    const mockView = createMockWebviewView();

    provider.resolveWebviewView(mockView.view, {} as any, {} as any);
    await vi.advanceTimersByTimeAsync(50);

    const updateItems = findPostedMessage(mockView, 'updateItems');
    const readyTier = updateItems.tiers.find((tier: { id: string }) => tier.id === 'ready-to-start');
    const inProgressTier = updateItems.tiers.find((tier: { id: string }) => tier.id === 'in-progress');
    expect(readyTier.items.find((item: { id: string }) => item.id === 'pr-item').hasRelatedItems).toBe(true);
    expect(readyTier.items.find((item: { id: string }) => item.id === 'manual').hasRelatedItems).toBe(false);
    expect(inProgressTier.items.find((item: { id: string }) => item.id === 'issue-item').hasRelatedItems).toBe(true);

    const updateSources = findPostedMessage(mockView, 'updateSources');
    const sourcePr = updateSources.providers
      .flatMap((providerData: any) => providerData.groups)
      .flatMap((group: any) => group.items)
      .find((item: { externalId: string }) => item.externalId === 'owner/repo#10');
    expect(sourcePr.hasRelatedItems).toBe(true);
  });

  it('handles webview messages for opening, accepting, dismissing, transitioning, creating, acting, and opening URLs', async () => {
    vi.useFakeTimers();
    const workGraph = createMockWorkGraph([
      makeWorkItem({ id: 'existing-item', title: 'Existing item', state: WorkItemState.InProgress }),
    ]);
    const providerRegistry = createProviderRegistry({
      github: [
        { externalId: 'incoming-99', title: 'Incoming item', description: 'Desc', url: 'https://example.com/incoming/99', group: 'repo' },
        { externalId: 'openable', title: 'Open me', url: 'https://example.com/provider/1' },
      ],
    });
    const stateStore = createStateStore();
    const provider = createProvider(workGraph, providerRegistry, stateStore);
    const mockView = createMockWebviewView();

    provider.resolveWebviewView(mockView.view, {} as any, {} as any);
    await vi.advanceTimersByTimeAsync(50);
    vi.clearAllMocks();

    mockView.simulateMessage({ type: 'openItem', itemId: 'existing-item' });
    mockView.simulateMessage({ type: 'openItem', itemId: 'github::openable' });
    mockView.simulateMessage({ type: 'acceptItem', providerId: 'github', externalId: 'incoming-99' });
    mockView.simulateMessage({ type: 'dismissItem', providerId: 'github', externalId: 'incoming-99' });
    mockView.simulateMessage({ type: 'transitionState', itemId: 'existing-item', targetState: WorkItemState.Done });
    mockView.simulateMessage({ type: 'createItem' });
    mockView.simulateMessage({ type: 'runAction', itemId: 'existing-item' });
    mockView.simulateMessage({ type: 'openUrl', url: 'https://example.com/manual/2' });

    await vi.waitFor(() => {
      expect(vscode.commands.executeCommand).toHaveBeenCalledWith('devdocket.editItem', { id: 'existing-item' });
      expect(vscode.commands.executeCommand).toHaveBeenCalledWith('devdocket.createItem');
      expect(vscode.commands.executeCommand).toHaveBeenCalledWith('devdocket.runAction', { id: 'existing-item' });
      // Clicking an incoming item opens it in the editor (preview mode) — it
      // does NOT auto-accept and does NOT open the browser.
      expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
        'devdocket.previewIncomingItem',
        { providerId: 'github', externalId: 'openable' },
      );
      expect(vscode.env.openExternal).not.toHaveBeenCalledWith(expect.objectContaining({ path: 'https://example.com/provider/1' }));
      expect(vscode.env.openExternal).toHaveBeenCalledWith(expect.objectContaining({ path: 'https://example.com/manual/2' }));
      expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
        'devdocket.acceptFromInbox',
        {
          kind: 'item',
          providerId: 'github',
          externalId: 'incoming-99',
          title: 'Incoming item',
          description: 'Desc',
          url: 'https://example.com/incoming/99',
          group: 'repo',
        },
      );
      expect(stateStore.setState).toHaveBeenCalledWith('github', 'incoming-99', 'dismissed');
      expect(workGraph.transitionState).toHaveBeenCalledWith('existing-item', WorkItemState.Done);
    });
  });

  it('handles provider health messages through the webview message switch', async () => {
    vi.useFakeTimers();
    const provider = createProvider(createMockWorkGraph(), createProviderRegistry({}), createStateStore());
    const mockView = createMockWebviewView();

    provider.resolveWebviewView(mockView.view, {} as any, {} as any);
    await vi.advanceTimersByTimeAsync(50);
    vi.clearAllMocks();

    await mockView.simulateMessage({ type: 'showProviderHealth', providerId: 'github-issues' });

    expect(vscode.commands.executeCommand).toHaveBeenCalledWith('devdocket.showProviderHealthQuickPick');
  });

  it('routes incoming accept messages through the accept-from-inbox command', async () => {
    vi.useFakeTimers();
    const workGraph = createMockWorkGraph();
    const providerRegistry = createProviderRegistry({
      github: [
        {
          externalId: 'incoming-accept',
          title: 'Incoming accept',
          description: 'Acceptance details',
          url: 'https://example.com/incoming/accept',
          group: 'repo',
          canonicalId: 'canonical-accept',
        },
      ],
    });
    const provider = createProvider(workGraph, providerRegistry, createStateStore());
    const mockView = createMockWebviewView();

    provider.resolveWebviewView(mockView.view, {} as any, {} as any);
    await vi.advanceTimersByTimeAsync(50);
    vi.clearAllMocks();

    await mockView.simulateMessage({ type: 'acceptItem', providerId: 'github', externalId: 'incoming-accept' });

    expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
      'devdocket.acceptFromInbox',
      {
        kind: 'item',
        providerId: 'github',
        externalId: 'incoming-accept',
        title: 'Incoming accept',
        description: 'Acceptance details',
        url: 'https://example.com/incoming/accept',
        group: 'repo',
        canonicalId: 'canonical-accept',
      },
    );
    expect(workGraph.createItem).not.toHaveBeenCalled();
  });

  it('routes incoming acceptToFocus messages through the accept-to-focus-from-inbox command', async () => {
    vi.useFakeTimers();
    const workGraph = createMockWorkGraph();
    const providerRegistry = createProviderRegistry({
      github: [
        {
          externalId: 'incoming-start',
          title: 'Incoming start',
          description: 'Start details',
          url: 'https://example.com/incoming/start',
          group: 'repo',
          canonicalId: 'canonical-start',
        },
      ],
    });
    const provider = createProvider(workGraph, providerRegistry, createStateStore());
    const mockView = createMockWebviewView();

    provider.resolveWebviewView(mockView.view, {} as any, {} as any);
    await vi.advanceTimersByTimeAsync(50);
    vi.clearAllMocks();

    await mockView.simulateMessage({ type: 'acceptToFocus', providerId: 'github', externalId: 'incoming-start' });

    expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
      'devdocket.acceptToFocusFromInbox',
      {
        kind: 'item',
        providerId: 'github',
        externalId: 'incoming-start',
        title: 'Incoming start',
        description: 'Start details',
        url: 'https://example.com/incoming/start',
        group: 'repo',
        canonicalId: 'canonical-start',
      },
    );
    expect(workGraph.createItem).not.toHaveBeenCalled();
  });

  it('handles onboarding command messages through the webview message switch', async () => {
    vi.useFakeTimers();
    const provider = createProvider(
      createMockWorkGraph(),
      createProviderRegistry({}),
      createStateStore(),
    );
    const mockView = createMockWebviewView();

    provider.resolveWebviewView(mockView.view, {} as any, {} as any);
    await vi.advanceTimersByTimeAsync(50);
    vi.clearAllMocks();

    await mockView.simulateMessage({ type: 'createItem' });
    await mockView.simulateMessage({ type: 'openWalkthrough' });

    expect(vscode.commands.executeCommand).toHaveBeenCalledWith('devdocket.createItem');
    expect(vscode.commands.executeCommand).toHaveBeenCalledWith('devdocket.openWalkthrough');
  });

  it('handles reorderItems messages through the webview message switch', async () => {
    vi.useFakeTimers();
    const workGraph = createMockWorkGraph([
      makeWorkItem({ id: 'queue-a', title: 'Queue A', state: WorkItemState.New, sortOrder: 0, updatedAt: 100 }),
      makeWorkItem({ id: 'queue-b', title: 'Queue B', state: WorkItemState.New, sortOrder: 1, updatedAt: 90 }),
    ]);
    const provider = createProvider(workGraph, createProviderRegistry({}), createStateStore());
    const mockView = createMockWebviewView();

    provider.resolveWebviewView(mockView.view, {} as any, {} as any);
    await vi.advanceTimersByTimeAsync(50);

    mockView.simulateMessage({ type: 'reorderItems', itemIds: ['queue-b', 'queue-a'] });

    await vi.waitFor(() => {
      expect(workGraph.getReadyOrder()).toEqual(['queue-b', 'queue-a']);
    });
  });

  it('debounces refreshes so rapid calls post a single update', async () => {
    vi.useFakeTimers();
    const provider = createProvider(
      createMockWorkGraph([makeWorkItem({ id: 'queue-1', title: 'Queue 1', sortOrder: 0 })]),
      createProviderRegistry({}),
      createStateStore(),
    );
    const mockView = createMockWebviewView();

    provider.resolveWebviewView(mockView.view, {} as any, {} as any);
    provider.scheduleRefresh();
    provider.scheduleRefresh();

    await vi.advanceTimersByTimeAsync(49);
    expect(mockView.webview.postMessage).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(mockView.webview.postMessage).toHaveBeenCalledTimes(2);
    expect(findPostedMessage(mockView, 'updateItems')).toBeDefined();
    expect(findPostedMessage(mockView, 'updateSources')).toBeDefined();
  });
});
