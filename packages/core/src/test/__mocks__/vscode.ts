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
  constructor(public id: string, public color?: any) {}
}

class MockMarkdownString {
  value = '';
  supportThemeIcons = false;
  appendMarkdown(text: string) { this.value += text; }
  appendText(text: string) { this.value += text; }
}

const TreeItemCollapsibleState = {
  None: 0,
  Collapsed: 1,
  Expanded: 2,
};

const ViewColumn = {
  One: 1,
  Two: 2,
  Three: 3,
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

const ProgressLocation = {
  SourceControl: 1,
  Window: 10,
  Notification: 15,
};

const InputBoxValidationSeverity = {
  Info: 1,
  Warning: 2,
  Error: 3,
};

const window = {
  showInputBox: vi.fn(),
  showInformationMessage: vi.fn().mockResolvedValue(undefined),
  showWarningMessage: vi.fn(),
  showErrorMessage: vi.fn(),
  showQuickPick: vi.fn(),
  setStatusBarMessage: vi.fn(() => ({ dispose: vi.fn() })),
  withProgress: vi.fn((_options: any, task: (progress: any, token: any) => Promise<any>) => {
    const cancellationEmitter = new MockEventEmitter();
    return task(
      { report: vi.fn() },
      {
        isCancellationRequested: false,
        onCancellationRequested: cancellationEmitter.event,
      },
    );
  }),
  registerTreeDataProvider: vi.fn(() => ({ dispose: vi.fn() })),
  createTreeView: vi.fn(() => {
    const selectionEmitter = new MockEventEmitter();
    return {
      dispose: vi.fn(),
      message: undefined,
      badge: undefined,
      onDidChangeSelection: selectionEmitter.event,
      reveal: vi.fn().mockResolvedValue(undefined),
      _selectionEmitter: selectionEmitter,
    };
  }),
  createWebviewPanel: vi.fn(),
  registerWebviewPanelSerializer: vi.fn(() => ({ dispose: vi.fn() })),
  registerWebviewViewProvider: vi.fn(() => ({ dispose: vi.fn() })),
  createOutputChannel: vi.fn(() => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    trace: vi.fn(),
    appendLine: vi.fn(),
    append: vi.fn(),
    clear: vi.fn(),
    show: vi.fn(),
    hide: vi.fn(),
    dispose: vi.fn(),
    name: 'DevDocket',
    replace: vi.fn(),
    logLevel: 2,
    onDidChangeLogLevel: vi.fn(),
  })),
  createStatusBarItem: vi.fn((alignment?: number, priority?: number) => new MockStatusBarItem()),
};

const commands = {
  registerCommand: vi.fn(() => ({ dispose: vi.fn() })),
  executeCommand: vi.fn().mockResolvedValue(undefined),
};

const env = {
  openExternal: vi.fn(),
  clipboard: {
    writeText: vi.fn().mockResolvedValue(undefined),
  },
};

const Uri = {
  parse: vi.fn((s: string) => {
    const m = s.match(/^(\w+):/);
    return { toString: () => s, scheme: m ? m[1] : '', path: s, fsPath: s };
  }),
  file: vi.fn((s: string) => ({ toString: () => s, scheme: 'file', path: s, fsPath: s })),
  joinPath: vi.fn((base: { path?: string; fsPath?: string; toString?: () => string }, ...paths: string[]) => {
    const root = base.fsPath ?? base.path ?? base.toString?.() ?? '';
    const joined = [root, ...paths].join('\\').replace(/\\+/g, '\\');
    return { toString: () => joined, scheme: 'file', path: joined, fsPath: joined };
  }),
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

class MockMemento {
  private store = new Map<string, unknown>();
  keys(): readonly string[] { return [...this.store.keys()]; }
  get<T>(key: string): T | undefined;
  get<T>(key: string, defaultValue: T): T;
  get<T>(key: string, defaultValue?: T): T | undefined {
    if (!this.store.has(key)) { return defaultValue; }
    // Deep-clone on read to match real Memento JSON round-trip behavior
    return JSON.parse(JSON.stringify(this.store.get(key))) as T;
  }
  async update(key: string, value: unknown): Promise<void> {
    if (value === undefined) { this.store.delete(key); }
    // Deep-clone on write to match real Memento JSON serialization
    else { this.store.set(key, JSON.parse(JSON.stringify(value))); }
  }
}

const _onDidChangeConfigurationEmitter = new MockEventEmitter();

const workspace = {
  getConfiguration: vi.fn().mockReturnValue({
    get: vi.fn((key: string, defaultValue?: any) => defaultValue),
    update: vi.fn().mockResolvedValue(undefined),
    inspect: vi.fn(() => undefined),
  }),
  onDidChangeConfiguration: vi.fn((listener: Function) => _onDidChangeConfigurationEmitter.event(listener)),
  _onDidChangeConfigurationEmitter,
};

class MockThemeColor {
  constructor(public id: string) {}
}

const ConfigurationTarget = {
  Global: 1,
  Workspace: 2,
  WorkspaceFolder: 3,
};

const StatusBarAlignment = {
  Left: 1,
  Right: 2,
};

class MockStatusBarItem {
  text = '';
  tooltip: string | undefined;
  command: string | { command: string; title: string } | undefined;
  color: any;
  backgroundColor: any;
  show = vi.fn();
  hide = vi.fn();
  dispose = vi.fn();
}

const authentication = {
  getSession: vi.fn().mockResolvedValue(undefined),
};

export {
  MockEventEmitter as EventEmitter,
  MockThemeIcon as ThemeIcon,
  MockThemeColor as ThemeColor,
  MockMarkdownString as MarkdownString,
  MockTreeItem as TreeItem,
  MockDataTransferItem as DataTransferItem,
  MockDataTransfer as DataTransfer,
  MockCancellationTokenSource as CancellationTokenSource,
  MockDisposable as Disposable,
  MockStatusBarItem as StatusBarItem,
  MockMemento,
  MockMemento as Memento,
  TreeItemCollapsibleState,
  ViewColumn,
  ConfigurationTarget,
  StatusBarAlignment,
  ProgressLocation,
  InputBoxValidationSeverity,
  window,
  commands,
  env,
  Uri,
  workspace,
  authentication,
};
