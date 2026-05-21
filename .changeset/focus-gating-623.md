---
"@devdocket/shared": minor
"devdocket": patch
---

Throttle background provider refreshes when the VS Code window is unfocused so background windows still poll for new notifications while reducing redundant API calls across multiple windows.
