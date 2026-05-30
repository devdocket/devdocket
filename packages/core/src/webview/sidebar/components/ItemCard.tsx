import { useRef, useState } from 'preact/hooks';
import { postMessage } from '../../shared/messaging';
import { formatProviderAnnotation } from '../../shared/providerAnnotation';
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
  onClick: (modifiers: ClickModifiers) => void;
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
  /**
   * True when this card is part of an active multi-selection. Distinct from
   * `item.isSelected`, which marks the item currently shown in the editor /
   * preview panel. Multi-selection drives bulk-action eligibility; the editor
   * selection drives `aria-current`.
   */
  isInMultiSelection?: boolean;
  /**
   * True when this card lives in a listbox that supports multi-selection
   * (i.e. one of the My Work tiers). Used to drive `aria-selected` semantics:
   * in a multi-select listbox `aria-selected` reflects the listbox's
   * selection state (multi-selection), not the editor/preview selection
   * (which is exposed via `aria-current`). In a single-select listbox we
   * keep the legacy behavior of mirroring `item.isSelected` so non-bulk
   * tiers still announce a selected option.
   */
  isMultiSelectListbox?: boolean;
}

export interface ClickModifiers {
  /** Shift key — range-extend from the anchor item. */
  shift: boolean;
  /** Ctrl (Windows/Linux) or Cmd (macOS) — toggle this item in the selection. */
  toggle: boolean;
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
  isInMultiSelection = false,
  isMultiSelectListbox = false,
}: ItemCardProps) {
  const actions = getItemActions(item, onAccept, onAcceptToFocus, onDismiss, onTransition);
  const isDraggable = !disableDragReorder && (item.tierType === 'readyToStart' || item.tierType === 'inProgress');
  const [actionsOpen, setActionsOpen] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const annotation = formatProviderAnnotation({ source: item.repoAnnotation, author: item.author, authored: item.authored });
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
      case 'Tab': {
        if (actionsOpen) break;
        // Let the browser handle natural Tab navigation between the card
        // and any focusable descendants (e.g. the clickable CI badge)
        // before treating Tab as a request to jump to the next tier.
        // Without this, the card's keydown handler hijacks Tab on the
        // first press and focus never reaches the badge — making the
        // badge's advertised Enter/Space activation unreachable.
        const card = event.currentTarget as HTMLElement;
        const focusables = Array.from(
          card.querySelectorAll<HTMLElement>('[tabindex="0"]'),
        );
        const target = event.target as HTMLElement;
        const idx = focusables.indexOf(target);
        const goingForward = !event.shiftKey;
        const atEdge = idx === -1
          ? focusables.length === 0
          : goingForward
            ? idx === focusables.length - 1
            : idx === 0;
        if (!atEdge) break;
        if (onMoveTierFocus?.(goingForward ? 1 : -1)) {
          event.preventDefault();
        }
        break;
      }
      case 'Enter':
        event.preventDefault();
        // Keyboard activation should always open the item, regardless of
        // held modifiers. Forwarding Shift/Ctrl/Cmd here would turn a
        // keyboard "open" gesture into a selection-modifier gesture (e.g.
        // Shift+Enter would range-extend instead of opening).
        onClick({ shift: false, toggle: false });
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
      class={`item-card item-card--${getTierClassName(item.tierType)} ${item.isUrgent ? 'urgent' : ''} ${item.isSelected ? 'selected' : ''} ${isInMultiSelection ? 'multi-selected' : ''} ${actionsOpen ? 'actions-open' : ''} ${isDragging ? 'dragging' : ''}`.trim()}
      role="option"
      tabIndex={tabIndex}
      draggable={isDraggable}
      aria-label={buildItemAriaLabel(item, isInMultiSelection, isMultiSelectListbox)}
      aria-selected={isMultiSelectListbox ? isInMultiSelection : (item.isSelected ?? false)}
      aria-current={item.isSelected ? 'true' : undefined}
      onClick={(event) => onClick({ shift: event.shiftKey, toggle: event.ctrlKey || event.metaKey })}
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
            {item.hasRelatedItems ? <span class="related-indicator" aria-hidden="true">🔗</span> : null}
          </div>
        </div>
        {annotation ? (
          <div class="item-repo-annotation"><HighlightedText text={annotation} query={query} /></div>
        ) : null}
        {item.badges.length > 0 ? (
          <div class="badge-row">
            {item.badges.map(badge => (
              <BadgePill
                key={`${badge.type}-${badge.variant}-${badge.label}`}
                badge={badge}
                onClick={badge.type === 'ci' ? () => {
                  postMessage({ type: 'openWatches' });
                } : undefined}
                tabIndex={badge.type === 'ci' ? (tabIndex === 0 ? 0 : -1) : undefined}
                ariaLabel={badge.type === 'ci' ? `${badge.label} — open CI Watches` : undefined}
              />
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

function buildItemAriaLabel(item: ItemCardData, isInMultiSelection: boolean, isMultiSelectListbox: boolean): string {
  // aria-label fully overrides child text for screen readers, so build the
  // announcement from every visible piece of context: the title, repo
  // annotation, all badge labels (provider / type / CI / state /
  // provider-supplied), unread / urgent indicators, and any selection
  // state. Order matters — read top-to-bottom so the title is announced
  // first and qualifiers follow.
  //
  // "Selected" must align with `aria-selected` so screen readers don't get
  // contradictory cues. In a multi-select listbox `aria-selected` reflects
  // multi-selection (not editor focus), so the label should too — otherwise
  // the currently-open editor item could be announced as "selected" while
  // its `aria-selected` is false. The editor/preview cursor is communicated
  // via `aria-current` instead, which is the correct semantic for "this is
  // the focused one but not part of the selection".
  const parts: (string | undefined)[] = [];
  if (item.isUnseen) parts.push('unread');
  if (item.isUrgent) parts.push('urgent');
  parts.push(item.title);
  const annotation = formatProviderAnnotation({ source: item.repoAnnotation, author: item.author, authored: item.authored });
  if (annotation) parts.push(annotation);
  for (const badge of item.badges) {
    parts.push(badge.label);
  }
  if (item.hasRelatedItems) parts.push('has related items');
  if (isMultiSelectListbox) {
    if (isInMultiSelection) parts.push('selected');
  } else if (item.isSelected) {
    parts.push('selected');
  }
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
        actions.push(
          { id: 'start', icon: '▶', title: 'Start', onClick: () => onTransition(item.id, 'InProgress') },
          { id: 'pause', icon: '⏸', title: 'Pause', onClick: () => onTransition(item.id, 'Paused') },
        );
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
