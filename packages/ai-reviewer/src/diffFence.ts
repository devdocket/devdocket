/**
 * Build a fenced code block whose delimiter is strictly longer than any
 * matching-character run inside `content`, preventing prompt-injection escapes.
 *
 * Picks whichever fence character (backtick or tilde) yields the shorter
 * delimiter to avoid prompt bloat from adversarial inputs.
 * The minimum fence length is 4 (matching the previous hard-coded delimiter).
 */
export function fenceDiff(content: string): string {
  const MIN_FENCE = 4;

  const maxBacktickRun = longestRun(content, '`');
  const maxTildeRun = longestRun(content, '~');

  // Pick whichever character needs a shorter fence
  const [char, maxRun] = maxBacktickRun <= maxTildeRun ? ['`', maxBacktickRun] : ['~', maxTildeRun];

  const fenceLength = Math.max(MIN_FENCE, maxRun + 1);
  const fence = char.repeat(fenceLength);
  return `${fence}diff\n${content}\n${fence}`;
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
