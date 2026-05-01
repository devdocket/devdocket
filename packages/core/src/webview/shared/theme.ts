// Re-export color constants so existing imports from theme.ts continue to work.
export {
  tierColors,
  providerBadgeColors,
  stateBadgeColors,
  ciBadgeColors,
} from './colors';
export type { ThemedColor } from './colors';

export type ThemeKind = 'light' | 'dark' | 'high-contrast';

export function getThemeKind(): ThemeKind {
  if (document.body.classList.contains('vscode-light')) return 'light';
  if (document.body.classList.contains('vscode-high-contrast')) return 'high-contrast';
  return 'dark';
}
