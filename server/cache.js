/**
 * ============================================================
 * cache.js — Redis Cache Wrapper
 * ============================================================
 *
 * CONCEPT: What is a Cache?
 * A cache is a fast, temporary storage layer that sits between
 * your application and a slower data source (like a database).
 * Instead of hitting the slow source every time, you store
 * frequently-needed data in Redis (in-memory) for lightning-fast access.
 *
 * Redis stores data as key-value pairs in RAM — making it
 * ~100x faster than reading from disk-based databases.
 *
 * PATTERNS WE USE HERE:
 * 1. Cache-Aside (Lazy Loading) — only cache data when needed
 * 2. Write-Through              — write to cache AND store simultaneously
 * 3. TTL (Time-To-Live)         — auto-expire stale data
 */

const Redis = require('ioredis');

// ---------------------------------------------------------------
// Create a Redis client instance
// ioredis automatically reconnects if the connection drops
// ---------------------------------------------------------------
const redis = new Redis({
  host: '127.0.0.1',   // Redis server address (localhost)
  port: 6379,           // Default Redis port
  retryStrategy: (times) => {
    // Retry connecting with increasing delay (up to 3 seconds)
    const delay = Math.min(times * 100, 3000);
    console.log(`[Cache] Reconnecting to Redis... attempt ${times}`);
    return delay;
  },
  maxRetriesPerRequest: 3,
});

// Track connection events for learning/debugging
redis.on('connect',    () => console.log('[Cache] ✅ Connected to Redis'));
redis.on('error',  (err) => console.error('[Cache] ❌ Redis error:', err.message));
redis.on('reconnecting', () => console.log('[Cache] 🔄 Reconnecting to Redis...'));

// ---------------------------------------------------------------
// METRICS: Track cache hits and misses
// A "hit" = data was found in cache (fast!)
// A "miss" = data was NOT in cache, must fetch from source (slow)
// ---------------------------------------------------------------
const metrics = { hits: 0, misses: 0, sets: 0, deletes: 0 };

/**
 * GET a value from cache
 *
 * CACHE-ASIDE PATTERN:
 *   1. Check Redis for the key
 *   2. If found (HIT) → return cached value (fast!)
 *   3. If not found (MISS) → caller fetches from DB, then calls set()
 *
 * @param {string} key - The cache key to look up
 * @returns {Promise<any|null>} - Parsed value or null if not found
 */
async function get(key) {
  const raw = await redis.get(key);

  if (raw === null) {
    // CACHE MISS — data not found, caller needs to fetch from source
    metrics.misses++;
    console.log(`[Cache] MISS — key: "${key}"`);
    return null;
  }

  // CACHE HIT — data found, parse JSON and return
  metrics.hits++;
  console.log(`[Cache] HIT  — key: "${key}"`);
  return JSON.parse(raw);
}

/**
 * SET a value in cache
 *
 * @param {string} key    - The cache key
 * @param {any}    value  - The value to store (will be JSON-serialized)
 * @param {number} ttlSec - Time-To-Live in seconds (default: 5 minutes)
 *
 * TTL CONCEPT:
 *   Every cached item gets an expiry time. After TTL seconds,
 *   Redis automatically deletes the key. This prevents serving
 *   stale (outdated) data forever.
 */
async function set(key, value, ttlSec = 300) {
  // EX = expire in N seconds
  await redis.set(key, JSON.stringify(value), 'EX', ttlSec);
  metrics.sets++;
  console.log(`[Cache] SET  — key: "${key}" (TTL: ${ttlSec}s)`);
}

/**
 * DELETE a key from cache
 * Use this to invalidate (bust) the cache when data changes.
 *
 * CACHE INVALIDATION:
 *   When underlying data changes, the cached version becomes stale.
 *   We must delete it so the next request fetches fresh data.
 */
async function del(key) {
  await redis.del(key);
  metrics.deletes++;
  console.log(`[Cache] DEL  — key: "${key}"`);
}

/**
 * EXISTS — check if a key exists without fetching its value
 * @returns {Promise<boolean>}
 */
async function exists(key) {
  const result = await redis.exists(key);
  return result === 1;
}

/**
 * INCR — atomically increment a counter by 1
 * This is used for rate limiting. Redis guarantees atomic increments
 * even under high concurrency — no race conditions!
 *
 * @param {string} key    - Counter key
 * @param {number} ttlSec - Set TTL only on first increment (if key is new)
 * @returns {Promise<number>} - New counter value
 */
async function incr(key, ttlSec = 60) {
  const count = await redis.incr(key);

  // Set TTL only when we first create the key (count === 1)
  // This creates a "sliding window" for rate limiting
  if (count === 1) {
    await redis.expire(key, ttlSec);
  }

  return count;
}

/**
 * TTL — check how many seconds remain before a key expires
 * @returns {Promise<number>} - Seconds remaining (-1 if no expiry, -2 if gone)
 */
async function ttl(key) {
  return redis.ttl(key);
}

/**
 * PUSH to a Redis list (right-push)
 * Lists maintain insertion order — perfect for message history!
 *
 * WRITE-THROUGH PATTERN:
 *   Every new message is pushed to both the Redis list (cache)
 *   AND would normally also be saved to the database at the same time.
 *   This keeps cache and storage always in sync.
 *
 * @param {string} key   - List key
 * @param {any}    value - Value to append
 * @param {number} maxLen - Trim list to this max length (0 = no trim)
 * @param {number} ttlSec - Expiry for the list
 */
async function listPush(key, value, maxLen = 100, ttlSec = 3600) {
  const pipeline = redis.pipeline(); // Batch commands for efficiency
  pipeline.rpush(key, JSON.stringify(value)); // Append to right (end)

  if (maxLen > 0) {
    // Keep only the last `maxLen` items — automatic LRU-style trimming
    pipeline.ltrim(key, -maxLen, -1);
  }
  pipeline.expire(key, ttlSec); // Refresh TTL on each write
  await pipeline.exec();
  console.log(`[Cache] LIST PUSH — key: "${key}"`);
}

/**
 * GET all items from a Redis list
 * @param {string} key   - List key
 * @param {number} start - Start index (0 = beginning)
 * @param {number} end   - End index (-1 = all)
 * @returns {Promise<any[]>}
 */
async function listGet(key, start = 0, end = -1) {
  const items = await redis.lrange(key, start, end);
  return items.map((item) => JSON.parse(item));
}

/**
 * GET cache hit/miss metrics
 * Useful for understanding cache efficiency
 *
 * Hit Rate = hits / (hits + misses)
 * A good cache has >80% hit rate.
 */
function getMetrics() {
  const total = metrics.hits + metrics.misses;
  const hitRate = total > 0 ? ((metrics.hits / total) * 100).toFixed(1) : '0.0';
  return { ...metrics, hitRate: `${hitRate}%`, totalRequests: total };
}

/**
 * FLUSH — clear all keys in the current Redis database
 * WARNING: Only use in development/testing!
 */
async function flush() {
  await redis.flushdb();
  console.log('[Cache] 🗑️  Flushed all cache keys');
}

/** Gracefully close the Redis connection */
async function disconnect() {
  await redis.quit();
  console.log('[Cache] Redis connection closed');
}

module.exports = { get, set, del, exists, incr, ttl, listPush, listGet, getMetrics, flush, disconnect, redis };
