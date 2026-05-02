import { useEffect, useRef, useState } from 'preact/hooks';
import type { ExtensionMessage, SourceProviderData, TierData } from '../shared/types';
import { postMessage } from '../shared/messaging';
import { SourcesView } from './components/SourcesView';
import { TabBar } from './components/TabBar';
import { TierSection } from './components/TierSection';

export function App() {
  const [activeTab, setActiveTab] = useState<'myWork' | 'sources'>('myWork');
  const [tiers, setTiers] = useState<TierData[]>([]);
  const [sources, setSources] = useState<SourceProviderData[]>([]);
  const [selectedItemId, setSelectedItemId] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const previousTiersRef = useRef<TierData[] | undefined>(undefined);
  const announcementFrameRef = useRef<number | undefined>(undefined);

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
    const handler = (event: MessageEvent<ExtensionMessage>) => {
      const msg = event.data;
      switch (msg.type) {
        case 'updateItems': {
          const nextTiers = msg.tiers;
          const previousTiers = previousTiersRef.current;
          if (previousTiers) {
            announce(buildLiveAnnouncement(previousTiers, nextTiers));
          }
          previousTiersRef.current = nextTiers;
          setTiers(nextTiers);
          break;
        }
        case 'updateSources':
          setSources(msg.providers);
          break;
        case 'selectItem':
          setSelectedItemId(msg.itemId);
          break;
        case 'updateWatches':
          break;
      }
    };

    window.addEventListener('message', handler);
    return () => {
      window.removeEventListener('message', handler);
      if (announcementFrameRef.current !== undefined) {
        cancelAnimationFrame(announcementFrameRef.current);
      }
    };
  }, []);

  const handleTabSwitch = (tab: 'myWork' | 'sources') => {
    setActiveTab(tab);
    postMessage({ type: 'switchTab', tab });
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
            role="tabpanel"
            id="mission-control-panel-sources"
            aria-labelledby="mission-control-tab-sources"
          >
            <SourcesView
              providers={sources}
              onAcceptItem={(providerId, externalId) =>
                postMessage({ type: 'acceptItem', providerId, externalId })
              }
            />
          </div>
        ) : (
          <div
            class="my-work-tab"
            role="tabpanel"
            id="mission-control-panel-my-work"
            aria-labelledby="mission-control-tab-my-work"
          >
            {tiers.length === 0 ? (
              <div class="empty-state">No items yet</div>
            ) : (
              <div class="tiers">
                {tiers.map(tier => (
                  <TierSection
                    key={tier.id}
                    tier={{
                      ...tier,
                      items: tier.items.map(item => ({
                        ...item,
                        isSelected: item.id === selectedItemId,
                      })),
                    }}
                    onItemClick={(id) => {
                      // For incoming items, also mark them seen so the unread
                      // indicator clears once the user opens the editor.
                      const clicked = tier.items.find(item => item.id === id);
                      if (clicked?.tierType === 'incoming' && clicked.providerId && clicked.externalId && clicked.isUnseen) {
                        postMessage({ type: 'markSeen', providerId: clicked.providerId, externalId: clicked.externalId });
                      }
                      postMessage({ type: 'openItem', itemId: id });
                    }}
                    onAcceptItem={(providerId, externalId) => postMessage({ type: 'acceptItem', providerId, externalId })}
                    onAcceptToFocus={(providerId, externalId) => postMessage({ type: 'acceptToFocus', providerId, externalId })}
                    onDismissItem={(providerId, externalId) => postMessage({ type: 'dismissItem', providerId, externalId })}
                    onTransitionState={(itemId, targetState) => postMessage({ type: 'transitionState', itemId, targetState })}
                    onReorderItems={tier.id === 'ready-to-start' || tier.id === 'in-progress' ? (itemIds) => postMessage({ type: 'reorderItems', itemIds }) : undefined}
                    onAcceptAll={tier.id === 'incoming' ? () => postMessage({ type: 'acceptAll' }) : undefined}
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

interface ItemLocation {
  title: string;
  tierId: string;
  tierName: string;
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
