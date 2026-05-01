import { useEffect, useState } from 'preact/hooks';
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

  useEffect(() => {
    const handler = (event: MessageEvent<ExtensionMessage>) => {
      const msg = event.data;
      switch (msg.type) {
        case 'updateItems':
          setTiers(msg.tiers);
          break;
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
    return () => window.removeEventListener('message', handler);
  }, []);

  const handleTabSwitch = (tab: 'myWork' | 'sources') => {
    setActiveTab(tab);
    postMessage({ type: 'switchTab', tab });
  };

  return (
    <div class="mission-control">
      <TabBar activeTab={activeTab} onTabSwitch={handleTabSwitch} />
      <div class="tab-content">
        {activeTab === 'sources' ? (
          <SourcesView
            providers={sources}
            onAcceptItem={(providerId, externalId) =>
              postMessage({ type: 'acceptItem', providerId, externalId })
            }
          />
        ) : (
          <div class="my-work-tab">
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
                    onItemClick={(id) => postMessage({ type: 'openItem', itemId: id })}
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
