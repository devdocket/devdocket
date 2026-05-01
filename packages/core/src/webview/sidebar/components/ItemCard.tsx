import type { ItemCardData } from '../../shared/types';
import { BadgePill } from './BadgePill';

interface ItemCardProps {
  item: ItemCardData;
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

export function ItemCard({ item, onClick, onAccept, onDismiss, onTransition }: ItemCardProps) {
  const metaParts = [item.branchName, item.repoName].filter((value): value is string => Boolean(value));
  const actions = getItemActions(item, onAccept, onDismiss, onTransition);

  return (
    <div class={`item-card item-card--${getTierClassName(item.tierType)} ${item.isUrgent ? 'urgent' : ''} ${item.isSelected ? 'selected' : ''}`.trim()}>
      <button
        type="button"
        class="item-card-main"
        onClick={onClick}
        aria-current={item.isSelected ? 'true' : undefined}
      >
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
      </button>
      {actions.length > 0 ? (
        <div class="item-actions">
          {actions.map(action => (
            <button
              key={action.id}
              type="button"
              class="item-action-btn"
              title={action.title}
              aria-label={action.title}
              onClick={(event) => {
                event.stopPropagation();
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
