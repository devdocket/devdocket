import { useEffect, useState } from 'preact/hooks';
import { TabBar } from './components/TabBar';
import type { ExtensionMessage, SourceProviderData, TierData } from '../shared/types';
import { postMessage } from '../shared/messaging';

export function App() {
  const [activeTab, setActiveTab] = useState<'myWork' | 'sources'>('myWork');
  const [tiers, setTiers] = useState<TierData[]>([]);
  const [sources, setSources] = useState<SourceProviderData[]>([]);

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
        {activeTab === 'myWork' ? (
          <div class="my-work-tab">
            {tiers.length === 0 ? (
              <div class="empty-state">No items yet</div>
            ) : (
              <div class="tiers">
                <div class="placeholder">My Work content coming in Phase 2</div>
              </div>
            )}
          </div>
        ) : (
          <div class="sources-tab">
            {sources.length === 0 ? (
              <div class="empty-state">No sources yet</div>
            ) : (
              <div class="placeholder">Sources content coming in Phase 3</div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
