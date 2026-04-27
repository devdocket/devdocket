/**
 * Build a fenced code block whose delimiter is strictly longer than any
 * matching-character run inside `content`, preventing prompt-injection escapes.
 *
 * Picks whichever fence character (backtick or tilde) yields the shorter
 * delimiter to avoid prompt bloat from adversarial inputs. If the required
 * fence would still exceed `MAX_FENCE`, long runs of the chosen
 * character are truncated in the content to stay within the bound.
 *
 * The minimum fence length is 4 (matching the previous hard-coded delimiter).
 */
export function fenceDiff(content: string): string {
  const MIN_FENCE = 4;
  const MAX_FENCE = 10;

  const maxBacktickRun = longestRun(content, '`');
  const maxTildeRun = longestRun(content, '~');

  // Pick whichever character needs a shorter fence
  const [char, maxRun] = maxBacktickRun <= maxTildeRun ? ['`', maxBacktickRun] : ['~', maxTildeRun];

  let fenceLength = Math.max(MIN_FENCE, maxRun + 1);

  let safeContent = content;
  if (fenceLength > MAX_FENCE) {
    // Truncate runs of the fence character to stay within the cap
    safeContent = truncateRuns(content, char, MAX_FENCE - 1);
    fenceLength = MAX_FENCE;
  }

  const fence = char.repeat(fenceLength);
  return `${fence}diff\n${safeContent}\n${fence}`;
}

/** Replace any consecutive run of `char` longer than `maxLen` with exactly `maxLen` copies. */
function truncateRuns(text: string, char: string, maxLen: number): string {
  const escaped = char === '`' ? '`' : '~';
  return text.replace(new RegExp(`${escapeRegex(escaped)}{${maxLen + 1},}`, 'g'), char.repeat(maxLen));
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function longestRun(text: string, char: string): number {
  let maxRun = 0;
  let current = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === char) {
      current++;
      if (current > maxRun) maxRun = current;
    } else {
      current = 0;
    }
  }
  return maxRun;
}
