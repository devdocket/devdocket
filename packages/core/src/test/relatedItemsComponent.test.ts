import * as React from 'preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EditorItemData } from '../views/mainTypes';

function collectText(node: unknown): string[] {
  if (node === null || node === undefined || typeof node === 'boolean') {
    return [];
  }
  if (typeof node === 'string' || typeof node === 'number') {
    return [String(node)];
  }
  if (Array.isArray(node)) {
    return node.flatMap(collectText);
  }
  if (typeof node === 'object' && 'props' in node) {
    return collectText((node as { props?: { children?: unknown } }).props?.children);
  }
  return [];
}

describe('RelatedItems', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('uses neutral group headings for mixed related item directions', async () => {
    const items: EditorItemData['relatedItems'] = [
      { targetItemId: 'pr-1', targetKind: 'workItem', label: 'Closed by owner/repo#10', relation: 'closes', itemType: 'pr' },
      { targetItemId: 'issue-1', targetKind: 'workItem', label: 'Linked to owner/repo#2', relation: 'linked', itemType: 'issue' },
    ];

    vi.stubGlobal('React', React);
    const { RelatedItems } = await import('../webview/editor/components/RelatedItems');

    const text = collectText(RelatedItems({ items, onOpenItem: vi.fn() }));

    expect(text).toContain('Closing refs');
    expect(text).toContain('Links');
    expect(text).not.toContain('Closes');
    expect(text).not.toContain('Linked');
  });
});
