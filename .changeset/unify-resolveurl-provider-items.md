---
"@devdocket/shared": major
"devdocket": patch
"devdocket-github": minor
"devdocket-ado": patch
"devdocket-start-git-work": patch
---

Unify provider URL resolution with ProviderItem so imported items keep provider capabilities and metadata, enable Start Git Work for GitHub URL-imported issues and pull requests, and replace `ResolvedItem` / `ProviderResolvedItem` with `ResolvedUrlResult` for the registry-level pairing of `providerId` plus resolved item. Provider `resolveUrl` implementations now return `ProviderItem` directly, while `ProviderRegistry.resolveUrl` returns `ResolvedUrlResult`.

Migration notes: remove `ResolvedItem` and `ProviderResolvedItem` imports, update provider `resolveUrl` implementations to return `Promise<ProviderItem | undefined>`, and if you consume registry-level URL resolution use the new exported `ResolvedUrlResult` shape: `{ providerId, item }`. Ensure your resolved `ProviderItem` still sets `url` so imported work items link back to the source. Notes seeding for URL-created work items now comes from `item.description` in the core URL-import flow instead of a dedicated type field, so providers can no longer return a distinct notes seed separate from `description`.
