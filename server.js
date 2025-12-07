// server.js
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Static files
app.use(express.static(path.join(__dirname, 'public')));

// Basic route
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// In-memory data
// userId -> { name }
const users = new Map();
// userId -> socketId
const userSockets = new Map();
// socketId -> userId
const socketToUser = new Map();

// sessionId -> { type, users: [u1, u2], startedAt }
const activeSessions = new Map();
// userId -> sessionId
const userActiveSession = new Map();

function startSessionRecord(sessionId, type, u1, u2) {
  activeSessions.set(sessionId, {
    type,
    users: [u1, u2],
    startedAt: Date.now(),
  });
  userActiveSession.set(u1, sessionId);
  userActiveSession.set(u2, sessionId);
}

function endSessionRecord(sessionId) {
  if (!sessionId) return;
  const s = activeSessions.get(sessionId);
  if (!s) return;
  activeSessions.delete(sessionId);
  s.users.forEach((u) => {
    if (userActiveSession.get(u) === sessionId) {
      userActiveSession.delete(u);
    }
  });
}

// SOCKET.IO
io.on('connection', (socket) => {
  console.log('Socket connected:', socket.id);

  // User registration
  socket.on('register', (data, cb) => {
    try {
      const { name, existingUserId } = data || {};
      if (!name || !name.trim()) {
        return cb({ ok: false, error: 'Name required' });
      }

      let userId =
        existingUserId && users.has(existingUserId)
          ? existingUserId
          : crypto.randomUUID();

      users.set(userId, { name: name.trim() });
      userSockets.set(userId, socket.id);
      socketToUser.set(socket.id, userId);

      console.log(
        `User registered: ${name} (${userId}) via socket ${socket.id}`
      );

      cb({ ok: true, userId });
    } catch (err) {
      console.error('register error', err);
      cb({ ok: false, error: 'Internal error' });
    }
  });

  // Session request (chat / audio / video)
  socket.on('request-session', (data, cb) => {
    try {
      const { toUserId, type } = data || {};
      const fromUserId = socketToUser.get(socket.id);

      if (!fromUserId) {
        return cb({ ok: false, error: 'Not registered', code: 'not_registered' });
      }
      if (!toUserId || !type) {
        return cb({ ok: false, error: 'Missing fields', code: 'bad_request' });
      }

      const targetSocketId = userSockets.get(toUserId);
      if (!targetSocketId) {
        return cb({ ok: false, error: 'User offline', code: 'offline' });
      }

      // Busy check
      if (userActiveSession.has(toUserId)) {
        return cb({ ok: false, error: 'User busy', code: 'busy' });
      }

      const sessionId = crypto.randomUUID();

      // Session active record
      startSessionRecord(sessionId, type, fromUserId, toUserId);

      // notify other user
      io.to(targetSocketId).emit('incoming-session', {
        sessionId,
        fromUserId,
        type,
      });

      console.log(
        `Session request: type=${type}, sessionId=${sessionId}, from=${fromUserId}, to=${toUserId}`
      );

      cb({ ok: true, sessionId });
    } catch (err) {
      console.error('request-session error', err);
      cb({ ok: false, error: 'Internal error', code: 'internal' });
    }
  });

  // Callee accepts / rejects
  socket.on('answer-session', (data) => {
    try {
      const { sessionId, toUserId, type, accept } = data || {};
      const fromUserId = socketToUser.get(socket.id);
      if (!fromUserId || !sessionId || !toUserId) return;

      const targetSocketId = userSockets.get(toUserId);
      if (!targetSocketId) return;

      // rejectஆனா busy lock remove
      if (!accept) {
        endSessionRecord(sessionId);
      }

      io.to(targetSocketId).emit('session-answered', {
        sessionId,
        fromUserId,
        type,
        accept: !!accept,
      });

      console.log(
        `Session answer: sessionId=${sessionId}, type=${type}, from=${fromUserId}, to=${toUserId}, accept=${!!accept}`
      );
    } catch (err) {
      console.error('answer-session error', err);
    }
  });

  // WebRTC signaling relay
  socket.on('signal', (data) => {
    try {
      const { sessionId, toUserId, signal } = data || {};
      const fromUserId = socketToUser.get(socket.id);
      if (!fromUserId || !sessionId || !toUserId || !signal) return;

      const targetSocketId = userSockets.get(toUserId);
      if (!targetSocketId) return;

      io.to(targetSocketId).emit('signal', {
        sessionId,
        fromUserId,
        signal,
      });
    } catch (err) {
      console.error('signal error', err);
    }
  });

  // Chat message (Socket.IO)
  socket.on('chat-message', (data) => {
    try {
      const { toUserId, text, sessionId, timestamp } = data || {};
      const fromUserId = socketToUser.get(socket.id);
      if (!fromUserId || !toUserId || !text) return;

      const targetSocketId = userSockets.get(toUserId);
      if (!targetSocketId) return;

      io.to(targetSocketId).emit('chat-message', {
        fromUserId,
        text,
        sessionId: sessionId || null,
        timestamp: timestamp || Date.now(),
      });
    } catch (err) {
      console.error('chat-message error', err);
    }
  });

  // Session end (duration logging)
  socket.on('session-ended', (data) => {
    try {
      const { sessionId, toUserId, type, durationMs } = data || {};
      const fromUserId = socketToUser.get(socket.id);
      if (!fromUserId || !sessionId || !toUserId) return;

      // clear busy/both users
      endSessionRecord(sessionId);

      const targetSocketId = userSockets.get(toUserId);
      if (targetSocketId) {
        io.to(targetSocketId).emit('session-ended', {
          sessionId,
          fromUserId,
          type,
          durationMs,
        });
      }

      console.log(
        `Session ended: sessionId=${sessionId}, type=${type}, from=${fromUserId}, to=${toUserId}, duration=${durationMs} ms`
      );
    } catch (err) {
      console.error('session-ended error', err);
    }
  });

  socket.on('disconnect', () => {
    const userId = socketToUser.get(socket.id);
    if (userId) {
      console.log(`Socket disconnected: ${socket.id}, userId=${userId}`);
      socketToUser.delete(socket.id);

      // userஅவங்க sideல இருந்த active session இருந்தா unlock
      const sid = userActiveSession.get(userId);
      endSessionRecord(sid);
    } else {
      console.log('Socket disconnected (no user):', socket.id);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on http://0.0.0.0:${PORT}`);
});
