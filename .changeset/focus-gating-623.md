---
"@devdocket/shared": minor
"devdocket": patch
---

Add focus-aware refresh gating so background provider refreshes are skipped when the VS Code window is unfocused, reducing redundant API calls across multiple windows.
