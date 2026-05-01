import { useState } from 'preact/hooks';
import type { TierData } from '../../shared/types';
import { ItemCard } from './ItemCard';

interface TierSectionProps {
  tier: TierData;
  onItemClick: (itemId: string) => void;
  onAcceptItem?: (providerId: string, externalId: string) => void;
  onDismissItem?: (providerId: string, externalId: string) => void;
  onTransitionState?: (itemId: string, targetState: string) => void;
  onAcceptAll?: () => void;
  onClearHistory?: () => void;
}

export function TierSection({
  tier,
  onItemClick,
  onAcceptItem,
  onDismissItem,
  onTransitionState,
  onAcceptAll,
  onClearHistory,
}: TierSectionProps) {
  const [collapsed, setCollapsed] = useState(tier.collapsed);
  const toggleCollapsed = () => setCollapsed(value => !value);

  return (
    <section class={`tier-section tier-${tier.id}`}>
      <div class="tier-header">
        <button
          type="button"
          class="tier-header-main"
          onClick={toggleCollapsed}
          aria-expanded={!collapsed}
        >
          <span aria-hidden="true">{tier.icon}</span>
          <span>{tier.name}</span>
          <span class="tier-count">({tier.items.length})</span>
        </button>
        {tier.id === 'incoming' && onAcceptAll ? (
          <button
            type="button"
            class="tier-header-action"
            title="Accept all"
            aria-label="Accept all incoming items"
            onClick={(event) => {
              event.stopPropagation();
              onAcceptAll();
            }}
          >
            Accept All
          </button>
        ) : null}
        {tier.id === 'done' && onClearHistory ? (
          <button
            type="button"
            class="tier-header-action"
            title="Clear history"
            aria-label="Clear completed items"
            onClick={(event) => {
              event.stopPropagation();
              onClearHistory();
            }}
          >
            Clear
          </button>
        ) : null}
        <button
          type="button"
          class="tier-toggle-button"
          onClick={toggleCollapsed}
          aria-label={`${collapsed ? 'Expand' : 'Collapse'} ${tier.name}`}
        >
          <span class="tier-toggle" aria-hidden="true">{collapsed ? '▸' : '▾'}</span>
        </button>
      </div>
      {!collapsed ? (
        <div class="tier-items">
          {tier.items.map(item => (
            <ItemCard
              key={item.id}
              item={item}
              onClick={() => onItemClick(item.id)}
              onAccept={onAcceptItem}
              onDismiss={onDismissItem}
              onTransition={onTransitionState}
            />
          ))}
        </div>
      ) : null}
    </section>
  );
}
