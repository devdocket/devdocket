import * as vscode from 'vscode';

/** Maximum characters per tool-result text part in the conversation.
 *  Prevents any single tool result from overflowing the model's context window. */
export const MAX_TOOL_RESULT_LENGTH = 80_000;

/** Truncate oversized text parts in tool result content to stay within
 *  the model's context budget. Non-text parts are passed through. */
export function truncateToolContent(
  content: (vscode.LanguageModelTextPart | vscode.LanguageModelToolResultPart)[],
): (vscode.LanguageModelTextPart | vscode.LanguageModelToolResultPart)[] {
  return content.map((part) => {
    if (part instanceof vscode.LanguageModelTextPart && part.value.length > MAX_TOOL_RESULT_LENGTH) {
      const truncationNotice =
        `\n\n(truncated from ${part.value.length.toLocaleString()} chars — content exceeded context budget)`;
      const sliceLength = Math.max(0, MAX_TOOL_RESULT_LENGTH - truncationNotice.length);
      return new vscode.LanguageModelTextPart(
        part.value.slice(0, sliceLength) + truncationNotice,
      );
    }
    return part;
  });
}
