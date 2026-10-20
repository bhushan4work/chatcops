import {
  type AppendOptions,
  type ChatMessage,
  ConflictError,
  type Conversation,
  type ConversationStore,
  type ConversationSummary,
  type ListQuery,
} from '@chatcops/core';
import { parseJson } from './adapter.js';
import type { RedisLike } from './types.js';

const GET_SCRIPT = `
local meta = redis.call('HGETALL', KEYS[1])
if #meta == 0 then
  return nil
end
local messages = redis.call('LRANGE', KEYS[2], 0, -1)
return { meta, messages }
`;

const SAVE_SCRIPT = `
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
    createdAt = tonumber(ARGV[3])
  end
end

local updatedAt = tonumber(ARGV[3])
local ttl = tonumber(ARGV[5])

redis.call('HSET', KEYS[1], 'id', ARGV[1], 'version', newVersion, 'createdAt', createdAt, 'updatedAt', updatedAt)
if ARGV[4] ~= '' then
  redis.call('HSET', KEYS[1], 'metadata', ARGV[4])
else
  redis.call('HDEL', KEYS[1], 'metadata')
end

redis.call('DEL', KEYS[2])
for i = 6, #ARGV do
  redis.call('RPUSH', KEYS[2], ARGV[i])
end

redis.call('PEXPIRE', KEYS[1], ttl)
redis.call('PEXPIRE', KEYS[2], ttl)
redis.call('ZADD', KEYS[3], updatedAt, ARGV[1])

return newVersion
`;

const APPEND_SCRIPT = `
local rawVersion = redis.call('HGET', KEYS[1], 'version')
local currentVersion = 0
if rawVersion then
  currentVersion = tonumber(rawVersion)
end

local expectedVersionStr = ARGV[2]
if expectedVersionStr ~= '' then
  local expectedVersion = tonumber(expectedVersionStr)
  if expectedVersion ~= currentVersion then
    return { 'CONFLICT', currentVersion }
  end
end

local newVersion = currentVersion + 1
local now = tonumber(ARGV[3])
local ttl = tonumber(ARGV[5])

local createdAt = now
local rawCreatedAt = redis.call('HGET', KEYS[1], 'createdAt')
if rawCreatedAt then
  createdAt = tonumber(rawCreatedAt)
end

local metadataArg = ARGV[4]
if metadataArg ~= '' then
  local rawMeta = redis.call('HGET', KEYS[1], 'metadata')
  if rawMeta and rawMeta ~= '' then
    local currentMeta = cjson.decode(rawMeta)
    local patchMeta = cjson.decode(metadataArg)
    for k, v in pairs(patchMeta) do
      currentMeta[k] = v
    end
    redis.call('HSET', KEYS[1], 'metadata', cjson.encode(currentMeta))
  else
    redis.call('HSET', KEYS[1], 'metadata', metadataArg)
  end
end

redis.call('HSET', KEYS[1], 'id', ARGV[1], 'version', newVersion, 'createdAt', createdAt, 'updatedAt', now)

for i = 6, #ARGV do
  redis.call('RPUSH', KEYS[2], ARGV[i])
end

redis.call('PEXPIRE', KEYS[1], ttl)
redis.call('PEXPIRE', KEYS[2], ttl)
redis.call('ZADD', KEYS[3], now, ARGV[1])

return { 'OK', newVersion }
`;

const UPDATE_MESSAGE_SCRIPT = `
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
local now = tonumber(ARGV[4])
local ttl = tonumber(ARGV[5])

redis.call('HSET', KEYS[1], 'version', newVersion, 'updatedAt', now)
redis.call('PEXPIRE', KEYS[1], ttl)
redis.call('PEXPIRE', KEYS[2], ttl)
redis.call('ZADD', KEYS[3], now, ARGV[1])

return 1
`;

const REMOVE_MESSAGE_SCRIPT = `
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
local now = tonumber(ARGV[3])
local ttl = tonumber(ARGV[4])

redis.call('HSET', KEYS[1], 'version', newVersion, 'updatedAt', now)
redis.call('PEXPIRE', KEYS[1], ttl)
redis.call('PEXPIRE', KEYS[2], ttl)
redis.call('ZADD', KEYS[3], now, ARGV[1])

return 1
`;

const DELETE_SCRIPT = `
redis.call('DEL', KEYS[1], KEYS[2])
redis.call('ZREM', KEYS[3], ARGV[1])
return 1
`;

const LIST_SCRIPT = `
local zsetKey = KEYS[1]
local prefix = ARGV[1]
local limit = tonumber(ARGV[2])
local cursor = ARGV[3]
local updatedAfterStr = ARGV[4]
local now = tonumber(ARGV[5])
local ttl = tonumber(ARGV[6])

redis.call('ZREMRANGEBYSCORE', zsetKey, '-inf', '(' .. (now - ttl))

local minScore = '-inf'
if updatedAfterStr ~= '' then
  minScore = '(' .. updatedAfterStr
end

local ids = redis.call('ZREVRANGEBYSCORE', zsetKey, '+inf', minScore)

local validItems = {}
for _, id in ipairs(ids) do
  local metaKey = prefix .. ':conv:' .. id .. ':meta'
  local meta = redis.call('HMGET', metaKey, 'createdAt', 'updatedAt', 'metadata')
  if meta[1] and meta[2] then
    local msgsKey = prefix .. ':conv:' .. id .. ':messages'
    local count = redis.call('LLEN', msgsKey)
    local cur = meta[2] .. ':' .. id
    table.insert(validItems, {
      id = id,
      createdAt = meta[1],
      updatedAt = meta[2],
      metadata = meta[3] or '',
      count = count,
      cursor = cur
    })
  else
    redis.call('ZREM', zsetKey, id)
  end
end

local startIndex = 1
if cursor ~= '' then
  startIndex = #validItems + 1
  for i, item in ipairs(validItems) do
    if item.cursor == cursor then
      startIndex = i + 1
      break
    end
  end
end

local results = {}
local count = 0

for i = startIndex, #validItems do
  if count >= limit then
    break
  end
  local item = validItems[i]
  table.insert(results, item.id)
  table.insert(results, item.createdAt)
  table.insert(results, item.updatedAt)
  table.insert(results, item.count)
  table.insert(results, item.metadata)
  count = count + 1
end

local nextCursor = ''
if startIndex + count - 1 < #validItems and count > 0 then
  nextCursor = validItems[startIndex + count - 1].cursor
end

return { nextCursor, results }
`;

const PURGE_SCRIPT = `
local ids = redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', '(' .. ARGV[2])
local removed = 0
for _, id in ipairs(ids) do
  local metaKey = ARGV[1] .. ':conv:' .. id .. ':meta'
  local msgsKey = ARGV[1] .. ':conv:' .. id .. ':messages'
  redis.call('DEL', metaKey, msgsKey)
  redis.call('ZREM', KEYS[1], id)
  removed = removed + 1
end
return removed
`;

export class RedisConversationStore implements ConversationStore {
  private readonly zsetKey: string;

  constructor(
    private readonly redis: RedisLike,
    private readonly prefix: string,
    private readonly ttlMs: number
  ) {
    this.zsetKey = `${this.prefix}:conversations`;
  }

  private metaKey(id: string): string {
    return `${this.prefix}:conv:${id}:meta`;
  }

  private messagesKey(id: string): string {
    return `${this.prefix}:conv:${id}:messages`;
  }

  async get(id: string): Promise<Conversation | null> {
    const res = await this.redis.eval<[], [unknown[], unknown[]] | null>(
      GET_SCRIPT,
      [this.metaKey(id), this.messagesKey(id)],
      []
    );

    if (!res) return null;

    const [rawMeta, rawMessages] = res;
    if (!rawMeta || rawMeta.length === 0) return null;

    const metaMap: Record<string, unknown> = {};
    for (let i = 0; i < rawMeta.length; i += 2) {
      metaMap[String(rawMeta[i])] = rawMeta[i + 1];
    }

    const messages = (rawMessages ?? []).map((m) => parseJson<ChatMessage>(m));
    const metadata = metaMap.metadata ? parseJson<Record<string, unknown>>(metaMap.metadata) : undefined;

    return {
      id: String(metaMap.id || id),
      messages,
      version: Number(metaMap.version ?? 0),
      createdAt: Number(metaMap.createdAt ?? 0),
      updatedAt: Number(metaMap.updatedAt ?? 0),
      ...(metadata ? { metadata } : {}),
    };
  }

  async save(conversation: Conversation): Promise<void> {
    const id = conversation.id;
    const now = Date.now();
    const createdAt = conversation.createdAt ?? 0;
    const metadataJson = conversation.metadata ? JSON.stringify(conversation.metadata) : '';
    const messagesJson = (conversation.messages ?? []).map((m) => JSON.stringify(m));

    await this.redis.eval(
      SAVE_SCRIPT,
      [this.metaKey(id), this.messagesKey(id), this.zsetKey],
      [id, createdAt, now, metadataJson, this.ttlMs, ...messagesJson]
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
    const metadataJson = options.metadata ? JSON.stringify(options.metadata) : '';
    const messagesJson = messages.map((m) => JSON.stringify(m));

    const res = await this.redis.eval<
      (string | number)[],
      [string, number]
    >(
      APPEND_SCRIPT,
      [this.metaKey(id), this.messagesKey(id), this.zsetKey],
      [id, expectedVersionStr, now, metadataJson, this.ttlMs, ...messagesJson]
    );

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
    const cursor = query.cursor ?? '';
    const updatedAfterStr = query.updatedAfter !== undefined ? String(query.updatedAfter) : '';
    const now = Date.now();

    const res = await this.redis.eval<(string | number)[], [string, unknown[]]>(
      LIST_SCRIPT,
      [this.zsetKey],
      [this.prefix, query.limit, cursor, updatedAfterStr, now, this.ttlMs]
    );

    const [nextCursor, rawItems] = res;
    const items: ConversationSummary[] = [];

    if (rawItems) {
      for (let i = 0; i < rawItems.length; i += 5) {
        const id = String(rawItems[i]);
        const createdAt = Number(rawItems[i + 1]);
        const updatedAt = Number(rawItems[i + 2]);
        const messageCount = Number(rawItems[i + 3]);
        const rawMeta = rawItems[i + 4];
        const metadata = rawMeta && rawMeta !== '' ? parseJson<Record<string, unknown>>(rawMeta) : undefined;

        items.push({
          id,
          createdAt,
          updatedAt,
          messageCount,
          ...(metadata ? { metadata } : {}),
        });
      }
    }

    return nextCursor ? { items, cursor: nextCursor } : { items };
  }

  async purge(before: number): Promise<number> {
    const res = await this.redis.eval<(string | number)[], number>(
      PURGE_SCRIPT,
      [this.zsetKey],
      [this.prefix, before]
    );
    return Number(res);
  }
}
