/**
 * Format a Date as a human-readable relative time string (e.g. "2 minutes ago").
 * Falls back to an absolute timestamp for durations of 24 hours or more.
 */
export function formatRelativeTime(date: Date): string {
  const now = Date.now();
  const diffMs = now - date.getTime();

  if (diffMs < 0) {
    return 'just now';
  }

  const seconds = Math.floor(diffMs / 1000);
  if (seconds < 60) {
    return 'just now';
  }

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  }

  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  }

  return date.toLocaleString();
}
