import type { BulkAction } from '../bulkActions';

interface BulkActionBarProps {
  count: number;
  actions: readonly BulkAction[];
  onAction: (action: BulkAction) => void;
  onClear: () => void;
}

export function BulkActionBar({ count, actions, onAction, onClear }: BulkActionBarProps) {
  return (
    <div
      class="bulk-action-bar"
      role="toolbar"
      aria-label="Bulk actions"
    >
      <span class="bulk-action-count" aria-live="polite" aria-atomic="true">{count} selected</span>
      <div class="bulk-action-buttons">
        {actions.map(action => (
          <button
            key={action.id}
            type="button"
            class="bulk-action-btn"
            title={`${action.label} ${count} item${count === 1 ? '' : 's'}`}
            aria-label={`${action.label} ${count} selected item${count === 1 ? '' : 's'}`}
            onClick={() => onAction(action)}
          >
            <span aria-hidden="true">{action.icon}</span>
            <span>{action.label}</span>
          </button>
        ))}
        <button
          type="button"
          class="bulk-action-btn bulk-action-clear"
          title="Clear selection (Escape)"
          aria-label="Clear selection"
          onClick={onClear}
        >
          ✕
        </button>
      </div>
    </div>
  );
}
