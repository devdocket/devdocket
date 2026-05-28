import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { ExtensionMessage, ItemCardData, SourceProviderData, TierData } from '../shared/types';
import { postMessage } from '../shared/messaging';
import { useThemeChangeCounter } from '../shared/theme';
import { BulkActionBar } from './components/BulkActionBar';
import { OnboardingEmptyState } from './components/OnboardingEmptyState';
import { SearchBox } from './components/SearchBox';
import { SourcesView } from './components/SourcesView';
import { TabBar } from './components/TabBar';
import { applyCIBadgeChangesToSources, applyCIBadgeChangesToTiers } from './ciBadgeUpdates';
import { TierSection } from './components/TierSection';
import type { ClickModifiers } from './components/ItemCard';
import { filterProviders, filterTiers } from './filter';
import { getBulkActionsForItems, type BulkAction } from './bulkActions';
import {
  applySelectionClick,
  clearSelection,
  isMultiSelectTier,
  reconcileSelection,
  type SelectionState,
} from './selectionModel';
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
  const [multiSelection, setMultiSelection] = useState<SelectionState>(null);
  const [queries, setQueries] = useState<TabQueries>(emptyQueries);
  const [appliedQueries, setAppliedQueries] = useState<TabQueries>(emptyQueries);
  const [searchBoxVisible, setSearchBoxVisible] = useState(hiddenSearchBoxes);
  const [announcement, setAnnouncement] = useState('');
  const previousTiersRef = useRef<TierData[] | undefined>(undefined);
  const announcementFrameRef = useRef<number | undefined>(undefined);
  const myWorkFilterActiveRef = useRef(false);
  const lastNoResultsAnnouncementRef = useRef<TabQueries>(emptyQueries);
  // Declared up-front (not next to its sibling refs below) because the
  // window-level keydown handler installed in the mount effect references
  // `multiSelectionRef.current` to read the latest selection without
  // re-installing the listener. Keeping the declaration here avoids TS's
  // "used before its declaration" diagnostic on the closure capture.
  const multiSelectionRef = useRef(multiSelection);
  multiSelectionRef.current = multiSelection;
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
      if (isFindShortcut) {
        event.preventDefault();
        event.stopPropagation();
        postMessage({ type: 'requestToggleSearch' });
        return;
      }
      if (event.key === 'Escape' && multiSelectionRef.current) {
        // Don't preventDefault — Escape should still close any open dropdowns
        // / clear focus / etc.; we just additionally clear the multi-select.
        setMultiSelection(clearSelection());
      }
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

  // Reconcile the multi-selection whenever tier contents change. If items
  // were transitioned out of the selected tier (e.g. as a result of the
  // bulk action that user just invoked) drop them from the selection. If
  // nothing is left, fall back to null so the bulk action bar hides.
  useEffect(() => {
    setMultiSelection(current => {
      if (!current) {
        return current;
      }
      const tier = tiers.find(t => t.id === current.tierId);
      const next = reconcileSelection(current, tier ? { tierId: tier.id, itemIds: tier.items.map(i => i.id) } : undefined);
      return next === current ? current : next;
    });
  }, [tiers]);

  // Resolve the selected tier from the unfiltered tier list, not the
  // visible one — multi-selection is a property of the underlying tier,
  // not the search-filtered projection. Without this, typing into the
  // search box could leave the bulk-action bar visible with an empty
  // action set when the filter hides every selected card.
  const selectedTier = multiSelection ? tiers.find(t => t.id === multiSelection.tierId) : undefined;
  const selectedItems: ItemCardData[] = useMemo(() => {
    if (!multiSelection || !selectedTier) {
      return [];
    }
    return selectedTier.items.filter(item => multiSelection.itemIds.has(item.id));
  }, [multiSelection, selectedTier]);
  const bulkActions = useMemo(() => getBulkActionsForItems(selectedItems), [selectedItems]);
  const showBulkBar = multiSelection !== null && multiSelection.itemIds.size > 1;

  const handleTierItemClick = (tier: TierData, itemId: string, modifiers: ClickModifiers) => {
    const clicked = tier.items.find(item => item.id === itemId);
    const supportsMultiSelect = isMultiSelectTier(tier.id);
    const wantsMultiSelectGesture = supportsMultiSelect && (modifiers.shift || modifiers.toggle);

    if (wantsMultiSelectGesture) {
      // Modifier click on a multi-select-capable tier: update selection and
      // do NOT open the item — keeps the modifier-click gesture purely about
      // building a selection, matching standard list-box behavior.
      setMultiSelection(current => applySelectionClick(
        current,
        itemId,
        { tierId: tier.id, itemIds: tier.items.map(i => i.id) },
        modifiers.shift ? 'range' : 'toggle',
      ));
      return;
    }

    // Plain click: on a multi-select-capable tier, replace the selection
    // with the single clicked item (so the listbox always has an
    // aria-selected option and shift-click has an anchor). On non-multi-select
    // tiers (Incoming, Sources) just drop any stray selection. Either way,
    // also open the item.
    if (supportsMultiSelect) {
      setMultiSelection(applySelectionClick(
        null,
        itemId,
        { tierId: tier.id, itemIds: tier.items.map(i => i.id) },
        'none',
      ));
    } else {
      setMultiSelection(null);
    }

    if (clicked?.tierType === 'incoming' && clicked.providerId && clicked.externalId && clicked.isUnseen) {
      postMessage({ type: 'markSeen', providerId: clicked.providerId, externalId: clicked.externalId });
    }
    postMessage({
      type: 'openItem',
      itemId,
      ...(clicked?.providerId ? { providerId: clicked.providerId } : {}),
      ...(clicked?.externalId ? { externalId: clicked.externalId } : {}),
    });
  };

  const handleBulkAction = (action: BulkAction) => {
    if (!multiSelection) {
      return;
    }
    const itemIds = Array.from(multiSelection.itemIds);
    postMessage({ type: 'bulkTransition', itemIds, targetState: action.targetState });
    // Optimistically clear; the next updateItems push will re-render the
    // tiers with the items in their new home.
    setMultiSelection(null);
  };

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
                    onItemClick={(id, modifiers) => handleTierItemClick(tier, id, modifiers)}
                    multiSelectionIds={multiSelection?.tierId === tier.id ? multiSelection.itemIds : undefined}
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
      {showBulkBar ? (
        <BulkActionBar
          count={multiSelection!.itemIds.size}
          actions={bulkActions}
          onAction={handleBulkAction}
          onClear={() => setMultiSelection(null)}
        />
      ) : null}
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
