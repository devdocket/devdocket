---
"devdocket": patch
---

Debounce watch persistence writes and skip saves when only poll timestamps change, reducing repeated full-envelope rewrites during CI polling.
