export type ThemeKind = 'light' | 'dark' | 'high-contrast';

export function getThemeKind(): ThemeKind {
  if (document.body.classList.contains('vscode-light')) return 'light';
  if (document.body.classList.contains('vscode-high-contrast')) return 'high-contrast';
  return 'dark';
}

export const tierColors = {
  incoming: { dark: '#3794FF', light: '#005FB8' },
  inProgress: { dark: '#89D185', light: '#388A34' },
  urgent: { dark: '#F14C4C', light: '#CD2D2D' },
  readyToStart: { dark: '#6E6E6E', light: '#B0B0B0' },
  paused: { dark: '#CCA700', light: '#BF8803' },
  done: { dark: '#6E6E6E', light: '#B0B0B0' },
} as const;
