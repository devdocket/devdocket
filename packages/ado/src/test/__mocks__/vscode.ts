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
}

const TreeItemCollapsibleState = {
  None: 0,
  Collapsed: 1,
  Expanded: 2,
};

class MockTreeItem {
  label: string;
  collapsibleState: number;
  description?: string;
  tooltip?: any;
  contextValue?: string;
  iconPath?: any;
  constructor(label: string, collapsibleState?: number) {
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
  createWebviewPanel: vi.fn(),
};

const commands = {
  registerCommand: vi.fn(() => ({ dispose: vi.fn() })),
  executeCommand: vi.fn(),
};

const env = {
  openExternal: vi.fn(),
};

const Uri = {
  parse: vi.fn((s: string) => ({ toString: () => s })),
  file: vi.fn((path: string) => ({ fsPath: path, toString: () => `file://${path}` })),
};

const authentication = {
  getSession: vi.fn().mockResolvedValue({ accessToken: 'mock-token' }),
};

const workspace = {
  getConfiguration: vi.fn().mockReturnValue({
    get: vi.fn((key: string, defaultValue?: any) => defaultValue),
  }),
  workspaceFolders: [{ uri: { fsPath: '/mock/workspace' } }],
};

const extensions = {
  getExtension: vi.fn().mockReturnValue({
    isActive: true,
    exports: {},
    activate: vi.fn(),
  }),
};

class MockDisposable {
  private callback: () => void;
  constructor(callback: () => void) { this.callback = callback; }
  dispose() { this.callback(); }
}

export {
  MockEventEmitter as EventEmitter,
  MockThemeIcon as ThemeIcon,
  MockMarkdownString as MarkdownString,
  MockTreeItem as TreeItem,
  MockDisposable as Disposable,
  TreeItemCollapsibleState,
  window,
  commands,
  env,
  Uri,
  authentication,
  workspace,
  extensions,
};
