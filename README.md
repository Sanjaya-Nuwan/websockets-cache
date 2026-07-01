# WebSockets + Cache — Project Documentation

> A hands-on project for learning **WebSockets** and **Redis caching** through building a real-time multi-room chat application.

---

## Table of Contents

1. [Project Overview](#1-project-overview)
2. [Project Structure](#2-project-structure)
3. [Quick Start](#3-quick-start)
4. [WebSockets — Complete Guide](#4-websockets--complete-guide)
   - 4.1 [What Are WebSockets?](#41-what-are-websockets)
   - 4.2 [The WebSocket Handshake](#42-the-websocket-handshake)
   - 4.3 [WebSocket vs HTTP](#43-websocket-vs-http)
   - 4.4 [Server Events (Node.js `ws`)](#44-server-events-nodejs-ws)
   - 4.5 [Client Events (Browser API)](#45-client-events-browser-api)
   - 4.6 [Broadcasting](#46-broadcasting)
   - 4.7 [Heartbeat / Ping-Pong](#47-heartbeat--ping-pong)
   - 4.8 [Reconnection Strategy](#48-reconnection-strategy)
   - 4.9 [Closing Connections Gracefully](#49-closing-connections-gracefully)
5. [Redis Caching — Complete Guide](#5-redis-caching--complete-guide)
   - 5.1 [What Is a Cache?](#51-what-is-a-cache)
   - 5.2 [Why Redis?](#52-why-redis)
   - 5.3 [Cache-Aside Pattern](#53-cache-aside-pattern)
   - 5.4 [Write-Through Pattern](#54-write-through-pattern)
   - 5.5 [TTL (Time-To-Live)](#55-ttl-time-to-live)
   - 5.6 [LRU Eviction](#56-lru-eviction)
   - 5.7 [Rate Limiting with Cache](#57-rate-limiting-with-cache)
   - 5.8 [Cache Hit Rate](#58-cache-hit-rate)
   - 5.9 [Cache Invalidation](#59-cache-invalidation)
6. [Code Walkthrough](#6-code-walkthrough)
7. [Message Protocol](#7-message-protocol)
8. [Experiments to Try](#8-experiments-to-try)
9. [Common Mistakes](#9-common-mistakes)
10. [Further Learning](#10-further-learning)

---

## 1. Project Overview

This project teaches WebSockets and Redis caching through **practical application** rather than theory alone.

| Concept | Where You'll See It |
|---|---|
| WebSocket handshake | `server/index.js` — `wss.on('connection', ...)` |
| WS broadcasting | `server/index.js` — `broadcast()` function |
| WS events (open/message/close/error) | `client/app.js` — all `addEventListener` calls |
| Reconnection with backoff | `client/app.js` — `scheduleReconnect()` |
| Ping/Pong heartbeat | Both files — keep-alive mechanisms |
| Cache-Aside | `server/chatRoom.js` — `getMessageHistory()` |
| Write-Through | `server/chatRoom.js` — `saveMessage()` |
| TTL expiry | `server/cache.js` — all `set()` calls |
| Rate limiting | `server/rateLimiter.js` — `checkRateLimit()` |
| Atomic INCR | `server/cache.js` — `incr()` function |
| Cache metrics | Sidebar stats panel in the UI |

---

## 2. Project Structure

```
websockets-cache/
│
├── server/
│   ├── index.js          ← WebSocket server (start here)
│   ├── cache.js          ← Redis wrapper with educational comments
│   ├── chatRoom.js       ← Room + message logic (cache patterns)
│   └── rateLimiter.js    ← Rate limiting using Redis INCR + TTL
│
├── client/
│   ├── index.html        ← Chat UI shell
│   ├── style.css         ← Premium dark UI (glassmorphism)
│   └── app.js            ← WebSocket client (reconnection, events)
│
├── DOCS.md               ← You are here
└── package.json
```

---

## 3. Quick Start

### Prerequisites

- **Node.js** ≥ 18 ([download](https://nodejs.org))
- **Redis** running locally

#### Install Redis (macOS)
```bash
brew install redis
brew services start redis   # Start Redis as a background service
redis-cli ping              # Should print: PONG
```

#### Install Redis (Ubuntu/Debian)
```bash
sudo apt install redis-server
sudo systemctl start redis
redis-cli ping
```

### Run the Project

```bash
# 1. Install Node.js dependencies
npm install

# 2. Start the WebSocket server
npm start

# 3. Open the client in your browser
# Just open: client/index.html
# (double-click the file, or use a local server)

# Optional: Live reload during development
npm run dev   # Uses Node --watch flag
```

### Verify Redis is Working

Open Redis CLI and watch keys being created in real time:

```bash
redis-cli monitor    # Shows all Redis commands in real time
```

---

## 4. WebSockets — Complete Guide

### 4.1 What Are WebSockets?

The standard **HTTP request-response model** has a fundamental limitation:
- Client must always **initiate** the request
- Server **cannot push** data unless asked
- After the response, the connection is **closed**

**WebSockets** solve this by upgrading the connection to a **persistent, bidirectional channel**:

```
HTTP Model:          WebSocket Model:
─────────────        ─────────────────────────────────
Client → Server      Client ←→ Server (always open)
Client ← Server       ↑↑↑ both can send any time ↑↑↑
[connection closed]
Client → Server
Client ← Server
[connection closed]
```

**Real-world uses of WebSockets:**
- Chat applications (Discord, Slack)
- Live sports scores & financial tickers
- Collaborative editing (Google Docs)
- Online gaming
- IoT device dashboards
- Live notifications

### 4.2 The WebSocket Handshake

WebSocket reuses HTTP for the initial connection — this is called the **upgrade handshake**.

**Step 1 — Client sends HTTP request with upgrade headers:**
```
GET / HTTP/1.1
Host: localhost:3000
Upgrade: websocket
Connection: Upgrade
Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==
Sec-WebSocket-Version: 13
```

**Step 2 — Server responds with 101 Switching Protocols:**
```
HTTP/1.1 101 Switching Protocols
Upgrade: websocket
Connection: Upgrade
Sec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=
```

**Step 3 — The TCP connection is now a WebSocket channel.** HTTP is no longer used. Both sides speak the WebSocket **framing protocol** directly.

The `Sec-WebSocket-Key` / `Sec-WebSocket-Accept` handshake prevents caching proxies from accidentally forwarding WebSocket traffic as HTTP.

### 4.3 WebSocket vs HTTP

| Feature | HTTP | WebSocket |
|---|---|---|
| Direction | Client → Server only | Bidirectional |
| Connection | New TCP per request | One persistent TCP |
| Latency | High (new connection setup) | Low (connection already open) |
| Overhead | Headers sent every request | Minimal frame headers |
| Server push | Not native (needs polling) | Native |
| Use case | REST APIs, page loads | Real-time, streaming |

**When NOT to use WebSockets:**
- Simple one-time data fetches (use fetch/HTTP)
- Large file uploads/downloads (use HTTP)
- When clients only need to read, not push data (use SSE instead)

### 4.4 Server Events (Node.js `ws`)

In `server/index.js`, the WebSocket server uses the `ws` npm library:

```javascript
const { WebSocketServer } = require('ws');
const wss = new WebSocketServer({ server });

// Fires each time a NEW client connects
wss.on('connection', (ws, req) => {
  console.log('New client connected!');

  // 'message' — fires when this client sends data
  ws.on('message', (data) => {
    const parsed = JSON.parse(data.toString());
    // handle the message...
  });

  // 'close' — fires when this client disconnects
  // code: 1000 = normal, 1001 = going away, 1006 = abnormal
  ws.on('close', (code, reason) => {
    console.log(`Disconnected: code=${code}`);
    // IMPORTANT: Always clean up state here!
  });

  // 'error' — fires on network errors
  // CRITICAL: Without this handler, Node.js CRASHES on error!
  ws.on('error', (err) => {
    console.error('WebSocket error:', err.message);
  });
});
```

> **Why must you handle 'error'?**  
> In Node.js, unhandled `'error'` events crash the entire process. Always add an error handler to every WebSocket!

### 4.5 Client Events (Browser API)

The browser has a built-in `WebSocket` class. In `client/app.js`:

```javascript
// Create connection — handshake happens immediately
const ws = new WebSocket('ws://localhost:3000');

// Connection opened (handshake complete)
ws.addEventListener('open', () => {
  console.log('Connected!');
  ws.send(JSON.stringify({ type: 'join', payload: { username: 'Alice' } }));
});

// Message received from server
ws.addEventListener('message', (event) => {
  const data = JSON.parse(event.data);
  console.log('Received:', data.type);
});

// Connection closed
ws.addEventListener('close', (event) => {
  console.log('Closed, code:', event.code);
  // Implement reconnection logic here
});

// Error occurred
ws.addEventListener('error', (err) => {
  console.error('Error:', err);
});
```

**WebSocket `readyState` values:**

| Value | Constant | Meaning |
|---|---|---|
| 0 | `WebSocket.CONNECTING` | Handshake in progress |
| 1 | `WebSocket.OPEN` | Connection ready |
| 2 | `WebSocket.CLOSING` | Close handshake in progress |
| 3 | `WebSocket.CLOSED` | Connection closed |

> Always check `ws.readyState === WebSocket.OPEN` before calling `ws.send()`!

### 4.6 Broadcasting

The `ws` library doesn't have built-in "rooms" like Socket.io. We implement it manually:

```javascript
// Broadcast to ALL connected clients
function broadcastAll(message) {
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(message));
    }
  });
}

// Broadcast to clients in a SPECIFIC ROOM
// Our clients Map stores each client's current roomId
function broadcastToRoom(roomId, message, excludeWs = null) {
  for (const [, client] of clients) {
    if (client.roomId !== roomId) continue;       // skip other rooms
    if (excludeWs && client.ws === excludeWs) continue; // skip sender
    client.ws.send(JSON.stringify(message));
  }
}
```

This pattern — maintaining your own `clients` Map — is how production WebSocket servers work at the application layer.

### 4.7 Heartbeat / Ping-Pong

WebSocket connections can **silently die**. Network issues, proxy timeouts, and mobile devices going to sleep can all drop connections without triggering the `close` event.

**Solution:** Periodic Ping-Pong

The WebSocket protocol has built-in **ping and pong frames** (different from application-level messages):

```javascript
// Server sends a ping every 30 seconds
const heartbeat = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) {
      ws.terminate(); // No pong → dead connection
      return;
    }
    ws.isAlive = false;
    ws.ping();  // Send protocol-level ping
  });
}, 30_000);

// Client automatically responds to pings with pong
// We just listen for the pong to mark the connection alive
wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
});
```

In our project, we also send **application-level pings** from the client every 15 seconds to measure latency:
```javascript
// client/app.js
state.pingTime = Date.now();
ws.send(JSON.stringify({ type: 'ping' }));

// On pong response:
const latency = Date.now() - state.pingTime; // Round-trip time in ms
```

### 4.8 Reconnection Strategy

Networks are unreliable. Always implement reconnection:

```javascript
// Exponential backoff: 1s → 2s → 4s → 8s → 16s (max)
let attempts = 0;

function scheduleReconnect() {
  attempts++;
  const delay = Math.min(1000 * Math.pow(2, attempts - 1), 16000);
  console.log(`Reconnecting in ${delay}ms...`);
  setTimeout(connect, delay);
}
```

**Why exponential backoff?**  
If 1000 users all reconnect immediately after a server restart, they'll create a thundering herd that crashes the server again. Exponential backoff spreads reconnection attempts over time.

### 4.9 Closing Connections Gracefully

WebSocket has a **close handshake** (similar to TCP FIN):
1. One side sends a **Close frame** with a status code and reason
2. The other side echoes the Close frame
3. The underlying TCP connection closes

```javascript
// Client closing gracefully
ws.close(1000, 'User logged out');
// Code 1000 = Normal closure

// Server-side: forceful termination (no handshake)
ws.terminate(); // Use only for dead connections
```

**WebSocket Close Codes:**

| Code | Meaning |
|---|---|
| 1000 | Normal closure |
| 1001 | Going away (page navigation) |
| 1002 | Protocol error |
| 1003 | Unsupported data |
| 1006 | Abnormal closure (no close frame received) |
| 1011 | Internal server error |

---

## 5. Redis Caching — Complete Guide

### 5.1 What Is a Cache?

A **cache** is a fast, temporary storage layer between your application and slower data sources (databases, external APIs, disk).

```
Without Cache:
Request → [Your App] → [PostgreSQL on disk] → response (slow, ~50ms)

With Cache:
Request → [Your App] → [Redis in RAM]       → response (fast, ~0.5ms)
                              ↓ MISS
                       [PostgreSQL] → store in Redis → response
```

**The golden rule:** Serve as many requests as possible from cache, fall back to the primary store only on a miss.

### 5.2 Why Redis?

Redis (Remote Dictionary Server) is the industry-standard cache because:

| Feature | Why It Matters |
|---|---|
| **In-memory** | ~100-1000x faster than disk reads |
| **Persistent** | Can write to disk so data survives restarts |
| **Data structures** | Strings, Lists, Sets, Hashes, Sorted Sets |
| **Atomic operations** | INCR, LPUSH are safe under high concurrency |
| **TTL support** | Keys auto-expire — no manual cleanup |
| **Single-threaded** | No lock contention, predictable performance |
| **Pub/Sub** | Built-in message broadcasting |

**Redis data types used in this project:**

| Command | Used For |
|---|---|
| `GET` / `SET` | Room data, user sessions |
| `LPUSH` / `LRANGE` | Message history (ordered list) |
| `INCR` / `EXPIRE` | Rate limiting counters |
| `TTL` | Check remaining expiry |

### 5.3 Cache-Aside Pattern

Also called **Lazy Loading** — the most common caching strategy.

```
          ┌─────────────┐
          │  Application │
          └──────┬───────┘
                 │ 1. Read from cache
        ┌────────▼────────┐
        │    Redis Cache   │
        └────────┬────────┘
                 │
         ┌───────┴───────┐
         │  HIT?    MISS? │
         │               │
  ┌──────▼──────┐  ┌──────▼──────────────┐
  │ Return data │  │ 2. Fetch from DB     │
  │ (fast! ✅)  │  │ 3. Store in cache    │
  └─────────────┘  │ 4. Return data (slow)│
                   └──────────────────────┘
```

**In our code** (`server/chatRoom.js`):
```javascript
async function getMessageHistory(roomId) {
  const key = `messages:${roomId}`;

  // Step 1: Try Redis first
  const cached = await cache.listGet(key);

  if (cached.length > 0) {
    // CACHE HIT — return fast
    return cached;
  }

  // CACHE MISS — fetch from DB and populate cache
  // const fromDB = await db.messages.find({ roomId });
  // await cache.listPush(key, ...fromDB);
  // return fromDB;
  return [];
}
```

**Pros:** Simple, only caches data that's actually needed  
**Cons:** First request always goes to DB (cold start miss)

### 5.4 Write-Through Pattern

Every write goes to **both the cache AND the database simultaneously**.

```
Write Request
     │
     ▼
┌─────────────┐
│  Application │
└──────┬───────┘
       │ Write to BOTH at the same time
   ┌───┴────┐
   ▼        ▼
Redis    Database
(fast)   (slow, but always in sync)
```

**In our code** (`server/chatRoom.js`):
```javascript
async function saveMessage(roomId, message) {
  // Write-Through: push to cache AND (in production) to DB
  await cache.listPush(`messages:${roomId}`, message, 50, 7200);
  // await db.messages.insert(message);  ← would go here in production
}
```

**Pros:** Cache is always fresh, no cache misses on reads  
**Cons:** Every write is slower (two writes instead of one)

### 5.5 TTL (Time-To-Live)

TTL is the **expiry duration** for a cached value. After TTL seconds, Redis **automatically deletes** the key.

```javascript
// Cache message history for 2 hours
await redis.set(key, value, 'EX', 7200);  // EX = expire in N seconds

// Check remaining TTL
const remaining = await redis.ttl(key);
// Returns: seconds remaining, or -1 (no expiry), or -2 (key doesn't exist)
```

**Why use TTL?**
- Prevents serving **stale data** forever
- Automatically frees memory
- Forces periodic refresh from the source of truth

**TTL choices in this project:**

| Cache Key | TTL | Reason |
|---|---|---|
| `messages:{roomId}` | 2 hours (7200s) | History stays warm for active rooms |
| `ratelimit:{action}:{userId}` | 10 seconds | Rate limit window duration |
| Generic `set()` default | 5 minutes (300s) | Safe default for most data |

### 5.6 LRU Eviction

When Redis runs out of memory, it needs to **evict (delete) keys** to make room. The most common policy is **LRU (Least Recently Used)** — evict the key that was least recently read or written.

Redis supports this via the `maxmemory-policy` configuration:
```
maxmemory 256mb
maxmemory-policy allkeys-lru
```

In our message lists, we simulate LRU trimming by keeping only the **last 50 messages**:
```javascript
// In cache.js listPush():
pipeline.ltrim(key, -50, -1);  // Keep only last 50 items
// Items older than 50 are automatically deleted (evicted)
```

This is equivalent to saying: "recent messages are more valuable than old ones."

### 5.7 Rate Limiting with Cache

Rate limiting prevents a single user from overwhelming the server.

**Algorithm: Fixed Window Counter**

```
Window:  [-----10 seconds-----]
User A:  ■ ■ ■ ■ ■ ■ ■ ■ ← 8 allowed
                            ← BLOCKED (limit reached)
         [new 10s window starts → counter resets]
```

**Redis makes this elegant:**

```javascript
async function checkRateLimit(userId, action, limit, windowSec) {
  const key = `ratelimit:${action}:${userId}`;

  // INCR atomically increments the counter by 1
  // If key doesn't exist, Redis creates it at 0 first
  const count = await redis.incr(key);

  // On first increment, set the window TTL
  if (count === 1) {
    await redis.expire(key, windowSec);
    // After windowSec, key auto-deletes → counter resets
  }

  return { allowed: count <= limit, count };
}
```

**Why Redis's INCR is perfect for rate limiting:**
- **Atomic** — even with 10,000 concurrent requests, count is always accurate
- **Fast** — O(1) operation, ~0.1ms
- **Self-cleaning** — TTL means no background job needed to reset counters

### 5.8 Cache Hit Rate

**Hit Rate** = (hits) / (hits + misses) × 100%

A well-tuned cache should have a **hit rate of 80%+**. In the sidebar stats panel, you can see live hit/miss counts as you use the app.

```
Scenario                         Hit Rate
────────────────────────────────────────
First user joins (cold cache)    0% (all misses)
Second user joins same room      100% (history cached)
After 2-hour TTL expires         0% (keys evicted, cold again)
Heavy traffic same room          95%+ (warm cache)
```

### 5.9 Cache Invalidation

> *"There are only two hard things in Computer Science: cache invalidation and naming things."*  
> — Phil Karlton

Cache invalidation = knowing **when your cached data is stale** and removing it.

**Strategies:**
1. **TTL-based** — Let the key expire on its own (used in this project)
2. **Event-based** — Delete key explicitly when data changes
3. **Write-Through** — Always update cache on write (always fresh)

```javascript
// Event-based invalidation example:
async function updateRoomDescription(roomId, newDesc) {
  await db.rooms.update(roomId, { description: newDesc });
  await cache.del(`room:${roomId}`); // Invalidate stale cache
  // Next read will be a MISS, fetching fresh data
}
```

---

## 6. Code Walkthrough

### File: `server/cache.js`

The Redis wrapper that all other modules use. Study these functions:

| Function | Teaches |
|---|---|
| `get(key)` | Cache-Aside read, hit/miss tracking |
| `set(key, value, ttlSec)` | TTL-based expiry |
| `incr(key, ttlSec)` | Atomic counter for rate limiting |
| `listPush(key, value, maxLen)` | Write-Through + LRU trimming |
| `listGet(key)` | Reading Redis lists |
| `getMetrics()` | Observability — hit rate calculation |

### File: `server/rateLimiter.js`

Demonstrates the **Fixed Window Counter** pattern using Redis INCR + TTL.

### File: `server/chatRoom.js`

Contains the **Cache-Aside** pattern in `getMessageHistory()` and **Write-Through** in `saveMessage()`.

### File: `server/index.js`

The WebSocket server. Key sections to study:

1. **Lines creating `wss`** — WebSocket server setup
2. **`wss.on('connection', ...)`** — per-client event handling
3. **`ws.on('message', ...)`** — incoming message parsing and routing
4. **`ws.on('close', ...)`** — cleanup on disconnect
5. **`broadcast()` function** — room-scoped message delivery
6. **Heartbeat interval** — detecting dead connections

### File: `client/app.js`

The browser-side WebSocket client. Key sections:

1. **`connect()` function** — handshake + all event listeners
2. **`send()` helper** — safe send with readyState check
3. **`scheduleReconnect()`** — exponential backoff reconnection
4. **`startPingLoop()`** — latency measurement via application ping
5. **`handleServerMessage()`** — message type dispatch

---

## 7. Message Protocol

All WebSocket messages in this project use a consistent JSON schema:

### Client → Server

```jsonc
{ "type": "join",         "payload": { "username": "alice", "room": "general" } }
{ "type": "send_message", "payload": { "text": "Hello!" } }
{ "type": "typing",       "payload": { "isTyping": true } }
{ "type": "switch_room",  "payload": { "room": "javascript" } }
{ "type": "get_stats",    "payload": {} }
{ "type": "ping",         "payload": {} }
```

### Server → Client

```jsonc
{ "type": "welcome",          "payload": { "socketId": "...", "availableRooms": [...] } }
{ "type": "joined",           "payload": { "user": {...}, "room": {...}, "history": [...] } }
{ "type": "new_message",      "payload": { "id": "...", "text": "...", "username": "...", ... } }
{ "type": "user_joined",      "payload": { "user": {...}, "onlineUsers": [...] } }
{ "type": "user_left",        "payload": { "user": {...}, "onlineUsers": [...] } }
{ "type": "typing_indicator", "payload": { "userId": "...", "username": "...", "isTyping": true } }
{ "type": "rate_limited",     "payload": { "message": "...", "resetIn": 8 } }
{ "type": "stats",            "payload": { "cacheMetrics": {...}, "rooms": [...] } }
{ "type": "pong",             "payload": { "timestamp": 1234567890 } }
{ "type": "error",            "payload": { "message": "..." } }
```

---

## 8. Experiments to Try

These experiments will deepen your understanding by breaking things and observing what happens:

### WebSocket Experiments

**1. Observe the handshake in DevTools**
- Open Chrome DevTools → Network tab
- Filter by "WS"
- Open `client/index.html`, connect, and click on the WebSocket request
- Inspect the "Headers" tab to see the Upgrade headers

**2. Watch messages flow in real-time**
- In DevTools → Network → WS → click Messages tab
- See every JSON frame sent and received with timestamps

**3. Test reconnection**
- Connect and join a room
- Kill the server: `Ctrl+C`
- Watch the status indicator and latency badge
- Restart the server: `npm start`
- Watch it reconnect automatically

**4. Open multiple tabs**
- Open `client/index.html` in 3 browser tabs
- Join the same room with different usernames
- Observe: messages appear instantly in all tabs
- Watch typing indicators appear in real time

**5. Simulate a dead connection**
- In `server/index.js`, temporarily change heartbeat to 5 seconds
- Use Chrome's "Throttle" in DevTools to simulate an offline connection
- Watch the server terminate the dead connection

### Cache Experiments

**6. Watch Redis keys in real time**
```bash
redis-cli monitor
```
- Join a room, send messages
- Watch `SET`, `RPUSH`, `LTRIM`, `EXPIRE` commands appear

**7. Inspect cached messages**
```bash
redis-cli
> LRANGE messages:general 0 -1   # See all cached messages
> TTL messages:general            # Check remaining TTL
> LLEN messages:general           # Count messages in list
```

**8. Observe cache-aside in action**
```bash
redis-cli FLUSHDB   # Clear all cache
```
- Reconnect client → first join is a cache MISS (0 history)
- Send 5 messages
- Reconnect client again → now it's a cache HIT (5 messages loaded)
- Watch the hit/miss counter in the sidebar update

**9. Trigger rate limiting**
- Send more than 8 messages in 10 seconds
- Watch the yellow warning banner appear
- Wait 10 seconds for the counter to reset
- Observe the counter in Redis:
```bash
redis-cli GET ratelimit:send_message:<your-user-id>
```

**10. Measure cache impact**
- In `server/chatRoom.js`, add `await sleep(50)` to simulate a slow DB
- Notice the delay on first load (MISS)
- Notice instant load on second connection (HIT)

---

## 9. Common Mistakes

### WebSocket Mistakes

❌ **Not checking `readyState` before sending**
```javascript
// WRONG — may throw if not connected
ws.send(data);

// CORRECT
if (ws.readyState === WebSocket.OPEN) {
  ws.send(data);
}
```

❌ **No error handler on the server**
```javascript
// WRONG — will crash Node.js if error occurs
ws.on('message', handler);

// CORRECT — always handle errors
ws.on('error', (err) => console.error(err));
```

❌ **Not cleaning up on disconnect**
```javascript
// WRONG — stale entries accumulate, cause bugs
ws.on('close', () => { /* nothing */ });

// CORRECT
ws.on('close', () => {
  clients.delete(socketId);
  chatRoom.removeUser(userId);
});
```

❌ **Sending objects directly without JSON.stringify**
```javascript
ws.send({ type: 'test' });      // WRONG — sends "[object Object]"
ws.send(JSON.stringify({ type: 'test' })); // CORRECT
```

### Cache Mistakes

❌ **Never expiring cache (no TTL)**
```javascript
redis.set('user:1', data);          // WRONG — stays forever, goes stale
redis.set('user:1', data, 'EX', 300); // CORRECT — expires in 5 min
```

❌ **Caching too aggressively (ignoring cache invalidation)**
```javascript
// Update DB but forget to invalidate cache → stale data served!
await db.user.update(userId, newData);
// MISSING: await cache.del(`user:${userId}`);
```

❌ **Not handling cache MISS gracefully**
```javascript
// WRONG — throws if cache miss returns null
const data = JSON.parse(await redis.get(key));

// CORRECT
const raw = await redis.get(key);
const data = raw ? JSON.parse(raw) : null;
if (!data) { /* fetch from DB */ }
```

❌ **Race conditions without atomic operations**
```javascript
// WRONG for counters — two requests can read the same value simultaneously
const count = parseInt(await redis.get(key) || '0');
await redis.set(key, count + 1);

// CORRECT — INCR is atomic, no race condition possible
const count = await redis.incr(key);
```

---

## 10. Further Learning

### Next Steps for WebSockets
- **Socket.io** — higher-level library with rooms, namespaces, fallback to HTTP polling
- **WebSocket compression** — `permessage-deflate` extension for bandwidth efficiency
- **Authentication** — JWT tokens in WebSocket URL query params or initial message
- **Horizontal scaling** — Multiple server instances with Redis Pub/Sub for cross-server broadcasting
- **Load testing** — Use `artillery` or `k6` to test how many concurrent WebSocket connections your server handles

### Next Steps for Caching
- **Redis Pub/Sub** — For broadcasting cache invalidation events across multiple servers
- **Redis Streams** — Advanced message queue, ideal for WebSocket message persistence
- **Bloom Filters** — Probabilistic data structure to avoid cache stampede
- **Cache warming** — Pre-populate cache before traffic arrives
- **Distributed caching** — Redis Cluster for horizontal cache scaling

### Recommended Reading
- [WebSocket RFC 6455](https://datatracker.ietf.org/doc/html/rfc6455) — The specification
- [Redis documentation](https://redis.io/docs) — Official Redis docs with patterns
- [Martin Fowler — Cache-Aside](https://martinfowler.com/bliki/TwoHardThings.html)
- [The System Design Primer](https://github.com/donnemartin/system-design-primer) — Caching chapter
- [ws library GitHub](https://github.com/websockets/ws) — The library used in this project

---

*Project created as a hands-on WebSockets + Redis learning resource.*  
*Every file is heavily commented — read the source code alongside this documentation.*
