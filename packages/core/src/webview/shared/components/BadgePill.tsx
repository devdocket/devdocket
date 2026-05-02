import type { JSX } from 'preact';
import type { BadgeData } from '../types';
import { getThemeKind, providerBadgeColors, stateBadgeColors, ciBadgeColors } from '../theme';

interface BadgePillProps {
  badge: BadgeData;
}

export function BadgePill({ badge }: BadgePillProps) {
  const colors = getBadgeColors(badge);

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

  // Type badges (Issue / PR) appear on every item, so use a quiet treatment
  // — transparent background with muted foreground — so they read as a
  // category annotation rather than competing with provider/state pills.
  if (badge.type === 'type') {
    return {
      backgroundColor: 'transparent',
      color: 'var(--vscode-descriptionForeground)',
      border: '1px solid var(--vscode-widget-border, rgba(127, 127, 127, 0.3))',
      fontWeight: 400,
    };
  }

  const palette = badge.type === 'ci' ? ciBadgeColors : stateBadgeColors;
  const themed = palette[badge.variant];
  if (themed) {
    const isLight = getThemeKind() === 'light';
    const pair = isLight ? themed.light : themed.dark;
    return { backgroundColor: pair.bg, color: pair.fg };
  }

  return vscodeBadgeFallback;
}
