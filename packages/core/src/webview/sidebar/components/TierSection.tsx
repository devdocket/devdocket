import { useEffect, useRef, useState } from 'preact/hooks';
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
  const [activeItemId, setActiveItemId] = useState<string | undefined>(() =>
    tier.items.find(item => item.isSelected)?.id ?? tier.items[0]?.id,
  );
  const headerButtonRef = useRef<HTMLButtonElement>(null);
  const itemRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const toggleCollapsed = () => setCollapsed(value => !value);
  const itemCountLabel = `${tier.name}, ${tier.items.length} item${tier.items.length === 1 ? '' : 's'}`;
  const itemsId = `mission-control-tier-${tier.id}`;

  useEffect(() => {
    if (tier.items.length === 0) {
      setActiveItemId(undefined);
      return;
    }

    const selectedItem = tier.items.find(item => item.isSelected);
    setActiveItemId(currentItemId => {
      if (selectedItem) {
        return selectedItem.id;
      }

      if (currentItemId && tier.items.some(item => item.id === currentItemId)) {
        return currentItemId;
      }

      return tier.items[0]?.id;
    });
  }, [tier.items]);

  const focusItem = (itemId: string) => {
    requestAnimationFrame(() => itemRefs.current[itemId]?.focus());
  };

  const moveItemFocus = (direction: -1 | 1) => {
    if (tier.items.length === 0) {
      return;
    }

    const currentIndex = activeItemId ? tier.items.findIndex(item => item.id === activeItemId) : -1;
    const startIndex = currentIndex >= 0 ? currentIndex : 0;
    const nextIndex = startIndex + direction;
    if (nextIndex < 0 || nextIndex >= tier.items.length) {
      return;
    }

    const nextItem = tier.items[nextIndex];
    setActiveItemId(nextItem.id);
    focusItem(nextItem.id);
  };

  const focusTierHeader = (direction: -1 | 1): boolean => {
    const currentHeader = headerButtonRef.current;
    if (!currentHeader) {
      return false;
    }

    const container = currentHeader.closest('.my-work-tab') ?? document.body;
    const tierHeaders = Array.from(container.querySelectorAll<HTMLButtonElement>('[data-tier-header="true"]'));
    const currentIndex = tierHeaders.indexOf(currentHeader);
    const targetHeader = currentIndex >= 0 ? tierHeaders[currentIndex + direction] : undefined;
    if (!targetHeader) {
      return false;
    }

    requestAnimationFrame(() => targetHeader.focus());
    return true;
  };

  return (
    <section class={`tier-section tier-${tier.id}`}>
      <div class="tier-header">
        <button
          type="button"
          ref={headerButtonRef}
          class="tier-header-main"
          data-tier-header="true"
          onClick={toggleCollapsed}
          aria-expanded={!collapsed}
          aria-controls={!collapsed ? itemsId : undefined}
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
          tabIndex={-1}
        >
          <span class="tier-toggle" aria-hidden="true">{collapsed ? '▸' : '▾'}</span>
        </button>
      </div>
      {!collapsed ? (
        <div
          id={itemsId}
          class="tier-items"
          role="listbox"
          aria-label={itemCountLabel}
          aria-orientation="vertical"
          aria-multiselectable={false}
        >
          {tier.items.map(item => (
            <ItemCard
              key={item.id}
              item={item}
              tabIndex={item.id === activeItemId ? 0 : -1}
              itemRef={(element) => {
                itemRefs.current[item.id] = element;
              }}
              onFocus={() => setActiveItemId(item.id)}
              onMoveFocus={moveItemFocus}
              onMoveTierFocus={focusTierHeader}
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
