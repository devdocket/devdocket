import type { JSX } from 'preact';
import type { BadgeData } from '../../shared/types';
import { getThemeKind, providerBadgeColors, stateBadgeColors, ciBadgeColors } from '../../shared/theme';

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

  const palette = badge.type === 'ci' ? ciBadgeColors : stateBadgeColors;
  const themed = palette[badge.variant];
  if (themed) {
    const isLight = getThemeKind() === 'light';
    const pair = isLight ? themed.light : themed.dark;
    return { backgroundColor: pair.bg, color: pair.fg };
  }

  return vscodeBadgeFallback;
}
