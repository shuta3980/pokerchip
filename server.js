const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

const rooms = {};

function deepClone(obj) { return JSON.parse(JSON.stringify(obj)); }

function saveSnapshot(room) {
  room.snapshot = deepClone({ players: room.players, pot: room.pot, currentBet: room.currentBet });
}

function generateRoomCode() {
  return Math.floor(1000 + Math.random() * 9000).toString();
}

io.on('connection', (socket) => {
  socket.on('createRoom', ({ playerName }) => {
    let code;
    do { code = generateRoomCode(); } while (rooms[code]);

    rooms[code] = {
      code,
      players: [{ id: socket.id, name: playerName, chips: 1000, bet: 0, folded: false }],
      pot: 0,
      currentBet: 0,
      hostId: socket.id,
      gameStarted: false,
    };

    socket.join(code);
    socket.roomCode = code;
    socket.emit('roomCreated', { code, room: rooms[code] });
  });

  socket.on('joinRoom', ({ roomCode, playerName }) => {
    const room = rooms[roomCode];
    if (!room) return socket.emit('error', { message: '部屋が見つかりません' });
    if (room.players.length >= 6) return socket.emit('error', { message: '部屋が満員です' });
    if (room.gameStarted) return socket.emit('error', { message: 'ゲームはすでに始まっています' });

    room.players.push({ id: socket.id, name: playerName, chips: 1000, bet: 0, folded: false });
    socket.join(roomCode);
    socket.roomCode = roomCode;

    io.to(roomCode).emit('roomUpdated', room);
    socket.emit('joinedRoom', { room });
  });

  socket.on('startGame', () => {
    const room = rooms[socket.roomCode];
    if (!room || socket.id !== room.hostId) return;
    if (room.players.length < 2) return socket.emit('error', { message: '2人以上必要です' });

    room.gameStarted = true;
    room.currentPlayerIndex = 0;
    io.to(room.code).emit('gameStarted', room);
  });

  socket.on('bet', ({ amount }) => {
    const room = rooms[socket.roomCode];
    if (!room) return;
    const player = room.players.find(p => p.id === socket.id);
    if (!player) return;

    saveSnapshot(room);
    const actual = Math.min(amount, player.chips);
    player.chips -= actual;
    player.bet += actual;
    room.pot += actual;
    if (player.bet > room.currentBet) room.currentBet = player.bet;
    io.to(room.code).emit('roomUpdated', room);
  });

  socket.on('call', () => {
    const room = rooms[socket.roomCode];
    if (!room) return;
    const player = room.players.find(p => p.id === socket.id);
    if (!player) return;

    saveSnapshot(room);
    const needed = Math.min(room.currentBet - player.bet, player.chips);
    player.chips -= needed;
    player.bet += needed;
    room.pot += needed;
    io.to(room.code).emit('roomUpdated', room);
  });

  socket.on('check', () => {
    const room = rooms[socket.roomCode];
    if (!room) return;
    io.to(room.code).emit('roomUpdated', room);
  });

  socket.on('fold', () => {
    const room = rooms[socket.roomCode];
    if (!room) return;
    const player = room.players.find(p => p.id === socket.id);
    if (!player) return;

    saveSnapshot(room);
    player.folded = true;
    io.to(room.code).emit('roomUpdated', room);
  });

  socket.on('undo', () => {
    const room = rooms[socket.roomCode];
    if (!room || !room.snapshot) return socket.emit('error', { message: '元に戻せる操作がありません' });

    room.players = room.snapshot.players;
    room.pot = room.snapshot.pot;
    room.currentBet = room.snapshot.currentBet;
    room.snapshot = null;
    io.to(room.code).emit('roomUpdated', room);
    io.to(room.code).emit('undone');
  });

  socket.on('awardPot', ({ winnerId }) => {
    const room = rooms[socket.roomCode];
    if (!room || socket.id !== room.hostId) return;

    const winner = room.players.find(p => p.id === winnerId);
    if (!winner) return;

    winner.chips += room.pot;
    room.pot = 0;
    room.currentBet = 0;
    room.players.forEach(p => { p.bet = 0; p.folded = false; });

    io.to(room.code).emit('potAwarded', { winnerName: winner.name, room });
  });

  socket.on('newHand', () => {
    const room = rooms[socket.roomCode];
    if (!room || socket.id !== room.hostId) return;

    room.pot = 0;
    room.currentBet = 0;
    room.players.forEach(p => { p.bet = 0; p.folded = false; });

    io.to(room.code).emit('roomUpdated', room);
  });

  socket.on('disconnect', () => {
    const code = socket.roomCode;
    if (!code || !rooms[code]) return;

    const room = rooms[code];
    room.players = room.players.filter(p => p.id !== socket.id);

    if (room.players.length === 0) {
      delete rooms[code];
    } else {
      if (room.hostId === socket.id) room.hostId = room.players[0].id;
      io.to(code).emit('roomUpdated', room);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
