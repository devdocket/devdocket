import * as vscode from 'vscode';
import { WorkItem, WorkItemState } from '../models/workItem';

export interface WorkItemTooltipOptions {
  /** Whether to show the State line. Default: true */
  showState?: boolean;
  /** Which timestamp field to display. Default: 'createdAt' */
  timestamp?: 'createdAt' | 'updatedAt';
  /** Label for the timestamp line. Default: 'Created' for createdAt, 'Last updated' for updatedAt. */
  timestampLabel?: string;
  /** How to display notes: 'labeled' prefixes "**Notes:**", 'plain' shows raw text. Default: 'labeled' */
  notesStyle?: 'labeled' | 'plain';
}

/**
 * Build a MarkdownString tooltip for a WorkItem tree node.
 * Unifies the tooltip patterns across Focus, Queue, and History views.
 */
export function buildWorkItemTooltip(
  item: WorkItem,
  title: string,
  options?: WorkItemTooltipOptions,
): vscode.MarkdownString {
  const {
    showState = true,
    timestamp = 'createdAt',
    timestampLabel,
    notesStyle = 'labeled',
  } = options ?? {};

  const md = new vscode.MarkdownString();
  md.appendMarkdown(`**Title:** `);
  md.appendText(title);
  md.appendMarkdown(`\n\n`);

  if (item.notes) {
    if (notesStyle === 'labeled') {
      md.appendMarkdown(`**Notes:** `);
    }
    md.appendText(item.notes);
    md.appendMarkdown(`\n\n`);
  }

  if (showState) {
    md.appendMarkdown(`**State:** ${item.state}\n\n`);
  }

  const label = timestampLabel ?? (timestamp === 'createdAt' ? 'Created' : 'Last updated');
  md.appendMarkdown(`**`);
  md.appendText(label);
  md.appendMarkdown(`:** `);
  md.appendText(new Date(item[timestamp]).toLocaleString());

  return md;
}

/**
 * Resolve a WorkItemState to its corresponding ThemeIcon.
 * Covers all states used across Focus, History, and Queue views.
 */
export function getWorkItemIcon(state: WorkItemState): vscode.ThemeIcon {
  switch (state) {
    case WorkItemState.InProgress:
      return new vscode.ThemeIcon('play-circle');
    case WorkItemState.Paused:
      return new vscode.ThemeIcon('debug-pause');
    case WorkItemState.Done:
      return new vscode.ThemeIcon('check');
    case WorkItemState.Archived:
      return new vscode.ThemeIcon('archive');
    case WorkItemState.New:
      return new vscode.ThemeIcon('circle-filled');
    default:
      return new vscode.ThemeIcon('circle-outline');
  }
}

/**
 * Check if a URL is a recognized PR URL (GitHub or Azure DevOps).
 * Used to distinguish PR URLs from arbitrary URLs for contextValue flags.
 */
export function isPrUrl(url: string): boolean {
  try {
    const u = new URL(url);
    // GitHub PR
    if (u.hostname === 'github.com' && /^\/[^/]+\/[^/]+\/pull\/\d+/.test(u.pathname)) {
      return true;
    }
    // ADO PR
    if (u.hostname.endsWith('dev.azure.com') && u.pathname.includes('/pullrequest/')) {
      return true;
    }
    if (u.hostname.endsWith('.visualstudio.com') && u.pathname.includes('/pullrequest/')) {
      return true;
    }
    return false;
  } catch {
    return false;
  }
}
