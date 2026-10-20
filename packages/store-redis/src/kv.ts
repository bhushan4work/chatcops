import type { KeyValueStore } from '@chatcops/core';
import { parseJson } from './adapter.js';
import type { RedisLike } from './types.js';

export class RedisKeyValueStore implements KeyValueStore {
  constructor(
    private readonly redis: RedisLike,
    private readonly prefix: string
  ) {}

  private key(key: string): string {
    return `${this.prefix}:kv:${key}`;
  }

  async get<T = unknown>(key: string): Promise<T | null> {
    const raw = await this.redis.get(this.key(key));
    if (raw === null || raw === undefined) return null;
    return parseJson<T>(raw);
  }

  async set(key: string, value: unknown, options?: { ttlMs?: number }): Promise<void> {
    const fullKey = this.key(key);
    const valStr = JSON.stringify(value);
    await this.redis.set(fullKey, valStr, options?.ttlMs ? { px: options.ttlMs } : undefined);
  }

  async setIfAbsent(
    key: string,
    value: unknown,
    options?: { ttlMs?: number }
  ): Promise<boolean> {
    const fullKey = this.key(key);
    const valStr = JSON.stringify(value);
    const res = await this.redis.set(fullKey, valStr, {
      nx: true,
      ...(options?.ttlMs ? { px: options.ttlMs } : {}),
    });
    return res === 'OK' || res === true;
  }

  async delete(key: string): Promise<void> {
    await this.redis.del(this.key(key));
  }
}
