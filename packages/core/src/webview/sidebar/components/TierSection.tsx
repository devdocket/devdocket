import { Fragment } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import type { TierData } from '../../shared/types';
import { ItemCard } from './ItemCard';

interface TierSectionProps {
  tier: TierData;
  onItemClick: (itemId: string) => void;
  onAcceptItem?: (providerId: string, externalId: string) => void;
  onAcceptToFocus?: (providerId: string, externalId: string) => void;
  onDismissItem?: (providerId: string, externalId: string) => void;
  onTransitionState?: (itemId: string, targetState: string) => void;
  onReorderItems?: (itemIds: string[]) => void;
  /**
   * Fired when a card from another reorderable tier is dropped onto this
   * tier. The receiving extension converts this into a state transition
   * (e.g. dropping a Ready item on the In Progress tier transitions it to
   * `InProgress`). Only set for tiers that accept cross-tier drops.
   */
  onCrossTierDrop?: (itemId: string) => void;
  onAcceptAll?: () => void;
  onClearHistory?: () => void;
  disableDragReorder?: boolean;
  isFilterActive?: boolean;
  forceExpanded?: boolean;
  totalCount?: number;
  query?: string;
}

export function TierSection({
  tier,
  onItemClick,
  onAcceptItem,
  onAcceptToFocus,
  onDismissItem,
  onTransitionState,
  onReorderItems,
  onCrossTierDrop,
  onAcceptAll,
  onClearHistory,
  disableDragReorder = false,
  isFilterActive = false,
  forceExpanded = false,
  totalCount,
  query,
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
  const isReorderableTier = !disableDragReorder && (tier.id === 'ready-to-start' || tier.id === 'in-progress');
  const isCollapsed = forceExpanded ? false : collapsed;
  const countLabel = totalCount === undefined ? `(${tier.items.length})` : `(${tier.items.length} of ${totalCount})`;
  const toggleCollapsed = () => {
    if (!forceExpanded) {
      setCollapsed(value => !value);
    }
  };
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

  useEffect(() => {
    if (!isReorderableTier) {
      clearDropState();
    }
  }, [isReorderableTier]);

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
      // Cross-tier drop: the source card lives in another reorderable tier
      // (typically the other half of Ready ↔ In Progress). Hand off to the
      // App-level handler which posts a transition message to the extension.
      onCrossTierDrop?.(sourceItemId);
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

  /**
   * Move the focused item up or down within the tier via keyboard. Mirrors
   * the same reorder protocol used by the drag-and-drop handler so the
   * extension only ever receives a single canonical ordering message.
   */
  const moveItemByKeyboard = (itemId: string, direction: -1 | 1) => {
    if (!isReorderableTier) {
      return;
    }

    const currentIndex = tier.items.findIndex(item => item.id === itemId);
    if (currentIndex === -1) {
      return;
    }

    const nextIndex = currentIndex + direction;
    if (nextIndex < 0 || nextIndex >= tier.items.length) {
      return;
    }

    const reorderedItems = tier.items.slice();
    const [moved] = reorderedItems.splice(currentIndex, 1);
    reorderedItems.splice(nextIndex, 0, moved);
    onReorderItems?.(reorderedItems.map(item => item.id));
    setActiveItemId(moved.id);
    focusItem(moved.id);
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
          aria-expanded={!isCollapsed}
          aria-controls={!isCollapsed ? itemsId : undefined}
        >
          <span aria-hidden="true">{tier.icon}</span>
          <span>{tier.name}</span>
          <span class="tier-count">{countLabel}</span>
        </button>
        {tier.id === 'incoming' && onAcceptAll ? (
          <button
            type="button"
            class="tier-header-action"
            title={isFilterActive ? 'Clear filter to use Accept All' : 'Accept all'}
            aria-label="Accept all incoming items"
            aria-disabled={isFilterActive}
            onClick={(event) => {
              event.stopPropagation();
              if (!isFilterActive) {
                onAcceptAll();
              }
            }}
          >
            Accept All
          </button>
        ) : null}
        {tier.id === 'done' && onClearHistory ? (
          <button
            type="button"
            class="tier-header-action"
            title={isFilterActive ? 'Clear filter to clear history' : 'Clear history'}
            aria-label="Clear completed items"
            disabled={isFilterActive}
            onClick={(event) => {
              event.stopPropagation();
              if (!isFilterActive) {
                onClearHistory();
              }
            }}
          >
            Clear
          </button>
        ) : null}
        <button
          type="button"
          class="tier-toggle-button"
          onClick={toggleCollapsed}
          aria-label={`${isCollapsed ? 'Expand' : 'Collapse'} ${tier.name}`}
          tabIndex={-1}
        >
          <span class="tier-toggle" aria-hidden="true">{isCollapsed ? '▸' : '▾'}</span>
        </button>
      </div>
      {!isCollapsed ? (
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
              {isReorderableTier && dropIndex === index ? <div class="drop-indicator" aria-hidden="true" /> : null}
              <ItemCard
                item={item}
                query={query}
                disableDragReorder={disableDragReorder}
                tabIndex={item.id === activeItemId ? 0 : -1}
                itemRef={(element) => {
                  itemRefs.current[item.id] = element;
                }}
                onFocus={() => setActiveItemId(item.id)}
                onMoveFocus={moveItemFocus}
                onMoveTierFocus={focusTierHeader}
                onClick={() => onItemClick(item.id)}
                onAccept={onAcceptItem}
                onAcceptToFocus={onAcceptToFocus}
                onDismiss={onDismissItem}
                onTransition={onTransitionState}
                onDragStart={isReorderableTier ? handleDragStart : undefined}
                onDragEnd={isReorderableTier ? handleDragEnd : undefined}
                onMoveItem={isReorderableTier ? moveItemByKeyboard : undefined}
              />
            </Fragment>
          ))}
          {isReorderableTier && dropIndex === tier.items.length ? <div class="drop-indicator" aria-hidden="true" /> : null}
        </div>
      ) : null}
    </section>
  );
}
