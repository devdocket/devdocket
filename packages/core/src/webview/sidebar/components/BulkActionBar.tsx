import { useEffect, useRef } from 'preact/hooks';
import type { BulkAction } from '../bulkActions';

interface BulkActionBarProps {
  count: number;
  actions: readonly BulkAction[];
  onAction: (action: BulkAction) => void;
  onClear: () => void;
}

export function BulkActionBar({ count, actions, onAction, onClear }: BulkActionBarProps) {
  // Capture the element that had focus before the bar mounted so we can
  // restore focus to it after the bar unmounts. Without this, keyboard
  // users who activate a bulk action (focus on a bar button) get dropped
  // to document.body when the bar disappears, breaking the
  // "return to where I was" expectation for screen-reader users.
  const previouslyFocused = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const candidate = document.activeElement;
    if (candidate instanceof HTMLElement && !candidate.closest('.bulk-action-bar')) {
      previouslyFocused.current = candidate;
    }
    return () => {
      const target = previouslyFocused.current;
      if (target && target.isConnected) {
        target.focus();
      }
    };
  }, []);

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
