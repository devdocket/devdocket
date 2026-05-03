export function stateLabel(state: string): string {
  return state === 'InProgress'
    ? 'In Progress'
    : state.replace(/([a-z])([A-Z])/g, '$1 $2');
}

export function stateTone(state: string): string {
  switch (state) {
    case 'InProgress':
      return 'in-progress';
    case 'Paused':
      return 'paused';
    case 'Done':
      return 'done';
    case 'Archived':
      return 'archived';
    default:
      return 'new';
  }
}

export function activityTypeLabel(type: string): string {
  switch (type) {
    case 'created':
      return 'Created';
    case 'state-changed':
      return 'State changed';
    case 'updated':
      return 'Updated';
    case 'action-executed':
      return 'Action executed';
    case 'auto-completed':
      return 'Auto completed';
    case 'work-started':
      return 'Work started';
    case 'cleanup':
      return 'Cleanup';
    case 'cleanup-dismissed':
      return 'Cleanup dismissed';
    case 'version-updated':
      return 'Version updated';
    default:
      return type;
  }
}

export function transitionLabel(currentState: string, targetState: string): string {
  switch (targetState) {
    case 'InProgress':
      return currentState === 'Paused' ? 'Resume' : 'Start';
    case 'Paused':
      return 'Pause';
    case 'Done':
      return 'Complete';
    case 'Archived':
      return 'Archive';
    case 'New':
      return 'Requeue';
    default:
      return stateLabel(targetState);
  }
}
