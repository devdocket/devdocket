import type { JSX } from 'preact';
import type { BadgeData } from '../types';
import { isLightTheme, providerBadgeColors, stateBadgeColors, ciBadgeColors } from '../theme';

interface BadgePillProps {
  badge: BadgeData;
  onClick?: () => void;
  /**
   * Forwarded to the focusable button element. Defaults to `0`. Sidebar
   * cards implement a roving-tabindex listbox, so the parent passes `-1`
   * for non-active cards to keep only the active card's badge in the Tab
   * order.
   */
  tabIndex?: number;
  /** Required for the clickable variant so the action is announced. */
  ariaLabel?: string;
}

export function BadgePill({ badge, onClick, tabIndex = 0, ariaLabel }: BadgePillProps) {
  const colors = getBadgeColors(badge);

  if (onClick) {
    const handleClick: JSX.MouseEventHandler<HTMLSpanElement> = (event) => {
      event.stopPropagation();
      onClick();
    };
    const handleKeyDown: JSX.KeyboardEventHandler<HTMLSpanElement> = (event) => {
      if (event.key !== 'Enter' && event.key !== ' ' && event.key !== 'Spacebar') {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      onClick();
    };

    return (
      <span
        class="badge-pill badge-pill--clickable"
        style={colors}
        role="button"
        tabIndex={tabIndex}
        aria-label={ariaLabel ?? badge.label}
        onClick={handleClick}
        onKeyDown={handleKeyDown}
      >
        {badge.label}
      </span>
    );
  }

  return (
    <span class="badge-pill" style={colors}>
      {badge.label}
    </span>
  );
}

const vscodeBadgeFallback: JSX.CSSProperties = {
  backgroundColor: 'var(--vscode-badge-background)',
  color: 'var(--vscode-badge-foreground)',
};

function getBadgeColors(badge: BadgeData): JSX.CSSProperties {
  if (badge.type === 'provider') {
    const entry = providerBadgeColors[badge.variant as keyof typeof providerBadgeColors];
    if (entry) {
      return { backgroundColor: entry.bg, color: entry.fg };
    }
    return vscodeBadgeFallback;
  }

  // Outline-only treatment: type pills (Issue / PR) and provider-supplied
  // badges with the 'neutral' variant. Used for category labels that appear
  // on every item — should read as a quiet annotation, not an alert.
  if (badge.type === 'type' || (badge.type === 'provider-supplied' && badge.variant === 'neutral')) {
    return outlineFallback;
  }

  // Provider-supplied + state + ci badges all share the themed palette so
  // the same severity reads the same way regardless of source.
  const palette = badge.type === 'ci' ? ciBadgeColors : stateBadgeColors;
  const themed = palette[badge.variant];
  if (themed) {
    const pair = isLightTheme() ? themed.light : themed.dark;
    return {
      backgroundColor: pair.bg,
      color: pair.fg,
      ...(pair.border ? { border: `1px solid ${pair.border}` } : {}),
    };
  }

  return outlineFallback;
}

const outlineFallback: JSX.CSSProperties = {
  backgroundColor: 'transparent',
  color: 'var(--vscode-descriptionForeground)',
  border: '1px solid var(--vscode-widget-border, rgba(127, 127, 127, 0.3))',
  fontWeight: 400,
};
