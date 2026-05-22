---
"devdocket": patch
---

Wait for the sidebar webview to signal it is ready before posting initial data, with a fallback timeout so first-open content still appears if the ready message never arrives.
