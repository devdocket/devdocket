import { useRef, useState } from 'preact/hooks';
import type { ItemCardData } from '../../shared/types';
import { BadgePill } from './BadgePill';

interface ItemCardProps {
  item: ItemCardData;
  tabIndex: number;
  itemRef?: (element: HTMLDivElement | null) => void;
  onFocus?: () => void;
  onMoveFocus?: (direction: -1 | 1) => void;
  onMoveTierFocus?: (direction: -1 | 1) => boolean;
  onClick: () => void;
  onAccept?: (providerId: string, externalId: string) => void;
  onDismiss?: (providerId: string, externalId: string) => void;
  onTransition?: (itemId: string, targetState: string) => void;
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
  onDismiss,
  onTransition,
}: ItemCardProps) {
  const metaParts = [item.branchName, item.repoName].filter((value): value is string => Boolean(value));
  const actions = getItemActions(item, onAccept, onDismiss, onTransition);
  const [actionsOpen, setActionsOpen] = useState(false);
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

  return (
    <div
      ref={setItemElement}
      class={`item-card item-card--${getTierClassName(item.tierType)} ${item.isUrgent ? 'urgent' : ''} ${item.isSelected ? 'selected' : ''} ${actionsOpen ? 'actions-open' : ''}`.trim()}
      role="option"
      tabIndex={tabIndex}
      aria-label={buildItemAriaLabel(item)}
      aria-selected={item.isSelected ?? false}
      aria-current={item.isSelected ? 'true' : undefined}
      onClick={onClick}
      onKeyDown={handleKeyDown}
      onFocus={onFocus}
      onBlurCapture={handleBlurCapture}
    >
      <div class="item-card-main">
        <div class="item-line-1">
          <div class="item-title-wrap">
            {item.isUnseen ? <span class="unseen-dot" aria-hidden="true">●</span> : null}
            <span class="item-title">{item.title}</span>
          </div>
          {item.relativeTime ? <span class="item-time">{item.relativeTime}</span> : null}
        </div>
        {item.badges.length > 0 ? (
          <div class="badge-row">
            {item.badges.map(badge => (
              <BadgePill key={`${badge.type}-${badge.variant}-${badge.label}`} badge={badge} />
            ))}
          </div>
        ) : null}
        {metaParts.length > 0 ? <div class="item-meta">{metaParts.join(' · ')}</div> : null}
      </div>
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
  const providerLabel = item.badges.find(badge => badge.type === 'provider')?.label;
  const stateLabels = item.badges
    .filter(badge => badge.type === 'state')
    .map(badge => badge.label);

  return [item.title, providerLabel, ...stateLabels, item.relativeTime || undefined]
    .filter((value): value is string => Boolean(value))
    .join(', ');
}

function getItemActions(
  item: ItemCardData,
  onAccept?: (providerId: string, externalId: string) => void,
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
          title: 'Accept',
          onClick: () => onAccept(providerId, externalId),
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
