---
"@chatcops/widget": patch
---

Fix browser global IIFE export to allow `window.ChatCops.init()` directly without `.default`, and capture `document.currentScript` before deferring auto-init on DOMContentLoaded.
