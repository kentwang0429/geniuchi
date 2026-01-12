// ================= server.js (ROOM TTL + REJOIN BY NAME + UNDO + BLOCK NEW JOIN DURING PLAYING + AI ADD/CONFIG) =================
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const GameManager = require('./gameManager');

const app = express();
const server = http.createServer(app);

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

// ===== Helpers for AI/config =====
function isHost(room, socketId) {
  return room?.hostId === socketId;
}

function findPlayer(room, playerId) {
  return room?.players?.find((p) => p.id === playerId) || null;
}

function anyAI(room) {
  return room?.players?.some((p) => p.isAI);
}

function genAiId(roomId) {
  return `ai:${roomId}:${Math.floor(1000 + Math.random() * 9000)}`;
}

function randomInt(n) {
  return Math.floor(Math.random() * n);
}

function randomRoleIndex(excludeSet = new Set()) {
  const pool = [];
  for (let i = 0; i <= 5; i++) if (!excludeSet.has(i)) pool.push(i);
  if (!pool.length) return null;
  return pool[randomInt(pool.length)];
}

// ✅ 統一用 gameManager 的 roomUpdated（包含 roleInfo / turnMeta）
function emitRoomUpdated(room) {
  if (!room) return;
  if (typeof gameManager._emitRoomUpdated === 'function') {
    gameManager._emitRoomUpdated(room.id, room);
  } else {
    io.to(room.id).emit('roomUpdated', room);
  }
}

// ✅ 配置完成判斷（顏色 + 角色(單/雙)）
function isPlayerConfigured(room, p) {
  if (!room || !p) return false;
  if (p.colorIndex === null || p.colorIndex === undefined) return false;

  if (room.mode === 'DUAL') {
    const a = p.roleIndex1;
    const b = p.roleIndex2;
    if (typeof a !== 'number' || typeof b !== 'number') return false;
    if (a === b) return false;
    return true;
  } else {
    return typeof p.roleIndex === 'number';
  }
}

// ✅ AI 自動 READY：只要配置完成就 ready=true
function autoReadyIfAi(room, p) {
  if (!room || !p) return;
  if (p.isAI) {
    p.ready = isPlayerConfigured(room, p);
  }
}

setInterval(() => {
  const t = now();
  for (const roomId of Object.keys(rooms)) {
    const room = rooms[roomId];
    if (!room) continue;

    const last = room.lastActiveAt || 0;
    const expired = t - last > ROOM_TTL_MS;

    if (expired && !anyConnected(room)) {
      delete rooms[roomId];
    }
  }
}, CLEANUP_INTERVAL_MS);

io.on('connection', (socket) => {
  // ✅ AI host controls (role / color) - 多事件名 alias + cb 防呆
  const wrapCb = (cb) => (typeof cb === 'function' ? cb : () => {});

  // ---- Role ----
  socket.on('setAiRole', (payload, cb) => gameManager.setAiRole?.(socket, payload, wrapCb(cb)));
  socket.on('setAIRole', (payload, cb) => gameManager.setAiRole?.(socket, payload, wrapCb(cb)));
  socket.on('aiPickRole', (payload, cb) => gameManager.setAiRole?.(socket, payload, wrapCb(cb)));
  socket.on('pickRoleFor', (payload, cb) => gameManager.setAiRole?.(socket, payload, wrapCb(cb)));
  socket.on('pickRoleByHost', (payload, cb) => gameManager.setAiRole?.(socket, payload, wrapCb(cb)));
  socket.on('hostSetAiRole', (payload, cb) => gameManager.setAiRole?.(socket, payload, wrapCb(cb)));

  // ---- Color ----
  socket.on('setAiColor', (payload, cb) => gameManager.setAiColor?.(socket, payload, wrapCb(cb)));
  socket.on('setAIColor', (payload, cb) => gameManager.setAiColor?.(socket, payload, wrapCb(cb)));
  socket.on('aiPickColor', (payload, cb) => gameManager.setAiColor?.(socket, payload, wrapCb(cb)));
  socket.on('pickColorFor', (payload, cb) => gameManager.setAiColor?.(socket, payload, wrapCb(cb)));
  socket.on('pickColorByHost', (payload, cb) => gameManager.setAiColor?.(socket, payload, wrapCb(cb)));
  socket.on('hostSetAiColor', (payload, cb) => gameManager.setAiColor?.(socket, payload, wrapCb(cb)));


  // =========================
  // ✅ NEW: Kick / Remove player & AI (host-only)  (前端可先 emit；後端已接好)
  // =========================
  const _forceLeaveRoom = (targetSocketId, roomId) => {
    try {
      const s = io.sockets?.sockets?.get(targetSocketId);
      if (s) s.leave(roomId);
    } catch (e) {}
  };

  const _emitKicked = (targetSocketId, roomId, reason) => {
    try {
      io.to(targetSocketId).emit('kicked', { roomId, reason: reason || 'kicked' });
      // alias：有些前端可能監聽不同事件名
      io.to(targetSocketId).emit('forceLeave', { roomId, reason: reason || 'kicked' });
      io.to(targetSocketId).emit('leftRoom', { roomId, forced: true, reason: reason || 'kicked' });
    } catch (e) {}
  };

  const _hostRemoveImpl = (payload, cb, onlyAI) => {
    cb = wrapCb(cb);
    let __cbCalled = false;
    const __safeCb = (v) => {
      if (__cbCalled) return;
      __cbCalled = true;
      try { cb(v); } catch (e) {}
    };
    cb = __safeCb;

    try {

    const roomId = payload?.roomId;
    const room = rooms[roomId];
    if (!room) return cb({ ok: false, message: '房間不存在' });

    touchRoom(room);

    if (!isHost(room, socket.id)) return cb({ ok: false, message: '只有房主可以踢人/移除 AI' });

    // ✅ 目標：人類需要指定；AI 可不指定（預設移除第一個 AI）
    const target = payload?.playerId || payload?.targetId || payload?.target || payload?.name || null;

    if (!onlyAI) {
      if (!target) return cb({ ok: false, message: '請指定要踢出的玩家' });
      // 不允許踢自己（房主）
      if (target === socket.id) return cb({ ok: false, message: '不可踢出自己' });
    }

    const reason = payload?.reason || (onlyAI ? 'remove_ai' : 'kick_player');

    // ✅ 交給 gameManager 做「從 players 移除 + turnIndex 安全修正 + roomUpdated/turnInfo」
    gameManager.removePlayer?.(roomId, { target, onlyAI: !!onlyAI, reason }, (res) => {
      if (!res?.ok) return cb(res);

      // ✅ 若踢的是真人：強制離開 socket room，並通知回大廳
      const rid = roomId;
      const removedId = res?.removed?.id;

      if (removedId && typeof removedId === 'string' && !String(removedId).startsWith('ai:')) {
        _forceLeaveRoom(removedId, rid);
        _emitKicked(removedId, rid, reason);
      }

      // ✅ 房間空了就清掉
      if ((room.players?.length || 0) === 0) {
        delete rooms[rid];
      } else {
        touchRoom(room);
      }

      cb({ ok: true, removed: res?.removed || null, room: rooms[rid] || null });
    });
    } catch (e) {
      try { console.error('[kick/remove] error', e); } catch (_) {}
      try { cb({ ok: false, message: 'server error' }); } catch (_) {}
    }

  };

  // ---- Player kick ----
  socket.on('kickPlayer', (payload, cb) => _hostRemoveImpl(payload, cb, false));
  socket.on('kick', (payload, cb) => _hostRemoveImpl(payload, cb, false));
  socket.on('removePlayer', (payload, cb) => _hostRemoveImpl(payload, cb, false));
  socket.on('hostKickPlayer', (payload, cb) => _hostRemoveImpl(payload, cb, false));
  socket.on('forceKick', (payload, cb) => _hostRemoveImpl(payload, cb, false));

  // ---- AI remove ----
  socket.on('removeAi', (payload, cb) => _hostRemoveImpl(payload, cb, true));
  socket.on('removeAI', (payload, cb) => _hostRemoveImpl(payload, cb, true));
  socket.on('kickAi', (payload, cb) => _hostRemoveImpl(payload, cb, true));
  socket.on('kickAI', (payload, cb) => _hostRemoveImpl(payload, cb, true));
  socket.on('deleteAi', (payload, cb) => _hostRemoveImpl(payload, cb, true));
  socket.on('deleteAI', (payload, cb) => _hostRemoveImpl(payload, cb, true));


  socket.on('removeBot', (payload, cb) => _hostRemoveImpl(payload, cb, true));
  socket.on('removeNpc', (payload, cb) => _hostRemoveImpl(payload, cb, true));
  socket.on('removeNPC', (payload, cb) => _hostRemoveImpl(payload, cb, true));
  socket.on('deleteBot', (payload, cb) => _hostRemoveImpl(payload, cb, true));
  socket.on('deleteNpc', (payload, cb) => _hostRemoveImpl(payload, cb, true));
  socket.on('kickBot', (payload, cb) => _hostRemoveImpl(payload, cb, true));
  socket.on('kickNpc', (payload, cb) => _hostRemoveImpl(payload, cb, true));
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
    emitRoomUpdated(room);
  });

  socket.on('joinRoom', (data, cb) => {
    const room = rooms[data?.roomId];
    if (!room) return cb({ ok: false, message: '房間不存在' });

    const name = (data?.name || '').trim();
    if (!name) return cb({ ok: false, message: '請輸入名稱' });

    touchRoom(room);

    if (name.toLowerCase() === 'ai') {
      return cb({ ok: false, message: '此名稱保留，請換一個' });
    }

    const sameNameOnline = room.players.find((p) => p.name === name && p.connected);
    if (sameNameOnline) {
      return cb({ ok: false, message: '此名稱已在房內使用中' });
    }

    const existing = room.players.find((p) => p.name === name && !p.connected);

    if (existing) {
      if (existing.isAI) {
        return cb({ ok: false, message: '此名稱保留，請換一個' });
      }

      existing.id = socket.id;
      existing.connected = true;
      existing.lastSeenAt = now();

      if (!room.hostId || room.hostId === null) {
        room.hostId = socket.id;
      }

      socket.join(room.id);

      cb({ ok: true, room, rejoined: true });
      emitRoomUpdated(room);

      io.to(room.id).emit('placed', {
        board: room.board,
        turnIndex: room.turnIndex,
        turnSlot: room.turnSlot || 1,
        roundCount: room.roundCount,
        status: room.status,
      });

      return;
    }

    if (room.status !== 'LOBBY') {
      return cb({ ok: false, message: '該房間棋局已開始' });
    }

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
    emitRoomUpdated(room);
  });

  socket.on('leaveRoom', (data, cb) => {
    const room = rooms[data?.roomId];
    if (!room) return cb({ ok: false, message: '房間不存在' });

    const idx = room.players.findIndex((p) => p.id === socket.id);
    if (idx === -1) return cb({ ok: false, message: '你不在此房間' });

    room.players.splice(idx, 1);
    socket.leave(room.id);

    if (room.hostId === socket.id) {
      const online = room.players.find((p) => p.connected);
      room.hostId = online?.id || room.players[0]?.id || null;
    }

    if (room.players.length === 0) {
      delete rooms[room.id];
    } else {
      touchRoom(room);
      emitRoomUpdated(room);
    }

    cb({ ok: true });
  });

  // =========================
  // ✅ NEW: AI (host-only)
  // =========================

  socket.on('addAi', (data, cb) => {
    const room = rooms[data?.roomId];
    if (!room) return cb?.({ ok: false, message: '房間不存在' });

    touchRoom(room);

    if (!isHost(room, socket.id)) return cb?.({ ok: false, message: '只有房主可以新增 AI' });
    if (room.status !== 'LOBBY') return cb?.({ ok: false, message: '遊戲開始後不可新增 AI' });

    if (anyAI(room)) return cb?.({ ok: false, message: 'AI 已存在' });

    if (room.players.length >= room.maxPlayers) return cb?.({ ok: false, message: '房間已滿' });

    const aiId = genAiId(room.id);

    room.players.push({
      id: aiId,
      name: 'AI',
      isAI: true,

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

      connected: false,
      lastSeenAt: now(),
    });

    emitRoomUpdated(room);
    cb?.({ ok: true, room, aiId });
  });

  // ✅ NEW：一次隨機 AI 的 顏色+角色，並自動 READY
  socket.on('randomAiSetup', (data, cb) => {
    const room = rooms[data?.roomId];
    if (!room) return cb?.({ ok: false, message: '房間不存在' });

    touchRoom(room);

    if (!isHost(room, socket.id)) return cb?.({ ok: false, message: '只有房主可以替 AI 隨機' });
    if (room.status !== 'LOBBY') return cb?.({ ok: false, message: '遊戲開始後不可隨機 AI' });

    const ai = data?.playerId ? findPlayer(room, data.playerId) : (room.players.find((p) => p.isAI) || null);
    if (!ai || !ai.isAI) return cb?.({ ok: false, message: 'AI 玩家不存在' });

    const colorCount = Number.isInteger(data?.colorCount) && data.colorCount > 0 ? data.colorCount : 8;

    const used = new Set(room.players.filter((p) => p !== ai).map((p) => p.colorIndex).filter((v) => Number.isInteger(v)));
    const colorPool = [];
    for (let i = 0; i < colorCount; i++) if (!used.has(i)) colorPool.push(i);

    const pool = colorPool.length ? colorPool : Array.from({ length: colorCount }, (_, i) => i);
    ai.colorIndex = pool[randomInt(pool.length)];

    if (room.mode === 'DUAL') {
      const r1 = randomRoleIndex();
      const r2 = randomRoleIndex(new Set([r1]));
      if (r1 === null || r2 === null) return cb?.({ ok: false, message: '沒有可用角色' });
      ai.roleIndex1 = r1;
      ai.roleIndex2 = r2;
    } else {
      const r = randomRoleIndex();
      if (r === null) return cb?.({ ok: false, message: '沒有可用角色' });
      ai.roleIndex = r;
    }

    autoReadyIfAi(room, ai);

    emitRoomUpdated(room);
    cb?.({
      ok: true,
      aiId: ai.id,
      colorIndex: ai.colorIndex,
      roleIndex: room.mode === 'DUAL' ? null : ai.roleIndex,
      roleIndex1: room.mode === 'DUAL' ? ai.roleIndex1 : null,
      roleIndex2: room.mode === 'DUAL' ? ai.roleIndex2 : null,
      ready: ai.ready,
    });
  });

  // ✅ 房主幫某玩家（含 AI）設定顏色
  socket.on('setPlayerColor', (data, cb) => {
    const room = rooms[data?.roomId];
    if (!room) return cb?.({ ok: false, message: '房間不存在' });

    touchRoom(room);

    if (!isHost(room, socket.id)) return cb?.({ ok: false, message: '只有房主可以設定他人顏色' });

    const targetId = data?.playerId;
    const colorIndex = data?.colorIndex ?? null;

    const p = findPlayer(room, targetId);
    if (!p) return cb?.({ ok: false, message: '玩家不存在' });

    p.colorIndex = colorIndex;

    // ✅ AI：若配置齊，自動 READY
    autoReadyIfAi(room, p);

    emitRoomUpdated(room);
    cb?.({ ok: true, room });
  });

  // ✅ 房主幫某玩家（含 AI）設定角色（DUAL 要帶 slot=1/2）
  socket.on('setPlayerRole', (data, cb) => {
    const room = rooms[data?.roomId];
    if (!room) return cb?.({ ok: false, message: '房間不存在' });

    touchRoom(room);

    if (!isHost(room, socket.id)) return cb?.({ ok: false, message: '只有房主可以設定他人角色' });

    const targetId = data?.playerId;
    const roleIndex = data?.roleIndex;
    const slot = data?.slot;

    const p = findPlayer(room, targetId);
    if (!p) return cb?.({ ok: false, message: '玩家不存在' });

    if (typeof roleIndex !== 'number') return cb?.({ ok: false, message: 'roleIndex 無效' });

    if (room.mode !== 'DUAL') {
      p.roleIndex = roleIndex;

      autoReadyIfAi(room, p);
      emitRoomUpdated(room);
      return cb?.({ ok: true, room });
    }

    if (slot !== 1 && slot !== 2) {
      return cb?.({ ok: false, message: 'DUAL 模式請指定角色槽位(slot=1/2)' });
    }

    const other = slot === 1 ? p.roleIndex2 : p.roleIndex1;
    if (typeof other === 'number' && other === roleIndex) {
      return cb?.({ ok: false, message: '同一玩家的 角色1 / 角色2 不能選相同角色' });
    }

    if (slot === 1) p.roleIndex1 = roleIndex;
    else p.roleIndex2 = roleIndex;

    autoReadyIfAi(room, p);
    emitRoomUpdated(room);
    cb?.({ ok: true, room });
  });

  // ✅ 房主幫某玩家（含 AI）隨機角色（DUAL 保證兩槽不重複）
  socket.on('randomRole', (data, cb) => {
    const room = rooms[data?.roomId];
    if (!room) return cb?.({ ok: false, message: '房間不存在' });

    touchRoom(room);

    if (!isHost(room, socket.id)) return cb?.({ ok: false, message: '只有房主可以替他人隨機角色' });

    const targetId = data?.playerId;
    const slot = data?.slot ?? 1;

    const p = findPlayer(room, targetId);
    if (!p) return cb?.({ ok: false, message: '玩家不存在' });

    if (room.mode !== 'DUAL') {
      const pick = randomRoleIndex();
      if (pick === null) return cb?.({ ok: false, message: '沒有可用角色' });
      p.roleIndex = pick;

      autoReadyIfAi(room, p);
      emitRoomUpdated(room);
      return cb?.({ ok: true, room, roleIndex: pick });
    }

    if (slot !== 1 && slot !== 2) {
      return cb?.({ ok: false, message: 'DUAL 模式請指定角色槽位(slot=1/2)' });
    }

    const exclude = new Set();
    if (slot === 1 && typeof p.roleIndex2 === 'number') exclude.add(p.roleIndex2);
    if (slot === 2 && typeof p.roleIndex1 === 'number') exclude.add(p.roleIndex1);

    const pick = randomRoleIndex(exclude);
    if (pick === null) return cb?.({ ok: false, message: '沒有可用角色' });

    if (slot === 1) p.roleIndex1 = pick;
    else p.roleIndex2 = pick;

    autoReadyIfAi(room, p);
    emitRoomUpdated(room);
    cb?.({ ok: true, room, roleIndex: pick, slot });
  });

  socket.on('setPlayerReady', (data, cb) => {
    const room = rooms[data?.roomId];
    if (!room) return cb?.({ ok: false, message: '房間不存在' });

    touchRoom(room);

    if (!isHost(room, socket.id)) return cb?.({ ok: false, message: '只有房主可以設定他人準備' });

    const targetId = data?.playerId;
    const ready = !!data?.ready;

    const p = findPlayer(room, targetId);
    if (!p) return cb?.({ ok: false, message: '玩家不存在' });

    p.ready = ready;
    emitRoomUpdated(room);
    cb?.({ ok: true, room });
  });

  // =========================
  // Existing events
  // =========================

  socket.on('pickColor', (data, cb) => {
    const room = rooms[data?.roomId];
    if (!room) return cb({ ok: false, message: '房間不存在' });

    const p = room.players.find((pp) => pp.id === socket.id);
    if (!p) return cb({ ok: false, message: '玩家不存在' });

    p.colorIndex = data?.colorIndex ?? null;
    touchRoom(room);

    cb({ ok: true, room });
    emitRoomUpdated(room);
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
      emitRoomUpdated(room);
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
    emitRoomUpdated(room);
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
      if (p.roleIndex1 === p.roleIndex2) {
        return cb({ ok: false, message: 'DUAL 的 角色1 / 角色2 不能重複' });
      }
    } else {
      if (p.roleIndex === null) {
        return cb({ ok: false, message: '請先選擇角色' });
      }
    }

    p.ready = true;
    touchRoom(room);

    cb({ ok: true, room });
    emitRoomUpdated(room);
  });

  // ✅ startGame：後端硬檢查（真人要 ready；AI 會自動 ready）
  socket.on('startGame', (data, cb) => {
    const room = rooms[data?.roomId];
    if (!room) return cb?.({ ok: false, message: '房間不存在' });

    if (room.hostId !== socket.id) return cb?.({ ok: false, message: '只有房主可以開始' });
    if (room.status !== 'LOBBY') return cb?.({ ok: false, message: '目前不在大廳狀態' });

    // ✅ 保險：先刷新 AI ready 狀態
    for (const p of room.players) autoReadyIfAi(room, p);

    const notConfigured = room.players.filter((p) => !isPlayerConfigured(room, p));
    if (notConfigured.length) {
      return cb?.({ ok: false, message: '尚有人未選擇完成（顏色/角色）' });
    }

    const notReadyHumans = room.players.filter((p) => !p.isAI && !p.ready);
    if (notReadyHumans.length) {
      return cb?.({ ok: false, message: '尚有人未準備' });
    }

    touchRoom(room);
    gameManager.startGame(room.id);
    cb?.({ ok: true });
  });

  socket.on('place', (data, cb) => {
    const room = rooms[data?.roomId];
    if (room) touchRoom(room);
    gameManager.placePiece(socket, data, cb);
  });

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
    for (const roomId in rooms) {
      const room = rooms[roomId];
      const index = room.players.findIndex((p) => p.id === socket.id);
      if (index !== -1) {
        room.players[index].connected = false;
        room.players[index].lastSeenAt = now();
        touchRoom(room);

        if (room.hostId === socket.id) {
          const online = room.players.find((p) => p.connected);
          room.hostId = online?.id || room.hostId;
        }

        emitRoomUpdated(room);
        break;
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));
