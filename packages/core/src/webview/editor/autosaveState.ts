export type AutosaveStatus = 'idle' | 'pending' | 'saving' | 'saved' | 'error';

export interface AutosaveState {
  status: AutosaveStatus;
  requestId?: string;
  savedAt?: number;
  message?: string;
}

export type AutosaveAction =
  | { type: 'edit' }
  | { type: 'send'; requestId: string }
  | { type: 'ack'; requestId: string; savedAt: number }
  | { type: 'error'; requestId: string; message: string };

export const initialAutosaveState: AutosaveState = { status: 'idle' };

export function reduceAutosaveState(state: AutosaveState, action: AutosaveAction): AutosaveState {
  switch (action.type) {
    case 'edit':
      return { status: 'pending' };
    case 'send':
      return { status: 'saving', requestId: action.requestId };
    case 'ack':
      if (state.status !== 'saving' || state.requestId !== action.requestId) {
        return state;
      }
      return { status: 'saved', requestId: action.requestId, savedAt: action.savedAt };
    case 'error':
      if (state.status !== 'saving' || state.requestId !== action.requestId) {
        return state;
      }
      return { status: 'error', requestId: action.requestId, message: action.message };
    default:
      return state;
  }
}
