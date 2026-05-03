// Re-export color constants so existing imports from theme.ts continue to work.
import { useEffect, useState } from 'preact/hooks';

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

/**
 * Watches the VS Code body classList for theme changes and triggers a
 * re-render of the calling component on every change. The returned counter
 * value is unused — calling this hook is the opt-in. Use it once at the
 * top of each webview entry-point so descendant components that consult
 * {@link isLightTheme} or {@link getThemeKind} re-render when the user
 * switches color themes.
 */
export function useThemeChangeCounter(): number {
  const [counter, setCounter] = useState(0);
  useEffect(() => {
    const observer = new MutationObserver(() => {
      setCounter(value => value + 1);
    });
    observer.observe(document.body, { attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, []);
  return counter;
}
