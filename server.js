const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// In-memory only. Nothing is persisted or backed up.
// rooms are keyed by a stable internal roomId that never changes for a room's lifetime.
// inviteCodes maps the *visible, shareable* code -> roomId, and can be rotated freely
// without touching anyone's socket.io room membership.
// rooms = { roomId: { host: socketId, participants: { socketId: {name, color} }, currentCode } }
const rooms = {};
const inviteCodes = {};

// A fixed, high-contrast palette so every participant gets a distinct,
// consistent chat/name color for the life of the room.
const COLOR_PALETTE = ['#7d72c9', '#e8a33d', '#4caf7d', '#c9614f', '#5aa9c9', '#c97db0', '#c9b25a', '#8f83db'];

function generateCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no confusing chars
  let code;
  do {
    code = Array.from({ length: 5 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  } while (inviteCodes[code]);
  return code;
}

function publicParticipants(room) {
  return Object.entries(room.participants).map(([id, p]) => ({ id, name: p.name, color: p.color }));
}

app.get('/api/create-room', (req, res) => {
  const code = generateCode();
  const roomId = code; // fine to reuse as the internal id at creation time
  rooms[roomId] = { host: null, participants: {}, currentCode: code };
  inviteCodes[code] = roomId;
  res.json({ code });
});

function cleanupRoom(roomId) {
  delete rooms[roomId];
  Object.keys(inviteCodes).forEach((c) => {
    if (inviteCodes[c] === roomId) delete inviteCodes[c];
  });
}

io.on('connection', (socket) => {
  let joinedRoom = null; // this holds the stable roomId, not the visible code
  let username = null;

  socket.on('join-room', ({ code, name, asHost }) => {
    code = (code || '').toUpperCase().trim();
    let roomId = inviteCodes[code];

    if (!roomId) {
      if (asHost) {
        roomId = code;
        rooms[roomId] = { host: null, participants: {}, currentCode: code };
        inviteCodes[code] = roomId;
      } else {
        socket.emit('join-error', 'Room not found. Check the code and try again.');
        return;
      }
    }

    const room = rooms[roomId];
    joinedRoom = roomId;
    username = (name || 'Guest').slice(0, 24);
    socket.join(roomId);

    const color = COLOR_PALETTE[Object.keys(room.participants).length % COLOR_PALETTE.length];
    room.participants[socket.id] = { name: username, color };

    if (asHost || !room.host) {
      room.host = socket.id;
    }

    const isHost = room.host === socket.id;

    socket.emit('joined', {
      code: room.currentCode,
      isHost,
      selfId: socket.id,
      color,
      participants: publicParticipants(room),
    });

    socket.to(roomId).emit('participant-joined', {
      id: socket.id,
      username,
      color,
      participants: publicParticipants(room),
    });

    if (room.host && room.host !== socket.id) {
      socket.emit('host-available', { hostId: room.host });
    }
  });

  // WebRTC signaling relay for the screen share (mesh: host <-> each viewer)
  socket.on('signal', ({ to, data }) => {
    io.to(to).emit('signal', { from: socket.id, data });
  });

  // Separate signaling channel for voice chat (mic audio), kept distinct
  // from screen-share signaling since they're independent peer connections.
  socket.on('voice-signal', ({ to, data }) => {
    io.to(to).emit('voice-signal', { from: socket.id, data });
  });

  socket.on('voice-stopped', () => {
    if (joinedRoom) socket.to(joinedRoom).emit('voice-stopped', { from: socket.id });
  });

  socket.on('request-stream', () => {
    if (joinedRoom && rooms[joinedRoom] && rooms[joinedRoom].host) {
      io.to(rooms[joinedRoom].host).emit('viewer-wants-stream', { viewerId: socket.id });
    }
  });

  // Host tells the room a stream just became available, so anyone who
  // already asked (and got nothing, because sharing hadn't started yet)
  // knows to ask again.
  socket.on('sharing-started', () => {
    if (joinedRoom) socket.to(joinedRoom).emit('sharing-started');
  });

  socket.on('sharing-stopped', () => {
    if (joinedRoom) socket.to(joinedRoom).emit('sharing-stopped');
  });

  // Host requests a fresh shareable code. The room's internal id (and
  // everyone's socket.io membership) never changes — only the public code
  // does, so old links/codes stop working immediately without kicking
  // anyone already in the room.
  socket.on('regen-code', () => {
    if (!joinedRoom || !rooms[joinedRoom] || rooms[joinedRoom].host !== socket.id) return;
    const oldCode = rooms[joinedRoom].currentCode;
    const newCode = generateCode();
    delete inviteCodes[oldCode];
    inviteCodes[newCode] = joinedRoom;
    rooms[joinedRoom].currentCode = newCode;
    io.to(joinedRoom).emit('code-changed', { code: newCode });
  });

  socket.on('chat-message', ({ text }) => {
    if (!joinedRoom || !rooms[joinedRoom] || !text) return;
    const me = rooms[joinedRoom].participants[socket.id];
    io.to(joinedRoom).emit('chat-message', {
      username,
      color: me ? me.color : null,
      text: String(text).slice(0, 500),
      time: Date.now(),
    });
  });

  // A viewer can't truly pause/seek the host's screen share (it's a live
  // mirror, not a file we control) — so instead we relay a request to the
  // host, who can act on it in their own player, and let everyone see the
  // ask in chat for transparency.
  socket.on('playback-request', ({ action, label }) => {
    if (!joinedRoom || !rooms[joinedRoom]) return;
    const hostId = rooms[joinedRoom].host;
    if (!hostId || hostId === socket.id) return;
    io.to(hostId).emit('playback-request', { username, action, label });
    io.to(joinedRoom).emit('system-message', { text: `${username} requested: ${label}` });
  });

  socket.on('disconnect', () => {
    if (!joinedRoom || !rooms[joinedRoom]) return;
    const room = rooms[joinedRoom];
    delete room.participants[socket.id];
    const wasHost = room.host === socket.id;
    if (wasHost) room.host = null;

    io.to(joinedRoom).emit('participant-left', {
      id: socket.id,
      username,
      wasHost,
      participants: publicParticipants(room),
    });

    if (Object.keys(room.participants).length === 0) {
      cleanupRoom(joinedRoom);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`US Watch running on http://localhost:${PORT}`));
