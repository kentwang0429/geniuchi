// ================= server.js (ROOM TTL + REJOIN BY NAME + UNDO + BLOCK NEW JOIN DURING PLAYING) =================
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const GameManager = require('./gameManager');

const app = express();
const server = http.createServer(app);

// ✅ 建議加上 transports 與 cors（Render / 跨網域時比較穩）
const io = new Server(server, {
  cors: { origin: '*' },
  transports: ['websocket', 'polling'],
});

const rooms = {};
const gameManager = new GameManager(io, rooms);

app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ===== Room keep-alive =====
// ✅ 房間 5 分鐘內不清除（保留棋局/回合/狀態），斷線重整可用「同名」回來
const ROOM_TTL_MS = 5 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 30 * 1000;

function now() {
  return Date.now();
}

function touchRoom(room) {
  if (!room) return;
  room.lastActiveAt = now();
}

function markConnected(room, socketId, isConnected) {
  if (!room?.players) return;
  const p = room.players.find((pp) => pp.id === socketId);
  if (!p) return;
  p.connected = isConnected;
  p.lastSeenAt = now();
  touchRoom(room);
}

function anyConnected(room) {
  return room?.players?.some((p) => p.connected);
}

setInterval(() => {
  const t = now();
  for (const roomId of Object.keys(rooms)) {
    const room = rooms[roomId];
    if (!room) continue;

    const last = room.lastActiveAt || 0;
    const expired = t - last > ROOM_TTL_MS;

    // ✅ 只有「全部都不在線」且過期才刪
    if (expired && !anyConnected(room)) {
      delete rooms[roomId];
    }
  }
}, CLEANUP_INTERVAL_MS);

io.on('connection', (socket) => {
  // ✅ 讓前端可送心跳（可有可無，但保險）
  socket.on('pingRoom', (data, cb) => {
    const room = rooms[data?.roomId];
    if (room) touchRoom(room);
    cb && cb({ ok: true });
  });

  socket.on('createRoom', (data, cb) => {
    let roomId = '';
    do {
      roomId = String(Math.floor(11 + Math.random() * 89));
    } while (rooms[roomId]);

    const mode = data?.mode === 'DUAL' ? 'DUAL' : 'SINGLE';

    const room = {
      id: roomId,
      mode,
      maxPlayers: data?.maxPlayers || 4,
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
      lastActiveAt: now(),
    };

    const name = (data?.name || 'Player').trim() || 'Player';

    room.players.push({
      id: socket.id,
      name,
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

      connected: true,
      lastSeenAt: now(),
    });

    rooms[roomId] = room;
    socket.join(roomId);

    touchRoom(room);

    cb({ ok: true, room });
    io.to(roomId).emit('roomUpdated', room);
  });

  socket.on('joinRoom', (data, cb) => {
    const room = rooms[data?.roomId];
    if (!room) return cb({ ok: false, message: '房間不存在' });

    const name = (data?.name || '').trim();
    if (!name) return cb({ ok: false, message: '請輸入名稱' });

    touchRoom(room);

    // ✅ 1) 若房內已有「同名且在線」玩家：不允許再加入（避免重名分身）
    const sameNameOnline = room.players.find((p) => p.name === name && p.connected);
    if (sameNameOnline) {
      return cb({ ok: false, message: '此名稱已在房內使用中' });
    }

    // ✅ 2) 同名重連：如果房內已存在同名「離線玩家」，就把他接回來（保留棋局、回合、勝場、角色、顏色…）
    const existing = room.players.find((p) => p.name === name && !p.connected);

    if (existing) {
      existing.id = socket.id;
      existing.connected = true;
      existing.lastSeenAt = now();

      // 如果房主離線又回來，也同步 hostId（避免 hostId 指向不存在的 socket）
      if (!room.hostId || room.hostId === null) {
        room.hostId = socket.id;
      }

      socket.join(room.id);

      cb({ ok: true, room, rejoined: true });
      io.to(room.id).emit('roomUpdated', room);

      // ✅ 讓所有人同步最新棋盤/回合（尤其是重連者）
      io.to(room.id).emit('placed', {
        board: room.board,
        turnIndex: room.turnIndex,
        turnSlot: room.turnSlot || 1,
        roundCount: room.roundCount,
        status: room.status,
      });

      return;
    }

    // ✅ 3) ⭐重要：棋局開始後，禁止任何「非同名回歸」的新玩家加入
    //    只要不是 LOBBY，就視為棋局中（包含 PLAYING / ENDED）
    if (room.status !== 'LOBBY') {
      return cb({ ok: false, message: '該房間棋局已開始' });
    }

    // ✅ 4) 正常加入（只限 LOBBY）
    if (room.players.length >= room.maxPlayers)
      return cb({ ok: false, message: '房間已滿' });

    room.players.push({
      id: socket.id,
      name,
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

      connected: true,
      lastSeenAt: now(),
    });

    socket.join(room.id);

    cb({ ok: true, room, rejoined: false });
    io.to(room.id).emit('roomUpdated', room);
  });

  // ✅ 退出房間：真正移除玩家（不走保留）
  socket.on('leaveRoom', (data, cb) => {
    const room = rooms[data?.roomId];
    if (!room) return cb({ ok: false, message: '房間不存在' });

    const idx = room.players.findIndex((p) => p.id === socket.id);
    if (idx === -1) return cb({ ok: false, message: '你不在此房間' });

    room.players.splice(idx, 1);
    socket.leave(room.id);

    // 若房主走了，轉交房主（簡單處理：第一位在線玩家，否則第一位玩家）
    if (room.hostId === socket.id) {
      const online = room.players.find((p) => p.connected);
      room.hostId = online?.id || room.players[0]?.id || null;
    }

    if (room.players.length === 0) {
      delete rooms[room.id];
    } else {
      touchRoom(room);
      io.to(room.id).emit('roomUpdated', room);
    }

    cb({ ok: true });
  });

  socket.on('pickColor', (data, cb) => {
    const room = rooms[data?.roomId];
    if (!room) return cb({ ok: false, message: '房間不存在' });

    const p = room.players.find((pp) => pp.id === socket.id);
    if (!p) return cb({ ok: false, message: '玩家不存在' });

    p.colorIndex = data?.colorIndex ?? null;
    touchRoom(room);

    cb({ ok: true, room });
    io.to(room.id).emit('roomUpdated', room);
  });

  socket.on('pickRole', (data, cb) => {
    const room = rooms[data?.roomId];
    if (!room) return cb({ ok: false, message: '房間不存在' });

    const p = room.players.find((pp) => pp.id === socket.id);
    if (!p) return cb({ ok: false, message: '玩家不存在' });

    const roleIndex = data?.roleIndex;
    const slot = data?.slot;

    touchRoom(room);

    if (room.mode !== 'DUAL') {
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
    const room = rooms[data?.roomId];
    if (!room) return cb({ ok: false, message: '房間不存在' });

    const p = room.players.find((pp) => pp.id === socket.id);
    if (!p) return cb({ ok: false, message: '玩家不存在' });

    if (p.colorIndex === null) {
      return cb({ ok: false, message: '請先選擇顏色' });
    }

    if (room.mode === 'DUAL') {
      if (p.roleIndex1 === null || p.roleIndex2 === null) {
        return cb({ ok: false, message: 'DUAL 模式請先選擇 角色1 與 角色2' });
      }
    } else {
      if (p.roleIndex === null) {
        return cb({ ok: false, message: '請先選擇角色' });
      }
    }

    p.ready = true;
    touchRoom(room);

    cb({ ok: true, room });
    io.to(room.id).emit('roomUpdated', room);
  });

  socket.on('startGame', (data) => {
    const room = rooms[data?.roomId];
    if (!room) return;

    // ✅ 只能在 LOBBY 才能開始
    if (room.hostId === socket.id && room.status === 'LOBBY') {
      touchRoom(room);
      gameManager.startGame(room.id);
    }
  });

  socket.on('place', (data, cb) => {
    const room = rooms[data?.roomId];
    if (room) touchRoom(room);
    gameManager.placePiece(socket, data, cb);
  });

  // ✅ 新增：悔棋（巴特/羅根第 1 手）
  socket.on('undoMove', (data, cb) => {
    const room = rooms[data?.roomId];
    if (room) touchRoom(room);
    gameManager.undoMove(socket, data, cb);
  });

  socket.on('restartGame', (data) => {
    const room = rooms[data?.roomId];
    if (room) touchRoom(room);
    gameManager.restartGame(data.roomId);
  });

  socket.on('ginyuAbilityStart', (data, cb) => {
    const room = rooms[data?.roomId];
    if (room) touchRoom(room);
    gameManager.ginyuAbilityStart(socket, data, cb);
  });

  socket.on('ginyuSelectSource', (data, cb) => {
    const room = rooms[data?.roomId];
    if (room) touchRoom(room);
    gameManager.ginyuSelectSource(socket, data, cb);
  });

  socket.on('ginyuSelectTarget', (data, cb) => {
    const room = rooms[data?.roomId];
    if (room) touchRoom(room);
    gameManager.ginyuSelectTarget(socket, data, cb);
  });

  socket.on('ginyuCancel', (data, cb) => {
    const room = rooms[data?.roomId];
    if (room) touchRoom(room);
    gameManager.ginyuCancel(socket, data, cb || (() => {}));
  });

  socket.on('gudoAbilityStart', (data, cb) => {
    const room = rooms[data?.roomId];
    if (room) touchRoom(room);
    gameManager.gudoAbilityStart(socket, data, cb);
  });

  socket.on('gudoSelectSource', (data, cb) => {
    const room = rooms[data?.roomId];
    if (room) touchRoom(room);
    gameManager.gudoSelectSource(socket, data, cb);
  });

  socket.on('gudoSelectTarget', (data, cb) => {
    const room = rooms[data?.roomId];
    if (room) touchRoom(room);
    gameManager.gudoSelectTarget(socket, data, cb);
  });

  socket.on('gudoMovePiece', (data, cb) => {
    const room = rooms[data?.roomId];
    if (room) touchRoom(room);
    gameManager.gudoMovePiece(socket, data, cb);
  });

  socket.on('jeiceAbilityStart', (data, cb) => {
    const room = rooms[data?.roomId];
    if (room) touchRoom(room);
    gameManager.jeiceAbilityStart(socket, data, cb);
  });

  socket.on('jeicePlace', (data, cb) => {
    const room = rooms[data?.roomId];
    if (room) touchRoom(room);
    gameManager.jeicePlace(socket, data, cb);
  });

  socket.on('jeiceSelectTarget', (data, cb) => {
    const room = rooms[data?.roomId];
    if (room) touchRoom(room);
    gameManager.jeiceSelectTarget(socket, data, cb);
  });

  socket.on('jeiceCancel', (data, cb) => {
    const room = rooms[data?.roomId];
    if (room) touchRoom(room);
    gameManager.jeiceCancel(socket, data, cb || (() => {}));
  });

  socket.on('disconnect', () => {
    // ✅ 斷線不踢人：只標記離線，保留 5 分鐘
    for (const roomId in rooms) {
      const room = rooms[roomId];
      const index = room.players.findIndex((p) => p.id === socket.id);
      if (index !== -1) {
        room.players[index].connected = false;
        room.players[index].lastSeenAt = now();
        touchRoom(room);

        // 若房主離線：暫時轉交給在線玩家（避免開局按鈕失效）
        if (room.hostId === socket.id) {
          const online = room.players.find((p) => p.connected);
          room.hostId = online?.id || room.hostId;
        }

        io.to(roomId).emit('roomUpdated', room);
        break;
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));
