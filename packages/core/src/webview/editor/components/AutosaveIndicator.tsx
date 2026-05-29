import { useEffect, useState } from 'preact/hooks';
import type { AutosaveStatus } from '../autosaveState';

interface AutosaveIndicatorProps {
  status: AutosaveStatus;
  savedAt?: number;
}

const SAVED_VISIBLE_MS = 2000;

/**
 * Compact item-level autosave indicator. The visual affordance is a small
 * colored dot next to the item's state pill — amber while there are unsaved
 * or in-flight changes, green briefly after a successful save (then fades
 * to nothing), and red while a save error is unresolved.
 *
 * The wrapping `role="status"` element is always mounted so screen readers
 * see a stable live region; only its text content (visually hidden) changes
 * on each transition, which is what NVDA / VoiceOver / JAWS actually
 * announce. The dot itself is `aria-hidden` and decorative.
 *
 * The error path keeps its dedicated banner with a Retry button rendered by
 * EditorApp; this indicator is intentionally low-signal on its own.
 */
export function AutosaveIndicator({ status, savedAt }: AutosaveIndicatorProps) {
  const [savedExpired, setSavedExpired] = useState(false);

  useEffect(() => {
    if (status !== 'saved') {
      setSavedExpired(false);
      return;
    }

    setSavedExpired(false);
    const timer = window.setTimeout(() => setSavedExpired(true), SAVED_VISIBLE_MS);
    return () => window.clearTimeout(timer);
  }, [status, savedAt]);

  const dotVisible = status !== 'idle' && !(status === 'saved' && savedExpired);
  const tone = dotVisible ? toneFor(status) : undefined;
  const label = dotVisible ? labelFor(status) : '';

  return (
    <span class="editor-autosave-live" role="status" aria-live="polite">
      <span class="editor-visually-hidden">{label}</span>
      {dotVisible ? (
        <span
          class={`editor-autosave-dot editor-autosave-dot--${tone}`}
          title={label}
          aria-hidden="true"
        />
      ) : null}
    </span>
  );
}

function toneFor(status: Exclude<AutosaveStatus, 'idle'>): string {
  switch (status) {
    case 'pending':
      return 'pending';
    case 'saving':
      return 'saving';
    case 'saved':
      return 'saved';
    case 'error':
      return 'error';
  }
}

function labelFor(status: Exclude<AutosaveStatus, 'idle'>): string {
  switch (status) {
    case 'pending':
      return 'Unsaved changes';
    case 'saving':
      return 'Saving…';
    case 'saved':
      return 'Saved';
    case 'error':
      return 'Save failed';
  }
}
