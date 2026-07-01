/**
 * ============================================================
 * client/app.js — WebSocket Client
 * ============================================================
 *
 * THE WEBSOCKET CLIENT-SIDE FLOW:
 *
 * 1. Create a WebSocket object pointing at ws://server
 * 2. Listen for events:
 *    - 'open'    → connection established, ready to send
 *    - 'message' → received data from server (parse JSON)
 *    - 'close'   → connection lost, try to reconnect
 *    - 'error'   → something went wrong
 * 3. Send messages with ws.send(JSON.stringify(data))
 * 4. Implement reconnection logic for robustness
 *
 * ============================================================
 */

// ── App State ──────────────────────────────────────────────
const state = {
  ws: null,               // The WebSocket instance
  connected: false,       // Is the WS connection open?
  currentUser: null,      // { id, username, color }
  currentRoom: null,      // { id, name }
  typingTimeout: null,    // Timer for typing indicator
  isTyping: false,        // Are we currently in "typing" state?
  pingTime: null,         // Timestamp of last ping (for latency)
  reconnectAttempts: 0,   // How many reconnection tries
  reconnectTimer: null,   // setTimeout reference for reconnect
  onlineUsers: [],        // Users currently in the room
};

const WS_URL    = 'ws://127.0.0.1:3000';
const MAX_RETRY = 5;       // Give up reconnecting after this many tries
const PING_INTERVAL = 15_000; // Send ping every 15 seconds

// ── DOM References ─────────────────────────────────────────
const $ = (id) => document.getElementById(id);

const loginScreen    = $('login-screen');
const chatScreen     = $('chat-screen');
const loginForm      = $('login-form');
const usernameInput  = $('username-input');
const roomInput      = $('room-input');
const joinBtn        = $('join-btn');
const connectionHint = $('connection-status-hint');
const wsStatus       = $('ws-status');
const messagesEl     = $('messages');
const messageInput   = $('message-input');
const sendBtn        = $('send-btn');
const typingBar      = $('typing-bar');
const typingText     = $('typing-text');
const currentRoomName = $('current-room-name');
const onlineCountEl  = $('online-count');
const onlineUsersEl  = $('online-users');
const roomListEl     = $('room-list');
const latencyValue   = $('latency-value');
const charCount      = $('char-count');
const rateLimitWarn  = $('rate-limit-warning');
const rateLimitText  = $('rate-limit-text');
const roomModal      = $('room-modal');
const newRoomInput   = $('new-room-input');

// ── Screen Transitions ─────────────────────────────────────
function showScreen(name) {
  // Fade between screens
  const screens = document.querySelectorAll('.screen');
  screens.forEach((s) => {
    s.classList.remove('active');
  });
  const target = name === 'login' ? loginScreen : chatScreen;
  target.style.display = name === 'chat' ? 'flex' : 'flex';
  // Trigger reflow then add active class for CSS transition
  requestAnimationFrame(() => target.classList.add('active'));
}

// ══════════════════════════════════════════════════════════
// WEBSOCKET CONNECTION
// ══════════════════════════════════════════════════════════

/**
 * Open a WebSocket connection to the server.
 *
 * new WebSocket(url) does three things:
 *   1. Sends an HTTP GET with "Upgrade: websocket" header
 *   2. Server responds 101 Switching Protocols
 *   3. Connection becomes a persistent two-way channel
 */
function connect() {
  if (state.ws && state.ws.readyState === WebSocket.OPEN) return;

  setConnectionStatus('connecting');
  console.log(`[WS Client] Connecting to ${WS_URL}...`);

  // Create WebSocket — this starts the handshake immediately
  state.ws = new WebSocket(WS_URL);

  // ── Event: Connection Opened ───────────────────────────
  state.ws.addEventListener('open', () => {
    console.log('[WS Client] ✅ Connected!');
    state.connected = true;
    state.reconnectAttempts = 0;
    clearTimeout(state.reconnectTimer);
    setConnectionStatus('connected');
    connectionHint.textContent = 'Connected! Enter your username to join.';
    startPingLoop(); // Begin heartbeat pings
  });

  // ── Event: Message Received ────────────────────────────
  // Server sends JSON: { type, payload, timestamp }
  state.ws.addEventListener('message', (event) => {
    let parsed;
    try {
      parsed = JSON.parse(event.data);
    } catch {
      console.error('[WS Client] Received non-JSON message:', event.data);
      return;
    }

    const { type, payload } = parsed;
    console.log(`[WS Client] 📨 Received: type="${type}"`);

    // Route to handler based on message type
    handleServerMessage(type, payload);
  });

  // ── Event: Connection Closed ───────────────────────────
  // This fires whether WE closed it or the server did
  state.ws.addEventListener('close', (event) => {
    console.log(`[WS Client] 🔴 Connection closed (code: ${event.code})`);
    state.connected = false;
    setConnectionStatus('disconnected');
    stopPingLoop();

    // Don't reconnect if we deliberately closed (code 1000 = normal)
    if (event.code !== 1000) {
      scheduleReconnect();
    }
  });

  // ── Event: Error ───────────────────────────────────────
  state.ws.addEventListener('error', (err) => {
    console.error('[WS Client] ⚠️  WebSocket error:', err);
    connectionHint.textContent = 'Cannot connect to server. Is it running?';
    setConnectionStatus('disconnected');
  });
}

/**
 * Send a JSON message to the server.
 * @param {string} type    - Message type (matches server switch cases)
 * @param {object} payload - Data to send
 */
function send(type, payload = {}) {
  if (!state.ws || state.ws.readyState !== WebSocket.OPEN) {
    console.warn('[WS Client] Tried to send but not connected');
    return;
  }
  state.ws.send(JSON.stringify({ type, payload }));
}

/**
 * Gracefully close the WebSocket connection.
 * Code 1000 = "Normal Closure" (tells server we're done intentionally)
 */
function disconnect() {
  stopPingLoop();
  if (state.ws) {
    state.ws.close(1000, 'User disconnected');
    state.ws = null;
  }
  state.connected = false;
  state.currentUser = null;
  state.currentRoom = null;
  resetChatUI();
  showScreen('login');
}

// ══════════════════════════════════════════════════════════
// RECONNECTION LOGIC
// When connection drops unexpectedly, try to reconnect
// with exponential backoff (increasing delay between attempts)
// ══════════════════════════════════════════════════════════
function scheduleReconnect() {
  if (state.reconnectAttempts >= MAX_RETRY) {
    connectionHint.textContent = `Could not reconnect after ${MAX_RETRY} attempts.`;
    console.log('[WS Client] Max reconnect attempts reached. Giving up.');
    return;
  }

  state.reconnectAttempts++;

  // Exponential backoff: 1s, 2s, 4s, 8s, 16s ...
  const delay = Math.min(1000 * Math.pow(2, state.reconnectAttempts - 1), 16000);

  console.log(`[WS Client] Reconnecting in ${delay}ms (attempt ${state.reconnectAttempts}/${MAX_RETRY})...`);
  connectionHint.textContent = `Connection lost. Reconnecting in ${(delay / 1000).toFixed(0)}s...`;

  state.reconnectTimer = setTimeout(() => {
    connect();
  }, delay);
}

// ══════════════════════════════════════════════════════════
// HEARTBEAT — Ping/Pong Keep-Alive
// We send periodic ping messages to:
//   1. Detect if connection is still alive
//   2. Measure round-trip latency
// ══════════════════════════════════════════════════════════
let pingInterval = null;

function startPingLoop() {
  stopPingLoop();
  pingInterval = setInterval(() => {
    if (state.ws?.readyState === WebSocket.OPEN) {
      state.pingTime = Date.now();
      send('ping');
    }
  }, PING_INTERVAL);
}

function stopPingLoop() {
  clearInterval(pingInterval);
  pingInterval = null;
}

// ══════════════════════════════════════════════════════════
// SERVER MESSAGE HANDLER
// Dispatch incoming messages to the right UI updater
// ══════════════════════════════════════════════════════════
function handleServerMessage(type, payload) {
  switch (type) {

    case 'welcome':
      // Server confirmed connection, update available rooms
      renderRoomList(payload.availableRooms || []);
      break;

    case 'joined':
      // Successfully joined a room — update all UI
      state.currentUser = payload.user;
      state.currentRoom = payload.room;
      state.onlineUsers = payload.onlineUsers || [];

      showScreen('chat');
      currentRoomName.textContent = payload.room.name;
      $('message-input').placeholder = `Message #${payload.room.name}`;

      // Render history from cache
      renderMessageHistory(payload.history || []);
      renderOnlineUsers(state.onlineUsers);
      updateRoomList(payload.room);
      requestStats();
      break;

    case 'switched_room':
      state.currentRoom = payload.room;
      state.onlineUsers = payload.onlineUsers || [];
      currentRoomName.textContent = payload.room.name;
      $('message-input').placeholder = `Message #${payload.room.name}`;
      clearMessages();
      renderMessageHistory(payload.history || []);
      renderOnlineUsers(state.onlineUsers);
      updateRoomList(payload.room);
      requestStats();
      break;

    case 'new_message':
      appendMessage(payload);
      break;

    case 'user_joined':
      state.onlineUsers = payload.onlineUsers || [];
      renderOnlineUsers(state.onlineUsers);
      appendSystemMessage(`${payload.user.username} joined the room`);
      break;

    case 'user_left':
      state.onlineUsers = payload.onlineUsers || [];
      renderOnlineUsers(state.onlineUsers);
      appendSystemMessage(`${payload.user?.username || 'Someone'} left the room`);
      break;

    case 'typing_indicator':
      handleTypingIndicator(payload);
      break;

    case 'rate_limited':
      showRateLimitWarning(payload.message, payload.resetIn);
      break;

    case 'stats':
      renderCacheStats(payload.cacheMetrics);
      renderRoomList(payload.rooms || []);
      break;

    case 'pong':
      if (state.pingTime) {
        const latencyMs = Date.now() - state.pingTime;
        latencyValue.textContent = latencyMs;
        state.pingTime = null;
      }
      break;

    case 'error':
      console.error('[WS Client] Server error:', payload.message);
      showToast(payload.message, 'error');
      break;

    default:
      console.log('[WS Client] Unknown message type:', type);
  }
}

// ══════════════════════════════════════════════════════════
// UI RENDERING
// ══════════════════════════════════════════════════════════

/** Update WebSocket connection status badge */
function setConnectionStatus(status) {
  wsStatus.className = `status-indicator ${status}`;
  const texts = { connected: 'Connected', disconnected: 'Disconnected', connecting: 'Connecting...' };
  wsStatus.querySelector('.status-text').textContent = texts[status] || status;
}

/** Get initials for user avatar */
function getInitials(username) {
  return username.slice(0, 2).toUpperCase();
}

/** Render the list of available rooms in the sidebar */
function renderRoomList(rooms) {
  roomListEl.innerHTML = '';
  const defaultRooms = rooms.length
    ? rooms
    : [{ name: 'general' }, { name: 'javascript' }, { name: 'redis' }, { name: 'websockets' }];

  defaultRooms.forEach((room) => {
    const div = document.createElement('div');
    div.className = `room-item ${state.currentRoom?.name === room.name ? 'active' : ''}`;
    div.dataset.room = room.name;
    div.innerHTML = `
      <span class="room-hash-prefix">#</span>
      <span>${room.name}</span>
      ${room.onlineCount > 0 ? `<span class="room-count">${room.onlineCount}</span>` : ''}
    `;
    div.addEventListener('click', () => switchRoom(room.name));
    roomListEl.appendChild(div);
  });
}

/** Update the active room highlight in sidebar */
function updateRoomList(activeRoom) {
  document.querySelectorAll('.room-item').forEach((el) => {
    el.classList.toggle('active', el.dataset.room === activeRoom.name);
  });
}

/** Render online users list in sidebar */
function renderOnlineUsers(users) {
  onlineCountEl.textContent = users.length;
  onlineUsersEl.innerHTML = '';
  users.forEach((user) => {
    const div = document.createElement('div');
    div.className = 'user-item';
    div.innerHTML = `
      <div class="user-avatar" style="background: ${user.color}">${getInitials(user.username)}</div>
      <span>${user.username}${user.id === state.currentUser?.id ? ' (you)' : ''}</span>
    `;
    onlineUsersEl.appendChild(div);
  });
}

/** Render message history from cache with a divider */
function renderMessageHistory(messages) {
  clearMessages();

  if (messages.length === 0) return;

  // Add a visual divider to indicate these are cached messages
  const divider = document.createElement('div');
  divider.className = 'history-divider';
  divider.textContent = `${messages.length} cached messages`;
  messagesEl.appendChild(divider);

  messages.forEach((msg) => appendMessage(msg, false)); // false = don't animate history
  scrollToBottom();
}

/** Append a new message to the chat */
function appendMessage(msg, animate = true) {
  const empty = $('messages-empty');
  if (empty) empty.remove();

  const group = document.createElement('div');
  group.className = 'message-group';
  if (!animate) group.style.animation = 'none';

  const time = new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  group.innerHTML = `
    <div class="message-avatar" style="background: ${msg.color}">${getInitials(msg.username)}</div>
    <div class="message-body">
      <div class="message-meta">
        <span class="message-author" style="color: ${msg.color}">${escapeHtml(msg.username)}</span>
        <span class="message-time">${time}</span>
      </div>
      <div class="message-text">${escapeHtml(msg.text)}</div>
    </div>
  `;

  messagesEl.appendChild(group);

  // Auto-scroll if user is near the bottom
  const isNearBottom = messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 120;
  if (isNearBottom || animate) scrollToBottom();
}

/** Append a system message (join/leave) */
function appendSystemMessage(text) {
  const div = document.createElement('div');
  div.className = 'system-message';
  div.innerHTML = `<span class="sys-dot"></span>${escapeHtml(text)}`;
  messagesEl.appendChild(div);
  scrollToBottom();
}

/** Clear all chat messages */
function clearMessages() {
  messagesEl.innerHTML = '';
}

/** Handle typing indicators from other users */
const typingUsers = new Map(); // userId → username

function handleTypingIndicator({ userId, username, isTyping }) {
  if (isTyping) {
    typingUsers.set(userId, username);
  } else {
    typingUsers.delete(userId);
  }

  if (typingUsers.size === 0) {
    typingText.textContent = '';
  } else {
    const names = Array.from(typingUsers.values()).join(', ');
    typingText.textContent = `${names} ${typingUsers.size === 1 ? 'is' : 'are'} typing...`;
  }
}

/** Render cache metrics in sidebar */
function renderCacheStats(metrics) {
  if (!metrics) return;
  $('stat-hits').textContent    = metrics.hits ?? '—';
  $('stat-misses').textContent  = metrics.misses ?? '—';
  $('stat-hitrate').textContent = metrics.hitRate ?? '—';
  $('stat-sets').textContent    = metrics.sets ?? '—';
}

/** Show rate limit warning banner */
function showRateLimitWarning(message, resetIn) {
  rateLimitWarn.classList.remove('hidden');
  rateLimitText.textContent = `${message} (resets in ${resetIn}s)`;
  clearTimeout(rateLimitWarn._timer);
  rateLimitWarn._timer = setTimeout(() => {
    rateLimitWarn.classList.add('hidden');
  }, (resetIn + 1) * 1000);
}

/** Scroll chat to bottom */
function scrollToBottom() {
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

/** Escape HTML to prevent XSS */
function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Reset chat UI to blank state */
function resetChatUI() {
  clearMessages();
  state.onlineUsers = [];
  onlineUsersEl.innerHTML = '';
  typingUsers.clear();
  typingText.textContent = '';
}

/** Request stats from server */
function requestStats() {
  send('get_stats');
}

/** Switch to a different room */
function switchRoom(roomName) {
  if (roomName === state.currentRoom?.name) return;
  send('switch_room', { room: roomName });
}

// ══════════════════════════════════════════════════════════
// EVENT LISTENERS
// ══════════════════════════════════════════════════════════

// ── Login form submit ──────────────────────────────────────
loginForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const username = usernameInput.value.trim();
  const room = roomInput.value.trim() || 'general';

  if (!username) return;
  if (!state.connected) {
    connectionHint.textContent = 'Not connected to server. Make sure `npm start` is running.';
    return;
  }

  joinBtn.disabled = true;
  joinBtn.querySelector('span').textContent = 'Joining...';
  send('join', { username, room });
});

// ── Room preset chips ──────────────────────────────────────
document.querySelectorAll('.room-chip').forEach((chip) => {
  chip.addEventListener('click', () => {
    document.querySelectorAll('.room-chip').forEach((c) => c.classList.remove('active'));
    chip.classList.add('active');
    roomInput.value = chip.dataset.room;
  });
});

// ── Send message ───────────────────────────────────────────
function sendMessage() {
  const text = messageInput.value.trim();
  if (!text || !state.connected) return;

  send('send_message', { text });
  messageInput.value = '';
  charCount.textContent = '500';
  charCount.className = 'char-count';
  messageInput.style.height = 'auto';

  // Stop typing indicator
  if (state.isTyping) {
    state.isTyping = false;
    send('typing', { isTyping: false });
  }
}

sendBtn.addEventListener('click', sendMessage);

messageInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});

// ── Character counter & typing indicator ──────────────────
messageInput.addEventListener('input', () => {
  // Auto-resize textarea
  messageInput.style.height = 'auto';
  messageInput.style.height = Math.min(messageInput.scrollHeight, 140) + 'px';

  // Update character counter
  const remaining = 500 - messageInput.value.length;
  charCount.textContent = remaining;
  charCount.className = 'char-count' + (remaining < 50 ? ' warn' : '') + (remaining < 10 ? ' danger' : '');

  // Typing indicator
  if (messageInput.value.length > 0) {
    if (!state.isTyping) {
      state.isTyping = true;
      send('typing', { isTyping: true });
    }
    clearTimeout(state.typingTimeout);
    state.typingTimeout = setTimeout(() => {
      state.isTyping = false;
      send('typing', { isTyping: false });
    }, 2000); // Stop typing indicator after 2s of no input
  } else {
    if (state.isTyping) {
      state.isTyping = false;
      send('typing', { isTyping: false });
    }
  }
});

// ── Disconnect button ──────────────────────────────────────
$('disconnect-btn').addEventListener('click', () => {
  if (confirm('Disconnect from the server?')) {
    disconnect();
  }
});

// ── Stats button ───────────────────────────────────────────
$('stats-btn').addEventListener('click', requestStats);
$('refresh-stats-btn').addEventListener('click', requestStats);

// ── Add room modal ─────────────────────────────────────────
$('add-room-btn').addEventListener('click', () => {
  roomModal.classList.remove('hidden');
  newRoomInput.focus();
});

$('cancel-room-btn').addEventListener('click', () => {
  roomModal.classList.add('hidden');
  newRoomInput.value = '';
});

$('confirm-room-btn').addEventListener('click', () => {
  const name = newRoomInput.value.trim().toLowerCase().replace(/\s+/g, '-');
  if (!name) return;
  roomModal.classList.add('hidden');
  newRoomInput.value = '';
  switchRoom(name);
});

$('room-modal').querySelector('.modal-backdrop').addEventListener('click', () => {
  roomModal.classList.add('hidden');
});

newRoomInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('confirm-room-btn').click();
  if (e.key === 'Escape') $('cancel-room-btn').click();
});

// ── Mobile sidebar ─────────────────────────────────────────
$('mobile-sidebar-btn').addEventListener('click', () => {
  document.querySelector('.sidebar').classList.toggle('open');
});

$('sidebar-toggle').addEventListener('click', () => {
  document.querySelector('.sidebar').classList.toggle('open');
});

// ── Simple toast notification ──────────────────────────────
function showToast(message, type = 'info') {
  const toast = document.createElement('div');
  toast.style.cssText = `
    position: fixed; bottom: 80px; right: 20px; z-index: 999;
    background: var(--bg-elevated); border: 1px solid var(--border);
    padding: 10px 16px; border-radius: 8px; font-size: 0.85rem;
    color: ${type === 'error' ? 'var(--red)' : 'var(--text-primary)'};
    box-shadow: var(--shadow-md); animation: msg-in 0.2s ease;
    max-width: 300px;
  `;
  toast.textContent = message;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 4000);
}

// ══════════════════════════════════════════════════════════
// INITIALIZATION
// ══════════════════════════════════════════════════════════
// Start connecting immediately when the page loads
connect();

// Populate sidebar with default rooms while connecting
renderRoomList([]);
