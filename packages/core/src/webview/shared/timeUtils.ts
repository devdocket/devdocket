import { format } from 'timeago.js';

export function formatRelativeTime(epochMs: number): string {
  return format(epochMs);
}
