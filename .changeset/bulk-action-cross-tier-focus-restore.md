---
"devdocket": patch
---

After a bulk action moves items between tiers, restore keyboard focus to the actioned item in its new tier (with sensible fallbacks: the destination tier header if the item is hidden, the origin tier header if the item is gone entirely, then the My Work tab). Keyboard and screen-reader users no longer get dropped onto `document.body` after Accept / Dismiss / Pause / Resume / Complete bulk actions.
