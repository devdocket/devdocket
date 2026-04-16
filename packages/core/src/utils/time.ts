import { format } from 'timeago.js';

/**
 * Format a Date as a human-readable relative time string (e.g. "5 minutes ago").
 * Delegates to timeago.js for relative time formatting.
 */
export function formatRelativeTime(date: Date): string {
  return format(date);
}
