import { vi } from 'vitest';
import * as nodePath from 'path';

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

const FileType = {
  Unknown: 0,
  File: 1,
  Directory: 2,
  SymbolicLink: 64,
};

const mockLogOutputChannel = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  trace: vi.fn(),
  append: vi.fn(),
  appendLine: vi.fn(),
  clear: vi.fn(),
  show: vi.fn(),
  hide: vi.fn(),
  dispose: vi.fn(),
  name: 'DevDocket AI Review',
  logLevel: 2,
  onDidChangeLogLevel: vi.fn(),
  replace: vi.fn(),
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
  createOutputChannel: vi.fn(() => mockLogOutputChannel),
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
  joinPath: vi.fn((base: { fsPath: string }, ...segments: string[]) => {
    const joined = nodePath.posix.resolve(base.fsPath, ...segments);
    return { fsPath: joined, toString: () => `file://${joined}` };
  }),
};

const authentication = {
  getSession: vi.fn().mockResolvedValue({ accessToken: 'mock-token' }),
};

const workspace = {
  getConfiguration: vi.fn().mockReturnValue({
    get: vi.fn((key: string, defaultValue?: unknown) => defaultValue),
  }),
  workspaceFolders: [{ uri: { fsPath: '/mock/workspace' } }],
  getWorkspaceFolder: vi.fn((uri: { fsPath: string }) => {
    const folders = workspace.workspaceFolders;
    if (!folders) return undefined;
    for (const folder of folders) {
      if (uri.fsPath.startsWith(folder.uri.fsPath)) {
        return folder;
      }
    }
    return undefined;
  }),
  openTextDocument: vi.fn().mockResolvedValue({ uri: 'mock-doc-uri' }),
  fs: {
    readFile: vi.fn().mockResolvedValue(new Uint8Array()),
    readDirectory: vi.fn().mockResolvedValue([]),
    stat: vi.fn().mockResolvedValue({ type: 1 }),
    createDirectory: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
  },
};

class MockLanguageModelChatMessage {
  role: string;
  content: unknown;
  constructor(role: string, content: unknown) {
    this.role = role;
    this.content = content;
  }
  static User(content: unknown) {
    return new MockLanguageModelChatMessage('user', content);
  }
  static Assistant(content: unknown) {
    return new MockLanguageModelChatMessage('assistant', content);
  }
}

class MockLanguageModelTextPart {
  constructor(public value: string) {}
}

class MockLanguageModelToolCallPart {
  constructor(public callId: string, public name: string, public input: unknown) {}
}

class MockLanguageModelToolResultPart {
  constructor(public callId: string, public content: unknown[]) {}
}

class MockLanguageModelToolResult {
  constructor(public content: unknown[]) {}
}

class MockChatResponseMarkdownPart {
  value: { value: string };
  constructor(text: string) {
    this.value = { value: text };
  }
}

class MockChatRequestTurn {
  prompt: string;
  constructor(prompt: string) {
    this.prompt = prompt;
  }
}

class MockChatResponseTurn {
  response: MockChatResponseMarkdownPart[];
  constructor(parts: MockChatResponseMarkdownPart[]) {
    this.response = parts;
  }
}

const lm = {
  selectChatModels: vi.fn().mockResolvedValue([{
    sendRequest: vi.fn().mockResolvedValue({
      text: (async function* () { yield 'Review feedback here'; })(),
      stream: (async function* () { yield new MockLanguageModelTextPart('Review feedback here'); })(),
    }),
  }]),
  registerTool: vi.fn((_name: string, _impl: unknown) => ({ dispose: vi.fn() })),
  invokeTool: vi.fn().mockResolvedValue({
    content: [new MockLanguageModelTextPart('Tool result')],
  }),
  tools: [] as Array<{ name: string; description: string; inputSchema: unknown }>,
};

const chat = {
  createChatParticipant: vi.fn((id: string, handler: Function) => ({
    id,
    iconPath: undefined,
    requestHandler: handler,
    followupProvider: undefined as unknown,
    onDidReceiveFeedback: vi.fn(() => ({ dispose: vi.fn() })),
    dispose: vi.fn(),
  })),
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
  MockLanguageModelTextPart as LanguageModelTextPart,
  MockLanguageModelToolCallPart as LanguageModelToolCallPart,
  MockLanguageModelToolResultPart as LanguageModelToolResultPart,
  MockLanguageModelToolResult as LanguageModelToolResult,
  MockChatResponseMarkdownPart as ChatResponseMarkdownPart,
  MockChatRequestTurn as ChatRequestTurn,
  MockChatResponseTurn as ChatResponseTurn,
  TreeItemCollapsibleState,
  ProgressLocation,
  FileType,
  mockLogOutputChannel,
  window,
  commands,
  env,
  Uri,
  authentication,
  workspace,
  extensions,
  lm,
  chat,
};
