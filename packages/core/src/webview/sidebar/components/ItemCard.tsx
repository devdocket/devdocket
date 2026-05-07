import { useRef, useState } from 'preact/hooks';
import type { ItemCardData } from '../../shared/types';
import { BadgePill } from './BadgePill';
import { HighlightedText } from './HighlightedText';

interface ItemCardProps {
  item: ItemCardData;
  tabIndex: number;
  itemRef?: (element: HTMLDivElement | null) => void;
  onFocus?: () => void;
  onMoveFocus?: (direction: -1 | 1) => void;
  onMoveTierFocus?: (direction: -1 | 1) => boolean;
  onClick: () => void;
  onAccept?: (providerId: string, externalId: string) => void;
  onAcceptToFocus?: (providerId: string, externalId: string) => void;
  onDismiss?: (providerId: string, externalId: string) => void;
  onTransition?: (itemId: string, targetState: string) => void;
  onDragStart?: (itemId: string) => void;
  onDragEnd?: () => void;
  /**
   * Reorder this card within its tier in response to keyboard input
   * (Alt + Arrow Up/Down). Only set for cards inside reorderable tiers
   * (Ready to Start / In Progress).
   */
  onMoveItem?: (itemId: string, direction: -1 | 1) => void;
  disableDragReorder?: boolean;
  query?: string;
}

interface ItemAction {
  id: string;
  icon: string;
  title: string;
  onClick: () => void;
}

export function ItemCard({
  item,
  tabIndex,
  itemRef,
  onFocus,
  onMoveFocus,
  onMoveTierFocus,
  onClick,
  onAccept,
  onAcceptToFocus,
  onDismiss,
  onTransition,
  onDragStart,
  onDragEnd,
  onMoveItem,
  disableDragReorder = false,
  query,
}: ItemCardProps) {
  const actions = getItemActions(item, onAccept, onAcceptToFocus, onDismiss, onTransition);
  const isDraggable = !disableDragReorder && (item.tierType === 'readyToStart' || item.tierType === 'inProgress');
  const [actionsOpen, setActionsOpen] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const itemElementRef = useRef<HTMLDivElement | null>(null);
  const actionButtonRefs = useRef<Record<string, HTMLButtonElement | null>>({});

  const closeActions = () => setActionsOpen(false);
  const focusItem = () => requestAnimationFrame(() => itemElementRef.current?.focus());
  const openActions = () => {
    if (actions.length === 0) {
      return;
    }

    setActionsOpen(true);
    requestAnimationFrame(() => actionButtonRefs.current[actions[0].id]?.focus());
  };

  const setItemElement = (element: HTMLDivElement | null) => {
    itemElementRef.current = element;
    itemRef?.(element);
  };

  const handleKeyDown = (event: KeyboardEvent) => {
    // Alt + Arrow reorders the card within its tier (a11y alternative to drag-and-drop).
    if (event.altKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown') && isDraggable && onMoveItem) {
      event.preventDefault();
      onMoveItem(item.id, event.key === 'ArrowDown' ? 1 : -1);
      return;
    }
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        onMoveFocus?.(1);
        break;
      case 'ArrowUp':
        event.preventDefault();
        onMoveFocus?.(-1);
        break;
      case 'Tab':
        if (!actionsOpen && onMoveTierFocus?.(event.shiftKey ? -1 : 1)) {
          event.preventDefault();
        }
        break;
      case 'Enter':
        event.preventDefault();
        onClick();
        break;
      case ' ':
      case 'Spacebar':
        if (actionsOpen) {
          event.preventDefault();
          closeActions();
          break;
        }
        if (actions.length > 0) {
          event.preventDefault();
          openActions();
        }
        break;
      case 'Escape':
        if (actionsOpen) {
          event.preventDefault();
          closeActions();
        }
        break;
    }
  };

  const handleActionKeyDown = (event: KeyboardEvent) => {
    if (event.key !== 'Escape') {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    closeActions();
    focusItem();
  };

  const handleBlurCapture = (event: FocusEvent) => {
    const nextTarget = event.relatedTarget;
    if (nextTarget instanceof Node && event.currentTarget instanceof Node && event.currentTarget.contains(nextTarget)) {
      return;
    }

    closeActions();
  };

  const handleDragStart = (event: DragEvent) => {
    if (!isDraggable || !event.dataTransfer) {
      return;
    }

    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', item.id);
    setIsDragging(true);
    onDragStart?.(item.id);
  };

  const handleDragEnd = () => {
    setIsDragging(false);
    // Drag interactions can leave the card focused, which keeps :focus-within
    // styles (notably the drag handle overlay) visible until the user clicks
    // away. Drop focus explicitly so the handle hides immediately on drop.
    itemElementRef.current?.blur();
    onDragEnd?.();
  };

  return (
    <div
      ref={setItemElement}
      class={`item-card item-card--${getTierClassName(item.tierType)} ${item.isUrgent ? 'urgent' : ''} ${item.isSelected ? 'selected' : ''} ${actionsOpen ? 'actions-open' : ''} ${isDragging ? 'dragging' : ''}`.trim()}
      role="option"
      tabIndex={tabIndex}
      draggable={isDraggable}
      aria-label={buildItemAriaLabel(item)}
      aria-selected={item.isSelected ?? false}
      aria-current={item.isSelected ? 'true' : undefined}
      onClick={onClick}
      onKeyDown={handleKeyDown}
      onFocus={onFocus}
      onBlurCapture={handleBlurCapture}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
    >
      <div class="item-card-main">
        <div class="item-line-1">
          <div class="item-title-wrap">
            {item.isUnseen ? <span class="unseen-dot" aria-hidden="true">●</span> : null}
            <span class="item-title"><HighlightedText text={item.title} query={query} /></span>
          </div>
        </div>
        {item.repoAnnotation ? (
          <div class="item-repo-annotation"><HighlightedText text={item.repoAnnotation} query={query} /></div>
        ) : null}
        {item.badges.length > 0 ? (
          <div class="badge-row">
            {item.badges.map(badge => (
              <BadgePill key={`${badge.type}-${badge.variant}-${badge.label}`} badge={badge} />
            ))}
          </div>
        ) : null}
      </div>
      {isDraggable ? <span class="drag-handle" aria-hidden="true">⠿</span> : null}
      {actions.length > 0 ? (
        <div class="item-actions" role="group" aria-label={`${item.title} actions`}>
          {actions.map(action => (
            <button
              key={action.id}
              type="button"
              class="item-action-btn"
              title={action.title}
              aria-label={action.title}
              tabIndex={actionsOpen ? 0 : -1}
              ref={(element) => {
                actionButtonRefs.current[action.id] = element;
              }}
              onFocus={() => setActionsOpen(true)}
              onKeyDown={handleActionKeyDown}
              onClick={(event) => {
                event.stopPropagation();
                closeActions();
                action.onClick();
              }}
            >
              {action.icon}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function buildItemAriaLabel(item: ItemCardData): string {
  // aria-label fully overrides child text for screen readers, so build the
  // announcement from every visible piece of context: the title, repo
  // annotation, all badge labels (provider / type / CI / state /
  // provider-supplied), unread / urgent indicators, and any selection
  // state. Order matters — read top-to-bottom so the title is announced
  // first and qualifiers follow.
  const parts: (string | undefined)[] = [];
  if (item.isUnseen) parts.push('unread');
  if (item.isUrgent) parts.push('urgent');
  parts.push(item.title);
  if (item.repoAnnotation) parts.push(item.repoAnnotation);
  for (const badge of item.badges) {
    parts.push(badge.label);
  }
  if (item.isSelected) parts.push('selected');
  return parts.filter((value): value is string => Boolean(value)).join(', ');
}

function getItemActions(
  item: ItemCardData,
  onAccept?: (providerId: string, externalId: string) => void,
  onAcceptToFocus?: (providerId: string, externalId: string) => void,
  onDismiss?: (providerId: string, externalId: string) => void,
  onTransition?: (itemId: string, targetState: string) => void,
): ItemAction[] {
  const actions: ItemAction[] = [];

  switch (item.tierType) {
    case 'incoming': {
      const { providerId, externalId } = item;
      if (providerId && externalId && onAccept) {
        actions.push({
          id: 'accept',
          icon: '✓',
          title: 'Accept (move to Ready to Start)',
          onClick: () => onAccept(providerId, externalId),
        });
      }
      if (providerId && externalId && onAcceptToFocus) {
        actions.push({
          id: 'accept-to-focus',
          icon: '▶',
          title: 'Start (accept and move to In Progress)',
          onClick: () => onAcceptToFocus(providerId, externalId),
        });
      }
      if (providerId && externalId && onDismiss) {
        actions.push({
          id: 'dismiss',
          icon: '✗',
          title: 'Dismiss',
          onClick: () => onDismiss(providerId, externalId),
        });
      }
      break;
    }
    case 'inProgress':
      if (onTransition) {
        actions.push(
          { id: 'complete', icon: '✓', title: 'Complete', onClick: () => onTransition(item.id, 'Done') },
          { id: 'pause', icon: '⏸', title: 'Pause', onClick: () => onTransition(item.id, 'Paused') },
        );
      }
      break;
    case 'readyToStart':
      if (onTransition) {
        actions.push({ id: 'start', icon: '▶', title: 'Start', onClick: () => onTransition(item.id, 'InProgress') });
      }
      break;
    case 'paused':
      if (onTransition) {
        actions.push({ id: 'resume', icon: '▶', title: 'Resume', onClick: () => onTransition(item.id, 'InProgress') });
      }
      break;
    case 'done':
      if (onTransition) {
        actions.push({ id: 'requeue', icon: '↩', title: 'Requeue', onClick: () => onTransition(item.id, 'New') });
      }
      break;
  }

  return actions;
}

function getTierClassName(tierType: ItemCardData['tierType']): string {
  switch (tierType) {
    case 'inProgress':
      return 'in-progress';
    case 'readyToStart':
      return 'ready-to-start';
    default:
      return tierType;
  }
}
