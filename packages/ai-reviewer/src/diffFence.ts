/**
 * Build a fenced code block whose delimiter is strictly longer than any
 * backtick run inside `content`, preventing prompt-injection escapes.
 *
 * The minimum fence length is 4 (matching the previous hard-coded delimiter).
 */
export function fenceDiff(content: string): string {
  const MIN_FENCE = 4;

  // Find the longest consecutive run of backticks in the content
  let maxRun = 0;
  let current = 0;
  for (let i = 0; i < content.length; i++) {
    if (content[i] === '`') {
      current++;
      if (current > maxRun) maxRun = current;
    } else {
      current = 0;
    }
  }

  const fenceLength = Math.max(MIN_FENCE, maxRun + 1);
  const fence = '`'.repeat(fenceLength);
  return `${fence}diff\n${content}\n${fence}`;
}
