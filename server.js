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
  socket.on('createRoom', (data, cb) => {
    let roomId = '';
    do {
      roomId = String(Math.floor(11 + Math.random() * 89));
    } while (rooms[roomId]);

    const mode = data?.mode === 'DUAL' ? 'DUAL' : 'SINGLE';

    const room = {
      id: roomId,
      mode,
      maxPlayers: data.maxPlayers || 4,
      boardSize: 15,
      targetN: 5,
      status: 'LOBBY',
      hostId: socket.id,
      players: [],
      board: gameManager.createEmptyBoard(15),
      turnIndex: 0,
      turnSlot: mode === 'DUAL' ? 1 : 1,
      roundCount: 1,
      ginyuState: null,
      gudoState: null,
      jeiceState: null,
    };

    room.players.push({
      id: socket.id,
      name: data.name || 'Player',
      ready: false,
      colorIndex: null,

      roleIndex: null,
      roleIndex1: null,
      roleIndex2: null,

      placedThisTurn: 0,
      hasPlacedCross: false,
      usedGinyuThisTurn: false,
      usedGudoThisTurn: false,
      usedJeiceThisTurn: false,
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
      roleIndex1: null,
      roleIndex2: null,

      placedThisTurn: 0,
      hasPlacedCross: false,
      usedGinyuThisTurn: false,
      usedGudoThisTurn: false,
      usedJeiceThisTurn: false,
      wins: 0,
    });

    socket.join(room.id);
    cb({ ok: true, room });
    io.to(room.id).emit('roomUpdated', room);
  });

  // ✅ 新增：退出房間（防呆 UI）
  socket.on('leaveRoom', (data, cb) => {
    const room = rooms[data.roomId];
    if (!room) return cb({ ok: false, message: '房間不存在' });

    const idx = room.players.findIndex((p) => p.id === socket.id);
    if (idx === -1) return cb({ ok: false, message: '你不在此房間' });

    room.players.splice(idx, 1);
    socket.leave(room.id);

    // 若房主走了，轉交房主（簡單處理：第一位玩家）
    if (room.hostId === socket.id) {
      room.hostId = room.players[0]?.id || null;
    }

    if (room.players.length === 0) {
      delete rooms[room.id];
    } else {
      io.to(room.id).emit('roomUpdated', room);
    }

    cb({ ok: true });
  });

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
    if (!p) return cb({ ok: false, message: '玩家不存在' });

    const roleIndex = data.roleIndex;
    const slot = data.slot;

    if (room?.mode !== 'DUAL') {
      p.roleIndex = roleIndex;
      cb({ ok: true, room });
      io.to(room.id).emit('roomUpdated', room);
      return;
    }

    if (slot !== 1 && slot !== 2) {
      return cb({ ok: false, message: 'DUAL 模式請指定角色槽位(slot=1/2)' });
    }

    const other = slot === 1 ? p.roleIndex2 : p.roleIndex1;
    if (typeof other === 'number' && other === roleIndex) {
      return cb({
        ok: false,
        message: '同一玩家的 角色1 / 角色2 不能選相同角色',
      });
    }

    if (slot === 1) p.roleIndex1 = roleIndex;
    else p.roleIndex2 = roleIndex;

    cb({ ok: true, room });
    io.to(room.id).emit('roomUpdated', room);
  });

  socket.on('readyUp', (data, cb) => {
    const room = rooms[data.roomId];
    const p = room?.players.find((p) => p.id === socket.id);
    if (!p) return cb({ ok: false });

    if (p.colorIndex === null) {
      return cb({ ok: false, message: '請先選擇顏色' });
    }

    if (room?.mode === 'DUAL') {
      if (p.roleIndex1 === null || p.roleIndex2 === null) {
        return cb({ ok: false, message: 'DUAL 模式請先選擇 角色1 與 角色2' });
      }
    } else {
      if (p.roleIndex === null) {
        return cb({ ok: false, message: '請先選擇角色' });
      }
    }

    p.ready = true;
    cb({ ok: true, room });
    io.to(room.id).emit('roomUpdated', room);
  });

  socket.on('startGame', (data) => {
    const room = rooms[data.roomId];
    // ✅ 修改：只能在 LOBBY 才能開始（避免賽後倒數看棋盤時誤開新局）
    if (room && room.hostId === socket.id && room.status === 'LOBBY') {
      gameManager.startGame(data.roomId);
    }
  });

  socket.on('place', (data, cb) => {
    gameManager.placePiece(socket, data, cb);
  });

  socket.on('restartGame', (data) => {
    gameManager.restartGame(data.roomId);
  });

  socket.on('ginyuAbilityStart', (data, cb) => {
    gameManager.ginyuAbilityStart(socket, data, cb);
  });

  socket.on('ginyuSelectSource', (data, cb) => {
    gameManager.ginyuSelectSource(socket, data, cb);
  });

  socket.on('ginyuSelectTarget', (data, cb) => {
    gameManager.ginyuSelectTarget(socket, data, cb);
  });

  socket.on('ginyuCancel', (data, cb) => {
    gameManager.ginyuCancel(socket, data, cb || (() => {}));
  });

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

  socket.on('jeiceAbilityStart', (data, cb) => {
    gameManager.jeiceAbilityStart(socket, data, cb);
  });

  socket.on('jeicePlace', (data, cb) => {
    gameManager.jeicePlace(socket, data, cb);
  });

  socket.on('jeiceSelectTarget', (data, cb) => {
    gameManager.jeiceSelectTarget(socket, data, cb);
  });

  socket.on('jeiceCancel', (data, cb) => {
    gameManager.jeiceCancel(socket, data, cb || (() => {}));
  });

  socket.on('disconnect', () => {
    for (const roomId in rooms) {
      const room = rooms[roomId];
      const index = room.players.findIndex((p) => p.id === socket.id);
      if (index !== -1) {
        room.players.splice(index, 1);
        io.to(roomId).emit('roomUpdated', room);
        if (room.hostId === socket.id) {
          room.hostId = room.players[0]?.id || null;
        }
        if (room.players.length === 0) delete rooms[roomId];
        break;
      }
    }
  });
});

server.listen(3000, () =>
  console.log('✅ Server running on http://localhost:3000')
);
