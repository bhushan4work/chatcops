import type { CounterStore, CounterValue } from '@chatcops/core';
import type { RedisLike } from './types.js';

const INCREMENT_SCRIPT = `
local now = tonumber(ARGV[1])
local by = tonumber(ARGV[2])
local ttl = tonumber(ARGV[3])

local current = redis.call('HMGET', KEYS[1], 'value', 'expiresAt')
local val = current[1]
local exp = current[2]

if val and exp and tonumber(exp) <= now then
  redis.call('DEL', KEYS[1])
  val = nil
  exp = nil
end

if not val then
  local newVal = by
  local expiresAt = now + ttl
  redis.call('HSET', KEYS[1], 'value', newVal, 'expiresAt', expiresAt)
  redis.call('PEXPIRE', KEYS[1], ttl)
  return { newVal, expiresAt }
else
  local newVal = tonumber(val) + by
  local expiresAt = tonumber(exp)
  redis.call('HSET', KEYS[1], 'value', newVal)
  return { newVal, expiresAt }
end
`;

const GET_SCRIPT = `
local now = tonumber(ARGV[1])
local current = redis.call('HMGET', KEYS[1], 'value', 'expiresAt')
local val = current[1]
local exp = current[2]

if not val or not exp then
  return nil
end

if tonumber(exp) <= now then
  redis.call('DEL', KEYS[1])
  return nil
end

return { tonumber(val), tonumber(exp) }
`;

export class RedisCounterStore implements CounterStore {
  constructor(
    private readonly redis: RedisLike,
    private readonly prefix: string
  ) {}

  private key(key: string): string {
    return `${this.prefix}:counter:${key}`;
  }

  async increment(key: string, by: number, ttlMs: number): Promise<CounterValue> {
    const now = Date.now();
    const res = await this.redis.eval<[number, number, number], [number, number]>(
      INCREMENT_SCRIPT,
      [this.key(key)],
      [now, by, ttlMs]
    );

    return {
      value: Number(res[0]),
      expiresAt: Number(res[1]),
    };
  }

  async get(key: string): Promise<CounterValue | null> {
    const now = Date.now();
    const res = await this.redis.eval<[number], [number, number] | null>(
      GET_SCRIPT,
      [this.key(key)],
      [now]
    );

    if (!res) return null;

    return {
      value: Number(res[0]),
      expiresAt: Number(res[1]),
    };
  }
}
