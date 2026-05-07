import { useState } from 'preact/hooks';
import type { SourceGroupData, SourceProviderData } from '../../shared/types';
import { getGroupTotalCountKey } from '../filter';
import { HighlightedText } from './HighlightedText';
import { OnboardingEmptyState } from './OnboardingEmptyState';
import { SourceItem } from './SourceItem';

interface SourcesViewProps {
  providers: SourceProviderData[];
  onOpenItem: (providerId: string, externalId: string) => void;
  onShowProviderHealth: (providerId: string) => void;
  forceExpanded?: boolean;
  totalCounts?: Map<string, number>;
  query?: string;
}

export function SourcesView({ providers, onOpenItem, onShowProviderHealth, forceExpanded = false, totalCounts, query }: SourcesViewProps) {
  if (providers.length === 0) {
    return (
      <OnboardingEmptyState
        titleId="sources-empty-state-title"
        description="Create a work item manually, or install a provider extension to populate Sources with GitHub issues, Azure DevOps tasks, PR reviews, and more."
      />
    );
  }

  return (
    <div class="sources-list">
      {providers.map(provider => (
        <ProviderSection
          key={provider.providerId}
          provider={provider}
          onOpenItem={onOpenItem}
          onShowProviderHealth={onShowProviderHealth}
          forceExpanded={forceExpanded}
          totalCount={totalCounts?.get(provider.providerId)}
          totalCounts={totalCounts}
          query={query}
        />
      ))}
    </div>
  );
}

interface ProviderSectionProps {
  provider: SourceProviderData;
  onOpenItem: (providerId: string, externalId: string) => void;
  onShowProviderHealth: (providerId: string) => void;
  forceExpanded: boolean;
  totalCount?: number;
  totalCounts?: Map<string, number>;
  query?: string;
}

function ProviderSection({ provider, onOpenItem, onShowProviderHealth, forceExpanded, totalCount, totalCounts, query }: ProviderSectionProps) {
  const [collapsed, setCollapsed] = useState(false);
  const itemCount = provider.groups.reduce((total, group) => total + group.items.length, 0);
  const isCollapsed = forceExpanded ? false : collapsed;
  const countLabel = totalCount === undefined ? `(${itemCount})` : `(${itemCount} of ${totalCount})`;
  const collapseTitle = forceExpanded ? 'Clear filter to collapse' : undefined;
  const toggleCollapsed = () => {
    if (!forceExpanded) {
      setCollapsed(value => !value);
    }
  };

  return (
    <section
      class={`source-provider ${provider.isHealthy ? '' : 'unhealthy'}`.trim()}
      role="group"
      aria-label={provider.label}
    >
      <div class="source-provider-header">
        <span class="source-provider-title">
          <button
            type="button"
            class="source-provider-toggle-button source-provider-title-button"
            onClick={toggleCollapsed}
            aria-expanded={!isCollapsed}
            disabled={forceExpanded}
            title={collapseTitle}
          >
            <span>{provider.label}</span>
          </button>
          {!provider.isHealthy ? (
            <button
              type="button"
              class="health-warning health-warning-button"
              onClick={() => onShowProviderHealth(provider.providerId)}
              aria-label={`Provider ${provider.label} unhealthy — show details`}
            >
              ⚠
            </button>
          ) : null}
        </span>
        <button
          type="button"
          class="source-provider-toggle-button source-provider-meta"
          onClick={toggleCollapsed}
          aria-expanded={!isCollapsed}
          aria-label={`${isCollapsed ? 'Expand' : 'Collapse'} ${provider.label} source items`}
          disabled={forceExpanded}
          title={collapseTitle}
        >
          <span>{countLabel}</span>
          <span class="source-provider-toggle" aria-hidden="true">{isCollapsed ? '▸' : '▾'}</span>
        </button>
      </div>
      {!isCollapsed ? (
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
                forceExpanded={forceExpanded}
                totalCount={totalCounts?.get(getGroupTotalCountKey(provider.providerId, group.name))}
                query={query}
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
  forceExpanded: boolean;
  totalCount?: number;
  query?: string;
}

function GroupSection({ providerId, group, onOpenItem, forceExpanded, totalCount, query }: GroupSectionProps) {
  const [collapsed, setCollapsed] = useState(false);
  const isCollapsed = forceExpanded ? false : collapsed;
  const countLabel = totalCount === undefined ? `(${group.items.length})` : `(${group.items.length} of ${totalCount})`;
  const itemCountLabel = `${group.name}, ${group.items.length} item${group.items.length === 1 ? '' : 's'}`;
  const collapseTitle = forceExpanded ? 'Clear filter to collapse' : undefined;
  const toggleCollapsed = () => {
    if (!forceExpanded) {
      setCollapsed(value => !value);
    }
  };

  return (
    <section class="source-group" role="group" aria-label={itemCountLabel}>
      <button
        type="button"
        class="source-group-header"
        onClick={toggleCollapsed}
        aria-expanded={!isCollapsed}
        disabled={forceExpanded}
        title={collapseTitle}
      >
        <span class="source-group-title"><HighlightedText text={group.name} query={query} /></span>
        <span class="source-group-meta">
          <span>{countLabel}</span>
          <span class="source-group-toggle" aria-hidden="true">{isCollapsed ? '▸' : '▾'}</span>
        </span>
      </button>
      {!isCollapsed ? (
        <div class="source-group-items">
          {group.items.map(item => (
            <SourceItem
              key={`${item.providerId}-${item.externalId}`}
              item={item}
              query={query}
              onOpen={() => onOpenItem(providerId, item.externalId)}
            />
          ))}
        </div>
      ) : null}
    </section>
  );
}
