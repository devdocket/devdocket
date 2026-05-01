import type { SourceItemData } from '../../shared/types';
import { BadgePill } from './BadgePill';

interface SourceItemProps {
  item: SourceItemData;
  onAccept: () => void;
}

export function SourceItem({ item, onAccept }: SourceItemProps) {
  const statusLabel = item.isAccepted ? '✓' : item.isDismissed ? 'dismissed' : undefined;
  const statusClass = item.isAccepted ? 'accepted-mark' : item.isDismissed ? 'dismissed-label' : undefined;

  return (
    <button
      type="button"
      class={`source-item ${item.isAccepted ? 'accepted' : ''} ${item.isDismissed ? 'dismissed' : ''}`.trim()}
      onClick={item.isAccepted ? undefined : onAccept}
      disabled={item.isAccepted}
      aria-label={item.isAccepted ? `${item.title} accepted` : `Accept ${item.title}`}
    >
      <div class="source-item-line">
        <div class="source-item-title-wrap">
          <span class="source-item-title">{item.title}</span>
        </div>
        {statusLabel ? <span class={`source-item-status ${statusClass}`.trim()}>{statusLabel}</span> : null}
      </div>
      {item.badges.length > 0 ? (
        <div class="badge-row">
          {item.badges.map(badge => (
            <BadgePill key={`${badge.type}-${badge.variant}-${badge.label}`} badge={badge} />
          ))}
        </div>
      ) : null}
    </button>
  );
}
