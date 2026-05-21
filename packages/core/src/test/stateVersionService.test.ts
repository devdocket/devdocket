import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { StateVersionService } from '../services/stateVersionService';

describe('StateVersionService', () => {
  let onDidChange: (() => void) | undefined;
  let onDidCreate: (() => void) | undefined;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    onDidChange = undefined;
    onDidCreate = undefined;

    (vscode.workspace.createFileSystemWatcher as any).mockImplementation(() => ({
      onDidChange: (listener: () => void) => {
        onDidChange = listener;
        return { dispose: vi.fn() };
      },
      onDidCreate: (listener: () => void) => {
        onDidCreate = listener;
        return { dispose: vi.fn() };
      },
      onDidDelete: vi.fn(() => ({ dispose: vi.fn() })),
      dispose: vi.fn(),
    }));
    (vscode.workspace.fs.readFile as any).mockRejectedValue(new Error('not found'));
    (vscode.workspace.fs.writeFile as any).mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('writes a version file when bumped', async () => {
    const service = new StateVersionService(vscode.Uri.file('C:\\state'));

    await service.bump();

    expect(vscode.workspace.createFileSystemWatcher).toHaveBeenCalledWith(
      expect.objectContaining({ pattern: 'state-version.json' }),
    );
    expect(vscode.workspace.fs.writeFile).toHaveBeenCalledTimes(1);

    const [uri, content] = (vscode.workspace.fs.writeFile as any).mock.calls[0];
    expect(uri.fsPath).toBe('C:\\state\\state-version.json');

    const payload = JSON.parse(Buffer.from(content).toString('utf-8'));
    expect(payload.instanceId).toEqual(expect.any(String));
    expect(payload.version).toEqual(expect.any(Number));

    service.dispose();
  });

  it('ignores its own version writes', async () => {
    const service = new StateVersionService(vscode.Uri.file('C:\\state'));
    const listener = vi.fn();
    service.onDidExternalStateChange(listener);

    await service.bump();
    const [, content] = (vscode.workspace.fs.writeFile as any).mock.calls[0];
    (vscode.workspace.fs.readFile as any).mockResolvedValue(content);

    onDidChange?.();
    await vi.advanceTimersByTimeAsync(100);

    expect(listener).not.toHaveBeenCalled();

    service.dispose();
  });

  it('fires once for debounced external changes', async () => {
    const service = new StateVersionService(vscode.Uri.file('C:\\state'));
    const listener = vi.fn();
    service.onDidExternalStateChange(listener);
    (vscode.workspace.fs.readFile as any).mockResolvedValue(
      Buffer.from(JSON.stringify({ instanceId: 'other-window', version: 123 }), 'utf-8'),
    );

    onDidChange?.();
    onDidCreate?.();
    await vi.advanceTimersByTimeAsync(100);

    expect(vscode.workspace.fs.readFile).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledTimes(1);

    service.dispose();
  });

  it('does not fire repeatedly for the same external version', async () => {
    const service = new StateVersionService(vscode.Uri.file('C:\\state'));
    const listener = vi.fn();
    service.onDidExternalStateChange(listener);
    (vscode.workspace.fs.readFile as any).mockResolvedValue(
      Buffer.from(JSON.stringify({ instanceId: 'other-window', version: 123 }), 'utf-8'),
    );

    onDidChange?.();
    await vi.advanceTimersByTimeAsync(100);
    onDidChange?.();
    await vi.advanceTimersByTimeAsync(100);

    expect(listener).toHaveBeenCalledTimes(1);

    service.dispose();
  });

  it('writes a unique version for consecutive same-millisecond bumps', async () => {
    vi.setSystemTime(new Date('2026-05-21T02:00:00Z'));
    const service = new StateVersionService(vscode.Uri.file('C:\\state'));

    await service.bump();
    await service.bump();

    const firstPayload = JSON.parse(Buffer.from((vscode.workspace.fs.writeFile as any).mock.calls[0][1]).toString('utf-8'));
    const secondPayload = JSON.parse(Buffer.from((vscode.workspace.fs.writeFile as any).mock.calls[1][1]).toString('utf-8'));
    expect(secondPayload.version).toBeGreaterThan(firstPayload.version);

    service.dispose();
  });

  it('serializes concurrent bumps so each write gets a unique version', async () => {
    vi.setSystemTime(new Date('2026-05-21T02:00:00Z'));
    const service = new StateVersionService(vscode.Uri.file('C:\\state'));

    await Promise.all([service.bump(), service.bump(), service.bump()]);

    const versions = (vscode.workspace.fs.writeFile as any).mock.calls.slice(0, 3)
      .map(([, content]: [unknown, Uint8Array]) => JSON.parse(Buffer.from(content).toString('utf-8')).version);
    expect(new Set(versions).size).toBe(3);

    service.dispose();
  });

  it('stops reacting after dispose', async () => {
    const service = new StateVersionService(vscode.Uri.file('C:\\state'));
    const listener = vi.fn();
    service.onDidExternalStateChange(listener);
    (vscode.workspace.fs.readFile as any).mockResolvedValue(
      Buffer.from(JSON.stringify({ instanceId: 'other-window', version: 123 }), 'utf-8'),
    );

    service.dispose();
    onDidChange?.();
    await vi.advanceTimersByTimeAsync(100);

    expect(vscode.workspace.fs.readFile).not.toHaveBeenCalled();
    expect(listener).not.toHaveBeenCalled();
  });
});
