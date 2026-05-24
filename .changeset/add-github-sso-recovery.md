---
"@devdocket/shared": minor
"devdocket-github": minor
"devdocket": patch
---

Add a shared recoverable-error contract so providers can supply recovery actions without teaching the core extension about provider-specific failures, and use it for GitHub SSO authorization prompts and deduplicated background refresh notifications.
