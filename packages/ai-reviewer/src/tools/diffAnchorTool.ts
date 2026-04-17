import * as vscode from 'vscode';
import * as crypto from 'crypto';

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
          new vscode.LanguageModelTextPart('Error: filePath is required and must be a non-empty string'),
        ]);
      }

      const hash = crypto.createHash('sha256').update(filePath, 'utf8').digest('hex');
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(hash),
      ]);
    },
  });
}
