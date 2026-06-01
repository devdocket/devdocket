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
  // restore focus to it after the bar unmounts — but ONLY when focus had
  // actually entered the bar (e.g. user activated a bar button). If the bar
  // unmounts because the user navigated elsewhere (e.g. clicked the Sources
  // tab) and focus never reached the bar, stealing focus back to a hidden
  // My Work option would be unexpected.
  const barRef = useRef<HTMLDivElement>(null);
  const previouslyFocused = useRef<HTMLElement | null>(null);
  const barReceivedFocus = useRef(false);
  useEffect(() => {
    const candidate = document.activeElement;
    if (candidate instanceof HTMLElement && !candidate.closest('.bulk-action-bar')) {
      previouslyFocused.current = candidate;
    }
    const onFocusIn = () => {
      barReceivedFocus.current = true;
    };
    const bar = barRef.current;
    bar?.addEventListener('focusin', onFocusIn);
    return () => {
      bar?.removeEventListener('focusin', onFocusIn);
      const target = previouslyFocused.current;
      if (barReceivedFocus.current && target && target.isConnected) {
        target.focus();
      }
    };
  }, []);

  return (
    <div
      ref={barRef}
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
