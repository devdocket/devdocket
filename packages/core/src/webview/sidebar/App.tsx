import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { ExtensionMessage, SourceProviderData, TierData } from '../shared/types';
import { postMessage } from '../shared/messaging';
import { useThemeChangeCounter } from '../shared/theme';
import { OnboardingEmptyState } from './components/OnboardingEmptyState';
import { SearchBox } from './components/SearchBox';
import { SourcesView } from './components/SourcesView';
import { TabBar } from './components/TabBar';
import { applyCIBadgeChangesToSources, applyCIBadgeChangesToTiers } from './ciBadgeUpdates';
import { TierSection } from './components/TierSection';
import { filterProviders, filterTiers } from './filter';
import {
  emptyQueries,
  hiddenSearchBoxes,
  isSearchBoxEffectivelyVisible,
  type SidebarTab,
  type TabQueries,
} from './searchVisibility';

export function App() {
  const [activeTab, setActiveTab] = useState<SidebarTab>('myWork');
  const [tiers, setTiers] = useState<TierData[]>([]);
  const [tiersLoaded, setTiersLoaded] = useState(false);
  const [sources, setSources] = useState<SourceProviderData[]>([]);
  const [selectedItemId, setSelectedItemId] = useState<string | null>(null);
  const [queries, setQueries] = useState<TabQueries>(emptyQueries);
  const [appliedQueries, setAppliedQueries] = useState<TabQueries>(emptyQueries);
  const [searchBoxVisible, setSearchBoxVisible] = useState(hiddenSearchBoxes);
  const [announcement, setAnnouncement] = useState('');
  const previousTiersRef = useRef<TierData[] | undefined>(undefined);
  const announcementFrameRef = useRef<number | undefined>(undefined);
  const myWorkFilterActiveRef = useRef(false);
  const lastNoResultsAnnouncementRef = useRef<TabQueries>(emptyQueries);
  // Re-render on VS Code theme changes so badge / tier colors update live.
  useThemeChangeCounter();

  const myWorkQuery = appliedQueries.myWork;
  const sourcesQuery = appliedQueries.sources;
  const isMyWorkFilterActive = myWorkQuery.trim() !== '';
  const isSourcesFilterActive = sourcesQuery.trim() !== '';
  myWorkFilterActiveRef.current = isMyWorkFilterActive;
  const filteredTiers = useMemo(
    () => (isMyWorkFilterActive ? filterTiers(tiers, myWorkQuery) : undefined),
    [isMyWorkFilterActive, tiers, myWorkQuery],
  );
  const filteredSources = useMemo(
    () => (isSourcesFilterActive ? filterProviders(sources, sourcesQuery) : undefined),
    [isSourcesFilterActive, sources, sourcesQuery],
  );
  const visibleTiers = filteredTiers?.tiers ?? tiers;
  const visibleSources = filteredSources?.providers ?? sources;
  const myWorkVisibleCount = getTierItemCount(visibleTiers);
  const sourcesVisibleCount = getProviderItemCount(visibleSources);
  const myWorkSearchBoxVisible = isSearchBoxEffectivelyVisible('myWork', searchBoxVisible, queries, appliedQueries);
  const sourcesSearchBoxVisible = isSearchBoxEffectivelyVisible('sources', searchBoxVisible, queries, appliedQueries);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setAppliedQueries(current => {
        let changed = false;
        const next: TabQueries = { ...current };

        for (const tab of ['myWork', 'sources'] as const) {
          if (current[tab] !== queries[tab]) {
            next[tab] = queries[tab];
            changed = true;
          }
        }

        return changed ? next : current;
      });
    }, 150);

    return () => window.clearTimeout(timer);
  }, [queries]);

  const announce = (message?: string) => {
    if (!message) {
      return;
    }

    if (announcementFrameRef.current !== undefined) {
      cancelAnimationFrame(announcementFrameRef.current);
    }

    setAnnouncement('');
    announcementFrameRef.current = requestAnimationFrame(() => {
      setAnnouncement(message);
      announcementFrameRef.current = undefined;
    });
  };

  useEffect(() => {
    if (activeTab === 'myWork') {
      announceNoResults('myWork', myWorkQuery, myWorkVisibleCount, announce, lastNoResultsAnnouncementRef);
    }
  }, [activeTab, myWorkQuery, myWorkVisibleCount]);

  useEffect(() => {
    if (activeTab === 'sources') {
      announceNoResults('sources', sourcesQuery, sourcesVisibleCount, announce, lastNoResultsAnnouncementRef);
    }
  }, [activeTab, sourcesQuery, sourcesVisibleCount]);

  useEffect(() => {
    const handler = (event: MessageEvent<ExtensionMessage>) => {
      const msg = event.data;
      switch (msg.type) {
        case 'updateItems': {
          const nextTiers = msg.tiers;
          const previousTiers = previousTiersRef.current;
          if (previousTiers && !myWorkFilterActiveRef.current) {
            announce(buildLiveAnnouncement(previousTiers, nextTiers));
          }
          previousTiersRef.current = nextTiers;
          setTiers(nextTiers);
          setTiersLoaded(true);
          break;
        }
        case 'updateSources':
          setSources(msg.providers);
          break;
        case 'updateCIBadges':
          setTiers(current => applyCIBadgeChangesToTiers(current, msg.changes));
          setSources(current => applyCIBadgeChangesToSources(current, msg.changes));
          break;
        case 'selectItem':
          setSelectedItemId(msg.itemId);
          break;
        case 'updateWatches':
          break;
        case 'toggleSearch': {
          const tab = activeTabRef.current;
          const currentlyVisible = isSearchBoxEffectivelyVisible(
            tab,
            searchBoxVisibleRef.current,
            queriesRef.current,
            appliedQueriesRef.current,
          );
          toggleSearchBox(tab, currentlyVisible);
          break;
        }
      }
    };

    window.addEventListener('message', handler);

    // Signal that the webview is ready to receive extension messages.
    postMessage({ type: 'webviewReady' });

    // Required: VS Code's keybinding service does NOT see keystrokes that
    // happen inside a sidebar webview view's iframe (registerWebviewViewProvider).
    // The package.json `devdocket.toggleSearch` keybinding only fires when focus
    // is on non-webview chrome, which is the rare case. To make Ctrl+F (Cmd+F)
    // actually work when the user is interacting with the sidebar, we must
    // intercept the keystroke here and forward it to the host as a message.
    // Both paths coexist by design — they cover disjoint focus contexts.
    const keydownHandler = (event: KeyboardEvent) => {
      const isFindShortcut = (event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && (event.key === 'f' || event.key === 'F');
      if (!isFindShortcut) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      postMessage({ type: 'requestToggleSearch' });
    };
    window.addEventListener('keydown', keydownHandler);

    return () => {
      window.removeEventListener('message', handler);
      window.removeEventListener('keydown', keydownHandler);
      if (announcementFrameRef.current !== undefined) {
        cancelAnimationFrame(announcementFrameRef.current);
      }
    };
  }, []);

  const handleTabSwitch = (tab: SidebarTab) => {
    setActiveTab(tab);
    postMessage({ type: 'switchTab', tab });
  };

  const handleQueryChange = (tab: SidebarTab, query: string) => {
    setQueries(current => ({ ...current, [tab]: query }));
  };

  const clearQuery = (tab: SidebarTab) => {
    setQueries(current => ({ ...current, [tab]: '' }));
    setAppliedQueries(current => ({ ...current, [tab]: '' }));
    if (announcementFrameRef.current !== undefined) {
      cancelAnimationFrame(announcementFrameRef.current);
      announcementFrameRef.current = undefined;
    }
    setAnnouncement('');
  };

  const showSearchBox = (tab: SidebarTab) => {
    setSearchBoxVisible(current => ({ ...current, [tab]: true }));
  };

  const clearAndHideSearchBox = (tab: SidebarTab) => {
    clearQuery(tab);
    setSearchBoxVisible(current => ({ ...current, [tab]: false }));
  };

  const toggleSearchBox = (tab: SidebarTab, visible: boolean) => {
    if (visible) {
      clearAndHideSearchBox(tab);
      return;
    }

    showSearchBox(tab);
  };

  const activeTabRef = useRef(activeTab);
  activeTabRef.current = activeTab;
  const searchBoxVisibleRef = useRef(searchBoxVisible);
  searchBoxVisibleRef.current = searchBoxVisible;
  const queriesRef = useRef(queries);
  queriesRef.current = queries;
  const appliedQueriesRef = useRef(appliedQueries);
  appliedQueriesRef.current = appliedQueries;

  return (
    <div class="mission-control">
      <TabBar
        activeTab={activeTab}
        onTabSwitch={handleTabSwitch}
      />
      <div class="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {announcement}
      </div>
      <div class="tab-content">
        {activeTab === 'sources' ? (
          <div
            class="sources-tab"
            role="tabpanel"
            id="mission-control-panel-sources"
            aria-labelledby="mission-control-tab-sources"
          >
            {sourcesSearchBoxVisible ? (
              <SearchBox
                label="Search Sources"
                query={queries.sources}
                onChange={(query) => handleQueryChange('sources', query)}
                onClear={() => clearQuery('sources')}
                onClose={() => clearAndHideSearchBox('sources')}
                autoFocus
              />
            ) : null}
            {isSourcesFilterActive && sourcesVisibleCount === 0 ? (
              <NoMatches query={sourcesQuery} onClear={() => clearQuery('sources')} />
            ) : (
              <SourcesView
                providers={visibleSources}
                forceExpanded={isSourcesFilterActive}
                totalCounts={filteredSources?.totalCounts}
                query={isSourcesFilterActive ? sourcesQuery : undefined}
                onOpenItem={(providerId, externalId) =>
                  postMessage({ type: 'openSourceItem', providerId, externalId })
                }
                onShowProviderHealth={(providerId) =>
                  postMessage({ type: 'showProviderHealth', providerId })
                }
              />
            )}
          </div>
        ) : (
          <div
            class="my-work-tab"
            role="tabpanel"
            id="mission-control-panel-my-work"
            aria-labelledby="mission-control-tab-my-work"
          >
            {myWorkSearchBoxVisible ? (
              <SearchBox
                label="Search My Work"
                query={queries.myWork}
                onChange={(query) => handleQueryChange('myWork', query)}
                onClear={() => clearQuery('myWork')}
                onClose={() => clearAndHideSearchBox('myWork')}
                autoFocus
              />
            ) : null}
            {isMyWorkFilterActive && myWorkVisibleCount === 0 ? (
              <NoMatches query={myWorkQuery} onClear={() => clearQuery('myWork')} />
            ) : !isMyWorkFilterActive && tiersLoaded && tiers.every(tier => tier.items.length === 0) ? (
              <EmptyMyWork />
            ) : (
              <div class="tiers">
                {visibleTiers.map(tier => (
                  <TierSection
                    key={tier.id}
                    tier={{
                      ...tier,
                      items: tier.items.map(item => ({
                        ...item,
                        isSelected: item.id === selectedItemId,
                      })),
                    }}
                    forceExpanded={isMyWorkFilterActive}
                    totalCount={filteredTiers?.totalCounts.get(tier.id)}
                    query={isMyWorkFilterActive ? myWorkQuery : undefined}
                    disableDragReorder={isMyWorkFilterActive}
                    isFilterActive={isMyWorkFilterActive}
                    onItemClick={(id) => {
                      // For incoming items, also mark them seen so the unread
                      // indicator clears once the user opens the editor.
                      const clicked = tier.items.find(item => item.id === id);
                      if (clicked?.tierType === 'incoming' && clicked.providerId && clicked.externalId && clicked.isUnseen) {
                        postMessage({ type: 'markSeen', providerId: clicked.providerId, externalId: clicked.externalId });
                      }
                      // Pass providerId/externalId along when known so the
                      // extension can route to the preview panel without
                      // re-parsing the legacy `${providerId}::${externalId}`
                      // cache key (which can split incorrectly if either
                      // side contains '::').
                      postMessage({
                        type: 'openItem',
                        itemId: id,
                        ...(clicked?.providerId ? { providerId: clicked.providerId } : {}),
                        ...(clicked?.externalId ? { externalId: clicked.externalId } : {}),
                      });
                    }}
                    onAcceptItem={(providerId, externalId) => postMessage({ type: 'acceptItem', providerId, externalId })}
                    onAcceptToFocus={(providerId, externalId) => postMessage({ type: 'acceptToFocus', providerId, externalId })}
                    onDismissItem={(providerId, externalId) => postMessage({ type: 'dismissItem', providerId, externalId })}
                    onTransitionState={(itemId, targetState) => postMessage({ type: 'transitionState', itemId, targetState })}
                    onReorderItems={tier.id === 'ready-to-start' || tier.id === 'in-progress' ? (itemIds) => postMessage({ type: 'reorderItems', itemIds }) : undefined}
                    onCrossTierDrop={tier.id === 'ready-to-start' || tier.id === 'in-progress'
                      ? (itemId) => postMessage({ type: 'crossTierDrop', itemId, targetTier: tier.id })
                      : undefined}
                    onAcceptAll={tier.id === 'incoming' ? () => postMessage({
                      type: 'acceptAll',
                      items: tier.items.flatMap(item => (item.providerId && item.externalId)
                        ? [{ providerId: item.providerId, externalId: item.externalId }]
                        : []),
                    }) : undefined}
                    onClearHistory={tier.id === 'done' ? () => postMessage({ type: 'clearHistory' }) : undefined}
                  />
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function EmptyMyWork() {
  return (
    <OnboardingEmptyState
      titleId="my-work-empty-state-title"
      description="Create a work item manually, or install a provider extension to automatically discover GitHub issues, Azure DevOps tasks, PR reviews, and more."
    />
  );
}

interface ItemLocation {
  title: string;
  tierId: string;
  tierName: string;
}

function NoMatches({ query, onClear }: { query: string; onClear: () => void }) {
  const displayQuery = query.trim();

  return (
    <div class="empty-state">
      No matches for {displayQuery}.{' '}
      <button type="button" class="empty-state-link" onClick={onClear}>Clear filter.</button>
    </div>
  );
}

function announceNoResults(
  tab: SidebarTab,
  query: string,
  visibleCount: number,
  announce: (message?: string) => void,
  lastNoResultsAnnouncementRef: { current: TabQueries },
): void {
  const displayQuery = query.trim();

  if (displayQuery && visibleCount === 0) {
    if (lastNoResultsAnnouncementRef.current[tab] !== displayQuery) {
      announce(`No results for ${displayQuery}`);
      lastNoResultsAnnouncementRef.current = { ...lastNoResultsAnnouncementRef.current, [tab]: displayQuery };
    }
    return;
  }

  if (lastNoResultsAnnouncementRef.current[tab]) {
    lastNoResultsAnnouncementRef.current = { ...lastNoResultsAnnouncementRef.current, [tab]: '' };
  }
}

function getTierItemCount(tiers: TierData[]): number {
  return tiers.reduce((total, tier) => total + tier.items.length, 0);
}

function getProviderItemCount(providers: SourceProviderData[]): number {
  return providers.reduce(
    (providerTotal, provider) => providerTotal + provider.groups.reduce((groupTotal, group) => groupTotal + group.items.length, 0),
    0,
  );
}

function buildLiveAnnouncement(previousTiers: TierData[], nextTiers: TierData[]): string | undefined {
  const messages: string[] = [];
  const incomingDelta = getIncomingCount(nextTiers) - getIncomingCount(previousTiers);
  if (incomingDelta > 0) {
    messages.push(`${incomingDelta} new incoming item${incomingDelta === 1 ? '' : 's'}`);
  }

  const movedItems = findMovedItems(previousTiers, nextTiers);
  if (movedItems.length === 1) {
    messages.push(`${movedItems[0].title} moved to ${movedItems[0].tierName}`);
  } else if (movedItems.length > 1) {
    const destinationCounts = new Map<string, { count: number; tierName: string }>();
    for (const item of movedItems) {
      const destination = destinationCounts.get(item.tierId) ?? { count: 0, tierName: item.tierName };
      destination.count += 1;
      destinationCounts.set(item.tierId, destination);
    }

    if (destinationCounts.size === 1) {
      const [{ count, tierName }] = Array.from(destinationCounts.values());
      messages.push(`${count} items moved to ${tierName}`);
    } else {
      messages.push(`${movedItems.length} items changed state`);
    }
  }

  return messages.length > 0 ? messages.join('. ') : undefined;
}

function getIncomingCount(tiers: TierData[]): number {
  return tiers.find(tier => tier.id === 'incoming')?.items.length ?? 0;
}

function findMovedItems(previousTiers: TierData[], nextTiers: TierData[]): ItemLocation[] {
  const previousLocations = buildItemLocations(previousTiers);
  const nextLocations = buildItemLocations(nextTiers);
  const movedItems: ItemLocation[] = [];

  for (const [itemId, nextLocation] of nextLocations) {
    const previousLocation = previousLocations.get(itemId);
    if (previousLocation && previousLocation.tierId !== nextLocation.tierId) {
      movedItems.push(nextLocation);
    }
  }

  return movedItems;
}

function buildItemLocations(tiers: TierData[]): Map<string, ItemLocation> {
  const locations = new Map<string, ItemLocation>();

  for (const tier of tiers) {
    for (const item of tier.items) {
      locations.set(item.id, {
        title: item.title,
        tierId: tier.id,
        tierName: tier.name,
      });
    }
  }

  return locations;
}
