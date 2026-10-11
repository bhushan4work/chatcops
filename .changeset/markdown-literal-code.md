---
'@chatcops/widget': patch
---

Keep code literal in markdown rendering by stashing fenced code blocks and inline code as placeholders before any other transformation, so `*`, `**`, `[text](url)`, `- `, and `1. ` inside code no longer produce formatting, links, or lists, and newlines inside `<pre><code>` are preserved instead of becoming `<br>`.
