// @vitest-environment jsdom
import { h, render } from 'preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BadgePill } from '../webview/shared/components/BadgePill';

const badge = { label: '✓ CI passing', type: 'ci' as const, variant: 'ci-pass' };

afterEach(() => {
  render(null, document.body);
  document.body.innerHTML = '';
});

describe('BadgePill', () => {
  it('renders as a button-role element when clickable', () => {
    const onClick = vi.fn();
    render(h(BadgePill, { badge, onClick }), document.body);

    const button = document.body.querySelector('[role="button"]') as HTMLElement | null;
    expect(button).not.toBeNull();
    expect(button?.tabIndex).toBe(0);

    button?.click();
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('renders as an inert span when no click handler is provided', () => {
    render(h(BadgePill, { badge }), document.body);

    const pill = document.body.querySelector('.badge-pill') as HTMLElement | null;
    expect(pill?.tagName).toBe('SPAN');
    expect(pill?.getAttribute('role')).toBeNull();
    expect(pill?.hasAttribute('tabindex')).toBe(false);
  });
});
