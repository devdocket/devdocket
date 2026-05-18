import { describe, expect, it } from 'vitest';
import { CIWatchSection } from '../webview/editor/components/CIWatchSection';

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

function findByClass(node: unknown, className: string): unknown {
  if (Array.isArray(node)) {
    return node.map(child => findByClass(child, className)).find(Boolean);
  }
  if (node === null || node === undefined || typeof node !== 'object') {
    return undefined;
  }
  if ('props' in node) {
    const props = (node as { props?: { class?: string; className?: string; children?: unknown } }).props;
    const classes = props?.class ?? props?.className;
    if (classes?.split(' ').includes(className)) {
      return node;
    }
    return findByClass(props?.children, className);
  }
  return undefined;
}

describe('CIWatchSection', () => {
  it('renders partial-success runs with an amber warning chip', () => {
    const section = CIWatchSection({
      ciWatch: {
        state: 'open',
        runs: [{ id: 'run-1', name: 'Publish artifacts', state: 'completed', conclusion: 'partial_success' }],
        totalActive: 0,
        totalFailing: 0,
      },
      onOpenWatches: () => undefined,
    });

    const chip = findByClass(section, 'ci-watch-chip--warn') as { props?: { children?: unknown } } | undefined;
    expect(chip).toBeDefined();
    expect(collectText(chip).join('')).toBe('⚠Publish artifacts (Succeeded with issues)');
  });
});
