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
  // restore focus to it after the bar unmounts. Restoration is gated on
  // TWO conditions to avoid stealing focus from wherever the user actually
  // navigated to:
  //
  //   1. Focus must have entered the bar at some point while mounted
  //      (`barReceivedFocus`), so the bar isn't restoring focus for
  //      unmounts that the user wasn't interacting with.
  //   2. At cleanup time, focus must EITHER still be inside the bar
  //      (the bar's own button activation removed it / the cleanup runs
  //      before browser focus fallback) OR have been dropped to
  //      `document.body` (browser fallback after the focused element was
  //      removed). If focus has moved elsewhere (e.g. the user pressed
  //      the Sources tab while the bar was mounted), do nothing.
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
      if (!barReceivedFocus.current) {
        return;
      }
      const target = previouslyFocused.current;
      if (!target || !target.isConnected) {
        return;
      }
      const currentFocus = document.activeElement;
      const focusStillInsideBar = !!bar && currentFocus instanceof Node && bar.contains(currentFocus);
      const focusLost = currentFocus === null || currentFocus === document.body;
      if (focusStillInsideBar || focusLost) {
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
