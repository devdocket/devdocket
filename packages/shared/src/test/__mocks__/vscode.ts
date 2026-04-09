import { vi } from 'vitest';

class MockEventEmitter {
  private listeners: Function[] = [];
  event = (listener: Function) => {
    this.listeners.push(listener);
    return { dispose: () => { this.listeners = this.listeners.filter(l => l !== listener); } };
  };
  fire(data?: any) {
    for (const listener of this.listeners) {
      listener(data);
    }
  }
  dispose() {
    this.listeners = [];
  }
}

class MockDisposable {
  private callback: () => void;
  constructor(callback: () => void) { this.callback = callback; }
  dispose() { this.callback(); }
}

const window = {
  showInformationMessage: vi.fn(),
  showWarningMessage: vi.fn(),
  showErrorMessage: vi.fn(),
  createOutputChannel: vi.fn(() => ({
    appendLine: vi.fn(),
    append: vi.fn(),
    clear: vi.fn(),
    show: vi.fn(),
    hide: vi.fn(),
    dispose: vi.fn(),
    name: 'WorkCenter Shared',
    replace: vi.fn(),
  })),
};

export {
  MockEventEmitter as EventEmitter,
  MockDisposable as Disposable,
  window,
};
