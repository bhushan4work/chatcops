---
"@chatcops/widget": minor
---

Two widgets on one page now keep separate conversations. Each widget gets its own host element (`chatcops-root`, then `chatcops-root-2` and so on, all with the class `chatcops-root`) and destroying one no longer removes another's host. A new `siteId` option names a widget's saved conversation. Without it, a single widget uses the same storage keys as before, and a second widget on the page gets its own automatically, also across the script tag and bundled builds.
