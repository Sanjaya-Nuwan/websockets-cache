/**
 * ============================================================
 * rateLimiter.js — Cache-Based Rate Limiter
 * ============================================================
 *
 * CONCEPT: What is Rate Limiting?
 * Rate limiting controls how many times a user can perform an
 * action within a time window. Examples:
 *   - Max 5 messages per 10 seconds (prevent spam)
 *   - Max 100 API calls per minute (prevent abuse)
 *   - Max 3 login attempts per hour (prevent brute force)
 *
 * HOW CACHE MAKES THIS POSSIBLE:
 * We use Redis's atomic INCR command to count actions.
 * Redis handles concurrent increments safely — no race conditions.
 * Each counter automatically expires (TTL), resetting the window.
 *
 * ALGORITHM: Fixed Window Counter
 *   - Each user gets a key like: ratelimit:{userId}:{action}
 *   - We INCR the counter on each action
 *   - If count > limit → reject the action
 *   - After TTL seconds → counter resets automatically
 */

const cache = require('./cache');

/**
 * Check if a user is allowed to perform an action.
 *
 * @param {string} userId     - Unique identifier for the user
 * @param {string} action     - Action name (e.g., "send_message", "join_room")
 * @param {number} maxPerWindow - Max allowed actions in the time window
 * @param {number} windowSec  - Time window in seconds
 *
 * @returns {Promise<{allowed: boolean, count: number, remaining: number, resetIn: number}>}
 *
 * EXAMPLE USAGE:
 *   const result = await checkRateLimit('user123', 'send_message', 5, 10);
 *   if (!result.allowed) {
 *     // Tell the user they're sending too fast
 *   }
 */
async function checkRateLimit(userId, action, maxPerWindow = 5, windowSec = 10) {
  // Build a unique Redis key for this user + action combination
  // Format: ratelimit:send_message:user123
  const key = `ratelimit:${action}:${userId}`;

  // Atomically increment the counter (safe under concurrency!)
  // If key doesn't exist, Redis creates it at 0 first, then increments to 1
  const count = await cache.incr(key, windowSec);

  // How many seconds until this window resets?
  const resetIn = await cache.ttl(key);

  // How many actions are still allowed?
  const remaining = Math.max(0, maxPerWindow - count);

  const allowed = count <= maxPerWindow;

  if (!allowed) {
    console.log(`[RateLimiter] 🚫 BLOCKED — user: "${userId}", action: "${action}", count: ${count}/${maxPerWindow}, resets in: ${resetIn}s`);
  } else {
    console.log(`[RateLimiter] ✅ ALLOWED — user: "${userId}", action: "${action}", count: ${count}/${maxPerWindow}`);
  }

  return { allowed, count, remaining, resetIn, limit: maxPerWindow };
}

/**
 * Reset the rate limit counter for a specific user + action.
 * Useful for testing or admin overrides.
 *
 * @param {string} userId - User to reset
 * @param {string} action - Action to reset
 */
async function resetRateLimit(userId, action) {
  const key = `ratelimit:${action}:${userId}`;
  await cache.del(key);
  console.log(`[RateLimiter] 🔄 Reset rate limit — user: "${userId}", action: "${action}"`);
}

module.exports = { checkRateLimit, resetRateLimit };
