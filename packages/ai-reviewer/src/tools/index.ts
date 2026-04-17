import * as vscode from 'vscode';
import { registerReadFileTool } from './readFileTool';
import { registerListDirectoryTool } from './listDirectoryTool';
import { registerGetDiffTool } from './getDiffTool';
import { registerGetFileDiffTool } from './getFileDiffTool';
import { registerGitLogTool } from './gitLogTool';
import { registerSearchCodeTool } from './searchCodeTool';
import { registerDiffAnchorTool } from './diffAnchorTool';

export function registerAllTools(): vscode.Disposable[] {
  return [
    registerReadFileTool(),
    registerListDirectoryTool(),
    registerGetDiffTool(),
    registerGetFileDiffTool(),
    registerGitLogTool(),
    registerSearchCodeTool(),
    registerDiffAnchorTool(),
  ];
}
