const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// In-memory only. Nothing is persisted or backed up.
// rooms = { code: { host: socketId, participants: { socketId: username } } }
const rooms = {};

function generateCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no confusing chars
  let code;
  do {
    code = Array.from({ length: 5 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  } while (rooms[code]);
  return code;
}

app.get('/api/create-room', (req, res) => {
  const code = generateCode();
  rooms[code] = { host: null, participants: {} };
  res.json({ code });
});

io.on('connection', (socket) => {
  let joinedRoom = null;
  let username = null;

  socket.on('join-room', ({ code, name, asHost }) => {
    code = (code || '').toUpperCase().trim();
    if (!rooms[code]) {
      // Allow joining a room that doesn't exist yet only if explicitly creating as host
      if (asHost) {
        rooms[code] = { host: null, participants: {} };
      } else {
        socket.emit('join-error', 'Room not found. Check the code and try again.');
        return;
      }
    }

    joinedRoom = code;
    username = (name || 'Guest').slice(0, 24);
    socket.join(code);
    rooms[code].participants[socket.id] = username;

    if (asHost || !rooms[code].host) {
      rooms[code].host = socket.id;
    }

    const isHost = rooms[code].host === socket.id;

    socket.emit('joined', {
      code,
      isHost,
      participants: Object.values(rooms[code].participants),
    });

    socket.to(code).emit('participant-joined', { username, participants: Object.values(rooms[code].participants) });

    // If a stream is already live, tell the new joiner who the host is so they can request the feed
    if (rooms[code].host && rooms[code].host !== socket.id) {
      socket.emit('host-available', { hostId: rooms[code].host });
    }
  });

  // WebRTC signaling relay (mesh: host <-> each viewer)
  socket.on('signal', ({ to, data }) => {
    io.to(to).emit('signal', { from: socket.id, data });
  });

  socket.on('request-stream', () => {
    if (joinedRoom && rooms[joinedRoom] && rooms[joinedRoom].host) {
      io.to(rooms[joinedRoom].host).emit('viewer-wants-stream', { viewerId: socket.id });
    }
  });

  socket.on('chat-message', ({ text }) => {
    if (!joinedRoom || !text) return;
    io.to(joinedRoom).emit('chat-message', {
      username,
      text: String(text).slice(0, 500),
      time: Date.now(),
    });
  });

  socket.on('disconnect', () => {
    if (!joinedRoom || !rooms[joinedRoom]) return;
    const room = rooms[joinedRoom];
    delete room.participants[socket.id];
    const wasHost = room.host === socket.id;
    if (wasHost) room.host = null;

    io.to(joinedRoom).emit('participant-left', {
      username,
      wasHost,
      participants: Object.values(room.participants),
    });

    if (Object.keys(room.participants).length === 0) {
      delete rooms[joinedRoom]; // nothing persisted, room just disappears
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`US Watch running on http://localhost:${PORT}`));
