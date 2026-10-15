---
'@chatcops/server': patch
---

Return immediately from the tool executor when capturing leads without awaiting webhook delivery. Pending deliveries are tracked and awaited with `Promise.allSettled` before the final `done` response to prevent dropped webhooks on serverless hosts, and webhook `fetch` calls use `AbortSignal.timeout` to prevent hanging indefinitely.
