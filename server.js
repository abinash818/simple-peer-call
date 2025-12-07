// server.js
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// public folderல உள்ள static files serve பண்ண
app.use(express.static(path.join(__dirname, 'public')));

// Home page
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Socket.IO logic
io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

  // Optional: client தன் பெயர் / userId அனுப்பலாம்
  socket.on('register', (userId) => {
    socket.data.userId = userId;
    console.log(`User ${socket.id} registered as ${userId}`);
  });

  // One-to-one call request
  socket.on('call-user', ({ to }) => {
    console.log(`Call request from ${socket.id} to ${to}`);
    io.to(to).emit('incoming-call', { from: socket.id });
  });

  // simple-peer signaling relay
  socket.on('signal', ({ to, signal }) => {
    console.log(`Signal from ${socket.id} to ${to}`);
    io.to(to).emit('signal', { from: socket.id, signal });
  });

  socket.on('disconnect', () => {
    console.log('User disconnected:', socket.id);
  });
});

const PORT = 3000;
server.listen(PORT, () => {
  console.log(`Server running at http://0.0.0.0:${PORT}`);
});
