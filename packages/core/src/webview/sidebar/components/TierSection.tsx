import { useState } from 'preact/hooks';
import type { TierData } from '../../shared/types';
import { ItemCard } from './ItemCard';

interface TierSectionProps {
  tier: TierData;
  onItemClick: (itemId: string) => void;
}

export function TierSection({ tier, onItemClick }: TierSectionProps) {
  const [collapsed, setCollapsed] = useState(tier.collapsed);

  return (
    <section class={`tier-section tier-${tier.id}`}>
      <button
        type="button"
        class="tier-header"
        onClick={() => setCollapsed(value => !value)}
        aria-expanded={!collapsed}
      >
        <span aria-hidden="true">{tier.icon}</span>
        <span>{tier.name}</span>
        <span class="tier-count">({tier.items.length})</span>
        <span class="tier-toggle" aria-hidden="true">{collapsed ? '▸' : '▾'}</span>
      </button>
      {!collapsed ? (
        <div class="tier-items">
          {tier.items.map(item => (
            <ItemCard key={item.id} item={item} onClick={() => onItemClick(item.id)} />
          ))}
        </div>
      ) : null}
    </section>
  );
}
