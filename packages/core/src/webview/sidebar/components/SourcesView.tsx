import { useState } from 'preact/hooks';
import type { SourceGroupData, SourceProviderData } from '../../shared/types';
import { OnboardingEmptyState } from './OnboardingEmptyState';
import { SourceItem } from './SourceItem';

interface SourcesViewProps {
  providers: SourceProviderData[];
  onOpenItem: (providerId: string, externalId: string) => void;
}

export function SourcesView({ providers, onOpenItem }: SourcesViewProps) {
  if (providers.length === 0) {
    return (
      <div class="sources-tab">
        <OnboardingEmptyState
          titleId="sources-empty-state-title"
          description="Create a work item manually, or install a provider extension to populate Sources with GitHub issues, Azure DevOps tasks, PR reviews, and more."
        />
      </div>
    );
  }

  return (
    <div class="sources-tab">
      <div class="sources-list">
        {providers.map(provider => (
          <ProviderSection
            key={provider.providerId}
            provider={provider}
            onOpenItem={onOpenItem}
          />
        ))}
      </div>
    </div>
  );
}

interface ProviderSectionProps {
  provider: SourceProviderData;
  onOpenItem: (providerId: string, externalId: string) => void;
}

function ProviderSection({ provider, onOpenItem }: ProviderSectionProps) {
  const [collapsed, setCollapsed] = useState(false);
  const itemCount = provider.groups.reduce((total, group) => total + group.items.length, 0);

  return (
    <section
      class={`source-provider ${provider.isHealthy ? '' : 'unhealthy'}`.trim()}
      role="group"
      aria-label={provider.label}
    >
      <button
        type="button"
        class="source-provider-header"
        onClick={() => setCollapsed(value => !value)}
        aria-expanded={!collapsed}
      >
        <span class="source-provider-title">
          <span>{provider.label}</span>
          {!provider.isHealthy ? <span class="health-warning" aria-label="Provider unhealthy">⚠</span> : null}
        </span>
        <span class="source-provider-meta">
          <span>({itemCount})</span>
          <span class="source-provider-toggle" aria-hidden="true">{collapsed ? '▸' : '▾'}</span>
        </span>
      </button>
      {!collapsed ? (
        <div class="source-provider-groups">
          {provider.groups.length === 0 ? (
            <div class="source-empty">No items found</div>
          ) : (
            provider.groups.map(group => (
              <GroupSection
                key={`${provider.providerId}-${group.name}`}
                providerId={provider.providerId}
                group={group}
                onOpenItem={onOpenItem}
              />
            ))
          )}
        </div>
      ) : null}
    </section>
  );
}

interface GroupSectionProps {
  providerId: string;
  group: SourceGroupData;
  onOpenItem: (providerId: string, externalId: string) => void;
}

function GroupSection({ providerId, group, onOpenItem }: GroupSectionProps) {
  const [collapsed, setCollapsed] = useState(false);
  const itemCountLabel = `${group.name}, ${group.items.length} item${group.items.length === 1 ? '' : 's'}`;

  return (
    <section class="source-group" role="group" aria-label={itemCountLabel}>
      <button
        type="button"
        class="source-group-header"
        onClick={() => setCollapsed(value => !value)}
        aria-expanded={!collapsed}
      >
        <span class="source-group-title">{group.name}</span>
        <span class="source-group-meta">
          <span>({group.items.length})</span>
          <span class="source-group-toggle" aria-hidden="true">{collapsed ? '▸' : '▾'}</span>
        </span>
      </button>
      {!collapsed ? (
        <div class="source-group-items">
          {group.items.map(item => (
            <SourceItem
              key={`${item.providerId}-${item.externalId}`}
              item={item}
              onOpen={() => onOpenItem(providerId, item.externalId)}
            />
          ))}
        </div>
      ) : null}
    </section>
  );
}
