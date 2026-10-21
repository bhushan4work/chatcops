import {
  type AppendOptions,
  type ChatMessage,
  ConflictError,
  type Conversation,
  type ConversationStore,
  type ConversationSummary,
  type ListQuery,
} from '@chatcops/core';
import { decodeEvalResult, formatSlotPrefix } from './adapter.js';
import type { RedisLike } from './types.js';

const GET_SCRIPT = `
local meta = redis.call('HGETALL', KEYS[1])
if #meta == 0 then
  return nil
end
local messages = redis.call('LRANGE', KEYS[2], 0, -1)
return cjson.encode({ meta = meta, messages = messages })
`;

const SAVE_SCRIPT = `
local now = tonumber(ARGV[3])
local ttl = tonumber(ARGV[4])

if ttl > 0 then
  redis.call('ZREMRANGEBYSCORE', KEYS[3], '-inf', '(' .. (now - ttl))
end

local currentVersion = redis.call('HGET', KEYS[1], 'version')
local newVersion = 1
if currentVersion then
  newVersion = tonumber(currentVersion) + 1
end

local createdAt = tonumber(ARGV[2])
if not createdAt or createdAt == 0 then
  local currentCreatedAt = redis.call('HGET', KEYS[1], 'createdAt')
  if currentCreatedAt then
    createdAt = tonumber(currentCreatedAt)
  else
    createdAt = now
  end
end

local updatedAt = now

redis.call('DEL', KEYS[1], KEYS[2])

redis.call('HSET', KEYS[1], 'id', ARGV[1], 'version', newVersion, 'createdAt', createdAt, 'updatedAt', updatedAt)

local numMeta = tonumber(ARGV[5])
local metaOffset = 5
for i = 1, numMeta do
  local k = ARGV[metaOffset + (i - 1) * 2 + 1]
  local v = ARGV[metaOffset + (i - 1) * 2 + 2]
  redis.call('HSET', KEYS[1], 'meta:' .. k, v)
end

local msgStart = metaOffset + numMeta * 2 + 1
for i = msgStart, #ARGV do
  redis.call('RPUSH', KEYS[2], ARGV[i])
end

if ttl <= 0 then
  redis.call('DEL', KEYS[1], KEYS[2])
  redis.call('ZREM', KEYS[3], ARGV[1])
else
  redis.call('PEXPIRE', KEYS[1], ttl)
  redis.call('PEXPIRE', KEYS[2], ttl)
  redis.call('ZADD', KEYS[3], updatedAt, ARGV[1])
end

return newVersion
`;

const APPEND_SCRIPT = `
local now = tonumber(ARGV[3])
local ttl = tonumber(ARGV[4])

if ttl > 0 then
  redis.call('ZREMRANGEBYSCORE', KEYS[3], '-inf', '(' .. (now - ttl))
end

local rawVersion = redis.call('HGET', KEYS[1], 'version')
local currentVersion = 0
if rawVersion then
  currentVersion = tonumber(rawVersion)
end

local expectedVersionStr = ARGV[2]
if expectedVersionStr ~= '' then
  local expectedVersion = tonumber(expectedVersionStr)
  if expectedVersion ~= currentVersion then
    return cjson.encode({ 'CONFLICT', tostring(currentVersion) })
  end
end

local newVersion = currentVersion + 1

local createdAt = now
local rawCreatedAt = redis.call('HGET', KEYS[1], 'createdAt')
if rawCreatedAt then
  createdAt = tonumber(rawCreatedAt)
end

redis.call('HSET', KEYS[1], 'id', ARGV[1], 'version', newVersion, 'createdAt', createdAt, 'updatedAt', now)

-- Shallow merge metadata fields directly into Redis hash fields without Lua cjson
local numMeta = tonumber(ARGV[5])
local metaOffset = 5
for i = 1, numMeta do
  local k = ARGV[metaOffset + (i - 1) * 2 + 1]
  local v = ARGV[metaOffset + (i - 1) * 2 + 2]
  redis.call('HSET', KEYS[1], 'meta:' .. k, v)
end

local msgStart = metaOffset + numMeta * 2 + 1
for i = msgStart, #ARGV do
  redis.call('RPUSH', KEYS[2], ARGV[i])
end

if ttl <= 0 then
  redis.call('DEL', KEYS[1], KEYS[2])
  redis.call('ZREM', KEYS[3], ARGV[1])
else
  redis.call('PEXPIRE', KEYS[1], ttl)
  redis.call('PEXPIRE', KEYS[2], ttl)
  redis.call('ZADD', KEYS[3], now, ARGV[1])
end

return cjson.encode({ 'OK', tostring(newVersion) })
`;

const UPDATE_MESSAGE_SCRIPT = `
local now = tonumber(ARGV[4])
local ttl = tonumber(ARGV[5])

if ttl > 0 then
  redis.call('ZREMRANGEBYSCORE', KEYS[3], '-inf', '(' .. (now - ttl))
end

local rawVersion = redis.call('HGET', KEYS[1], 'version')
if not rawVersion then
  return 0
end

local msgs = redis.call('LRANGE', KEYS[2], 0, -1)
local targetId = ARGV[2]
local foundIndex = -1

for i, rawMsg in ipairs(msgs) do
  local decoded = cjson.decode(rawMsg)
  if decoded['id'] == targetId then
    foundIndex = i - 1
    break
  end
end

if foundIndex == -1 then
  return 0
end

redis.call('LSET', KEYS[2], foundIndex, ARGV[3])

local newVersion = tonumber(rawVersion) + 1

redis.call('HSET', KEYS[1], 'version', newVersion, 'updatedAt', now)
if ttl <= 0 then
  redis.call('DEL', KEYS[1], KEYS[2])
  redis.call('ZREM', KEYS[3], ARGV[1])
else
  redis.call('PEXPIRE', KEYS[1], ttl)
  redis.call('PEXPIRE', KEYS[2], ttl)
  redis.call('ZADD', KEYS[3], now, ARGV[1])
end

return 1
`;

const REMOVE_MESSAGE_SCRIPT = `
local now = tonumber(ARGV[3])
local ttl = tonumber(ARGV[4])

if ttl > 0 then
  redis.call('ZREMRANGEBYSCORE', KEYS[3], '-inf', '(' .. (now - ttl))
end

local rawVersion = redis.call('HGET', KEYS[1], 'version')
if not rawVersion then
  return 0
end

local msgs = redis.call('LRANGE', KEYS[2], 0, -1)
local targetId = ARGV[2]
local found = false
local remaining = {}

for _, rawMsg in ipairs(msgs) do
  local decoded = cjson.decode(rawMsg)
  if decoded['id'] == targetId then
    found = true
  else
    table.insert(remaining, rawMsg)
  end
end

if not found then
  return 0
end

redis.call('DEL', KEYS[2])
for _, m in ipairs(remaining) do
  redis.call('RPUSH', KEYS[2], m)
end

local newVersion = tonumber(rawVersion) + 1

redis.call('HSET', KEYS[1], 'version', newVersion, 'updatedAt', now)
if ttl <= 0 then
  redis.call('DEL', KEYS[1], KEYS[2])
  redis.call('ZREM', KEYS[3], ARGV[1])
else
  redis.call('PEXPIRE', KEYS[1], ttl)
  redis.call('PEXPIRE', KEYS[2], ttl)
  redis.call('ZADD', KEYS[3], now, ARGV[1])
end

return 1
`;

const DELETE_SCRIPT = `
redis.call('DEL', KEYS[1], KEYS[2])
redis.call('ZREM', KEYS[3], ARGV[1])
return 1
`;

const PURGE_IDS_SCRIPT = `
local ids = redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', '(' .. ARGV[1])
if #ids == 0 then
  return '[]'
end
return cjson.encode(ids)
`;

const PURGE_EXEC_SCRIPT = `
local zsetKey = KEYS[1]
local numIds = tonumber(ARGV[1])

for i = 2, #KEYS do
  redis.call('DEL', KEYS[i])
end

for i = 2, numIds + 1 do
  redis.call('ZREM', zsetKey, ARGV[i])
end

return numIds
`;

const LIST_IDS_SCRIPT = `
local maxScore = ARGV[1]
local minScore = ARGV[2]
local offset = tonumber(ARGV[3])
local count = tonumber(ARGV[4])

local ids = redis.call('ZREVRANGEBYSCORE', KEYS[1], maxScore, minScore, 'LIMIT', offset, count)
if #ids == 0 then
  return '[]'
end
return cjson.encode(ids)
`;

const LIST_ITEMS_SCRIPT = `
local zsetKey = KEYS[1]
local numItems = tonumber(ARGV[1])
local results = {}

for i = 1, numItems do
  local metaKey = KEYS[1 + i]
  local msgsKey = KEYS[1 + numItems + i]
  local id = ARGV[1 + i]

  local meta = redis.call('HGETALL', metaKey)
  if #meta > 0 then
    local count = redis.call('LLEN', msgsKey)
    table.insert(results, { id, meta, count })
  else
    redis.call('ZREM', zsetKey, id)
    table.insert(results, { id, nil, 0 })
  end
end

if #results == 0 then
  return '[]'
end
return cjson.encode(results)
`;

export class RedisConversationStore implements ConversationStore {
  private readonly zsetKey: string;
  private readonly slotPrefix: string;
  private readonly ttlMs: number;

  constructor(
    private readonly redis: RedisLike,
    prefix: string,
    ttlMs: number
  ) {
    this.slotPrefix = formatSlotPrefix(prefix);
    this.zsetKey = `${this.slotPrefix}:conversations`;
    this.ttlMs = Math.ceil(ttlMs);
  }

  private metaKey(id: string): string {
    return `${this.slotPrefix}:conv:${id}:meta`;
  }

  private messagesKey(id: string): string {
    return `${this.slotPrefix}:conv:${id}:messages`;
  }

  private serializeMetadata(metadata?: Record<string, unknown>): string[] {
    if (!metadata) return [];
    const entries: string[] = [];
    for (const [k, v] of Object.entries(metadata)) {
      if (v !== undefined) {
        entries.push(k, JSON.stringify(v));
      }
    }
    return entries;
  }

  async get(id: string): Promise<Conversation | null> {
    const raw = await this.redis.eval<[], unknown>(
      GET_SCRIPT,
      [this.metaKey(id), this.messagesKey(id)],
      []
    );

    if (!raw) return null;
    const res = decodeEvalResult<{ meta: unknown[]; messages: unknown[] } | null>(raw);
    if (!res?.meta || res.meta.length === 0) return null;

    const metaMap: Record<string, unknown> = {};
    const metadata: Record<string, unknown> = {};
    let hasMetadata = false;

    for (let i = 0; i < res.meta.length; i += 2) {
      const k = String(res.meta[i]);
      const v = res.meta[i + 1];
      if (k.startsWith('meta:')) {
        const field = k.slice(5);
        try {
          metadata[field] = typeof v === 'string' ? JSON.parse(v) : v;
        } catch {
          metadata[field] = v;
        }
        hasMetadata = true;
      } else if (k === 'metadata' && !hasMetadata) {
        // Backwards compatibility with legacy store format
        try {
          const parsed = typeof v === 'string' ? JSON.parse(v) : v;
          if (parsed && typeof parsed === 'object') {
            Object.assign(metadata, parsed);
            hasMetadata = true;
          }
        } catch {}
      } else {
        metaMap[k] = v;
      }
    }

    const messages = (res.messages ?? []).map((m) =>
      typeof m === 'string' ? JSON.parse(m) : m
    ) as ChatMessage[];

    return {
      id, // Preserve requested id directly
      messages,
      version: Number(metaMap.version ?? 0),
      createdAt: Number(metaMap.createdAt ?? 0),
      updatedAt: Number(metaMap.updatedAt ?? 0),
      ...(hasMetadata ? { metadata } : {}),
    };
  }

  async save(conversation: Conversation): Promise<void> {
    const id = conversation.id;
    const now = Date.now();
    const createdAt = conversation.createdAt ?? 0;
    const metaPairs = this.serializeMetadata(conversation.metadata);
    const numMeta = metaPairs.length / 2;
    const messagesJson = (conversation.messages ?? []).map((m) => JSON.stringify(m));

    await this.redis.eval(
      SAVE_SCRIPT,
      [this.metaKey(id), this.messagesKey(id), this.zsetKey],
      [id, createdAt, now, this.ttlMs, numMeta, ...metaPairs, ...messagesJson]
    );
  }

  async append(
    id: string,
    messages: ChatMessage[],
    options: AppendOptions = {}
  ): Promise<{ version: number }> {
    const expectedVersionStr =
      options.expectedVersion !== undefined ? String(options.expectedVersion) : '';
    const now = Date.now();
    const metaPairs = this.serializeMetadata(options.metadata);
    const numMeta = metaPairs.length / 2;
    const messagesJson = messages.map((m) => JSON.stringify(m));

    const raw = await this.redis.eval<
      (string | number)[],
      unknown
    >(
      APPEND_SCRIPT,
      [this.metaKey(id), this.messagesKey(id), this.zsetKey],
      [id, expectedVersionStr, now, this.ttlMs, numMeta, ...metaPairs, ...messagesJson]
    );

    const res = decodeEvalResult<[string, string]>(raw);

    if (res[0] === 'CONFLICT') {
      const actualVersion = Number(res[1]);
      throw new ConflictError(id, options.expectedVersion ?? 0, actualVersion);
    }

    return { version: Number(res[1]) };
  }

  async updateMessage(id: string, message: ChatMessage): Promise<boolean> {
    const now = Date.now();
    const messageJson = JSON.stringify(message);

    const res = await this.redis.eval<(string | number)[], number>(
      UPDATE_MESSAGE_SCRIPT,
      [this.metaKey(id), this.messagesKey(id), this.zsetKey],
      [id, message.id, messageJson, now, this.ttlMs]
    );

    return Number(res) === 1;
  }

  async removeMessage(id: string, messageId: string): Promise<boolean> {
    const now = Date.now();

    const res = await this.redis.eval<(string | number)[], number>(
      REMOVE_MESSAGE_SCRIPT,
      [this.metaKey(id), this.messagesKey(id), this.zsetKey],
      [id, messageId, now, this.ttlMs]
    );

    return Number(res) === 1;
  }

  async delete(id: string): Promise<void> {
    await this.redis.eval(
      DELETE_SCRIPT,
      [this.metaKey(id), this.messagesKey(id), this.zsetKey],
      [id]
    );
  }

  async list(query: ListQuery): Promise<{ items: ConversationSummary[]; cursor?: string }> {
    const minScore =
      query.updatedAfter !== undefined ? `(${query.updatedAfter}` : '-inf';

    let cursorScore: number | undefined;
    let cursorId: string | undefined;

    if (query.cursor) {
      const colonIdx = query.cursor.indexOf(':');
      if (colonIdx !== -1) {
        const s = Number(query.cursor.slice(0, colonIdx));
        if (!Number.isNaN(s)) {
          cursorScore = s;
          cursorId = query.cursor.slice(colonIdx + 1);
        }
      }
      if (cursorScore === undefined || cursorId === undefined) {
        // Unknown or invalid cursor returns empty items
        return { items: [] };
      }
    }

    // Cursor-based pagination using ZREVRANGEBYSCORE ... LIMIT
    // If no cursor: maxScore is +inf, offset is 0, limit is query.limit + 1
    // If cursor: maxScore is cursorScore, scan a bounded window (limit + 50) to advance past cursorId
    const maxScore = cursorScore !== undefined ? String(cursorScore) : '+inf';
    const fetchCount = cursorId !== undefined ? query.limit + 50 : query.limit + 1;

    const rawIds = await this.redis.eval<(string | number)[], unknown>(
      LIST_IDS_SCRIPT,
      [this.zsetKey],
      [maxScore, minScore, 0, fetchCount]
    );

    const ids = decodeEvalResult<string[]>(rawIds);
    if (!Array.isArray(ids) || ids.length === 0) {
      return { items: [] };
    }

    let candidateIds = ids;
    if (cursorId !== undefined) {
      const idx = ids.indexOf(cursorId);
      if (idx === -1) {
        return { items: [] };
      }
      candidateIds = ids.slice(idx + 1);
    }

    const pageIds = candidateIds.slice(0, query.limit);
    const hasMore = candidateIds.length > query.limit;

    if (pageIds.length === 0) {
      return { items: [] };
    }

    // Step 2: Fetch metadata and message counts with cluster-safe key passing
    const metaKeys = pageIds.map((id) => this.metaKey(id));
    const msgsKeys = pageIds.map((id) => this.messagesKey(id));
    const keys = [this.zsetKey, ...metaKeys, ...msgsKeys];
    const scriptArgs: (string | number)[] = [pageIds.length, ...pageIds];

    const rawResults = await this.redis.eval<(string | number)[], unknown>(
      LIST_ITEMS_SCRIPT,
      keys,
      scriptArgs
    );

    const results = decodeEvalResult<[string, unknown[] | null, number][]>(rawResults);
    const items: ConversationSummary[] = [];

    if (results) {
      for (const [id, rawMeta, messageCount] of results) {
        if (!rawMeta || rawMeta.length === 0) continue;

        const metaMap: Record<string, unknown> = {};
        const metadata: Record<string, unknown> = {};
        let hasMetadata = false;

        for (let i = 0; i < rawMeta.length; i += 2) {
          const k = String(rawMeta[i]);
          const v = rawMeta[i + 1];
          if (k.startsWith('meta:')) {
            const field = k.slice(5);
            try {
              metadata[field] = typeof v === 'string' ? JSON.parse(v) : v;
            } catch {
              metadata[field] = v;
            }
            hasMetadata = true;
          } else if (k === 'metadata' && !hasMetadata) {
            try {
              const parsed = typeof v === 'string' ? JSON.parse(v) : v;
              if (parsed && typeof parsed === 'object') {
                Object.assign(metadata, parsed);
                hasMetadata = true;
              }
            } catch {}
          } else {
            metaMap[k] = v;
          }
        }

        items.push({
          id: String(id),
          createdAt: Number(metaMap.createdAt ?? 0),
          updatedAt: Number(metaMap.updatedAt ?? 0),
          messageCount: Number(messageCount),
          ...(hasMetadata ? { metadata } : {}),
        });
      }
    }

    if (hasMore && items.length > 0) {
      const last = items[items.length - 1];
      const nextCursor = `${last.updatedAt}:${last.id}`;
      return { items, cursor: nextCursor };
    }

    return { items };
  }

  async purge(before: number): Promise<number> {
    // Step 1: Query which conversation IDs were updated before cutoff
    const rawIds = await this.redis.eval<(string | number)[], unknown>(
      PURGE_IDS_SCRIPT,
      [this.zsetKey],
      [before]
    );

    const ids = decodeEvalResult<string[]>(rawIds);
    if (!Array.isArray(ids) || ids.length === 0) {
      return 0;
    }

    // Step 2: Delete keys with all keys explicitly passed in KEYS
    const metaKeys = ids.map((id) => this.metaKey(id));
    const msgsKeys = ids.map((id) => this.messagesKey(id));
    const keys = [this.zsetKey, ...metaKeys, ...msgsKeys];
    const scriptArgs: (string | number)[] = [ids.length, ...ids];

    const res = await this.redis.eval<(string | number)[], number>(
      PURGE_EXEC_SCRIPT,
      keys,
      scriptArgs
    );

    return Number(res);
  }
}
