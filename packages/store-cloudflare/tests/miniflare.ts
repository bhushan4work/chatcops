import { Miniflare } from 'miniflare';
import type { ChatCopsCounter, D1Database, DurableObjectNamespace, KVNamespace } from '../src/index.js';

let mf: Miniflare | undefined;
let d1Instance: D1Database | undefined;
let kvInstance: KVNamespace | undefined;
let countersInstance: DurableObjectNamespace<ChatCopsCounter> | undefined;

export async function getMiniflareBindings() {
  if (!mf) {
    mf = new Miniflare({
      workers: [
        {
          config: {
            name: 'test-worker',
            compatibilityDate: '2026-10-01',
            manifest: {
              mainModule: 'index.js',
              modules: {
                'index.js': {
                  type: 'esm',
                  contents: `
                    import { DurableObject } from 'cloudflare:workers';
                    export class ChatCopsCounter extends DurableObject {
                      async increment(byOrKey, ttlMsOrBy, maybeTtlMs) {
                        const key = typeof byOrKey === 'string' ? byOrKey : 'counter';
                        const by = typeof byOrKey === 'string' ? ttlMsOrBy : byOrKey;
                        const ttlMs = typeof byOrKey === 'string' ? (maybeTtlMs ?? 60000) : ttlMsOrBy;
                        const now = Date.now();
                        const current = await this.ctx.storage.get(key);
                        let next;
                        if (!current || current.expiresAt <= now) {
                          next = { value: by, expiresAt: now + ttlMs };
                        } else {
                          next = { value: current.value + by, expiresAt: current.expiresAt };
                        }
                        await this.ctx.storage.put(key, next);
                        return next;
                      }
                      async get(key) {
                        const storageKey = key ?? 'counter';
                        const current = await this.ctx.storage.get(storageKey);
                        if (!current || current.expiresAt <= Date.now()) return null;
                        return current;
                      }
                    }
                    export default {
                      fetch() { return new Response('ok'); }
                    };
                  `,
                },
              },
            },
            exports: {
              ChatCopsCounter: {
                type: 'durable-object',
                storage: 'sqlite',
              },
            },
            env: {
              DB: { type: 'd1' },
              KV: { type: 'kv' },
              COUNTERS: {
                type: 'durable-object',
                worker: 'test-worker',
                exportName: 'ChatCopsCounter',
              },
            },
          },
        },
      ],
    });
    await mf.ready;
    d1Instance = (await mf.getD1Database('DB')) as unknown as D1Database;
    kvInstance = (await mf.getKVNamespace('KV')) as unknown as KVNamespace;
    countersInstance = (await mf.getDurableObjectNamespace('COUNTERS')) as unknown as DurableObjectNamespace<ChatCopsCounter>;
  }
  return { mf, d1: d1Instance!, kv: kvInstance!, counters: countersInstance! };
}

export async function disposeMiniflare() {
  await mf?.dispose();
  mf = undefined;
}
