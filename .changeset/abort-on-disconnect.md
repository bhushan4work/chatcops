---
"@chatcops/core": minor
"@chatcops/server": minor
---

Stop the provider when the visitor disconnects. `ProviderChatParams` takes a `signal`, which all three providers pass to their SDK and check between tool rounds. `handleChat(body, clientIp, { signal })` stops quietly on abort and doesn't save the partial reply. The Express adapter aborts when the response closes early; the Vercel and Cloudflare adapters abort when the response stream is cancelled, and the Cloudflare adapter no longer throws an unhandled rejection after a disconnect. The Cloudflare handler accepts the Workers `(request, env, ctx)` arguments and uses `ctx.waitUntil` so lead webhooks still finish.
