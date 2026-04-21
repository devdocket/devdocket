import * as vscode from 'vscode';
import * as crypto from 'crypto';
import { errorToString } from './errorUtils';

interface DiffAnchorInput {
  filePath: string;
}

/** Computes the SHA-256 hex digest of a file path for use in GitHub PR diff URL anchors. */
export function registerDiffAnchorTool(): vscode.Disposable {
  return vscode.lm.registerTool('devdocket-diffAnchor', {
    async invoke(
      options: vscode.LanguageModelToolInvocationOptions<DiffAnchorInput>,
      _token: vscode.CancellationToken,
    ) {
      const { filePath } = options.input;
      if (!filePath || typeof filePath !== 'string') {
        return new vscode.LanguageModelToolResult([
          new vscode.LanguageModelTextPart('Error computing diff anchor: filePath is required and must be a non-empty string'),
        ]);
      }

      try {
        // Normalize to forward slashes to match GitHub's path format
        const normalizedPath = filePath.replace(/\\/g, '/');
        const hash = crypto.createHash('sha256').update(normalizedPath, 'utf8').digest('hex');
        return new vscode.LanguageModelToolResult([
          new vscode.LanguageModelTextPart(hash),
        ]);
      } catch (err) {
        return new vscode.LanguageModelToolResult([
          new vscode.LanguageModelTextPart(`Error computing diff anchor: ${errorToString(err)}`),
        ]);
      }
    },
  });
}
