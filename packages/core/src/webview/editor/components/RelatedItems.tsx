import type { EditorItemData } from '../../shared/types';

interface RelatedItemsProps {
  items: EditorItemData['relatedItems'];
  onOpenItem: (itemId: string) => void;
}

export function RelatedItems({ items, onOpenItem }: RelatedItemsProps) {
  if (items.length === 0) {
    return null;
  }

  const closes = items.filter(item => item.relation === 'closes');
  const linked = items.filter(item => item.relation === 'linked');
  const showGroupHeadings = closes.length > 0 && linked.length > 0;

  return (
    <section class="editor-section" aria-labelledby="editor-related-heading">
      <div class="editor-section-heading" id="editor-related-heading">Related</div>
      <div class="related-items">
        {renderGroup('Closes', closes, showGroupHeadings, onOpenItem)}
        {renderGroup('Linked', linked, showGroupHeadings, onOpenItem)}
      </div>
    </section>
  );
}

function renderGroup(
  label: string,
  items: EditorItemData['relatedItems'],
  showHeading: boolean,
  onOpenItem: (itemId: string) => void,
) {
  if (items.length === 0) {
    return null;
  }

  return (
    <div class="related-item-group">
      {showHeading ? <div class="related-item-group-heading">{label}</div> : null}
      {items.map(item => (
        <button
          key={`${item.targetKind}-${item.targetItemId}`}
          type="button"
          class="related-item"
          onClick={() => onOpenItem(item.targetItemId)}
        >
          <span class="related-item-title">{item.label}</span>
        </button>
      ))}
    </div>
  );
}
