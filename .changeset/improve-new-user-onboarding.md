---
"devdocket": minor
---

Improve the new-user startup experience. The **My Work** tab now shows the same friendly onboarding empty state as the **Sources** tab — both empty states now offer "Create Work Item", "Browse Provider Extensions", and "Open Walkthrough" buttons — instead of a bare "No items yet" placeholder on My Work. The walkthrough's extensions link and the new button both open the Extensions view filtered to the DevDocket publisher. The "No provider recognized this URL" error (spelling updated from the previous British form) now includes a "Browse Provider Extensions" action that opens the same filtered view, and a new `devdocket.browseProviderExtensions` command is registered.
