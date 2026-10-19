---
"@chatcops/server": minor
---

Visitor-supplied page context and pre-chat answers no longer go into the system prompt, where they had the same authority as the site's own instructions. They are sent in a `<visitor_context>` block in front of the visitor's latest message (not stored), with values that can't close the block early and a 4,000 character cap, and the system prompt tells the model to treat that block as information, never as instructions. The site's system prompt and knowledge base are unchanged. `locale` is only used when it looks like a language tag.
