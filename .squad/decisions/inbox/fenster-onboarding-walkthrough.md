# Decision: Onboarding Walkthrough Implementation

**Issue:** #225  
**Author:** Fenster (Extension Dev)  
**Status:** Implemented  
**Date:** 2026-04-23

## Context

Implemented VS Code walkthrough for new user onboarding to guide users through creating their first work item, understanding the Inbox → Queue → Focus → History workflow, connecting providers, and managing active work.

## Key Decisions

### 1. VS Code Native Walkthrough API
**Decision:** Use `contributes.walkthroughs` in package.json rather than a custom modal or webview.  
**Why:** VS Code's native walkthrough API provides a consistent UX familiar to users from other extensions. Appears in the Get Started tab automatically. No custom UI code needed.

### 2. Four-Step Onboarding Flow
**Decision:** Four steps — Create First Item, Understand Workflow, Connect Provider, Focus on Work.  
**Why:** Mirrors the natural user journey. Start with immediate action (create item), then explain concepts, then expand with providers, then close the loop with completion workflow.

### 3. Markdown Media Files
**Decision:** Each step uses a markdown file in `media/walkthroughs/` directory with command links.  
**Why:** Markdown allows rich formatting, code blocks, headers, and interactive command links (e.g., `[Create Work Item](command:devdocket.createItem)`). Easier to maintain than inline JSON strings.

### 4. Command Links for Interactivity
**Decision:** Embed command links in both step descriptions and markdown media.  
**Why:** Users can click directly to perform actions (create item, open extensions view, etc.) without searching for commands. Makes onboarding interactive rather than passive reading.

### 5. Media Organization
**Decision:** Created dedicated `packages/core/media/walkthroughs/` directory.  
**Why:** Keeps walkthrough content separate from other media assets. Future walkthroughs can add more files here. Mirrors pattern used by other VS Code extensions.

## Files Changed

- `packages/core/package.json` — Added `walkthroughs` contribution
- `packages/core/media/walkthroughs/create-item.md` — Step 1 content
- `packages/core/media/walkthroughs/workflow.md` — Step 2 content
- `packages/core/media/walkthroughs/providers.md` — Step 3 content
- `packages/core/media/walkthroughs/focus.md` — Step 4 content

## Future Considerations

- Add screenshots or animated GIFs to media files for visual learners
- Consider per-provider walkthroughs for GitHub/ADO setup
- Track walkthrough completion via telemetry (if added in the future)
