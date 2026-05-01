import type { ItemCardData } from '../../shared/types';
import { BadgePill } from './BadgePill';

interface ItemCardProps {
  item: ItemCardData;
  onClick: () => void;
}

export function ItemCard({ item, onClick }: ItemCardProps) {
  const metaParts = [item.branchName, item.repoName].filter((value): value is string => Boolean(value));

  return (
    <button
      type="button"
      class={`item-card item-card--${getTierClassName(item.tierType)} ${item.isUrgent ? 'urgent' : ''} ${item.isSelected ? 'selected' : ''}`.trim()}
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
  );
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
