---
"@devdocket/shared": minor
"devdocket": minor
---

Expose `DevDocketApi.contractVersion` and a `CONTRACT_VERSION` constant on `@devdocket/shared` so provider and action extensions can perform runtime compatibility checks. Providers and actions may declare an optional `minContractVersion`; when the core extension's contract version is lower, registration is skipped with a warning (and a no-op disposable is returned) instead of throwing, allowing host extensions to degrade gracefully against older DevDocket cores.
