/**
 * ============================================================
 * server/index.js — WebSocket Server Entry Point
 * ============================================================
 *
 * WHAT IS A WEBSOCKET?
 * HTTP is "request-response": client asks → server responds → done.
 * WebSocket is a persistent, two-way connection:
 *   - Client connects once (upgrading from HTTP)
 *   - Both sides can send messages at ANY time
 *   - Connection stays open until explicitly closed
 *
 * THE WEBSOCKET HANDSHAKE:
 *   1. Client sends HTTP request with "Upgrade: websocket" header
 *   2. Server responds with 101 Switching Protocols
 *   3. Connection is now a full-duplex TCP channel
 *   4. Both sides communicate using WebSocket frames (not HTTP)
 *
 * THE `ws` LIBRARY:
 *   The 'ws' npm package provides a clean, fast WebSocket server
 *   for Node.js. It handles the handshake, framing, and ping/pong
 *   so you can focus on your app logic.
 */

const http = require('http');
const { WebSocketServer, WebSocket } = require('ws');
const { v4: uuidv4 } = require('uuid');
const chatRoom = require('./chatRoom');
const { checkRateLimit } = require('./rateLimiter');
const cache = require('./cache');

const PORT = process.env.PORT || 3000;

// ---------------------------------------------------------------
// 1. Create an HTTP server
//    The WebSocket upgrade happens ON TOP of this HTTP server.
//    The same server handles both regular HTTP (for the client HTML)
//    and WebSocket connections.
// ---------------------------------------------------------------
const server = http.createServer((req, res) => {
  // Serve a simple info page for non-WebSocket requests
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('WebSocket + Cache Learning Server is running.\nOpen client/index.html in your browser.');
});

// ---------------------------------------------------------------
// 2. Attach a WebSocket server to the HTTP server
//    { server } means "listen on the same port as the HTTP server"
//    When a WebSocket connection comes in, `wss` handles it.
// ---------------------------------------------------------------
const wss = new WebSocketServer({ server });

// ---------------------------------------------------------------
// 3. Track all connected clients
//    clients: Map<socketId, { ws, userId, roomId, username }>
// ---------------------------------------------------------------
const clients = new Map();

// ---------------------------------------------------------------
// HELPER: Send a JSON message to a specific WebSocket
// WebSocket can only send strings or binary data — we JSON.stringify
// ---------------------------------------------------------------
function send(ws, type, payload) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type, payload, timestamp: new Date().toISOString() }));
  }
}

// ---------------------------------------------------------------
// HELPER: Broadcast a message to ALL clients in a specific room
// (or to all connected clients if roomId is null)
// ---------------------------------------------------------------
function broadcast(type, payload, roomId = null, excludeWs = null) {
  for (const [, client] of clients) {
    // Skip if not in the target room (or skip the sender)
    if (roomId && client.roomId !== roomId) continue;
    if (excludeWs && client.ws === excludeWs) continue;
    send(client.ws, type, payload);
  }
}

// ---------------------------------------------------------------
// 4. Handle new WebSocket connections
//    'connection' fires every time a client connects
// ---------------------------------------------------------------
wss.on('connection', (ws, req) => {
  const socketId = uuidv4();
  const clientIp = req.socket.remoteAddress;

  console.log(`\n[WS] 🔌 New connection: ${socketId} from ${clientIp}`);

  // Store minimal client state — userId and roomId added after login
  clients.set(socketId, { ws, userId: null, roomId: null, username: null });

  // ── Send a welcome message to the new client ─────────────────
  send(ws, 'welcome', {
    socketId,
    message: 'Connected to WebSocket + Cache Learning Server',
    availableRooms: chatRoom.getAllRooms(),
  });

  // ─────────────────────────────────────────────────────────────
  // 5. Handle incoming messages from this client
  //    'message' fires every time the client sends data
  //    All messages are JSON with { type, payload } structure
  // ─────────────────────────────────────────────────────────────
  ws.on('message', async (raw) => {
    let parsed;

    // Safely parse incoming JSON
    try {
      parsed = JSON.parse(raw.toString());
    } catch {
      send(ws, 'error', { message: 'Invalid JSON format' });
      return;
    }

    const { type, payload = {} } = parsed;
    const client = clients.get(socketId);

    console.log(`[WS] 📨 Message from ${socketId}: type="${type}"`);

    // ────────────────────────────────────────────────────────────
    // MESSAGE HANDLERS — each 'type' is a different action
    // ────────────────────────────────────────────────────────────

    switch (type) {

      // ── JOIN: User provides username and room name ────────────
      case 'join': {
        const { username, room = 'general' } = payload;

        if (!username || username.trim().length < 2) {
          send(ws, 'error', { message: 'Username must be at least 2 characters' });
          return;
        }

        // Register user (get ID + color)
        const user = chatRoom.registerUser(username.trim());

        // Get or create the room
        const roomObj = chatRoom.getOrCreateRoom(room);

        // Add to presence
        chatRoom.joinRoom(roomObj.id, user.id);

        // Update client state
        clients.set(socketId, { ws, userId: user.id, roomId: roomObj.id, username: user.username });

        // ── CACHE-ASIDE: Load message history ────────────────────
        // Try Redis first → fall back to empty array on miss
        const history = await chatRoom.getMessageHistory(roomObj.id);

        // Send the joining user their room info + history
        send(ws, 'joined', {
          user,
          room: roomObj,
          history,
          onlineUsers: chatRoom.getRoomPresence(roomObj.id),
        });

        // Notify others in the room that someone joined
        broadcast('user_joined', {
          user,
          onlineUsers: chatRoom.getRoomPresence(roomObj.id),
        }, roomObj.id, ws);

        console.log(`[WS] ✅ "${username}" joined room "${room}"`);
        break;
      }

      // ── SEND_MESSAGE: User sends a chat message ───────────────
      case 'send_message': {
        const client = clients.get(socketId);

        // Must be logged in first
        if (!client.userId) {
          send(ws, 'error', { message: 'You must join a room first' });
          return;
        }

        const { text } = payload;

        if (!text || text.trim().length === 0) {
          send(ws, 'error', { message: 'Message cannot be empty' });
          return;
        }

        if (text.length > 500) {
          send(ws, 'error', { message: 'Message too long (max 500 chars)' });
          return;
        }

        // ── RATE LIMITING ─────────────────────────────────────────
        // Allow max 8 messages per 10 seconds per user
        const rateCheck = await checkRateLimit(client.userId, 'send_message', 8, 10);

        if (!rateCheck.allowed) {
          send(ws, 'rate_limited', {
            message: `Slow down! You can send ${rateCheck.limit} messages per 10 seconds.`,
            resetIn: rateCheck.resetIn,
          });
          return;
        }

        // Build the message object
        const user = chatRoom.getUser(client.userId);
        const message = {
          id: uuidv4(),
          text: text.trim(),
          userId: client.userId,
          username: user.username,
          color: user.color,
          roomId: client.roomId,
          timestamp: new Date().toISOString(),
        };

        // ── WRITE-THROUGH: Save to cache immediately ──────────────
        await chatRoom.saveMessage(client.roomId, message);

        // Broadcast to everyone in the room (including sender)
        broadcast('new_message', message, client.roomId);

        console.log(`[WS] 💬 Message from "${user.username}" in room ${client.roomId}`);
        break;
      }

      // ── TYPING: Broadcast typing indicator ───────────────────
      case 'typing': {
        const client = clients.get(socketId);
        if (!client.userId) return;

        const user = chatRoom.getUser(client.userId);
        const { isTyping } = payload;

        // Broadcast to others in the room (NOT to the sender)
        broadcast('typing_indicator', {
          userId: client.userId,
          username: user.username,
          isTyping: !!isTyping,
        }, client.roomId, ws);
        break;
      }

      // ── SWITCH_ROOM: Move to a different room ─────────────────
      case 'switch_room': {
        const client = clients.get(socketId);
        if (!client.userId) return;

        const { room } = payload;
        const user = chatRoom.getUser(client.userId);

        // Leave current room
        if (client.roomId) {
          chatRoom.leaveRoom(client.roomId, client.userId);
          broadcast('user_left', {
            user,
            onlineUsers: chatRoom.getRoomPresence(client.roomId),
          }, client.roomId, ws);
        }

        // Join new room
        const newRoom = chatRoom.getOrCreateRoom(room);
        chatRoom.joinRoom(newRoom.id, client.userId);
        clients.set(socketId, { ...client, roomId: newRoom.id });

        const history = await chatRoom.getMessageHistory(newRoom.id);

        send(ws, 'switched_room', {
          room: newRoom,
          history,
          onlineUsers: chatRoom.getRoomPresence(newRoom.id),
        });

        broadcast('user_joined', {
          user,
          onlineUsers: chatRoom.getRoomPresence(newRoom.id),
        }, newRoom.id, ws);

        break;
      }

      // ── GET_STATS: Return cache + server statistics ───────────
      case 'get_stats': {
        const cacheMetrics = cache.getMetrics();
        send(ws, 'stats', {
          cacheMetrics,
          connectedClients: clients.size,
          rooms: chatRoom.getAllRooms(),
        });
        break;
      }

      // ── PING: Client keepalive / health check ─────────────────
      case 'ping': {
        send(ws, 'pong', { timestamp: Date.now() });
        break;
      }

      default:
        send(ws, 'error', { message: `Unknown message type: "${type}"` });
    }
  });

  // ─────────────────────────────────────────────────────────────
  // 6. Handle disconnection
  //    'close' fires when the connection is closed for ANY reason:
  //    browser closed, network dropped, client navigated away, etc.
  //
  //    IMPORTANT: Always clean up state on disconnect!
  //    Leaving stale entries in presence/clients causes bugs.
  // ─────────────────────────────────────────────────────────────
  ws.on('close', (code, reason) => {
    const client = clients.get(socketId);
    console.log(`[WS] 🔴 Disconnected: ${socketId} (code: ${code})`);

    if (client && client.userId) {
      const user = chatRoom.getUser(client.userId);

      // Notify others in the room
      if (client.roomId) {
        chatRoom.leaveRoom(client.roomId, client.userId);
        broadcast('user_left', {
          user,
          onlineUsers: chatRoom.getRoomPresence(client.roomId),
        }, client.roomId);
      }

      // Remove user data
      chatRoom.removeUser(client.userId);
    }

    // Always remove from clients map
    clients.delete(socketId);
    console.log(`[WS] Connected clients remaining: ${clients.size}`);
  });

  // ─────────────────────────────────────────────────────────────
  // 7. Handle errors
  //    'error' fires for network errors, malformed frames, etc.
  //    IMPORTANT: Always add an error handler to avoid crashes!
  //    Without it, unhandled 'error' events crash Node.js.
  // ─────────────────────────────────────────────────────────────
  ws.on('error', (err) => {
    console.error(`[WS] ⚠️  Error on socket ${socketId}:`, err.message);
  });
});

// ─────────────────────────────────────────────────────────────
// 8. HEARTBEAT — Ping/Pong Keep-Alive
//    WebSocket connections can silently die (network issues,
//    proxies timing out, etc.). We send periodic pings to detect
//    dead connections and clean them up.
//
//    Every 30s: send a ping to all clients
//    If no pong received → mark as dead → terminate
// ─────────────────────────────────────────────────────────────
const HEARTBEAT_INTERVAL = 30_000; // 30 seconds

const heartbeat = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) {
      // No pong received since last ping — connection is dead
      console.log('[WS] 💀 Terminating dead connection (no pong received)');
      ws.terminate();
      return;
    }

    // Mark as potentially dead, wait for pong to confirm alive
    ws.isAlive = false;
    ws.ping(); // Send WebSocket ping frame
  });
}, HEARTBEAT_INTERVAL);

// Handle pong responses (client automatically responds to server pings)
wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => {
    ws.isAlive = true; // Got pong → connection is alive
  });
});

// Stop heartbeat when server closes
wss.on('close', () => clearInterval(heartbeat));

// ─────────────────────────────────────────────────────────────
// 9. Start listening
// ─────────────────────────────────────────────────────────────
server.listen(PORT, () => {
  console.log('');
  console.log('╔══════════════════════════════════════════════════╗');
  console.log('║    WebSocket + Cache Learning Server             ║');
  console.log(`║    HTTP/WS Server: http://localhost:${PORT}        ║`);
  console.log('║    Open client/index.html in your browser        ║');
  console.log('╚══════════════════════════════════════════════════╝');
  console.log('');
  console.log('  Make sure Redis is running: redis-server');
  console.log('  Default Redis: 127.0.0.1:6379');
  console.log('');
});

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('\n[Server] Shutting down...');
  await cache.disconnect();
  server.close(() => {
    console.log('[Server] HTTP server closed');
    process.exit(0);
  });
});
