import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import * as vscode from 'vscode';
import { registerWatchCommands } from '../commands/watchCommands';

let commandHandlers: Map<string, (...args: any[]) => any>;

function registerCommandsWith(options: {
  input?: string;
  runWatcher?: any;
  prWatcher?: any;
  runActive?: boolean;
  prActive?: boolean;
} = {}) {
  commandHandlers = new Map();
  (vscode.commands.registerCommand as Mock).mockImplementation((id: string, handler: (...args: any[]) => any) => {
    commandHandlers.set(id, handler);
    return { dispose: vi.fn() };
  });
  (vscode.window.showInputBox as Mock).mockResolvedValue(options.input);

  const watcherRegistry = {
    findWatcherForUrl: vi.fn(() => options.runWatcher),
  };
  const prWatcherRegistry = {
    findWatcherForUrl: vi.fn(() => options.prWatcher),
  };
  const watcherService = {
    isRunActive: vi.fn(() => options.runActive ?? false),
    isPRActive: vi.fn(() => options.prActive ?? false),
    startWatch: vi.fn(async (identifier) => ({ identifier })),
    startPRWatch: vi.fn(async (identifier) => ({ identifier })),
  };
  const context = { subscriptions: [] };

  registerWatchCommands(
    context as any,
    watcherRegistry as any,
    prWatcherRegistry as any,
    watcherService as any,
    { open: vi.fn() } as any,
  );

  return { watcherRegistry, prWatcherRegistry, watcherService, context };
}

function invoke(name: string) {
  const handler = commandHandlers.get(name);
  if (!handler) {
    throw new Error(`Command not registered: ${name}`);
  }
  return handler();
}

describe('registerWatchCommands', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('registers Watch URL plus typed command aliases', () => {
    registerCommandsWith();

    expect(commandHandlers.has('devdocket.watchUrl')).toBe(true);
    expect(commandHandlers.has('devdocket.watchRun')).toBe(true);
    expect(commandHandlers.has('devdocket.watchPR')).toBe(true);
  });

  it('adds PR watches through the unified Watch URL input with live informational validation', async () => {
    const input = 'https://github.com/owner/repo/pull/42';
    const prIdentifier = {
      providerId: 'github-pr',
      prId: '42',
      displayName: 'PR #42',
      url: input,
      repo: 'owner/repo',
    };
    const prWatcher = {
      id: 'github-pr',
      label: 'GitHub Pull Requests',
      parsePRUrl: vi.fn(() => prIdentifier),
    };
    const { watcherService } = registerCommandsWith({ input, prWatcher });

    await invoke('devdocket.watchUrl');

    const inputOptions = (vscode.window.showInputBox as Mock).mock.calls[0][0];
    expect(inputOptions.placeHolder).toContain('https://github.com/owner/repo/pull/123');
    expect(inputOptions.placeHolder).toContain('https://github.com/owner/repo/actions/runs/12345');
    expect(inputOptions.validateInput(input)).toEqual({
      message: 'This looks like a GitHub PR — will be added as a PR watch.',
      severity: vscode.InputBoxValidationSeverity.Info,
    });
    expect(watcherService.startPRWatch).toHaveBeenCalledWith(prIdentifier, { forceRecreate: true });
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith('Now watching PR: PR #42');
  });

  it('adds run watches through the legacy watchRun alias using the unified URL classifier', async () => {
    const input = 'https://github.com/owner/repo/actions/runs/12345';
    const runIdentifier = {
      providerId: 'github-actions',
      runId: '12345',
      displayName: 'CI Build',
      url: input,
      repo: 'owner/repo',
    };
    const runWatcher = {
      id: 'github-actions',
      label: 'GitHub Actions',
      parseRunUrl: vi.fn(() => runIdentifier),
    };
    const { watcherService } = registerCommandsWith({ input, runWatcher });

    await invoke('devdocket.watchRun');

    expect(watcherService.startWatch).toHaveBeenCalledWith(runIdentifier);
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith('Now watching run: CI Build');
  });

  it('shows actionable feedback without starting a watch for unsupported URLs', async () => {
    registerCommandsWith({ input: 'https://example.com/nope' });

    await invoke('devdocket.watchUrl');

    const inputOptions = (vscode.window.showInputBox as Mock).mock.calls[0][0];
    expect(inputOptions.validateInput('')).toBeUndefined();
    expect(inputOptions.validateInput('https://example.com/nope')).toBe(
      'Unsupported URL. Paste a GitHub PR, GitHub Actions run, Azure DevOps PR, or Azure DevOps pipeline run URL.',
    );
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      'DevDocket: Unsupported URL. Paste a GitHub PR, GitHub Actions run, Azure DevOps PR, or Azure DevOps pipeline run URL.',
    );
  });
});
