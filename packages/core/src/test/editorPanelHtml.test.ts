import { describe, expect, it } from 'vitest';
import { getEditorPanelHtml, renderMarkdown } from '../views/editorPanelHtml';
import type { EditorItemData } from '../views/missionControlTypes';

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
    expect(html).toContain("Content-Security-Policy");
    expect(html).toContain("https://example.test/editor.js");
    expect(html).toContain("window.__DEVDOCKET_EDITOR_BOOTSTRAP__");
    expect(html).toMatch(/<script nonce="[^"]+" type="module" src="https:\/\/example\.test\/editor\.js"><\/script>/);
    expect(html).not.toContain("unsafe-inline");
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
