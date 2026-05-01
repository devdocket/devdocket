import { useRef } from 'preact/hooks';

interface TabBarProps {
  activeTab: 'myWork' | 'sources';
  onTabSwitch: (tab: 'myWork' | 'sources') => void;
  onCreateItem: () => void;
}

export function TabBar({ activeTab, onTabSwitch, onCreateItem }: TabBarProps) {
  const myWorkTabRef = useRef<HTMLButtonElement>(null);
  const sourcesTabRef = useRef<HTMLButtonElement>(null);

  const focusTab = (tab: 'myWork' | 'sources') => {
    requestAnimationFrame(() => {
      if (tab === 'myWork') {
        myWorkTabRef.current?.focus();
        return;
      }

      sourcesTabRef.current?.focus();
    });
  };

  const handleTabKeyDown = (event: KeyboardEvent, currentTab: 'myWork' | 'sources') => {
    let nextTab: 'myWork' | 'sources' | undefined;

    switch (event.key) {
      case 'ArrowLeft':
      case 'ArrowRight':
        nextTab = currentTab === 'myWork' ? 'sources' : 'myWork';
        break;
      case 'Home':
        nextTab = 'myWork';
        break;
      case 'End':
        nextTab = 'sources';
        break;
      default:
        return;
    }

    event.preventDefault();
    onTabSwitch(nextTab);
    focusTab(nextTab);
  };

  return (
    <div class="tab-bar">
      <div class="tab-list" role="tablist">
        <button
          id="mission-control-tab-my-work"
          ref={myWorkTabRef}
          class={`tab ${activeTab === 'myWork' ? 'active' : ''}`}
          type="button"
          role="tab"
          aria-selected={activeTab === 'myWork'}
          aria-controls="mission-control-panel-my-work"
          tabIndex={activeTab === 'myWork' ? 0 : -1}
          onClick={() => onTabSwitch('myWork')}
          onKeyDown={(event) => handleTabKeyDown(event, 'myWork')}
        >
          My Work
        </button>
        <button
          id="mission-control-tab-sources"
          ref={sourcesTabRef}
          class={`tab ${activeTab === 'sources' ? 'active' : ''}`}
          type="button"
          role="tab"
          aria-selected={activeTab === 'sources'}
          aria-controls="mission-control-panel-sources"
          tabIndex={activeTab === 'sources' ? 0 : -1}
          onClick={() => onTabSwitch('sources')}
          onKeyDown={(event) => handleTabKeyDown(event, 'sources')}
        >
          Sources
        </button>
      </div>
      <button
        type="button"
        class="tab-action"
        title="Create item"
        aria-label="Create item"
        onClick={onCreateItem}
      >
        ➕
      </button>
    </div>
  );
}
