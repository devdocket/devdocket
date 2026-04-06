## Summary

Add comprehensive tests for QueueTreeProvider covering:

- **getChildren**: empty queue, single item, sort order, items without sortOrder, state filtering
- **getTreeItem**: label, collapsibleState, description, contextValue, iconPath, tooltip content
- **handleDrag**: multiple items, MIME type correctness
- **handleDrop**: reorder to front/middle/end, single-item queue, invalid transfer values (non-array, non-string)
- **events**: onDidChangeTreeData fires on graph changes and refresh()
- **drag/drop mime types**: correct MIME type exposure
- **dispose**: cleanup and event forwarding stops

Also refactors existing handleDrop tests to use provider.getChildren() instead of duplicating sort logic.
