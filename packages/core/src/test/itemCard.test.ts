import { describe, expect, it } from 'vitest';
import { getItemActionClassName } from '../webview/sidebar/components/ItemCard';

describe('ItemCard', () => {
  it('visually distinguishes only the dismiss action', () => {
    expect(getItemActionClassName('accept')).toBe('item-action-btn');
    expect(getItemActionClassName('accept-to-focus')).toBe('item-action-btn');
    expect(getItemActionClassName('dismiss')).toBe('item-action-btn item-action-btn--dismiss');
  });
});
