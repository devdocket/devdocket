interface TabBarProps {
  activeTab: 'myWork' | 'sources';
  onTabSwitch: (tab: 'myWork' | 'sources') => void;
}

export function TabBar({ activeTab, onTabSwitch }: TabBarProps) {
  return (
    <div class="tab-bar" role="tablist">
      <button
        class={`tab ${activeTab === 'myWork' ? 'active' : ''}`}
        role="tab"
        aria-selected={activeTab === 'myWork'}
        onClick={() => onTabSwitch('myWork')}
      >
        My Work
      </button>
      <button
        class={`tab ${activeTab === 'sources' ? 'active' : ''}`}
        role="tab"
        aria-selected={activeTab === 'sources'}
        onClick={() => onTabSwitch('sources')}
      >
        Sources
      </button>
    </div>
  );
}
