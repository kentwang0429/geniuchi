// ================= server.js =================
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const GameManager = require('./gameManager');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const rooms = {};
const gameManager = new GameManager(io, rooms);

app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

io.on('connection', (socket) => {
  // === 房間系統 ===
  socket.on('createRoom', (data, cb) => {
    let roomId = '';
    do {
      roomId = String(Math.floor(11 + Math.random() * 89)); // 11~99
    } while (rooms[roomId]); // 避免撞號

    const room = {
      id: roomId,
      maxPlayers: data.maxPlayers || 4,
      boardSize: 15,
      targetN: 5,
      status: 'LOBBY',
      hostId: socket.id,
      players: [],
      board: gameManager.createEmptyBoard(15),
      turnIndex: 0,
      roundCount: 1,
      ginyuState: null,
      gudoState: null,
      jeiceState: null, // ✅ 吉斯狀態
    };

    room.players.push({
      id: socket.id,
      name: data.name || 'Player',
      ready: false,
      colorIndex: null,
      roleIndex: null,
      placedThisTurn: 0,
      hasPlacedCross: false,
      usedGinyuThisTurn: false,
      usedGudoThisTurn: false,
      usedJeiceThisTurn: false, // ✅
      wins: 0,
    });

    rooms[roomId] = room;
    socket.join(roomId);
    cb({ ok: true, room });
    io.to(roomId).emit('roomUpdated', room);
  });

  socket.on('joinRoom', (data, cb) => {
    const room = rooms[data.roomId];
    if (!room) return cb({ ok: false, message: '房間不存在' });
    if (room.players.length >= room.maxPlayers)
      return cb({ ok: false, message: '房間已滿' });

    room.players.push({
      id: socket.id,
      name: data.name,
      ready: false,
      colorIndex: null,
      roleIndex: null,
      placedThisTurn: 0,
      hasPlacedCross: false,
      usedGinyuThisTurn: false,
      usedGudoThisTurn: false,
      usedJeiceThisTurn: false, // ✅
      wins: 0,
    });

    socket.join(room.id);
    cb({ ok: true, room });
    io.to(room.id).emit('roomUpdated', room);
  });

  // === 玩家設定 ===
  socket.on('pickColor', (data, cb) => {
    const room = rooms[data.roomId];
    const p = room?.players.find((p) => p.id === socket.id);
    if (!p) return cb({ ok: false });
    p.colorIndex = data.colorIndex;
    cb({ ok: true, room });
    io.to(room.id).emit('roomUpdated', room);
  });

  socket.on('pickRole', (data, cb) => {
    const room = rooms[data.roomId];
    const p = room?.players.find((p) => p.id === socket.id);
    if (!p) return cb({ ok: false });
    p.roleIndex = data.roleIndex;
    cb({ ok: true, room });
    io.to(room.id).emit('roomUpdated', room);
  });

  socket.on('readyUp', (data, cb) => {
    const room = rooms[data.roomId];
    const p = room?.players.find((p) => p.id === socket.id);
    if (!p) return cb({ ok: false });
    if (p.colorIndex === null || p.roleIndex === null)
      return cb({ ok: false, message: '請先選擇顏色與角色' });
    p.ready = true;
    cb({ ok: true, room });
    io.to(room.id).emit('roomUpdated', room);
  });

  // === 遊戲控制 ===
  socket.on('startGame', (data) => {
    const room = rooms[data.roomId];
    if (room && room.hostId === socket.id) gameManager.startGame(data.roomId);
  });

  socket.on('place', (data, cb) => {
    gameManager.placePiece(socket, data, cb);
  });

  socket.on('restartGame', (data) => {
    gameManager.restartGame(data.roomId);
  });

  // === 基紐能力事件 ===
  socket.on('ginyuAbilityStart', (data, cb) => {
    gameManager.ginyuAbilityStart(socket, data, cb);
  });

  socket.on('ginyuSelectSource', (data, cb) => {
    gameManager.ginyuSelectSource(socket, data, cb);
  });

  socket.on('ginyuSelectTarget', (data, cb) => {
    gameManager.ginyuSelectTarget(socket, data, cb);
  });

  // ✅ 基紐能力取消（前端反悔/點錯取消）
  socket.on('ginyuCancel', (data, cb) => {
    gameManager.ginyuCancel(socket, data, cb || (() => {}));
  });

  // === 古杜能力事件 ===
  socket.on('gudoAbilityStart', (data, cb) => {
    gameManager.gudoAbilityStart(socket, data, cb);
  });

  socket.on('gudoSelectSource', (data, cb) => {
    gameManager.gudoSelectSource(socket, data, cb);
  });

  socket.on('gudoSelectTarget', (data, cb) => {
    gameManager.gudoSelectTarget(socket, data, cb);
  });

  socket.on('gudoMovePiece', (data, cb) => {
    gameManager.gudoMovePiece(socket, data, cb);
  });

  // ✅ 吉斯能力事件（Jeice）
  socket.on('jeiceAbilityStart', (data, cb) => {
    gameManager.jeiceAbilityStart(socket, data, cb);
  });

  // 吉斯：先落子（只能空格、不能叉叉；落子後回傳可擊退 targets）
  socket.on('jeicePlace', (data, cb) => {
    gameManager.jeicePlace(socket, data, cb);
  });

  // 吉斯：選擇要擊退的相鄰敵方「一般棋」
  socket.on('jeiceSelectTarget', (data, cb) => {
    gameManager.jeiceSelectTarget(socket, data, cb);
  });

  // 吉斯：取消（放棄整段技能流程；若已落子，依 gameManager 規則處理）
  socket.on('jeiceCancel', (data, cb) => {
    gameManager.jeiceCancel(socket, data, cb || (() => {}));
  });

  // === 斷線處理 ===
  socket.on('disconnect', () => {
    for (const roomId in rooms) {
      const room = rooms[roomId];
      const index = room.players.findIndex((p) => p.id === socket.id);
      if (index !== -1) {
        room.players.splice(index, 1);
        io.to(roomId).emit('roomUpdated', room);
        if (room.players.length === 0) delete rooms[roomId];
        break;
      }
    }
  });
});

server.listen(3000, () =>
  console.log('✅ Server running on http://localhost:3000')
);
