import { describe, expect, it } from 'vitest';
import { getEditorPanelHtml, renderMarkdown } from '../views/editorPanelHtml';
import type { EditorItemData } from '../views/mainTypes';

function makeEditorItem(overrides: Partial<EditorItemData> = {}): EditorItemData {
  const now = Date.now();
  return {
    id: 'item-1',
    title: 'Test Item',
    notes: 'Notes',
    url: 'https://example.com/items/1',
    description: '<p>Safe description</p>',
    state: 'New',
    createdAt: now,
    updatedAt: now,
    badges: [],
    isProviderManaged: false,
    validTransitions: ['InProgress', 'Archived'],
    hasActions: false,
    activityLog: [],
    relatedItems: [],
    ...overrides,
  };
}

describe('getEditorPanelHtml', () => {
  it('renders a minimal shell with the editor bundle and CSP nonce', () => {
    const html = getEditorPanelHtml({
      cspSource: 'https://example.test',
      scriptUri: 'https://example.test/editor.js',
      initialItem: makeEditorItem(),
    });

    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('Content-Security-Policy');
    expect(html).toContain('https://example.test/editor.js');
    expect(html).toContain('window.__DEVDOCKET_EDITOR_BOOTSTRAP__');
    expect(html).toContain('<div id="root"></div>');
    expect(html).toMatch(/<script nonce="[^"]+" type="module" src="https:\/\/example\.test\/editor\.js"><\/script>/);
    expect(html).not.toContain('unsafe-inline');
  });

  it('seeds serialized webview state without acquiring the VS Code API twice', () => {
    const html = getEditorPanelHtml({
      cspSource: 'https://example.test',
      scriptUri: 'https://example.test/editor.js',
      initialItem: makeEditorItem(),
    });

    expect(html).toContain('window.__DEVDOCKET_VSCODE_API__ = window.__DEVDOCKET_VSCODE_API__ || acquireVsCodeApi();');
    expect(html).toContain('window.__DEVDOCKET_VSCODE_API__.setState({"version":1,"itemId":"item-1"});');
  });

  it('bootstraps the editor app with transitions, activity, and related item data', () => {
    const html = getEditorPanelHtml({
      cspSource: 'https://example.test',
      scriptUri: 'https://example.test/editor.js',
      initialItem: makeEditorItem({
        validTransitions: ['InProgress', 'Done'],
        hasActions: true,
        activityLog: [{ timestamp: 123, type: 'work-started', detail: '{"branchName":"feature/test"}' }],
        relatedItems: [{ targetItemId: 'peer-1', targetKind: 'workItem', label: 'Closes owner/repo#2', relation: 'closes', itemType: 'issue' }],
      }),
    });

    expect(html).toContain('"validTransitions":["InProgress","Done"]');
    expect(html).toContain('"hasActions":true');
    expect(html).toContain('"activityLog":[{"timestamp":123,"type":"work-started"');
    expect(html).toContain('"relatedItems":[{"targetItemId":"peer-1"');
    expect(html).toContain('"label":"Closes owner/repo#2"');
  });

  it('escapes bootstrap data before embedding it in the HTML shell', () => {
    const html = getEditorPanelHtml({
      cspSource: 'https://example.test',
      scriptUri: 'https://example.test/editor.js',
      initialItem: makeEditorItem({ title: '<script>alert(1)</script>' }),
    });

    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('\\u003cscript\\u003ealert(1)\\u003c/script\\u003e');
  });

  it('escapes line separators before embedding bootstrap data in script', () => {
    const html = getEditorPanelHtml({
      cspSource: 'https://example.test',
      scriptUri: 'https://example.test/editor.js',
      initialItem: makeEditorItem({ title: 'Line\u2028Paragraph\u2029End' }),
    });

    expect(html).toContain('Line\\u2028Paragraph\\u2029End');
  });
});

describe('renderMarkdown', () => {
  it('sanitizes dangerous attributes and schemes', () => {
    const html = renderMarkdown('[click](javascript:alert(1)) <img src="https://example.test/x.png" onerror="alert(1)">');

    expect(html).not.toContain('javascript:alert');
    expect(html).not.toContain('onerror');
    expect(html).toContain('https://example.test/x.png');
  });

  it('preserves supported markdown formatting', () => {
    const html = renderMarkdown('## Heading\n\n- one\n- two\n\n`code`');

    expect(html).toContain('<h2>Heading</h2>');
    expect(html).toContain('<li>one</li>');
    expect(html).toContain('<code>code</code>');
  });
});
