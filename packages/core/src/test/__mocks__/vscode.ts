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

class MockThemeIcon {
  constructor(public id: string) {}
}

class MockMarkdownString {
  value = '';
  appendMarkdown(text: string) { this.value += text; }
  appendText(text: string) { this.value += text; }
}

const TreeItemCollapsibleState = {
  None: 0,
  Collapsed: 1,
  Expanded: 2,
};

class MockTreeItem {
  label: string | { label: string; highlights?: [number, number][] };
  collapsibleState: number;
  id?: string;
  description?: string;
  tooltip?: any;
  contextValue?: string;
  iconPath?: any;
  constructor(label: string | { label: string; highlights?: [number, number][] }, collapsibleState?: number) {
    this.label = label;
    this.collapsibleState = collapsibleState ?? 0;
  }
}

const window = {
  showInputBox: vi.fn(),
  showInformationMessage: vi.fn(),
  showWarningMessage: vi.fn(),
  showErrorMessage: vi.fn(),
  showQuickPick: vi.fn(),
  registerTreeDataProvider: vi.fn(() => ({ dispose: vi.fn() })),
  createTreeView: vi.fn(() => {
    const selectionEmitter = new MockEventEmitter();
    return {
      dispose: vi.fn(),
      message: undefined,
      badge: undefined,
      onDidChangeSelection: selectionEmitter.event,
      _selectionEmitter: selectionEmitter,
    };
  }),
  createWebviewPanel: vi.fn(),
  createOutputChannel: vi.fn(() => ({
    appendLine: vi.fn(),
    append: vi.fn(),
    clear: vi.fn(),
    show: vi.fn(),
    hide: vi.fn(),
    dispose: vi.fn(),
    name: 'WorkCenter',
    replace: vi.fn(),
  })),
};

const commands = {
  registerCommand: vi.fn(() => ({ dispose: vi.fn() })),
};

const env = {
  openExternal: vi.fn(),
};

const Uri = {
  parse: vi.fn((s: string) => ({ toString: () => s })),
};

class MockDataTransferItem {
  constructor(public value: any) {}
}

class MockDataTransfer {
  private readonly items = new Map<string, MockDataTransferItem>();
  get(mimeType: string): MockDataTransferItem | undefined { return this.items.get(mimeType); }
  set(mimeType: string, value: MockDataTransferItem): void { this.items.set(mimeType, value); }
}

class MockCancellationTokenSource {
  private _listeners: Function[] = [];
  token = {
    isCancellationRequested: false,
    onCancellationRequested: (listener: Function) => {
      if (this.token.isCancellationRequested) {
        listener();
      } else {
        this._listeners.push(listener);
      }
      return { dispose: () => { this._listeners = this._listeners.filter(l => l !== listener); } };
    },
  };
  cancel() {
    if (this.token.isCancellationRequested) {
      return;
    }
    this.token.isCancellationRequested = true;
    const listeners = this._listeners.slice();
    this._listeners = [];
    for (const listener of listeners) {
      listener();
    }
  }
  dispose() {
    this._listeners = [];
  }
}

class MockDisposable {
  private callback: () => void;
  constructor(callback: () => void) { this.callback = callback; }
  dispose() { this.callback(); }
}

const workspace = {
  getConfiguration: vi.fn().mockReturnValue({
    get: vi.fn((key: string, defaultValue?: any) => defaultValue),
  }),
  onDidChangeConfiguration: vi.fn(() => ({ dispose: vi.fn() })),
};

export {
  MockEventEmitter as EventEmitter,
  MockThemeIcon as ThemeIcon,
  MockMarkdownString as MarkdownString,
  MockTreeItem as TreeItem,
  MockDataTransferItem as DataTransferItem,
  MockDataTransfer as DataTransfer,
  MockCancellationTokenSource as CancellationTokenSource,
  MockDisposable as Disposable,
  TreeItemCollapsibleState,
  window,
  commands,
  env,
  Uri,
  workspace,
};
