// ================= gameManager.js (DUAL + role-token + SFX hooks + UNDO + TurnInfo + Rejoin helpers + AI) =================
// ✅ 本檔新增/修正重點：
// 1) 修正多處錯誤使用 room.id 造成 emit 發到 undefined 房間（嚴重不同步）
// 2) 每次重要互動都 touch room.lastActiveAt（配合 server.js 5 分鐘 TTL 不清房）
// 3) 新增 turnInfo / yourTurn：方便前端做「回合形狀/顏色 + 箭頭 + 輪到你了」
// 4) 新增 setPlayerRole / rejoinByName：給 server.js 用，減少 roomUpdated 造成的選角 UI 中斷
// 5) 保留原本 UNDO：巴特/羅根可在本回合第 1 手悔棋（可反覆悔到你下完第 2 手才結束回合）
// 6) ✅ 新增 AI：房主手動加入 AI，AI 支援 SINGLE/DUAL 並可使用技能（基紐/古杜/吉斯等）

class GameManager {
  constructor(io, rooms) {
    this.io = io;
    this.rooms = rooms;

    // ✅ 與前端賽後倒數一致：10 秒後回 Lobby 並重選角
    this.POST_GAME_MS = 10500;

    // ✅ AI delay（像人一點）
    this.AI_MIN_DELAY_MS = 350;
    this.AI_MAX_DELAY_MS = 850;

    // ✅ 音效 key 占位
    this.SFX_KEYS = {
      // BGM / Flow
      LOBBY_BGM: 'bgm_lobby_chala',
      BATTLE_BGM: 'bgm_battle',
      VICTORY: 'sfx_victory_10s',

      // UI
      UI_CLICK: 'sfx_ui_click',
      ROLE_CONFIRM: 'sfx_role_confirm',
      UNDO: 'sfx_undo',

      // Role hover
      ROLE_HOVER_0: 'sfx_role_ginyu_name',
      ROLE_HOVER_1: 'sfx_role_burter_name',
      ROLE_HOVER_2: 'sfx_role_recoome_name',
      ROLE_HOVER_3: 'sfx_role_logan_name',
      ROLE_HOVER_4: 'sfx_role_guldo_name',
      ROLE_HOVER_5: 'sfx_role_jeice_name',

      // Place
      PLACE_GINYU: 'sfx_place_ginyu',
      PLACE_BURTER_1: 'sfx_place_burter_1',
      PLACE_BURTER_2: 'sfx_place_burter_2',
      PLACE_RECOOME: 'sfx_place_recoome_slam',
      PLACE_LOGAN: 'sfx_place_logan',
      PLACE_LOGAN_CROSS: 'sfx_place_logan_cross',
      PLACE_GULDO: 'sfx_place_guldo',
      PLACE_JEICE: 'sfx_place_jeice',

      // Skills
      SKILL_GINYU_SWAP: 'sfx_skill_ginyu_swap',
      SKILL_GULDO: 'sfx_skill_guldo',
      SKILL_JEICE: 'sfx_skill_jeice',
    };

    // ✅ 角色說明
    this.ROLE_INFO = {
      0: { name: '基紐', desc: '可發動「交換」：選自己的基紐棋，再選同列/同行任一敵方正常棋，兩者交換位置。' },
      1: { name: '巴特', desc: '每回合可下 2 手（同一角色連線勝利需 6 連線）。第 1 手可悔棋。' },
      2: { name: '力庫姆', desc: '可覆蓋「非叉叉」位置（可蓋掉一般棋），不能下在灰叉上。' },
      3: { name: '羅根', desc: '每回合 2 手：第 1 手下正常棋（可下空格或自己的灰叉上）；第 2 手下灰叉（只能下空格）。第 1 手可悔棋。' },
      4: { name: '古杜', desc: '可移動古杜周圍 8 格內的一顆「正常棋」到該棋周圍的空格（需有空格）。' },
      5: { name: '吉斯', desc: '先落子；若相鄰有敵方正常棋，可選 1 顆擊退（遠離落子方向）最多 2 格，需有空格才可推。' },
    };

    this.roleAbilities = {
      0: {
        name: '基紐',
        maxMoves: 1,
        canOverride: false,
        canUseCross: false,
        place(board, x, y, token) {
          if (board[y][x] !== 0) throw new Error('該位置已有棋子');
          board[y][x] = token;
        },
      },
      1: {
        name: '巴特',
        maxMoves: 2,
        canOverride: false,
        canUseCross: false,
        place(board, x, y, token) {
          if (board[y][x] !== 0) throw new Error('該位置已有棋子');
          board[y][x] = token;
        },
      },
      2: {
        name: '力庫姆',
        maxMoves: 1,
        canOverride: true,
        canUseCross: false,
        place(board, x, y, token) {
          const cur = board?.[y]?.[x];

          // ✅ 基本保護：座標錯誤
          if (cur === undefined) throw new Error('座標錯誤');

          // ✅ 不能下在灰叉上
          if (cur < 0) throw new Error('不能放在叉叉上');

          // ✅ 防呆：不能壓到「同玩家同角色」(同 token = 同 ownerIndex + slot)
          // - 允許覆蓋對手棋、也允許覆蓋自己另一個 slot 的棋（DUAL）
          // - 但禁止覆蓋自己當前這個角色的棋
          if (cur === token) throw new Error('不能覆蓋自己同角色的棋子');

          board[y][x] = token;
        },
      },

      3: {
        name: '羅根',
        maxMoves: 2,
        canOverride: false,
        canUseCross: true,
        place(board, x, y, token, playerIndex, placedThisTurn) {
          if (placedThisTurn === 0) {
            // 第 1 手：可放空格 or 自己的灰叉上
            if (board[y][x] === -(playerIndex + 1)) {
              board[y][x] = token;
            } else if (board[y][x] === 0) {
              board[y][x] = token;
            } else {
              throw new Error('此處不可放置');
            }
          } else if (placedThisTurn === 1) {
            // 第 2 手：灰叉只能放空格
            if (board[y][x] !== 0) throw new Error('灰叉必須放在空格上');
            board[y][x] = -(playerIndex + 1);
          } else {
            throw new Error('超出本回合可下棋數量');
          }
        },
      },
      4: {
        name: '古杜',
        maxMoves: 1,
        canOverride: false,
        canUseCross: false,
        place(board, x, y, token) {
          if (board[y][x] !== 0) throw new Error('該位置已有棋子');
          board[y][x] = token;
        },
      },
      5: {
        name: '吉斯',
        maxMoves: 1,
        canOverride: false,
        canUseCross: false,
        place(board, x, y, token) {
          if (board[y][x] !== 0) throw new Error('該位置已有棋子');
          board[y][x] = token;
        },
      },
    };
  }

  // ================= Utils =================
  now() { return Date.now(); }

  _touchRoom(room) {
    if (!room) return;
    room.lastActiveAt = this.now();
  }

  // ✅ 判斷房主（兼容多種欄位命名）
  _isHost(socket, room) {
    if (!socket || !room) return false;
    // 常見：用 socket.id 當 host
    if (room.hostSocketId) return room.hostSocketId === socket.id;
    if (room.hostId) return room.hostId === socket.id;
    // 也有人用 name 當 host（有些版本會在 socket 上掛 playerName / name）
    const sName = socket.playerName || socket.name;
    if (room.hostName && sName) return room.hostName === sName;
    return false;
  }

  // ✅ 統一廣播房間狀態（沿用你現有 roomUpdated 事件）
  _broadcastRoom(roomId) {
    const room = this.rooms?.[roomId];
    if (!room) return;
    this._emitRoomUpdated(roomId, room);
  }

  createEmptyBoard(size) {
    return Array.from({ length: size }, () => Array(size).fill(0));
  }

  _tokenOf(playerIndex, slot) {
    return playerIndex * 2 + slot; // 1-based token
  }

  _decodeToken(token) {
    const ownerIndex = Math.floor((token - 1) / 2);
    const slot = ((token - 1) % 2) + 1;
    return { ownerIndex, slot };
  }

  _getActiveSlot(room) {
    return room.mode === 'DUAL' ? room.turnSlot || 1 : 1;
  }

  _getActiveRoleIndex(room, player, slot) {
    if (!player) return null;
    if (room.mode === 'DUAL') {
      return slot === 2 ? player.roleIndex2 : player.roleIndex1;
    }
    return player.roleIndex;
  }

  _isAiPlayer(p) {
    return !!p?.isAI;
  }
  _isPlayerConfigured(room, p) {
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

  // ✅ NEW: 解析 AI 目標索引（支援 roomIndex / AI-list index / playerId）
    // ✅ NEW: 解析 AI 目標索引（支援：playerId / aiIndex / target / targetId / targetName / targetIndex）
  _resolveAiPlayerIndex(room, payload) {
    if (!room || !Array.isArray(room.players)) return -1;

    const players = room.players;

    // helper：只回傳 AI index（避免誤把真人當 AI）
    const findAiIndexById = (id) => {
      if (!id || typeof id !== 'string') return -1;
      const idx = players.findIndex((p) => p?.id === id && p?.isAI);
      return idx >= 0 ? idx : -1;
    };

    const findAiIndexByName = (name) => {
      if (!name || typeof name !== 'string') return -1;
      const idx = players.findIndex((p) => String(p?.name || '') === String(name) && p?.isAI);
      return idx >= 0 ? idx : -1;
    };

    const resolveNumericIndex = (raw) => {
      const idx = typeof raw === 'number' ? raw : (typeof raw === 'string' ? Number(raw) : NaN);
      if (!Number.isInteger(idx)) return -1;

      // 1) 當作 room.players index
      if (idx >= 0 && idx < players.length) {
        if (players[idx]?.isAI) return idx;

        // 2) 若該格不是 AI，改把 idx 當作「AI-list index」
        const aiIdxs = [];
        for (let i = 0; i < players.length; i++) if (players[i]?.isAI) aiIdxs.push(i);
        if (idx >= 0 && idx < aiIdxs.length) return aiIdxs[idx];
      }
      return -1;
    };

    // =======================
    // 0) 先吃明確的 target* 欄位
    // =======================
    const tId = payload?.targetId;
    if (typeof tId === 'string' && tId.trim()) {
      const k = findAiIndexById(tId.trim());
      if (k >= 0) return k;
    }

    const tIndex = payload?.targetIndex;
    {
      const k = resolveNumericIndex(tIndex);
      if (k >= 0) return k;
    }

    const tName = payload?.targetName;
    if (typeof tName === 'string' && tName.trim()) {
      const k = findAiIndexByName(tName.trim());
      if (k >= 0) return k;
    }

    // =======================
    // 1) 再吃 id（aiPlayerId / aiId / playerId）
    // =======================
    const id = payload?.aiPlayerId || payload?.aiId || payload?.playerId;
    if (typeof id === 'string' && id.trim()) {
      const k = findAiIndexById(id.trim());
      if (k >= 0) return k;
    }

    // =======================
    // 2) 再吃 aiIndex 類
    // =======================
    const rawIndex =
      payload?.aiIndex ??
      payload?.playerIndex ??
      payload?.aiPlayerIndex ??
      payload?.aiIdx ??
      payload?.aiPlayerNo ??
      payload?.aiNo;

    {
      const k = resolveNumericIndex(rawIndex);
      if (k >= 0) return k;
    }

    // =======================
    // 3) 最後吃 target（你前端常用：target: p.id || p.name）
    // =======================
    const target = payload?.target;
    if (typeof target === 'string' && target.trim()) {
      const s = target.trim();

      // 3-1) 先當作 id
      const k1 = findAiIndexById(s);
      if (k1 >= 0) return k1;

      // 3-2) 再當作 name
      const k2 = findAiIndexByName(s);
      if (k2 >= 0) return k2;
    }

    return -1;
  }


  _getTurnMeta(room) {
    const turnIndex = room.turnIndex || 0;
    const turnSlot = room.turnSlot || 1;
    const p = room.players?.[turnIndex] || null;
    const roleIndex = this._getActiveRoleIndex(room, p, turnSlot);
    const token = typeof turnIndex === 'number' ? this._tokenOf(turnIndex, turnSlot) : null;

    const placedThisTurn = p?.placedThisTurn || 0;
    const maxMoves = (typeof roleIndex === 'number' && this.roleAbilities[roleIndex])
      ? this.roleAbilities[roleIndex].maxMoves
      : 1;

    const canUndo =
      room.status === 'PLAYING' &&
      (roleIndex === 1 || roleIndex === 3) &&
      placedThisTurn === 1; // ✅ 第一手後、第二手前

    return {
      turnIndex,
      turnSlot,
      turnPlayerId: p?.id || null,
      turnPlayerName: p?.name || p?.nickname || null,
      roleIndex: typeof roleIndex === 'number' ? roleIndex : null,
      token,
      roleName: typeof roleIndex === 'number' ? this.ROLE_INFO?.[roleIndex]?.name || null : null,
      placedThisTurn,
      maxMoves,
      canUndo,
    };
  }

  _emitPlaced(roomId, room, extra = {}) {
    const turnMeta = this._getTurnMeta(room);
    this.io.to(roomId).emit('placed', {
      board: room.board,
      turnIndex: turnMeta.turnIndex,
      turnSlot: turnMeta.turnSlot,
      roundCount: room.roundCount,
      status: room.status,
      turnMeta,
      roleInfo: this.ROLE_INFO,
      ...extra,
    });
  }

  _emitRoomUpdated(roomId, room, extra = {}) {
    const turnMeta = this._getTurnMeta(room);
    this.io.to(roomId).emit('roomUpdated', {
      ...room,
      turnMeta,
      roleInfo: this.ROLE_INFO,
      ...extra,
    });
  }

  _emitSfx(roomId, sfx) {
    try { this.io.to(roomId).emit('sfx', sfx); } catch (e) {}
  }

  _sfxForPlace(roleIndex, placedThisTurnBefore) {
    switch (roleIndex) {
      case 0: return this.SFX_KEYS.PLACE_GINYU;
      case 1: return placedThisTurnBefore === 0 ? this.SFX_KEYS.PLACE_BURTER_1 : this.SFX_KEYS.PLACE_BURTER_2;
      case 2: return this.SFX_KEYS.PLACE_RECOOME;
      case 3: return placedThisTurnBefore === 0 ? this.SFX_KEYS.PLACE_LOGAN : this.SFX_KEYS.PLACE_LOGAN_CROSS;
      case 4: return this.SFX_KEYS.PLACE_GULDO;
      case 5: return this.SFX_KEYS.PLACE_JEICE;
      default: return this.SFX_KEYS.UI_CLICK;
    }
  }

  _setFirstMoveSnapshot(player, snap) { player._firstMove = snap || null; }
  _getFirstMoveSnapshot(player) { return player?._firstMove || null; }
  _clearFirstMoveSnapshot(player) { if (player) player._firstMove = null; }

  // ✅ 讓前端做「輪到你了」提示＆回合箭頭
  _emitTurnInfo(roomId, room) {
    const meta = this._getTurnMeta(room);
    this.io.to(roomId).emit('turnInfo', meta);

    if (meta.turnPlayerId) {
      this.io.to(meta.turnPlayerId).emit('yourTurn', meta);
    }

    // ✅ 若輪到 AI：自動排程 AI 行動
    this._maybeScheduleAi(roomId);
  }

  // ================= Lobby helpers (給 server.js 用) =================
  setPlayerRole(roomId, data, cb) {
    const room = this.rooms[roomId];
    if (!room) return cb?.({ ok: false, message: '房間不存在' });

    this._touchRoom(room);

    const { playerId, slot = 1, roleIndex, name } = data || {};
    if (typeof roleIndex !== 'number') return cb?.({ ok: false, message: 'roleIndex 無效' });

    const idx = room.players?.findIndex((p) => p.id === playerId) ?? -1;
    if (idx === -1) return cb?.({ ok: false, message: '玩家不存在' });

    const p = room.players[idx];
    if (name) p.name = name;

    if (room.mode === 'DUAL') {
      if (slot === 2) p.roleIndex2 = roleIndex;
      else p.roleIndex1 = roleIndex;
    } else {
      p.roleIndex = roleIndex;
    }

    this.io.to(roomId).emit('rolePatched', {
      playerIndex: idx,
      playerId: p.id,
      name: p.name || null,
      slot: room.mode === 'DUAL' ? (slot === 2 ? 2 : 1) : 1,
      roleIndex,
      roleName: this.ROLE_INFO?.[roleIndex]?.name || null,
    });

    this._emitRoomUpdated(roomId, room);
    cb?.({ ok: true });
  }

  // ✅ 新增：設定玩家顏色（房主可幫 AI 設）
  setPlayerColor(roomId, data, cb) {
    const room = this.rooms[roomId];
    if (!room) return cb?.({ ok: false, message: '房間不存在' });

    this._touchRoom(room);

    const { playerId, colorIndex } = data || {};
    if (!playerId) return cb?.({ ok: false, message: 'playerId 無效' });

    const idx = room.players?.findIndex((p) => p.id === playerId) ?? -1;
    if (idx === -1) return cb?.({ ok: false, message: '玩家不存在' });

    room.players[idx].colorIndex = colorIndex ?? null;

    this.io.to(roomId).emit('colorPatched', {
      playerIndex: idx,
      playerId,
      colorIndex: room.players[idx].colorIndex,
    });

    this._emitRoomUpdated(roomId, room);
    cb?.({ ok: true });
  }

  // ✅ 新增：隨機角色（DUAL 兩角色不得重複）
  randomizeRole(roomId, data, cb) {
    const room = this.rooms[roomId];
    if (!room) return cb?.({ ok: false, message: '房間不存在' });

    this._touchRoom(room);

    const { playerId, slot = 1 } = data || {};
    const idx = room.players?.findIndex((p) => p.id === playerId) ?? -1;
    if (idx === -1) return cb?.({ ok: false, message: '玩家不存在' });

    const p = room.players[idx];
    const roles = Object.keys(this.ROLE_INFO).map((k) => Number(k)).filter((n) => Number.isFinite(n));

    let exclude = new Set();
    if (room.mode === 'DUAL') {
      if (slot === 1 && typeof p.roleIndex2 === 'number') exclude.add(p.roleIndex2);
      if (slot === 2 && typeof p.roleIndex1 === 'number') exclude.add(p.roleIndex1);
    }

    const pool = roles.filter((r) => !exclude.has(r));
    if (!pool.length) return cb?.({ ok: false, message: '沒有可用角色可隨機' });

    const pick = pool[Math.floor(Math.random() * pool.length)];

    if (room.mode === 'DUAL') {
      if (slot === 2) p.roleIndex2 = pick;
      else p.roleIndex1 = pick;
    } else {
      p.roleIndex = pick;
    }

    this.io.to(roomId).emit('rolePatched', {
      playerIndex: idx,
      playerId: p.id,
      name: p.name || null,
      slot: room.mode === 'DUAL' ? (slot === 2 ? 2 : 1) : 1,
      roleIndex: pick,
      roleName: this.ROLE_INFO?.[pick]?.name || null,
      random: true,
    });

    this._emitRoomUpdated(roomId, room);
    cb?.({ ok: true, roleIndex: pick });
  }

  // ✅ 斷線重整同名回歸
  rejoinByName(roomId, data, cb) {
    const room = this.rooms[roomId];
    if (!room) return cb?.({ ok: false, message: '房間不存在' });

    this._touchRoom(room);

    const { name, newSocketId } = data || {};
    if (!name || !newSocketId) return cb?.({ ok: false, message: '參數不足' });

    const idx = room.players?.findIndex((p) => (p.name || '') === name) ?? -1;
    if (idx === -1) return cb?.({ ok: false, message: '找不到同名玩家' });

    const p = room.players[idx];

    p.id = newSocketId;
    p.connected = true;
    p.lastRejoinAt = this.now();

    if (room.status === 'PLAYING') {
      const meta = this._getTurnMeta(room);
      if (meta.turnIndex === idx && meta.turnPlayerId) {
        this.io.to(meta.turnPlayerId).emit('yourTurn', meta);
      }
    }

    this._emitRoomUpdated(roomId, room, { rejoined: { playerIndex: idx, name } });
    cb?.({ ok: true, playerIndex: idx });
  }

  // ================= AI Scheduler =================
  _maybeScheduleAi(roomId) {
    const room = this.rooms[roomId];
    if (!room) return;
    if (room.status !== 'PLAYING') return;

    const p = room.players?.[room.turnIndex];
    if (!this._isAiPlayer(p)) return;

    if (room._aiBusy) return;
    if (room._aiTimer) return;

    const delay = this.AI_MIN_DELAY_MS + Math.floor(Math.random() * (this.AI_MAX_DELAY_MS - this.AI_MIN_DELAY_MS + 1));
    room._aiTimer = setTimeout(() => {
      room._aiTimer = null;
      this._aiThinkAndAct(roomId);
    }, delay);
  }

  _aiThinkAndAct(roomId) {
    const room = this.rooms[roomId];
    if (!room) return;
    if (room.status !== 'PLAYING') return;

    const p = room.players?.[room.turnIndex];
    if (!this._isAiPlayer(p)) return;

    if (room._aiBusy) return;
    room._aiBusy = true;

    try {
      // 安全：最多連做 6 個 action（巴特/羅根/DUAL 也足夠）
      for (let step = 0; step < 6; step++) {
        if (room.status !== 'PLAYING') break;

        const cur = room.players?.[room.turnIndex];
        if (!this._isAiPlayer(cur)) break;

        const acted = this._aiDoOneAction(roomId);
        if (!acted) break; // 萬一找不到動作就停止
      }
    } finally {
      room._aiBusy = false;
    }
  }

  _aiDoOneAction(roomId) {
    const room = this.rooms[roomId];
    if (!room) return false;

    const playerIndex = room.turnIndex;
    const player = room.players[playerIndex];
    const slot = this._getActiveSlot(room);
    const roleIndex = this._getActiveRoleIndex(room, player, slot);

    // 用假的 socket 走你既有的驗證流程（不需要 AI 真的連線）
    const fakeSocket = { id: player.id };

    // 1) 吉斯：優先用技能（含擊退）
    if (roleIndex === 5) {
      return this._aiPlayJeice(fakeSocket, roomId);
    }

    // 2) 基紐：如果未落子且未用過能力，嘗試用交換（有利才用）
    if (roleIndex === 0 && (player.placedThisTurn || 0) === 0 && !player.usedGinyuThisTurn) {
      const used = this._aiTryGinyuSwap(fakeSocket, roomId);
      if (used) return true;
    }

    // 3) 古杜：如果未落子且未用過能力，嘗試搬棋（有利才用）
    if (roleIndex === 4 && (player.placedThisTurn || 0) === 0 && !player.usedGudoThisTurn) {
      const used = this._aiTryGuldoMove(fakeSocket, roomId);
      if (used) return true;
    }

    // 4) 一般落子（含巴特/羅根第二手）
    return this._aiPlaceNormal(fakeSocket, roomId);
  }

  // ===== AI: Candidate cells (靠近戰場) =====
  _aiGatherCandidateCells(room, includeOverride = false, includeOwnCrossAsEmptyForLoganFirst = false, playerIndex = 0) {
    const board = room.board;
    const N = board.length;
    const hasAny = (() => {
      for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) if (board[y][x] !== 0) return true;
      return false;
    })();

    const inb = (x, y) => x >= 0 && x < N && y >= 0 && y < N;

    // 空盤：從中心附近選
    if (!hasAny) {
      const mid = Math.floor(N / 2);
      const pts = [];
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const x = mid + dx, y = mid + dy;
        if (inb(x, y)) pts.push({ x, y });
      }
      return pts;
    }

    const s = new Set();
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        if (board[y][x] === 0) continue;
        // 在任何棋周圍半徑2
        for (let dy = -2; dy <= 2; dy++) {
          for (let dx = -2; dx <= 2; dx++) {
            const nx = x + dx, ny = y + dy;
            if (!inb(nx, ny)) continue;

            const v = board[ny][nx];
            const key = nx + ',' + ny;

            // 一般：只收空格
            if (v === 0) s.add(key);
            // 覆蓋（力庫姆）：收非叉叉
            else if (includeOverride && v >= 0) s.add(key);
            // 羅根第一手：可下自己灰叉上
            else if (includeOwnCrossAsEmptyForLoganFirst && v === -(playerIndex + 1)) s.add(key);
          }
        }
      }
    }

    return Array.from(s).map((k) => {
      const [x, y] = k.split(',').map((n) => parseInt(n, 10));
      return { x, y };
    });
  }

  _aiEvalCenter(boardSize, x, y) {
    const mid = (boardSize - 1) / 2;
    const dx = x - mid, dy = y - mid;
    return -(dx * dx + dy * dy);
  }

  _aiCountNeighbors(board, x, y) {
    let c = 0;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        const v = board?.[y + dy]?.[x + dx];
        if (typeof v === 'number' && v !== 0) c++;
      }
    }
    return c;
  }

  _aiWouldWinIfPlace(room, x, y, token, roleIndex, placedThisTurnBefore, playerIndex) {
    const board = room.board;
    const N = board.length;
    if (y < 0 || y >= N || x < 0 || x >= N) return false;

    // 模擬落子（需符合角色規則）
    const tmp = board[y][x];
    try {
      if (roleIndex === 3) {
        this.roleAbilities[3].place(board, x, y, token, playerIndex, placedThisTurnBefore);
      } else {
        this.roleAbilities[roleIndex].place(board, x, y, token);
      }

      // 只有正常棋子（>0）才有勝利判定
      if (board[y][x] > 0) {
        const targetN = roleIndex === 1 ? 6 : room.targetN;
        const win = this.checkWinner(board, x, y, token, targetN);
        board[y][x] = tmp;
        return win;
      }
      board[y][x] = tmp;
      return false;
    } catch (e) {
      board[y][x] = tmp;
      return false;
    }
  }

  _aiPlaceNormal(fakeSocket, roomId) {
    const room = this.rooms[roomId];
    if (!room) return false;
    const playerIndex = room.turnIndex;
    const player = room.players[playerIndex];
    const slot = this._getActiveSlot(room);
    const roleIndex = this._getActiveRoleIndex(room, player, slot);
    const role = this.roleAbilities[roleIndex];
    if (!role) return false;

    const placedThisTurnBefore = player.placedThisTurn || 0;
    const token = this._tokenOf(playerIndex, slot);

    const includeOverride = roleIndex === 2; // 力庫姆覆蓋
    const includeOwnCrossAsEmptyForLoganFirst = roleIndex === 3 && placedThisTurnBefore === 0;

    const candidates = this._aiGatherCandidateCells(room, includeOverride, includeOwnCrossAsEmptyForLoganFirst, playerIndex);
    if (!candidates.length) return false;

    // 先找必勝
    for (const p of candidates) {
      if (this._aiWouldWinIfPlace(room, p.x, p.y, token, roleIndex, placedThisTurnBefore, playerIndex)) {
        let ok = false;
        this.placePiece(fakeSocket, { roomId, x: p.x, y: p.y }, (res) => { ok = !!res?.ok; });
        return ok;
      }
    }

    // 否則用簡單評分挑一個
    const board = room.board;
    const N = board.length;

    let best = null;
    for (const p of candidates) {
      // 先用 try/catch 檢查合法性
      const v0 = board[p.y][p.x];
      try {
        if (roleIndex === 3) {
          this.roleAbilities[3].place(board, p.x, p.y, token, playerIndex, placedThisTurnBefore);
        } else {
          role.place(board, p.x, p.y, token);
        }

        const placedV = board[p.y][p.x];
        // 還原
        board[p.y][p.x] = v0;

        // 評分
        let score = 0;
        score += this._aiEvalCenter(N, p.x, p.y) * 0.8;
        score += this._aiCountNeighbors(board, p.x, p.y) * 1.6;

        // 羅根第二手（灰叉）：更偏向靠近敵方棋
        if (roleIndex === 3 && placedThisTurnBefore === 1) {
          score += this._aiCountNeighbors(board, p.x, p.y) * 2.2;
        }

        // 覆蓋（力庫姆）：若覆蓋到對方棋，多給分
        if (roleIndex === 2 && v0 > 0 && v0 !== token) score += 6;

        if (!best || score > best.score) best = { ...p, score, placedV };
      } catch (e) {
        board[p.y][p.x] = v0;
      }
    }

    if (!best) return false;

    let ok = false;
    this.placePiece(fakeSocket, { roomId, x: best.x, y: best.y }, (res) => { ok = !!res?.ok; });
    return ok;
  }

  // ===== AI: Jeice (place + optional push) =====
  _aiPlayJeice(fakeSocket, roomId) {
    let started = false;
    this.jeiceAbilityStart(fakeSocket, { roomId }, (res) => { started = !!res?.ok; });
    if (!started) {
      // 若因為本回合已落子等原因，退回一般落子
      return this._aiPlaceNormal(fakeSocket, roomId);
    }

    const room = this.rooms[roomId];
    if (!room) return false;
    const playerIndex = room.turnIndex;

    // 先選落子點：挑最靠近中心&戰場的位置
    const candidates = this._aiGatherCandidateCells(room, false, false, playerIndex);
    if (!candidates.length) {
      // fallback：中心
      const mid = Math.floor(room.board.length / 2);
      candidates.push({ x: mid, y: mid });
    }

    // 先找落子立即勝利
    const slot = this._getActiveSlot(room);
    const token = this._tokenOf(playerIndex, slot);
    for (const p of candidates) {
      // jeicePlace 規則：只能空格
      if (room.board?.[p.y]?.[p.x] !== 0) continue;
      const tmp = room.board[p.y][p.x];
      room.board[p.y][p.x] = token;
      const roleIndexNow = this._getActiveRoleIndex(room, room.players[playerIndex], slot);
      const targetN = roleIndexNow === 1 ? 6 : room.targetN;
      const win = this.checkWinner(room.board, p.x, p.y, token, targetN);
      room.board[p.y][p.x] = tmp;
      if (win) {
        let ok = false;
        this.jeicePlace(fakeSocket, { roomId, x: p.x, y: p.y }, (res) => { ok = !!res?.ok; });
        return ok;
      }
    }

    // 否則挑分數最高
    let best = null;
    const N = room.board.length;
    for (const p of candidates) {
      if (room.board?.[p.y]?.[p.x] !== 0) continue;
      let score = 0;
      score += this._aiEvalCenter(N, p.x, p.y) * 1.0;
      score += this._aiCountNeighbors(room.board, p.x, p.y) * 2.0;
      if (!best || score > best.score) best = { ...p, score };
    }
    if (!best) {
      // fallback 找任一空格
      outer: for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) if (room.board[y][x] === 0) { best = { x, y, score: 0 }; break outer; }
    }
    if (!best) return false;

    let placeRes = null;
    this.jeicePlace(fakeSocket, { roomId, x: best.x, y: best.y }, (res) => { placeRes = res; });
    if (!placeRes?.ok) {
      // 落子失敗：直接取消（會結束回合）
      let ok = false;
      this.jeiceCancel(fakeSocket, { roomId }, (res) => { ok = !!res?.ok; });
      return ok;
    }

    // 如果有 targets：挑一個最有利的擊退；否則 jeicePlace 已經可能結束回合
    const targets = Array.isArray(placeRes.targets) ? placeRes.targets : [];
    if (!targets.length) return true;

    // 對每個 target 做簡單模擬：能推就推
    const board = room.board;
    const from = placeRes.placed || { x: best.x, y: best.y };

    const inb = (x, y) => y >= 0 && y < board.length && x >= 0 && x < board.length;

    let bestT = null;
    for (const t of targets) {
      const tv = board?.[t.y]?.[t.x];
      if (!(tv > 0)) continue;

      const dx = Math.sign(t.x - from.x);
      const dy = Math.sign(t.y - from.y);
      if (dx === 0 && dy === 0) continue;

      const oneX = t.x + dx, oneY = t.y + dy;
      const twoX = t.x + dx * 2, twoY = t.y + dy * 2;

      let score = 0;
      score += 2;

      if (inb(oneX, oneY) && board[oneY][oneX] === 0) {
        const can2 = inb(twoX, twoY) && board[twoY][twoX] === 0;
        score += can2 ? 4 : 2;
      } else {
        score -= 3;
      }

      if (!bestT || score > bestT.score) bestT = { ...t, score };
    }

    if (bestT && bestT.score >= 0) {
      let ok = false;
      this.jeiceSelectTarget(fakeSocket, { roomId, x: bestT.x, y: bestT.y }, (res) => { ok = !!res?.ok; });
      return ok;
    }

    // 不推：取消（會結束回合）
    let ok = false;
    this.jeiceCancel(fakeSocket, { roomId }, (res) => { ok = !!res?.ok; });
    return ok;
  }

  // ===== AI: Ginyu swap =====
  _aiTryGinyuSwap(fakeSocket, roomId) {
    const room = this.rooms[roomId];
    if (!room) return false;
    const playerIndex = room.turnIndex;

    let startRes = null;
    this.ginyuAbilityStart(fakeSocket, { roomId }, (res) => { startRes = res; });
    if (!startRes?.ok || !Array.isArray(startRes.sources) || !startRes.sources.length) return false;

    const board = room.board;
    const selfSlot = this._getActiveSlot(room);
    const selfToken = this._tokenOf(playerIndex, selfSlot);
    const N = board.length;

    const simulateSwapScore = (sx, sy, tx, ty) => {
      const a = board[sy][sx];
      const b = board[ty][tx];
      board[sy][sx] = b;
      board[ty][tx] = a;

      let score = 0;
      const winner = this.checkBoardForAnyWinner(room);
      if (winner === playerIndex) score += 100000;

      score += (this._aiEvalCenter(N, tx, ty) + this._aiEvalCenter(N, sx, sy)) * 0.2;

      board[sy][sx] = a;
      board[ty][tx] = b;
      return score;
    };

    let best = null;
    for (const s of startRes.sources) {
      let selRes = null;
      this.ginyuSelectSource(fakeSocket, { roomId, x: s.x, y: s.y }, (res) => { selRes = res; });
      const targets = selRes?.ok && Array.isArray(selRes.targets) ? selRes.targets : [];
      for (const t of targets) {
        if (!(board?.[t.y]?.[t.x] > 0) || board[t.y][t.x] === selfToken) continue;
        const score = simulateSwapScore(s.x, s.y, t.x, t.y);
        if (!best || score > best.score) best = { s, t, score };
      }
    }

    if (!best || best.score < 200) {
      this.ginyuCancel(fakeSocket, { roomId }, () => {});
      return false;
    }

    let ok = false;
    this.ginyuAbilityStart(fakeSocket, { roomId }, (res) => { ok = !!res?.ok; });
    if (!ok) return false;

    let ok2 = false;
    this.ginyuSelectSource(fakeSocket, { roomId, x: best.s.x, y: best.s.y }, (res) => { ok2 = !!res?.ok; });
    if (!ok2) return false;

    let ok3 = false;
    this.ginyuSelectTarget(fakeSocket, { roomId, x: best.t.x, y: best.t.y }, (res) => { ok3 = !!res?.ok; });
    return ok3;
  }

  // ===== AI: Guldo move =====
  _aiTryGuldoMove(fakeSocket, roomId) {
    const room = this.rooms[roomId];
    if (!room) return false;

    let startRes = null;
    this.gudoAbilityStart(fakeSocket, { roomId }, (res) => { startRes = res; });
    if (!startRes?.ok || !Array.isArray(startRes.sources) || !startRes.sources.length) return false;

    const board = room.board;
    const N = board.length;

    const scoreMove = (tx, ty, nx, ny) => {
      const tv = board[ty][tx];
      board[ty][tx] = 0;
      board[ny][nx] = tv;

      let score = 0;
      score += -this._aiEvalCenter(N, nx, ny) * 0.6;
      score += this._aiCountNeighbors(board, tx, ty) * 1.0;

      const winner = this.checkBoardForAnyWinner(room);
      if (winner === room.turnIndex) score += 60000;

      board[ny][nx] = 0;
      board[ty][tx] = tv;
      return score;
    };

    let best = null;

    for (const s of startRes.sources) {
      let selS = null;
      this.gudoSelectSource(fakeSocket, { roomId, x: s.x, y: s.y }, (res) => { selS = res; });
      if (!selS?.ok) continue;

      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        const tx = s.x + dx, ty = s.y + dy;
        const tv = board?.[ty]?.[tx];
        if (!(tv > 0)) continue;

        let selT = null;
        this.gudoSelectTarget(fakeSocket, { roomId, x: tx, y: ty }, (res) => { selT = res; });
        const empties = selT?.ok && Array.isArray(selT.emptyAround) ? selT.emptyAround : [];
        for (const e of empties) {
          const score = scoreMove(tx, ty, e.x, e.y);
          if (!best || score > best.score) best = { s, t: { x: tx, y: ty }, e, score };
        }
      }
    }

    if (!best || best.score < 120) {
      room.gudoState = null;
      this.io.to(roomId).emit('gudoCancelled');
      this._emitPlaced(roomId, room);
      this._emitTurnInfo(roomId, room);
      return false;
    }

    let ok = false;
    this.gudoAbilityStart(fakeSocket, { roomId }, (res) => { ok = !!res?.ok; });
    if (!ok) return false;

    let ok2 = false;
    this.gudoSelectSource(fakeSocket, { roomId, x: best.s.x, y: best.s.y }, (res) => { ok2 = !!res?.ok; });
    if (!ok2) return false;

    let ok3 = false;
    this.gudoSelectTarget(fakeSocket, { roomId, x: best.t.x, y: best.t.y }, (res) => { ok3 = !!res?.ok; });
    if (!ok3) return false;

    let ok4 = false;
    this.gudoMovePiece(fakeSocket, { roomId, x: best.e.x, y: best.e.y }, (res) => { ok4 = !!res?.ok; });
    return ok4;
  }

  // ================= Game Flow =================
  startGame(roomId) {
    const room = this.rooms[roomId];
    if (!room) return;

    this._touchRoom(room);

    room.status = 'PLAYING';
    room.turnIndex = 0;
    room.turnSlot = room.mode === 'DUAL' ? 1 : 1;
    room.roundCount = 1;
    room.board = this.createEmptyBoard(room.boardSize || 15);
    room.ginyuState = null;
    room.gudoState = null;
    room.jeiceState = null;

    room.players.forEach((p) => {
      p.placedThisTurn = 0;
      p.ready = false;
      p.usedGinyuThisTurn = false;
      p.usedGudoThisTurn = false;
      p.usedJeiceThisTurn = false;
      this._clearFirstMoveSnapshot(p);
      if (p.wins === undefined) p.wins = 0;
    });

    this._emitRoomUpdated(roomId, room);

    this._emitSfx(roomId, { key: this.SFX_KEYS.BATTLE_BGM, scope: 'bgm', action: 'start' });
    this._emitTurnInfo(roomId, room);
  }

  restartGame(roomId) {
    const room = this.rooms[roomId];
    if (!room) return;

    this._touchRoom(room);

    room.status = 'LOBBY';
    room.board = this.createEmptyBoard(room.boardSize || 15);
    room.ginyuState = null;
    room.gudoState = null;
    room.jeiceState = null;

    room.turnIndex = 0;
    room.turnSlot = room.mode === 'DUAL' ? 1 : 1;
    room.roundCount = 1;

    room.players.forEach((p) => {
      p.ready = false;
      p.placedThisTurn = 0;
      p.usedGinyuThisTurn = false;
      p.usedGudoThisTurn = false;
      p.usedJeiceThisTurn = false;
      this._clearFirstMoveSnapshot(p);
    });

    this._emitRoomUpdated(roomId, room);

    this._emitSfx(roomId, { key: this.SFX_KEYS.LOBBY_BGM, scope: 'bgm', action: 'start' });
    this._emitTurnInfo(roomId, room);
  }

  // ================= UNDO (Burter / Logan) =================
  undoMove(socket, data, cb) {
    const { roomId } = data || {};
    const room = this.rooms[roomId];
    if (!room) return cb?.({ ok: false, message: '房間不存在' });

    this._touchRoom(room);

    if (room.status !== 'PLAYING') return cb?.({ ok: false, message: '遊戲未開始' });

    const playerIndex = room.players.findIndex((p) => p.id === socket.id);
    if (playerIndex === -1) return cb?.({ ok: false, message: '玩家不存在' });
    if (playerIndex !== room.turnIndex) return cb?.({ ok: false, message: '尚未輪到你' });

    const player = room.players[playerIndex];
    const slot = this._getActiveSlot(room);
    const roleIndex = this._getActiveRoleIndex(room, player, slot);

    if (roleIndex !== 1 && roleIndex !== 3) {
      return cb?.({ ok: false, message: '只有巴特/羅根可悔棋' });
    }

    if ((player.placedThisTurn || 0) !== 1) {
      return cb?.({ ok: false, message: '只能在本回合第 1 手悔棋（第 2 手後不可悔）' });
    }

    const snap = this._getFirstMoveSnapshot(player);
    if (!snap) return cb?.({ ok: false, message: '沒有可悔棋的紀錄' });

    if (
      snap.turnIndex !== room.turnIndex ||
      snap.turnSlot !== (room.turnSlot || 1) ||
      snap.playerIndex !== playerIndex ||
      snap.slot !== slot
    ) {
      this._clearFirstMoveSnapshot(player);
      return cb?.({ ok: false, message: '悔棋狀態已失效' });
    }

    const { x, y, prev } = snap;
    if (room.board?.[y]?.[x] === undefined) {
      this._clearFirstMoveSnapshot(player);
      return cb?.({ ok: false, message: '悔棋座標錯誤' });
    }

    room.board[y][x] = prev;
    player.placedThisTurn = 0;

    room.ginyuState = null;
    room.gudoState = null;
    room.jeiceState = null;

    this._clearFirstMoveSnapshot(player);

    const sfx = {
      key: this.SFX_KEYS.UNDO,
      scope: 'sfx',
      action: 'play',
      by: { playerIndex, slot, roleIndex },
      meta: { x, y },
    };
    this._emitSfx(roomId, sfx);

    this._emitPlaced(roomId, room, { sfx, undo: { x, y } });
    this._emitTurnInfo(roomId, room);

    cb?.({ ok: true });
  }

  // ================= Normal Place =================
  placePiece(socket, data, cb) {
    const { roomId, x, y } = data || {};
    const room = this.rooms[roomId];
    if (!room) return cb?.({ ok: false, message: '房間不存在' });

    this._touchRoom(room);

    if (room.status !== 'PLAYING') return cb?.({ ok: false, message: '遊戲未開始' });

    const playerIndex = room.players.findIndex((p) => p.id === socket.id);
    if (playerIndex === -1) return cb?.({ ok: false, message: '玩家不存在' });
    if (playerIndex !== room.turnIndex) return cb?.({ ok: false, message: '尚未輪到你' });

    const player = room.players[playerIndex];
    const slot = this._getActiveSlot(room);
    const roleIndex = this._getActiveRoleIndex(room, player, slot);
    const role = this.roleAbilities[roleIndex];
    if (typeof roleIndex !== 'number' || !role) return cb?.({ ok: false, message: '角色未設定' });

    if (room.jeiceState && room.jeiceState.playerIndex === playerIndex) {
      return cb?.({ ok: false, message: '吉斯能力進行中，請先完成或取消' });
    }

    const board = room.board;
    const token = this._tokenOf(playerIndex, slot);

    const placedThisTurnBefore = player.placedThisTurn || 0;

    const shouldSnapshot = (roleIndex === 1 || roleIndex === 3) && placedThisTurnBefore === 0;
    let prevValue = null;

    try {
      prevValue = board?.[y]?.[x];
      if (roleIndex === 3) {
        role.place(board, x, y, token, playerIndex, placedThisTurnBefore);
      } else {
        role.place(board, x, y, token);
      }
      player.placedThisTurn = placedThisTurnBefore + 1;

      if (shouldSnapshot) {
        this._setFirstMoveSnapshot(player, {
          playerIndex,
          slot,
          roleIndex,
          x,
          y,
          prev: prevValue,
          turnIndex: room.turnIndex,
          turnSlot: room.turnSlot || 1,
        });
      } else {
        if (player.placedThisTurn >= 2) this._clearFirstMoveSnapshot(player);
      }
    } catch (err) {
      return cb?.({ ok: false, message: err?.message || '落子失敗' });
    }

    const targetN = roleIndex === 1 ? 6 : room.targetN;
    const win = this.checkWinner(board, x, y, token, targetN);

    const placeSfxKey = this._sfxForPlace(roleIndex, placedThisTurnBefore);

    if (win) {
      player.wins = (player.wins || 0) + 1;
      room.status = 'ENDED';
      room.ginyuState = null;
      room.gudoState = null;
      room.jeiceState = null;

      const victorySfx = { key: this.SFX_KEYS.VICTORY, scope: 'sfx', action: 'play', meta: { durationMs: 10000 } };

      this._emitPlaced(roomId, room, {
        win: { winnerIndex: playerIndex, winnerId: player.id },
        sfx: { key: placeSfxKey, by: { playerIndex, slot, roleIndex }, meta: { x, y, step: placedThisTurnBefore } },
        sfx2: victorySfx,
      });

      this._emitSfx(roomId, { key: placeSfxKey, scope: 'sfx', action: 'play', by: { playerIndex, slot, roleIndex }, meta: { x, y, step: placedThisTurnBefore } });
      this._emitSfx(roomId, victorySfx);

      setTimeout(() => this.restartGame(roomId), this.POST_GAME_MS);
      return cb?.({ ok: true, win: true });
    }

    this._emitSfx(roomId, { key: placeSfxKey, scope: 'sfx', action: 'play', by: { playerIndex, slot, roleIndex }, meta: { x, y, step: placedThisTurnBefore } });

    if (player.placedThisTurn >= role.maxMoves) {
      this._advanceTurn(room);
    }

    this._emitPlaced(roomId, room, {
      sfx: { key: placeSfxKey, by: { playerIndex, slot, roleIndex }, meta: { x, y, step: placedThisTurnBefore } },
    });

    this._emitTurnInfo(roomId, room);
    cb?.({ ok: true });
  }

  _advanceTurn(room) {
    const current = room.players[room.turnIndex];
    if (current) {
      current.placedThisTurn = 0;
      this._clearFirstMoveSnapshot(current);
    }

    if (room.mode === 'DUAL') {
      const lastIdx = room.players.length - 1;
      if ((room.turnSlot || 1) === 1) {
        if (room.turnIndex < lastIdx) room.turnIndex += 1;
        else { room.turnIndex = 0; room.turnSlot = 2; }
      } else {
        if (room.turnIndex < lastIdx) room.turnIndex += 1;
        else { room.turnIndex = 0; room.turnSlot = 1; }
      }
    } else {
      room.turnIndex = (room.turnIndex + 1) % room.players.length;
      room.turnSlot = 1;
    }

    room.roundCount = (room.roundCount || 0) + 1;

    room.ginyuState = null;
    room.gudoState = null;
    room.jeiceState = null;

    const next = room.players[room.turnIndex];
    if (next) {
      next.usedGinyuThisTurn = false;
      next.usedGudoThisTurn = false;
      next.usedJeiceThisTurn = false;
      next.placedThisTurn = 0;
      this._clearFirstMoveSnapshot(next);
    }
  }

  // ================= Ginyu =================
  emitGinyuCancelled(socket, roomId, message) {
    this.io.to(socket.id).emit('ginyuCancelled', { message });
    const room = this.rooms[roomId];
    if (room) {
      this._emitPlaced(roomId, room);
      this._emitTurnInfo(roomId, room);
    }
  }

  ginyuCancel(socket, data, cb) {
    const { roomId } = data || {};
    const room = this.rooms[roomId];
    if (!room) return cb?.({ ok: false, message: '房間不存在' });

    this._touchRoom(room);

    if (room.status !== 'PLAYING') return cb?.({ ok: false, message: '遊戲未開始' });

    const playerIndex = room.players.findIndex((p) => p.id === socket.id);
    if (playerIndex === -1) return cb?.({ ok: false, message: '玩家不存在' });
    if (playerIndex !== room.turnIndex) return cb?.({ ok: false, message: '尚未輪到你' });

    const player = room.players[playerIndex];
    const slot = this._getActiveSlot(room);
    const roleIndex = this._getActiveRoleIndex(room, player, slot);
    if (roleIndex !== 0) return cb?.({ ok: false, message: '只有基紐可以取消此能力' });

    room.ginyuState = null;
    this.emitGinyuCancelled(socket, roomId, '已取消基紐能力');
    cb?.({ ok: true });
  }

  ginyuAbilityStart(socket, data, cb) {
    const { roomId } = data || {};
    const room = this.rooms[roomId];
    if (!room) return cb?.({ ok: false, message: '房間不存在' });

    this._touchRoom(room);

    if (room.status !== 'PLAYING') return cb?.({ ok: false, message: '遊戲未開始' });

    const playerIndex = room.players.findIndex((p) => p.id === socket.id);
    if (playerIndex === -1) return cb?.({ ok: false, message: '玩家不存在' });
    if (playerIndex !== room.turnIndex) return cb?.({ ok: false, message: '尚未輪到你' });

    const player = room.players[playerIndex];
    const slot = this._getActiveSlot(room);
    const roleIndex = this._getActiveRoleIndex(room, player, slot);
    if (roleIndex !== 0) return cb?.({ ok: false, message: '只有基紐可以使用此能力' });

    if (player.placedThisTurn && player.placedThisTurn > 0) return cb?.({ ok: false, message: '本回合已經落子，無法發動能力' });
    if (player.usedGinyuThisTurn) return cb?.({ ok: false, message: '本回合已使用過基紐能力' });

    const board = room.board;
    const size = board.length;
    const selfToken = this._tokenOf(playerIndex, slot);
    const sources = [];

    for (let yy = 0; yy < size; yy++) {
      for (let xx = 0; xx < size; xx++) {
        if (board[yy][xx] !== selfToken) continue;

        let canSwap = false;
        for (let cx = 0; cx < size; cx++) {
          const v = board[yy][cx];
          if (v > 0 && v !== selfToken) { canSwap = true; break; }
        }
        if (!canSwap) {
          for (let cy = 0; cy < size; cy++) {
            const v = board[cy][xx];
            if (v > 0 && v !== selfToken) { canSwap = true; break; }
          }
        }
        if (canSwap) sources.push({ x: xx, y: yy });
      }
    }

    if (!sources.length) return cb?.({ ok: false, message: '目前沒有可以發動基紐能力的位置' });

    room.ginyuState = { playerIndex, selfToken, sources, source: null, targets: [] };

    this._emitSfx(roomId, { key: this.SFX_KEYS.SKILL_GINYU_SWAP, scope: 'sfx', action: 'prime', by: { playerIndex, slot, roleIndex } });
    cb?.({ ok: true, sources });
  }

  ginyuSelectSource(socket, data, cb) {
    const { roomId, x, y } = data || {};
    const room = this.rooms[roomId];
    if (!room) return cb?.({ ok: false, message: '房間不存在' });

    this._touchRoom(room);

    if (room.status !== 'PLAYING') return cb?.({ ok: false, message: '遊戲未開始' });

    const playerIndex = room.players.findIndex((p) => p.id === socket.id);
    if (playerIndex === -1) return cb?.({ ok: false, message: '玩家不存在' });
    if (playerIndex !== room.turnIndex) return cb?.({ ok: false, message: '尚未輪到你' });

    const player = room.players[playerIndex];
    const slot = this._getActiveSlot(room);
    const roleIndex = this._getActiveRoleIndex(room, player, slot);
    if (roleIndex !== 0) return cb?.({ ok: false, message: '只有基紐可以使用此能力' });

    const state = room.ginyuState;
    if (!state || state.playerIndex !== playerIndex) {
      room.ginyuState = null;
      this.emitGinyuCancelled(socket, roomId, '基紐能力已取消');
      return cb?.({ ok: false, message: '尚未發動基紐能力' });
    }

    const isSourceValid = state.sources?.some((p) => p.x === x && p.y === y);
    if (!isSourceValid) {
      room.ginyuState = null;
      this.emitGinyuCancelled(socket, roomId, '已取消基紐能力');
      return cb?.({ ok: false, message: '已取消基紐能力' });
    }

    const board = room.board;
    const size = board.length;
    const selfToken = state.selfToken;
    const targets = [];

    for (let cx = 0; cx < size; cx++) {
      const v = board[y][cx];
      if (v > 0 && v !== selfToken) targets.push({ x: cx, y });
    }

    for (let cy = 0; cy < size; cy++) {
      const v = board[cy][x];
      if (v > 0 && v !== selfToken && !targets.some((t) => t.x === x && t.y === cy)) {
        targets.push({ x, y: cy });
      }
    }

    if (!targets.length) {
      room.ginyuState = null;
      this.emitGinyuCancelled(socket, roomId, '此基紐棋沒有可交換目標，已取消');
      return cb?.({ ok: false, message: '此基紐棋沒有可交換目標' });
    }

    state.source = { x, y };
    state.targets = targets;

    cb?.({ ok: true, targets });
  }

  ginyuSelectTarget(socket, data, cb) {
    const { roomId, x, y } = data || {};
    const room = this.rooms[roomId];
    if (!room) return cb?.({ ok: false, message: '房間不存在' });

    this._touchRoom(room);

    if (room.status !== 'PLAYING') return cb?.({ ok: false, message: '遊戲未開始' });

    const playerIndex = room.players.findIndex((p) => p.id === socket.id);
    if (playerIndex === -1) return cb?.({ ok: false, message: '玩家不存在' });
    if (playerIndex !== room.turnIndex) return cb?.({ ok: false, message: '尚未輪到你' });

    const player = room.players[playerIndex];
    const slot = this._getActiveSlot(room);
    const roleIndex = this._getActiveRoleIndex(room, player, slot);
    if (roleIndex !== 0) return cb?.({ ok: false, message: '只有基紐可以使用此能力' });

    const state = room.ginyuState;
    if (!state || state.playerIndex !== playerIndex || !state.source) {
      room.ginyuState = null;
      this.emitGinyuCancelled(socket, roomId, '基紐能力已取消');
      return cb?.({ ok: false, message: '尚未選擇基紐棋' });
    }

    const isTargetValid = state.targets?.some((p) => p.x === x && p.y === y);
    if (!isTargetValid) {
      room.ginyuState = null;
      this.emitGinyuCancelled(socket, roomId, '已取消基紐能力');
      return cb?.({ ok: false, message: '已取消基紐能力' });
    }

    const board = room.board;
    const sx = state.source.x;
    const sy = state.source.y;

    const tmp = board[sy][sx];
    board[sy][sx] = board[y][x];
    board[y][x] = tmp;

    player.usedGinyuThisTurn = true;
    room.ginyuState = null;

    const swapSfx = {
      key: this.SFX_KEYS.SKILL_GINYU_SWAP,
      scope: 'sfx',
      action: 'play',
      by: { playerIndex, slot, roleIndex },
      meta: { from: { x: sx, y: sy }, to: { x, y } },
    };
    this._emitSfx(roomId, swapSfx);

    const winner = this.checkBoardForAnyWinner(room);
    if (winner !== null) {
      const winPlayer = room.players[winner];
      winPlayer.wins = (winPlayer.wins || 0) + 1;
      room.status = 'ENDED';

      const victorySfx = { key: this.SFX_KEYS.VICTORY, scope: 'sfx', action: 'play', meta: { durationMs: 10000 } };

      this._emitPlaced(roomId, room, { win: { winnerIndex: winner, winnerId: winPlayer.id }, sfx: swapSfx, sfx2: victorySfx });
      this._emitSfx(roomId, victorySfx);
      setTimeout(() => this.restartGame(roomId), this.POST_GAME_MS);
      return cb?.({ ok: true, win: true });
    }

    this._emitPlaced(roomId, room, { sfx: swapSfx });
    this._emitTurnInfo(roomId, room);
    cb?.({ ok: true });
  }

  // ================= Guldo =================
  gudoAbilityStart(socket, data, cb) {
    const { roomId } = data || {};
    const room = this.rooms[roomId];
    if (!room) return cb?.({ ok: false, message: '房間不存在' });

    this._touchRoom(room);

    if (room.status !== 'PLAYING') return cb?.({ ok: false, message: '遊戲未開始' });

    const playerIndex = room.players.findIndex((p) => p.id === socket.id);
    if (playerIndex === -1) return cb?.({ ok: false, message: '玩家不存在' });
    if (playerIndex !== room.turnIndex) return cb?.({ ok: false, message: '尚未輪到你' });

    const player = room.players[playerIndex];
    const slot = this._getActiveSlot(room);
    const roleIndex = this._getActiveRoleIndex(room, player, slot);
    if (roleIndex !== 4) return cb?.({ ok: false, message: '只有古杜可以使用此能力' });
    if (player.usedGudoThisTurn) return cb?.({ ok: false, message: '本回合已使用過古杜能力' });

    if (player.placedThisTurn && player.placedThisTurn > 0) return cb?.({ ok: false, message: '本回合已經落子，無法發動能力' });

    const board = room.board;
    const size = board.length;
    const selfToken = this._tokenOf(playerIndex, slot);
    const sources = [];

    for (let yy = 0; yy < size; yy++) for (let xx = 0; xx < size; xx++) if (board[yy][xx] === selfToken) sources.push({ x: xx, y: yy });

    if (!sources.length) return cb?.({ ok: false, message: '場上沒有古杜棋可使用能力' });

    room.gudoState = { playerIndex, selfToken, step: 'selectSource', source: null, target: null, emptyAround: [] };

    this._emitSfx(roomId, { key: this.SFX_KEYS.SKILL_GULDO, scope: 'sfx', action: 'prime', by: { playerIndex, slot, roleIndex } });
    cb?.({ ok: true, sources });
  }

  gudoSelectSource(socket, data, cb) {
    const { roomId, x, y } = data || {};
    const room = this.rooms[roomId];
    if (!room) return cb?.({ ok: false, message: '房間不存在' });

    this._touchRoom(room);

    if (room.status !== 'PLAYING') return cb?.({ ok: false, message: '遊戲未開始' });

    const playerIndex = room.players.findIndex((p) => p.id === socket.id);
    if (playerIndex === -1) return cb?.({ ok: false, message: '玩家不存在' });
    if (playerIndex !== room.turnIndex) return cb?.({ ok: false, message: '尚未輪到你' });

    const player = room.players[playerIndex];
    const slot = this._getActiveSlot(room);
    const roleIndex = this._getActiveRoleIndex(room, player, slot);
    if (roleIndex !== 4) return cb?.({ ok: false, message: '只有古杜可以使用此能力' });

    const state = room.gudoState;
    if (!state || state.playerIndex !== playerIndex) return cb?.({ ok: false, message: '尚未啟動古杜能力' });

    if (room.board?.[y]?.[x] !== state.selfToken) return cb?.({ ok: false, message: '請選擇自己的古杜棋' });

    state.source = { x, y };

    const offsets = [-1, 0, 1];
    const area = [];
    for (let dy of offsets) for (let dx of offsets) {
      const nx = x + dx, ny = y + dy;
      if (nx >= 0 && nx < room.board.length && ny >= 0 && ny < room.board.length) area.push({ x: nx, y: ny });
    }

    let hasOther = false;
    for (const p of area) {
      const v = room.board[p.y][p.x];
      if (v > 0 && v !== state.selfToken) { hasOther = true; break; }
    }

    if (!hasOther) {
      room.gudoState = null;
      this.io.to(roomId).emit('gudoCancelled');
      this._emitPlaced(roomId, room);
      this._emitTurnInfo(roomId, room);
      return cb?.({ ok: false, message: '周圍沒有可移動目標，古杜能力取消' });
    }

    state.step = 'selectTarget';
    cb?.({ ok: true, highlights: area });
  }

  gudoSelectTarget(socket, data, cb) {
    const { roomId, x, y } = data || {};
    const room = this.rooms[roomId];
    if (!room) return cb?.({ ok: false, message: '房間不存在' });

    this._touchRoom(room);

    if (room.status !== 'PLAYING') return cb?.({ ok: false, message: '遊戲未開始' });

    const playerIndex = room.players.findIndex((p) => p.id === socket.id);
    if (playerIndex === -1) return cb?.({ ok: false, message: '玩家不存在' });
    if (playerIndex !== room.turnIndex) return cb?.({ ok: false, message: '尚未輪到你' });

    const state = room.gudoState;
    if (!state || state.playerIndex !== playerIndex) return cb?.({ ok: false, message: '尚未啟動古杜能力' });
    if (!state.source) return cb?.({ ok: false, message: '請先選擇古杜棋' });

    if (Math.abs(x - state.source.x) > 1 || Math.abs(y - state.source.y) > 1) return cb?.({ ok: false, message: '只能選擇古杜周圍的棋子' });

    const v = room.board?.[y]?.[x];
    if (v === undefined) return cb?.({ ok: false, message: '座標錯誤' });

    if (v <= 0) return cb?.({ ok: false, message: '只能選正常棋（不能選空格/灰叉）' });
    if (v === state.selfToken) return cb?.({ ok: false, message: '不能選自己此角色的棋' });

    const offsets = [-1, 0, 1];
    const emptyAround = [];
    for (let dy of offsets) for (let dx of offsets) {
      const nx = x + dx, ny = y + dy;
      if (nx >= 0 && nx < room.board.length && ny >= 0 && ny < room.board.length) {
        if (room.board[ny][nx] === 0) emptyAround.push({ x: nx, y: ny });
      }
    }

    if (!emptyAround.length) {
      room.gudoState = null;
      this.io.to(roomId).emit('gudoCancelled');
      this._emitPlaced(roomId, room);
      this._emitTurnInfo(roomId, room);
      return cb?.({ ok: false, message: '該棋周圍沒有空格，古杜能力取消' });
    }

    state.target = { x, y };
    state.emptyAround = emptyAround;
    state.step = 'move';
    cb?.({ ok: true, emptyAround });
  }

  gudoMovePiece(socket, data, cb) {
    const { roomId, x, y } = data || {};
    const room = this.rooms[roomId];
    if (!room) return cb?.({ ok: false, message: '房間不存在' });

    this._touchRoom(room);

    if (room.status !== 'PLAYING') return cb?.({ ok: false, message: '遊戲未開始' });

    const playerIndex = room.players.findIndex((p) => p.id === socket.id);
    if (playerIndex === -1) return cb?.({ ok: false, message: '玩家不存在' });
    if (playerIndex !== room.turnIndex) return cb?.({ ok: false, message: '尚未輪到你' });

    const player = room.players[playerIndex];
    const slot = this._getActiveSlot(room);
    const roleIndex = this._getActiveRoleIndex(room, player, slot);

    const state = room.gudoState;
    if (!state || state.playerIndex !== playerIndex || !state.target) return cb?.({ ok: false, message: '尚未選定可移動棋' });

    if (room.board?.[y]?.[x] !== 0) return cb?.({ ok: false, message: '只能移動到空格' });

    const allowed = Array.isArray(state.emptyAround) ? state.emptyAround.some((p) => p.x === x && p.y === y) : false;
    if (!allowed) return cb?.({ ok: false, message: '只能移動到目標周圍的空格' });

    const targetPiece = state.target;
    const tv = room.board?.[targetPiece.y]?.[targetPiece.x];
    if (tv === undefined || tv <= 0) {
      room.gudoState = null;
      this.io.to(roomId).emit('gudoCancelled');
      this._emitPlaced(roomId, room);
      this._emitTurnInfo(roomId, room);
      return cb?.({ ok: false, message: '目標棋已不存在，古杜能力取消' });
    }

    room.board[targetPiece.y][targetPiece.x] = 0;
    room.board[y][x] = tv;

    player.usedGudoThisTurn = true;
    room.gudoState = null;

    const moveSfx = { key: this.SFX_KEYS.SKILL_GULDO, scope: 'sfx', action: 'play', by: { playerIndex, slot, roleIndex }, meta: { from: targetPiece, to: { x, y } } };
    this._emitSfx(roomId, moveSfx);

    const winner = this.checkBoardForAnyWinner(room);
    if (winner !== null) {
      const winPlayer = room.players[winner];
      winPlayer.wins = (winPlayer.wins || 0) + 1;
      room.status = 'ENDED';

      const victorySfx = { key: this.SFX_KEYS.VICTORY, scope: 'sfx', action: 'play', meta: { durationMs: 10000 } };

      this._emitPlaced(roomId, room, { win: { winnerIndex: winner, winnerId: winPlayer.id }, sfx: moveSfx, sfx2: victorySfx });
      this._emitSfx(roomId, victorySfx);
      setTimeout(() => this.restartGame(roomId), this.POST_GAME_MS);
      return cb?.({ ok: true, win: true });
    }

    this._emitPlaced(roomId, room, { sfx: moveSfx });
    this._emitTurnInfo(roomId, room);
    cb?.({ ok: true });
  }

  // ================= Jeice =================
  emitJeiceCancelled(socket, roomId, message) {
    this.io.to(socket.id).emit('jeiceCancelled', { message });
    const room = this.rooms[roomId];
    if (room) {
      this._emitPlaced(roomId, room);
      this._emitTurnInfo(roomId, room);
    }
  }

  jeiceAbilityStart(socket, data, cb) {
    const { roomId } = data || {};
    const room = this.rooms[roomId];
    if (!room) return cb?.({ ok: false, message: '房間不存在' });

    this._touchRoom(room);

    if (room.status !== 'PLAYING') return cb?.({ ok: false, message: '遊戲未開始' });

    const playerIndex = room.players.findIndex((p) => p.id === socket.id);
    if (playerIndex === -1) return cb?.({ ok: false, message: '玩家不存在' });
    if (playerIndex !== room.turnIndex) return cb?.({ ok: false, message: '尚未輪到你' });

    const player = room.players[playerIndex];
    const slot = this._getActiveSlot(room);
    const roleIndex = this._getActiveRoleIndex(room, player, slot);

    if (roleIndex !== 5) return cb?.({ ok: false, message: '只有吉斯可以使用此能力' });
    if (player.usedJeiceThisTurn) return cb?.({ ok: false, message: '本回合已使用過吉斯能力' });

    if (player.placedThisTurn && player.placedThisTurn > 0) return cb?.({ ok: false, message: '本回合已經落子，無法發動能力' });

    room.jeiceState = { playerIndex, slot, selfToken: this._tokenOf(playerIndex, slot), step: 'place', placed: null, targets: [] };

    this._emitSfx(roomId, { key: this.SFX_KEYS.SKILL_JEICE, scope: 'sfx', action: 'prime', by: { playerIndex, slot, roleIndex } });
    cb?.({ ok: true });
  }

  jeicePlace(socket, data, cb) {
    const { roomId, x, y } = data || {};
    const room = this.rooms[roomId];
    if (!room) return cb?.({ ok: false, message: '房間不存在' });

    this._touchRoom(room);

    if (room.status !== 'PLAYING') return cb?.({ ok: false, message: '遊戲未開始' });

    const playerIndex = room.players.findIndex((p) => p.id === socket.id);
    if (playerIndex === -1) return cb?.({ ok: false, message: '玩家不存在' });
    if (playerIndex !== room.turnIndex) return cb?.({ ok: false, message: '尚未輪到你' });

    const player = room.players[playerIndex];
    const state = room.jeiceState;

    if (!state || state.playerIndex !== playerIndex || state.step !== 'place') {
      room.jeiceState = null;
      this.emitJeiceCancelled(socket, roomId, '吉斯能力已取消');
      return cb?.({ ok: false, message: '尚未發動吉斯能力' });
    }

    const board = room.board;

    if (board?.[y]?.[x] === undefined) return cb?.({ ok: false, message: '座標錯誤' });
    if (board[y][x] !== 0) return cb?.({ ok: false, message: '只能落子在空格' });

    try {
      this.roleAbilities[5].place(board, x, y, state.selfToken);
      player.placedThisTurn = 1;
      player.usedJeiceThisTurn = true;
    } catch (err) {
      room.jeiceState = null;
      this.emitJeiceCancelled(socket, roomId, err?.message || '落子失敗');
      return cb?.({ ok: false, message: err?.message || '落子失敗' });
    }

    const placeSfx = { key: this.SFX_KEYS.PLACE_JEICE, scope: 'sfx', action: 'play', by: { playerIndex, slot: state.slot, roleIndex: 5 }, meta: { x, y } };
    this._emitSfx(roomId, placeSfx);

    const selfToken = state.selfToken;
    const targets = [];

    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      if (dx === 0 && dy === 0) continue;
      const tx = x + dx, ty = y + dy;
      const v = board?.[ty]?.[tx];
      if (typeof v === 'number' && v > 0 && v !== selfToken) targets.push({ x: tx, y: ty });
    }

    state.step = 'selectTarget';
    state.placed = { x, y };
    state.targets = targets;

    if (!targets.length) {
      room.jeiceState = null;

      const roleIndexNow = this._getActiveRoleIndex(room, player, state.slot);
      const targetN = roleIndexNow === 1 ? 6 : room.targetN;
      const win = this.checkWinner(board, x, y, selfToken, targetN);

      if (win) {
        player.wins = (player.wins || 0) + 1;
        room.status = 'ENDED';

        const victorySfx = { key: this.SFX_KEYS.VICTORY, scope: 'sfx', action: 'play', meta: { durationMs: 10000 } };

        this._emitPlaced(roomId, room, { win: { winnerIndex: playerIndex, winnerId: player.id }, sfx: placeSfx, sfx2: victorySfx });
        this._emitSfx(roomId, victorySfx);
        setTimeout(() => this.restartGame(roomId), this.POST_GAME_MS);
        return cb?.({ ok: true, targets: [], win: true });
      }

      this._advanceTurn(room);
      this._emitPlaced(roomId, room, { sfx: placeSfx });
      this._emitTurnInfo(roomId, room);
      return cb?.({ ok: true, targets: [] });
    }

    cb?.({ ok: true, targets, placed: { x, y } });
  }

  jeiceSelectTarget(socket, data, cb) {
    const { roomId, x, y } = data || {};
    const room = this.rooms[roomId];
    if (!room) return cb?.({ ok: false, message: '房間不存在' });

    this._touchRoom(room);

    if (room.status !== 'PLAYING') return cb?.({ ok: false, message: '遊戲未開始' });

    const playerIndex = room.players.findIndex((p) => p.id === socket.id);
    if (playerIndex === -1) return cb?.({ ok: false, message: '玩家不存在' });
    if (playerIndex !== room.turnIndex) return cb?.({ ok: false, message: '尚未輪到你' });

    const state = room.jeiceState;

    if (!state || state.playerIndex !== playerIndex || state.step !== 'selectTarget' || !state.placed) {
      room.jeiceState = null;
      this.emitJeiceCancelled(socket, roomId, '吉斯能力已取消');
      return cb?.({ ok: false, message: '尚未進入選擇擊退目標階段' });
    }

    const isValid = Array.isArray(state.targets) && state.targets.some((p) => p.x === x && p.y === y);
    if (!isValid) return this.jeiceCancel(socket, { roomId }, cb);

    const board = room.board;
    const from = state.placed;

    const tv = board?.[y]?.[x];
    if (tv === undefined) {
      room.jeiceState = null;
      this.emitJeiceCancelled(socket, roomId, '座標錯誤');
      return cb?.({ ok: false, message: '座標錯誤' });
    }

    if (tv <= 0) return this.jeiceCancel(socket, { roomId }, cb);

    const dx = Math.sign(x - from.x);
    const dy = Math.sign(y - from.y);
    if (dx === 0 && dy === 0) return this.jeiceCancel(socket, { roomId }, cb);

    const oneX = x + dx, oneY = y + dy;
    const twoX = x + dx * 2, twoY = y + dy * 2;

    const inBoard = (px, py) => py >= 0 && py < board.length && px >= 0 && px < board.length;

    let pushedTo = null;

    if (inBoard(oneX, oneY) && board[oneY][oneX] === 0) {
      const can2 = inBoard(twoX, twoY) && board[twoY][twoX] === 0;
      const nx = can2 ? twoX : oneX;
      const ny = can2 ? twoY : oneY;

      board[y][x] = 0;
      board[ny][nx] = tv;
      pushedTo = { x: nx, y: ny };
    } else {
      pushedTo = null;
    }

    room.jeiceState = null;

    const jeiceSkillSfx = { key: this.SFX_KEYS.SKILL_JEICE, scope: 'sfx', action: 'play', by: { playerIndex, slot: state.slot, roleIndex: 5 }, meta: { from, target: { x, y }, to: pushedTo } };
    this._emitSfx(roomId, jeiceSkillSfx);

    const winner = this.checkBoardForAnyWinner(room);
    if (winner !== null) {
      const winPlayer = room.players[winner];
      winPlayer.wins = (winPlayer.wins || 0) + 1;
      room.status = 'ENDED';

      const victorySfx = { key: this.SFX_KEYS.VICTORY, scope: 'sfx', action: 'play', meta: { durationMs: 10000 } };

      this._emitPlaced(roomId, room, { win: { winnerIndex: winner, winnerId: winPlayer.id }, effect: { type: 'jeice', from, target: { x, y }, to: pushedTo }, sfx: jeiceSkillSfx, sfx2: victorySfx });
      this._emitSfx(roomId, victorySfx);
      setTimeout(() => this.restartGame(roomId), this.POST_GAME_MS);
      cb?.({ ok: true, win: true });
      return;
    }

    this._advanceTurn(room);

    this._emitPlaced(roomId, room, { effect: { type: 'jeice', from, target: { x, y }, to: pushedTo }, sfx: jeiceSkillSfx });
    this._emitTurnInfo(roomId, room);
    cb?.({ ok: true, pushedTo });
  }

  jeiceCancel(socket, data, cb) {
    const { roomId } = data || {};
    const room = this.rooms[roomId];
    if (!room) return cb?.({ ok: false, message: '房間不存在' });

    this._touchRoom(room);

    if (room.status !== 'PLAYING') return cb?.({ ok: false, message: '遊戲未開始' });

    const playerIndex = room.players.findIndex((p) => p.id === socket.id);
    if (playerIndex === -1) return cb?.({ ok: false, message: '玩家不存在' });
    if (playerIndex !== room.turnIndex) return cb?.({ ok: false, message: '尚未輪到你' });

    const player = room.players[playerIndex];

    const state = room.jeiceState;
    const hasPlaced = !!state?.placed || player.placedThisTurn > 0;

    if (!state || state.playerIndex !== playerIndex) {
      room.jeiceState = null;
      this.io.to(socket.id).emit('jeiceCancelled', { message: '已取消吉斯流程' });

      if (hasPlaced) this._advanceTurn(room);

      this._emitPlaced(roomId, room);
      this._emitTurnInfo(roomId, room);
      return cb?.({ ok: true });
    }

    if (!state.placed) {
      player.usedJeiceThisTurn = true;
      room.jeiceState = null;

      this.io.to(socket.id).emit('jeiceCancelled', { message: '本回合不使用吉斯技能' });

      this._emitPlaced(roomId, room);
      this._emitTurnInfo(roomId, room);
      return cb?.({ ok: true });
    }

    player.usedJeiceThisTurn = true;
    room.jeiceState = null;

    this._advanceTurn(room);
    this._emitPlaced(roomId, room);
    this._emitTurnInfo(roomId, room);

    return cb?.({ ok: true });
  }

  // ================= Win Check =================
  checkBoardForAnyWinner(room) {
    const board = room.board;
    for (let y = 0; y < board.length; y++) {
      for (let x = 0; x < board[y].length; x++) {
        const v = board[y][x];
        if (v > 0) {
          const { ownerIndex, slot } = this._decodeToken(v);
          const owner = room.players?.[ownerIndex];
          const roleIndex = this._getActiveRoleIndex(room, owner, slot);
          const n = roleIndex === 1 ? 6 : room.targetN;
          if (this.checkWinner(board, x, y, v, n)) return ownerIndex;
        }
      }
    }
    return null;
  }

  checkWinner(board, x, y, token, targetN) {
    if (board[y][x] !== token) return false;

    const dirs = [[1, 0], [0, 1], [1, 1], [1, -1]];

    for (const [dx, dy] of dirs) {
      let c = 1;
      for (let i = 1; i < targetN; i++) {
        const v = board[y + dy * i]?.[x + dx * i];
        if (v === token) c++;
        else break;
      }
      for (let i = 1; i < targetN; i++) {
        const v = board[y - dy * i]?.[x - dx * i];
        if (v === token) c++;
        else break;
      }
      if (c >= targetN) return true;
    }
    return false;
  }

  // ================= AI Host Config =================
  setAiRole(socket, payload, cb) {
    try {
      const { roomId } = payload || {};
      const room = this.rooms?.[roomId];
      if (!room) return cb?.({ ok: false, message: '房間不存在' });

      // ✅ 只允許房主改 AI
      if (!this._isHost(socket, room)) return cb?.({ ok: false, message: '只有房主可操作 AI' });

      const aiPlayerIndex = this._resolveAiPlayerIndex(room, payload);
      if (aiPlayerIndex < 0) return cb?.({ ok: false, message: 'aiIndex 不合法' });

      const p = room.players?.[aiPlayerIndex];
      if (!p || !p.isAI) return cb?.({ ok: false, message: 'AI 玩家不存在' });

      const r = Number(payload?.roleIndex);
      if (!Number.isInteger(r) || r < 0) return cb?.({ ok: false, message: 'roleIndex 不合法' });

      if (room.mode === 'DUAL') {
        const s = Number(payload?.slot);
        if (s !== 1 && s !== 2) return cb?.({ ok: false, message: 'DUAL slot 必須是 1 或 2' });

        if (s === 1) {
          if (typeof p.roleIndex2 === 'number' && p.roleIndex2 === r) {
            return cb?.({ ok: false, message: 'AI 的 角色1/角色2 不能重複' });
          }
          p.roleIndex1 = r;
        } else {
          if (typeof p.roleIndex1 === 'number' && p.roleIndex1 === r) {
            return cb?.({ ok: false, message: 'AI 的 角色1/角色2 不能重複' });
          }
          p.roleIndex2 = r;
        }
      } else {
        p.roleIndex = r;
      }

            // ✅ AI：若配置齊（顏色 + 角色），自動 READY
      if (p.isAI) {
        p.ready = this._isPlayerConfigured(room, p);
      }

      this._touchRoom(room);
      this._broadcastRoom(roomId);

      return cb?.({ ok: true, room, aiPlayerIndex, aiReady: p.ready });

    } catch (e) {
      return cb?.({ ok: false, message: e?.message || 'setAiRole error' });
    }
  }

  setAiColor(socket, payload, cb) {
    try {
      const { roomId } = payload || {};
      const room = this.rooms?.[roomId];
      if (!room) return cb?.({ ok: false, message: '房間不存在' });

      if (!this._isHost(socket, room)) return cb?.({ ok: false, message: '只有房主可操作 AI' });

      const aiPlayerIndex = this._resolveAiPlayerIndex(room, payload);
      if (aiPlayerIndex < 0) return cb?.({ ok: false, message: 'aiIndex 不合法' });

      const p = room.players?.[aiPlayerIndex];
      if (!p || !p.isAI) return cb?.({ ok: false, message: 'AI 玩家不存在' });

      const c = Number(payload?.colorIndex ?? payload?.color ?? payload?.colorId);
      if (!Number.isInteger(c) || c < 0) return cb?.({ ok: false, message: 'colorIndex 不合法' });

      // ✅ 你的 Board 顯示用的是 player.colorIndex
      p.colorIndex = c;

            // ✅ AI：若配置齊（顏色 + 角色），自動 READY
      if (p.isAI) {
        p.ready = this._isPlayerConfigured(room, p);
      }

      this._touchRoom(room);
      this._broadcastRoom(roomId);

      return cb?.({ ok: true, room, aiPlayerIndex, aiReady: p.ready });

    } catch (e) {
      return cb?.({ ok: false, message: e?.message || 'setAiColor error' });
    }
  }
}

module.exports = GameManager;
