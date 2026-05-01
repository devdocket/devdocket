import { BadgePill } from '../../shared/components/BadgePill';
import type { EditorItemData } from '../../shared/types';
import { stateLabel, stateTone } from '../editorUtils';

interface RelatedItemsProps {
  items: EditorItemData['relatedItems'];
  onOpenItem: (itemId: string) => void;
}

export function RelatedItems({ items, onOpenItem }: RelatedItemsProps) {
  if (items.length === 0) {
    return null;
  }

  return (
    <section class="editor-section" aria-labelledby="editor-related-heading">
      <div class="editor-section-heading" id="editor-related-heading">Related items</div>
      <div class="related-items">
        {items.map(item => (
          <button
            key={item.id}
            type="button"
            class="related-item"
            onClick={() => onOpenItem(item.id)}
          >
            <div class="related-item-header">
              <span class="related-item-title">{item.title}</span>
              <span class={`editor-status editor-status--${stateTone(item.state)}`}>{stateLabel(item.state)}</span>
            </div>
            {item.badges.length > 0 ? (
              <div class="badge-row badge-row--compact">
                {item.badges.map(badge => (
                  <BadgePill key={`${item.id}-${badge.type}-${badge.variant}-${badge.label}`} badge={badge} />
                ))}
              </div>
            ) : null}
          </button>
        ))}
      </div>
    </section>
  );
}
