/**
 * ============================================================
 * chatRoom.js — Chat Room & Message Management
 * ============================================================
 *
 * This module manages:
 *  1. Chat rooms (create, join, leave)
 *  2. Message history (stored in Redis lists — Write-Through pattern)
 *  3. Online presence (who's in which room)
 *  4. Room metadata (cached with TTL)
 *
 * CACHE PATTERNS DEMONSTRATED:
 *  - Write-Through: Messages written to cache simultaneously with "storage"
 *  - Cache-Aside:   Room history loaded from cache, fallback to "DB" on miss
 *  - TTL:           Room data expires after inactivity
 */

const cache = require('./cache');
const { v4: uuidv4 } = require('uuid');

// ---------------------------------------------------------------
// In-memory structures (simulates what would normally be a database)
// In production, you'd replace these with PostgreSQL/MongoDB queries
// ---------------------------------------------------------------

// rooms: { roomId → { id, name, createdAt, description } }
const rooms = new Map();

// presence: { roomId → Set<userId> }
// Tracks who is currently in each room
const presence = new Map();

// userInfo: { userId → { id, username, color } }
const userInfo = new Map();

// ---------------------------------------------------------------
// ROOM MANAGEMENT
// ---------------------------------------------------------------

/**
 * Create or retrieve a chat room
 * @param {string} name - Room name (e.g., "general", "javascript")
 * @returns {object} The room object
 */
function getOrCreateRoom(name) {
  // Find existing room by name
  for (const [, room] of rooms) {
    if (room.name === name) return room;
  }

  // Create a new room
  const room = {
    id: uuidv4(),
    name,
    description: `Chat room: ${name}`,
    createdAt: new Date().toISOString(),
  };

  rooms.set(room.id, room);
  presence.set(room.id, new Set());
  console.log(`[ChatRoom] Created room "${name}" (${room.id})`);
  return room;
}

/**
 * Get all available rooms with online user counts
 * @returns {Array} List of room summaries
 */
function getAllRooms() {
  return Array.from(rooms.values()).map((room) => ({
    ...room,
    onlineCount: presence.get(room.id)?.size || 0,
  }));
}

// ---------------------------------------------------------------
// USER MANAGEMENT
// ---------------------------------------------------------------

/**
 * Register a new user connection
 * @param {string} username - Chosen display name
 * @returns {object} User object with generated ID and color
 */
function registerUser(username) {
  const userId = uuidv4();

  // Assign a random color to the user for visual distinction in UI
  const colors = [
    '#60a5fa', '#34d399', '#f472b6', '#a78bfa',
    '#fb923c', '#38bdf8', '#4ade80', '#f87171',
  ];
  const color = colors[Math.floor(Math.random() * colors.length)];

  const user = { id: userId, username, color, joinedAt: new Date().toISOString() };
  userInfo.set(userId, user);
  console.log(`[ChatRoom] Registered user "${username}" (${userId})`);
  return user;
}

/**
 * Get user info by ID
 */
function getUser(userId) {
  return userInfo.get(userId) || null;
}

/**
 * Remove a user entirely (on disconnect)
 */
function removeUser(userId) {
  // Remove from all rooms they were in
  for (const [roomId, users] of presence) {
    users.delete(userId);
  }
  userInfo.delete(userId);
  console.log(`[ChatRoom] Removed user ${userId}`);
}

// ---------------------------------------------------------------
// PRESENCE (Who's Online)
// ---------------------------------------------------------------

/**
 * Add a user to a room's presence list
 */
function joinRoom(roomId, userId) {
  if (!presence.has(roomId)) {
    presence.set(roomId, new Set());
  }
  presence.get(roomId).add(userId);
  console.log(`[ChatRoom] User ${userId} joined room ${roomId}`);
}

/**
 * Remove a user from a room's presence list
 */
function leaveRoom(roomId, userId) {
  presence.get(roomId)?.delete(userId);
  console.log(`[ChatRoom] User ${userId} left room ${roomId}`);
}

/**
 * Get all online users in a room (with their info)
 */
function getRoomPresence(roomId) {
  const userIds = presence.get(roomId) || new Set();
  return Array.from(userIds)
    .map((uid) => userInfo.get(uid))
    .filter(Boolean); // Filter out undefined (disconnected users)
}

// ---------------------------------------------------------------
// MESSAGE HISTORY (Cache-Aside + Write-Through)
// ---------------------------------------------------------------

/**
 * Save a new message
 *
 * WRITE-THROUGH PATTERN:
 *   We store the message in Redis immediately after it's created.
 *   In a real app, you'd also insert it into PostgreSQL/MongoDB here.
 *   Both writes happen together so cache and DB stay in sync.
 *
 * @param {string} roomId  - Room the message belongs to
 * @param {object} message - The message object
 */
async function saveMessage(roomId, message) {
  const key = `messages:${roomId}`;

  // Write-Through: push to cache immediately
  // Keep max 50 messages per room, expire list after 2 hours of inactivity
  await cache.listPush(key, message, 50, 7200);

  // In production, you'd also do:
  // await db.messages.insert(message);
}

/**
 * Load recent message history for a room
 *
 * CACHE-ASIDE PATTERN:
 *   1. Check Redis for the message list
 *   2. If MISS → load from "database" (simulated here as empty)
 *   3. Populate cache so next request is a HIT
 *
 * @param {string} roomId - Room to fetch history for
 * @returns {Promise<Array>} List of recent messages (oldest first)
 */
async function getMessageHistory(roomId) {
  const key = `messages:${roomId}`;

  // Step 1: Try cache first
  const cached = await cache.listGet(key);

  if (cached.length > 0) {
    // CACHE HIT — return immediately (fast!)
    console.log(`[ChatRoom] Message history CACHE HIT for room "${roomId}" (${cached.length} messages)`);
    return cached;
  }

  // CACHE MISS — in production, fetch from database here:
  // const fromDB = await db.messages.findByRoom(roomId, { limit: 50 });
  // await cache.listPush(key, ...fromDB); // Populate cache
  // return fromDB;

  console.log(`[ChatRoom] Message history CACHE MISS for room "${roomId}" — no history yet`);
  return [];
}

module.exports = {
  getOrCreateRoom,
  getAllRooms,
  registerUser,
  getUser,
  removeUser,
  joinRoom,
  leaveRoom,
  getRoomPresence,
  saveMessage,
  getMessageHistory,
};
