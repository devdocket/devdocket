/**
 * Converts any error value to a string message.
 * Used across all tools for consistent error message extraction.
 */
export function errorToString(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
