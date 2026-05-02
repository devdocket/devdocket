import type { EditorItemData } from '../../shared/types';
import { transitionLabel } from '../editorUtils';

interface ActionBarProps {
  item: EditorItemData;
  onTransition: (targetState: string) => void;
  onRunAction: () => void;
  onAccept: () => void;
  onDismiss: () => void;
}

interface ButtonSpec {
  key: string;
  label: string;
  style: 'primary' | 'secondary' | 'ghost' | 'danger';
  onClick: () => void;
}

export function ActionBar({ item, onTransition, onRunAction, onAccept, onDismiss }: ActionBarProps) {
  const buttons: ButtonSpec[] = [];

  if (item.isIncoming && item.providerId && item.externalId) {
    buttons.push({ key: 'accept', label: 'Accept', style: 'primary', onClick: onAccept });
    buttons.push({ key: 'dismiss', label: 'Dismiss', style: 'danger', onClick: onDismiss });
  } else {
    for (const targetState of preferredTransitions(item.state, item.validTransitions)) {
      buttons.push({
        key: targetState,
        label: transitionLabel(item.state, targetState),
        style: targetState === 'Done' || targetState === 'InProgress' ? 'primary' : 'secondary',
        onClick: () => onTransition(targetState),
      });
    }

    if (item.hasActions) {
      buttons.push({ key: 'run-action', label: 'Run Action…', style: 'secondary', onClick: onRunAction });
    }
  }

  if (buttons.length === 0) {
    return null;
  }

  return (
    <section class="editor-section editor-section--actions" aria-label="Available actions">
      <div class="action-bar">
        {buttons.map(button => (
          <button
            key={button.key}
            type="button"
            class={`editor-button editor-button--${button.style}`}
            onClick={button.onClick}
          >
            {button.label}
          </button>
        ))}
      </div>
    </section>
  );
}

function preferredTransitions(currentState: string, validTransitions: string[]): string[] {
  const preferredByState: Record<string, string[]> = {
    New: ['InProgress', 'Archived'],
    InProgress: ['Done', 'Paused'],
    Paused: ['InProgress', 'Done'],
    Done: ['New'],
    Archived: ['New'],
  };

  const preferred = preferredByState[currentState] ?? validTransitions;
  return preferred.filter(targetState => validTransitions.includes(targetState));
}
