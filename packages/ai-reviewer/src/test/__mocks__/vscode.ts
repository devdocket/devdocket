import { vi } from 'vitest';

class MockEventEmitter {
  private listeners: Function[] = [];
  event = (listener: Function) => {
    this.listeners.push(listener);
    return { dispose: () => { this.listeners = this.listeners.filter(l => l !== listener); } };
  };
  fire(data?: unknown) {
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
  tooltip?: unknown;
  contextValue?: string;
  iconPath?: unknown;
  constructor(label: string, collapsibleState?: number) {
    this.label = label;
    this.collapsibleState = collapsibleState ?? 0;
  }
}

const ProgressLocation = {
  SourceControl: 1,
  Window: 10,
  Notification: 15,
};

const window = {
  showInputBox: vi.fn(),
  showInformationMessage: vi.fn(),
  showWarningMessage: vi.fn(),
  showErrorMessage: vi.fn(),
  showQuickPick: vi.fn(),
  showTextDocument: vi.fn(),
  registerTreeDataProvider: vi.fn(() => ({ dispose: vi.fn() })),
  createWebviewPanel: vi.fn(),
  withProgress: vi.fn(async (options: unknown, task: Function) => {
    const progress = { report: vi.fn() };
    const token = { isCancellationRequested: false, onCancellationRequested: vi.fn() };
    return task(progress, token);
  }),
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
    get: vi.fn((key: string, defaultValue?: unknown) => defaultValue),
  }),
  workspaceFolders: [{ uri: { fsPath: '/mock/workspace' } }],
  openTextDocument: vi.fn().mockResolvedValue({ uri: 'mock-doc-uri' }),
};

class MockLanguageModelChatMessage {
  role: string;
  content: string;
  constructor(role: string, content: string) {
    this.role = role;
    this.content = content;
  }
  static User(content: string) {
    return new MockLanguageModelChatMessage('user', content);
  }
}

const lm = {
  selectChatModels: vi.fn().mockResolvedValue([{
    sendRequest: vi.fn().mockResolvedValue({
      text: (async function* () { yield 'Review feedback here'; })(),
    }),
  }]),
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
  MockLanguageModelChatMessage as LanguageModelChatMessage,
  TreeItemCollapsibleState,
  ProgressLocation,
  window,
  commands,
  env,
  Uri,
  authentication,
  workspace,
  extensions,
  lm,
};
