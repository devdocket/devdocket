import { describe, it, expect } from 'vitest';
import { MarkdownString } from 'vscode';
import { WorkItemState } from '../models/workItem';
import { buildWorkItemTooltip, getWorkItemIcon } from '../views/viewUtils';

function makeItem(overrides: Record<string, unknown> = {}) {
  return {
    id: 'item-1',
    title: 'Test item',
    state: WorkItemState.InProgress,
    createdAt: 1700000000000,
    updatedAt: 1700100000000,
    ...overrides,
  };
}

describe('buildWorkItemTooltip', () => {
  it('should include title, state, and createdAt by default', () => {
    const item = makeItem();
    const md = buildWorkItemTooltip(item as any, 'Test item');

    expect(md).toBeInstanceOf(MarkdownString);
    expect(md.value).toContain('**Title:** ');
    expect(md.value).toContain('**State:** InProgress');
    expect(md.value).toContain('**Created:**');
  });

  it('should include notes with label by default', () => {
    const item = makeItem({ notes: 'Some notes' });
    const md = buildWorkItemTooltip(item as any, 'Test item');
    expect(md.value).toContain('**Notes:** ');
  });

  it('should show notes as plain text when notesStyle is plain', () => {
    const item = makeItem({ notes: 'Some notes' });
    const md = buildWorkItemTooltip(item as any, 'Test item', { notesStyle: 'plain' });
    expect(md.value).not.toContain('**Notes:**');
    expect(md.value).toContain('Some notes');
  });

  it('should omit state when showState is false', () => {
    const item = makeItem();
    const md = buildWorkItemTooltip(item as any, 'Test item', { showState: false });
    expect(md.value).not.toContain('**State:**');
  });

  it('should use updatedAt when timestamp option is updatedAt', () => {
    const item = makeItem();
    const md = buildWorkItemTooltip(item as any, 'Test item', { timestamp: 'updatedAt' });
    expect(md.value).toContain('**Last updated:**');
  });

  it('should use custom timestampLabel', () => {
    const item = makeItem({ state: WorkItemState.Done });
    const md = buildWorkItemTooltip(item as any, 'Test item', {
      timestamp: 'updatedAt',
      timestampLabel: 'Completed at',
    });
    expect(md.value).toContain('**Completed at:**');
  });

  it('should omit notes section when item has no notes', () => {
    const item = makeItem();
    const md = buildWorkItemTooltip(item as any, 'Test item');
    expect(md.value).not.toContain('Notes');
  });
});

describe('getWorkItemIcon', () => {
  it('should return play-circle for InProgress', () => {
    const icon = getWorkItemIcon(WorkItemState.InProgress);
    expect(icon.id).toBe('play-circle');
  });

  it('should return debug-pause for Paused', () => {
    const icon = getWorkItemIcon(WorkItemState.Paused);
    expect(icon.id).toBe('debug-pause');
  });

  it('should return check for Done', () => {
    const icon = getWorkItemIcon(WorkItemState.Done);
    expect(icon.id).toBe('check');
  });

  it('should return archive for Archived', () => {
    const icon = getWorkItemIcon(WorkItemState.Archived);
    expect(icon.id).toBe('archive');
  });

  it('should return circle-filled for New', () => {
    const icon = getWorkItemIcon(WorkItemState.New);
    expect(icon.id).toBe('circle-filled');
  });
});
