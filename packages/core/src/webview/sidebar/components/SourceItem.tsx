import type { SourceItemData } from '../../shared/types';
import { BadgePill } from './BadgePill';
import { HighlightedText } from './HighlightedText';

interface SourceItemProps {
  item: SourceItemData;
  onOpen: () => void;
  query?: string;
}

export function SourceItem({ item, onOpen, query }: SourceItemProps) {
  // Click always opens the item: the editor for accepted items, the
  // read-only preview panel for unaccepted/dismissed items. Accept and
  // dismiss decisions happen inside the panel rather than on this row.
  const statusLabel = item.isAccepted ? '✓' : item.isDismissed ? 'dismissed' : undefined;
  const statusClass = item.isAccepted ? 'accepted-mark' : item.isDismissed ? 'dismissed-label' : undefined;

  return (
    <button
      type="button"
      class={`source-item ${item.isAccepted ? 'accepted' : ''} ${item.isDismissed ? 'dismissed' : ''}`.trim()}
      onClick={onOpen}
      aria-label={buildSourceItemAriaLabel(item)}
    >
      <div class="source-item-line">
        <div class="source-item-title-wrap">
          <span class="source-item-title"><HighlightedText text={item.title} query={query} /></span>
          {item.hasRelatedItems ? <span class="related-indicator" aria-hidden="true">🔗</span> : null}
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

function buildSourceItemAriaLabel(item: SourceItemData): string {
  const status = item.isAccepted ? 'accepted' : item.isDismissed ? 'dismissed' : 'available';
  const badgeLabels = item.badges.map(badge => badge.label);
  const related = item.hasRelatedItems ? 'has related items' : undefined;

  return [item.title, status, related, ...badgeLabels].filter((value): value is string => Boolean(value)).join(', ');
}
