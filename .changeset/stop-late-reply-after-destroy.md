---
'@chatcops/widget': patch
---

Stop a late reply from overwriting saved history after `destroy()`: `ChatClient.sendMessage` now accepts an optional `AbortSignal` (alongside its timeout), `destroy()` aborts the in-flight request, and a reply that finishes after the widget is destroyed no longer calls `saveHistory()`, `onMessage`, `onError`, or `emit()` — including when `ChatCops.init()` is called again.
