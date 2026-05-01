/**
 * Centralized color palette for all Mission Control webviews.
 *
 * This file contains NO DOM dependencies — it is safe to import from both
 * the Node-side extension code and the browser-side webview code.
 */

// ---------------------------------------------------------------------------
// Tier border colors
// ---------------------------------------------------------------------------

export const tierColors = {
  incoming:     { dark: '#3794FF', light: '#005FB8' },
  inProgress:   { dark: '#89D185', light: '#388A34' },
  urgent:       { dark: '#F14C4C', light: '#CD2D2D' },
  readyToStart: { dark: '#6E6E6E', light: '#B0B0B0' },
  paused:       { dark: '#CCA700', light: '#BF8803' },
  done:         { dark: '#6E6E6E', light: '#B0B0B0' },
} as const;

// ---------------------------------------------------------------------------
// Provider badge colors
// ---------------------------------------------------------------------------

export const providerBadgeColors = {
  github: { bg: '#2D333B', fg: '#E6EDF3' },
  ado:    { bg: '#1B5E9F', fg: '#E6EDF3' },
} as const;

// ---------------------------------------------------------------------------
// State badge colors  (semantic: red = action needed, green = positive, etc.)
// ---------------------------------------------------------------------------

export interface ThemedColor { dark: { bg: string; fg: string }; light: { bg: string; fg: string } }

export const stateBadgeColors: Record<string, ThemedColor> = {
  'changes-requested': {
    dark:  { bg: 'rgba(241,76,76,0.15)',   fg: '#F14C4C' },
    light: { bg: 'rgba(205,45,45,0.10)',   fg: '#CD2D2D' },
  },
  'approved': {
    dark:  { bg: 'rgba(137,209,133,0.15)', fg: '#89D185' },
    light: { bg: 'rgba(56,138,52,0.10)',   fg: '#388A34' },
  },
  'review-requested': {
    dark:  { bg: 'rgba(204,167,0,0.15)',   fg: '#CCA700' },
    light: { bg: 'rgba(191,136,3,0.10)',   fg: '#BF8803' },
  },
  'draft': {
    dark:  { bg: 'rgba(110,110,110,0.15)', fg: '#9E9E9E' },
    light: { bg: 'rgba(110,110,110,0.10)', fg: '#6E6E6E' },
  },
  'closed': {
    dark:  { bg: 'rgba(110,110,110,0.15)', fg: '#9E9E9E' },
    light: { bg: 'rgba(110,110,110,0.10)', fg: '#6E6E6E' },
  },
  'open': {
    dark:  { bg: 'rgba(55,148,255,0.15)',  fg: '#3794FF' },
    light: { bg: 'rgba(0,95,184,0.10)',    fg: '#005FB8' },
  },
  'ready-to-merge': {
    dark:  { bg: 'rgba(137,209,133,0.15)', fg: '#89D185' },
    light: { bg: 'rgba(56,138,52,0.10)',   fg: '#388A34' },
  },
};

// ---------------------------------------------------------------------------
// CI status badge colors
// ---------------------------------------------------------------------------

export const ciBadgeColors: Record<string, ThemedColor> = {
  'ci-pass': {
    dark:  { bg: 'rgba(137,209,133,0.15)', fg: '#89D185' },
    light: { bg: 'rgba(56,138,52,0.10)',   fg: '#388A34' },
  },
  'ci-fail': {
    dark:  { bg: 'rgba(241,76,76,0.15)',   fg: '#F14C4C' },
    light: { bg: 'rgba(205,45,45,0.10)',   fg: '#CD2D2D' },
  },
  'ci-running': {
    dark:  { bg: 'rgba(55,148,255,0.15)',  fg: '#3794FF' },
    light: { bg: 'rgba(0,95,184,0.10)',    fg: '#005FB8' },
  },
};

// ---------------------------------------------------------------------------
// CSS custom property generation (used by the HTML template)
// ---------------------------------------------------------------------------

/** Map from tierColors key → CSS custom property name */
const tierCssVarMap: Record<keyof typeof tierColors, string> = {
  incoming:     '--tier-incoming',
  inProgress:   '--tier-in-progress',
  urgent:       '--tier-urgent',
  readyToStart: '--tier-ready',
  paused:       '--tier-paused',
  done:         '--tier-done',
};

/** Generate CSS custom property declarations for tier colors in a given theme. */
export function buildTierColorCss(theme: 'dark' | 'light'): string {
  return Object.entries(tierCssVarMap)
    .map(([key, cssVar]) => `${cssVar}: ${tierColors[key as keyof typeof tierColors][theme]};`)
    .join('\n      ');
}
