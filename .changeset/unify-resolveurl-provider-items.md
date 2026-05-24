---
"@devdocket/shared": minor
"devdocket": patch
"devdocket-github": minor
"devdocket-ado": patch
---

Unify provider URL resolution with ProviderItem so imported items keep provider capabilities and metadata, and enable Start Git Work for GitHub URL-imported issues and pull requests. Providers can now return provider-facing resolve results without supplying providerId because the registry stamps it.
