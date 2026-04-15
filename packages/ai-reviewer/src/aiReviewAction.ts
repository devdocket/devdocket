import { BasePrAction, sanitizePrUrl } from './basePrAction';
import { DEFAULT_REVIEW_PROMPT } from './defaultPrompt';

// Re-export sanitizePrUrl for backward compatibility (tests import it from here)
export { sanitizePrUrl };

export class AiReviewAction extends BasePrAction {
  readonly id = 'ai-reviewer.review';
  readonly label = 'AI Code Review';

  protected readonly configSection = 'devdocketAiReview';
  protected readonly defaultPromptContent = DEFAULT_REVIEW_PROMPT;
  protected readonly progressTitle = 'AI Code Review';
  protected readonly outputHeader = '# AI Code Review\n\n';
  protected readonly confirmationMessage =
    'AI Code Review will send the PR diff to the language model for analysis. Continue?';

  protected getRuntimeInstructions(safePrUrl: string): string {
    return `

## Important Instructions

**PR URL:** ${safePrUrl} — include a link to this PR in the review header.

**File paths and line numbers:** When commenting on specific issues, always include the file path and line number(s) from the diff so the reader can locate the code immediately. Use the format \`path/to/file.ts:42\` for single lines or \`path/to/file.ts:42-50\` for ranges. If a finding spans multiple files, list each location separately.`;
  }
}
