// Re-export color constants so existing imports from theme.ts continue to work.
export {
  tierColors,
  providerBadgeColors,
  stateBadgeColors,
  ciBadgeColors,
} from './colors';
export type { ThemedColor } from './colors';

export type ThemeKind = 'light' | 'dark' | 'high-contrast' | 'high-contrast-light';

export function getThemeKind(): ThemeKind {
  // VS Code applies one of these classes to <body>:
  //   vscode-light, vscode-dark, vscode-high-contrast, vscode-high-contrast-light
  // Check the high-contrast-light variant first because VS Code may apply
  // both vscode-high-contrast AND vscode-high-contrast-light on light HC
  // themes, and we want to treat that as a light-background theme rather
  // than a dark one (otherwise dark-on-light badges become unreadable).
  if (document.body.classList.contains('vscode-high-contrast-light')) return 'high-contrast-light';
  if (document.body.classList.contains('vscode-high-contrast')) return 'high-contrast';
  if (document.body.classList.contains('vscode-light')) return 'light';
  return 'dark';
}

/**
 * Convenience predicate for callers that only care whether the theme has a
 * light background (used to pick light- vs dark-tuned color pairs). Treats
 * the high-contrast-light variant as light.
 */
export function isLightTheme(): boolean {
  const kind = getThemeKind();
  return kind === 'light' || kind === 'high-contrast-light';
}
