---
'@chatcops/server': patch
---

Reuse the same chat handler and `AnalyticsCollector` between `chatcopsMiddleware` and `chatcopsAnalyticsHandler` (keyed by the config object) so the analytics endpoint reports real traffic instead of zeros and no duplicate providers or cleanup intervals are created.
