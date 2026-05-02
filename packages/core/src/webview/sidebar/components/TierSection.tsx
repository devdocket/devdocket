import { Fragment } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import type { TierData } from '../../shared/types';
import { ItemCard } from './ItemCard';

interface TierSectionProps {
  tier: TierData;
  onItemClick: (itemId: string) => void;
  onAcceptItem?: (providerId: string, externalId: string) => void;
  onDismissItem?: (providerId: string, externalId: string) => void;
  onTransitionState?: (itemId: string, targetState: string) => void;
  onReorderItems?: (itemIds: string[]) => void;
  onAcceptAll?: () => void;
  onClearHistory?: () => void;
}

export function TierSection({
  tier,
  onItemClick,
  onAcceptItem,
  onDismissItem,
  onTransitionState,
  onReorderItems,
  onAcceptAll,
  onClearHistory,
}: TierSectionProps) {
  const [collapsed, setCollapsed] = useState(tier.collapsed);
  const [activeItemId, setActiveItemId] = useState<string | undefined>(() =>
    tier.items.find(item => item.isSelected)?.id ?? tier.items[0]?.id,
  );
  const [draggedItemId, setDraggedItemId] = useState<string | undefined>();
  const [dropIndex, setDropIndex] = useState<number | null>(null);
  const [isDragActive, setIsDragActive] = useState(false);
  const headerButtonRef = useRef<HTMLButtonElement>(null);
  const itemRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const dragDepthRef = useRef(0);
  const isReorderableTier = tier.id === 'ready-to-start' || tier.id === 'in-progress';
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

  const clearDropState = () => {
    dragDepthRef.current = 0;
    setDraggedItemId(undefined);
    setDropIndex(null);
    setIsDragActive(false);
  };

  const getDropIndexFromPointer = (clientY: number): number => {
    for (let index = 0; index < tier.items.length; index += 1) {
      const element = itemRefs.current[tier.items[index].id];
      if (!element) {
        continue;
      }

      const rect = element.getBoundingClientRect();
      if (clientY < rect.top + rect.height / 2) {
        return index;
      }
    }

    return tier.items.length;
  };

  const updateDropIndex = (clientY: number) => {
    setDropIndex(getDropIndexFromPointer(clientY));
  };

  const handleDragStart = (itemId: string) => {
    if (!isReorderableTier) {
      return;
    }

    dragDepthRef.current = 0;
    setDraggedItemId(itemId);
    setDropIndex(null);
    setIsDragActive(true);
  };

  const handleDragEnd = () => {
    clearDropState();
  };

  const handleDragEnter = (event: DragEvent) => {
    if (!isReorderableTier || !draggedItemId) {
      return;
    }

    dragDepthRef.current += 1;
    setIsDragActive(true);
    updateDropIndex(event.clientY);
  };

  const handleDragOver = (event: DragEvent) => {
    if (!isReorderableTier || !draggedItemId) {
      return;
    }

    event.preventDefault();
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = 'move';
    }
    setIsDragActive(true);
    updateDropIndex(event.clientY);
  };

  const handleDragLeave = () => {
    if (!isReorderableTier || !draggedItemId) {
      return;
    }

    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) {
      setDropIndex(null);
      setIsDragActive(false);
    }
  };

  const handleDrop = (event: DragEvent) => {
    if (!isReorderableTier) {
      return;
    }

    event.preventDefault();

    const sourceItemId = event.dataTransfer?.getData('text/plain') || draggedItemId;
    const nextDropIndex = getDropIndexFromPointer(event.clientY);
    clearDropState();

    if (!sourceItemId) {
      return;
    }

    const currentIndex = tier.items.findIndex(item => item.id === sourceItemId);
    if (currentIndex === -1) {
      return;
    }

    const draggedItem = tier.items[currentIndex];
    const reorderedItems = tier.items.filter(item => item.id !== sourceItemId);
    const boundedDropIndex = Math.max(0, Math.min(reorderedItems.length, nextDropIndex > currentIndex ? nextDropIndex - 1 : nextDropIndex));
    reorderedItems.splice(boundedDropIndex, 0, draggedItem);

    const reorderedIds = reorderedItems.map(item => item.id);
    if (reorderedIds.every((itemId, index) => itemId === tier.items[index]?.id)) {
      return;
    }

    onReorderItems?.(reorderedIds);
  };

  return (
    <section class="tier-section">
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
          class={`tier-items ${isDragActive ? 'drag-active' : ''}`.trim()}
          role="listbox"
          aria-label={itemCountLabel}
          aria-orientation="vertical"
          aria-multiselectable={false}
          onDragEnter={isReorderableTier ? handleDragEnter : undefined}
          onDragOver={isReorderableTier ? handleDragOver : undefined}
          onDragLeave={isReorderableTier ? handleDragLeave : undefined}
          onDrop={isReorderableTier ? handleDrop : undefined}
        >
          {tier.items.map((item, index) => (
            <Fragment key={item.id}>
              {dropIndex === index ? <div class="drop-indicator" aria-hidden="true" /> : null}
              <ItemCard
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
                onDragStart={isReorderableTier ? handleDragStart : undefined}
                onDragEnd={isReorderableTier ? handleDragEnd : undefined}
              />
            </Fragment>
          ))}
          {dropIndex === tier.items.length ? <div class="drop-indicator" aria-hidden="true" /> : null}
        </div>
      ) : null}
    </section>
  );
}
