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

  it('shows item title in heading instead of generic text', () => {
    const item = makeItem({ title: 'Fix login bug' });
    const html = getEditorPanelHtml({ cspSource, item });
    expect(html).toContain('<h2 id="editor-heading">Fix login bug</h2>');
    expect(html).not.toContain('Edit Work Item');
  });

  it('escapes special characters in heading title', () => {
    const item = makeItem({ title: 'Use <div> & "quotes"' });
    const html = getEditorPanelHtml({ cspSource, item });
    expect(html).toContain('<h2 id="editor-heading">Use &lt;div&gt; &amp; "quotes"</h2>');
    expect(html).not.toContain('>Use <div>');
  });

  it('preserves editor-heading id attribute', () => {
    const html = getEditorPanelHtml({ cspSource, item: makeItem() });
    expect(html).toMatch(/<h2 id="editor-heading">/);
    expect(html).toContain('aria-labelledby="editor-heading"');
  });

  it('generates unique nonces across calls', () => {
    const html1 = getEditorPanelHtml({ cspSource, item: makeItem() });
    const html2 = getEditorPanelHtml({ cspSource, item: makeItem() });
    const nonce1 = html1.match(/nonce="([^"]+)"/)![1];
    const nonce2 = html2.match(/nonce="([^"]+)"/)![1];
    expect(nonce1).not.toBe(nonce2);
  });

  describe('provider description', () => {
    it('renders a description section when providerDescription is provided', () => {
      const html = getEditorPanelHtml({
        cspSource,
        item: makeItem({ providerId: 'github' }),
        providerDescription: 'Fix the login bug on the main page',
      });
      expect(html).toContain('Fix the login bug on the main page');
      expect(html).toContain('Provider Description');
    });

    it('does not render a description section when providerDescription is omitted', () => {
      const html = getEditorPanelHtml({
        cspSource,
        item: makeItem({ providerId: 'github' }),
      });
      const descLabelPattern = /<label[^>]*>.*?Provider Description.*?<\/label>/s;
      expect(html).not.toMatch(descLabelPattern);
      // CSS class exists in <style>, but no actual description div in body
      expect(html).not.toContain('provider-desc-label');
    });

    it('does not render a description section when providerDescription is empty', () => {
      const html = getEditorPanelHtml({
        cspSource,
        item: makeItem({ providerId: 'github' }),
        providerDescription: '',
      });
      const descLabelPattern = /<label[^>]*>.*?Provider Description.*?<\/label>/s;
      expect(html).not.toMatch(descLabelPattern);
    });

    it('HTML-escapes the description to prevent XSS', () => {
      const xss = '<img src=x onerror="alert(1)"> & "quotes"';
      const html = getEditorPanelHtml({
        cspSource,
        item: makeItem({ providerId: 'github' }),
        providerDescription: xss,
      });
      expect(html).not.toContain('<img src=x');
      expect(html).toContain('&lt;img src=x');
      expect(html).toContain('&amp;');
    });

    it('renders the description as a non-editable div, not an input or textarea', () => {
      const html = getEditorPanelHtml({
        cspSource,
        item: makeItem({ providerId: 'github' }),
        providerDescription: 'Some provider description',
      });
      // The description should be in a div (inherently read-only), not an input/textarea
      const descIndex = html.indexOf('Some provider description');
      expect(descIndex).toBeGreaterThan(-1);

      const before = html.substring(0, descIndex);
      const lastTagOpen = before.lastIndexOf('<');
      const containingTag = html.substring(lastTagOpen, descIndex);
      expect(containingTag).toMatch(/^<div\b/);
      expect(containingTag).not.toMatch(/^<(input|textarea)\b/);
    });
  });
});
