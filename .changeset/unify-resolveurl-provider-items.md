---
"@devdocket/shared": minor
"devdocket": patch
"devdocket-github": minor
"devdocket-ado": patch
---

Unify provider URL resolution with ProviderItem so imported items keep provider capabilities and metadata, and enable Start Git Work for GitHub URL-imported issues and pull requests. Provider resolveUrl implementations should now return provider-facing results without providerId because the registry stamps it.
