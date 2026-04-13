import { describe, it, expect } from 'vitest';
import { getEditorPanelHtml } from '../views/editorPanelHtml';
import { WorkItem, WorkItemState } from '../models/workItem';

function makeItem(overrides: Partial<WorkItem> = {}): WorkItem {
  const now = Date.now();
  return {
    id: 'test-1',
    title: 'Test Item',
    state: WorkItemState.New,
    createdAt: now,
    updatedAt: now,
    notes: '',
    ...overrides,
  };
}

describe('getEditorPanelHtml', () => {
  const cspSource = 'https://example.test';

  it('returns valid HTML with CSP meta tag', () => {
    const html = getEditorPanelHtml({ cspSource, item: makeItem() });
    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('Content-Security-Policy');
    expect(html).toContain(cspSource);
  });

  it('applies nonce to both script and style tags', () => {
    const html = getEditorPanelHtml({ cspSource, item: makeItem() });
    const nonceMatches = html.match(/nonce="([^"]+)"/g);
    expect(nonceMatches).not.toBeNull();
    expect(nonceMatches!.length).toBe(2); // one on <style>, one on <script>

    // All nonces should be the same value
    const values = nonceMatches!.map(m => m.match(/nonce="([^"]+)"/)![1]);
    expect(values[0]).toBe(values[1]);
  });

  it('does not use unsafe-inline in CSP', () => {
    const html = getEditorPanelHtml({ cspSource, item: makeItem() });
    expect(html).not.toContain('unsafe-inline');
  });

  it('escapes HTML entities in title', () => {
    const item = makeItem({ title: '<script>alert("xss")</script>' });
    const html = getEditorPanelHtml({ cspSource, item });
    expect(html).not.toContain('<script>alert');
    expect(html).toContain('&lt;script&gt;');
  });

  it('escapes quotes in title attribute value', () => {
    const item = makeItem({ title: 'A "quoted" title' });
    const html = getEditorPanelHtml({ cspSource, item });
    expect(html).toContain('&quot;quoted&quot;');
  });

  it('escapes HTML in notes textarea', () => {
    const item = makeItem({ notes: '<b>bold</b> & more' });
    const html = getEditorPanelHtml({ cspSource, item });
    expect(html).toContain('&lt;b&gt;bold&lt;/b&gt; &amp; more');
  });

  it('marks title readonly for provider-owned items', () => {
    const item = makeItem({ providerId: 'github' });
    const html = getEditorPanelHtml({ cspSource, item });
    expect(html).toContain('readonly');
    expect(html).toContain('Title is managed by the provider');
  });

  it('does not mark title readonly for manual items', () => {
    const item = makeItem({ providerId: undefined });
    const html = getEditorPanelHtml({ cspSource, item });
    expect(html).not.toContain('aria-readonly');
    expect(html).not.toContain('Title is managed by the provider');
  });

  it('generates unique nonces across calls', () => {
    const html1 = getEditorPanelHtml({ cspSource, item: makeItem() });
    const html2 = getEditorPanelHtml({ cspSource, item: makeItem() });
    const nonce1 = html1.match(/nonce="([^"]+)"/)![1];
    const nonce2 = html2.match(/nonce="([^"]+)"/)![1];
    expect(nonce1).not.toBe(nonce2);
  });

  describe('source URL link', () => {
    it('renders a clickable link when item has a url', () => {
      const item = makeItem({ url: 'https://github.com/org/repo/issues/42' });
      const html = getEditorPanelHtml({ cspSource, item });
      expect(html).toContain('id="source-link"');
      expect(html).toMatch(/<button\s[^>]*data-url="https:\/\/github\.com\/org\/repo\/issues\/42"/);
      expect(html).toContain('Open in source');
    });

    it('does not render a link when item has no url', () => {
      const item = makeItem({ url: undefined });
      const html = getEditorPanelHtml({ cspSource, item });
      expect(html).not.toContain('id="source-link"');
      expect(html).not.toContain('Open in source');
    });

    it('escapes HTML entities in the url to prevent XSS', () => {
      const item = makeItem({ url: 'https://evil.com/"><script>alert(1)</script>' });
      const html = getEditorPanelHtml({ cspSource, item });
      expect(html).not.toContain('<script>alert(1)</script>');
      expect(html).toContain('&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;');
    });
  });
});
