// ================= gameManager.js (DUAL + role-token + SFX hooks + UNDO + TurnInfo + Rejoin helpers) =================
// ✅ 本檔新增/修正重點：
// 1) 修正多處錯誤使用 room.id 造成 emit 發到 undefined 房間（嚴重不同步）
// 2) 每次重要互動都 touch room.lastActiveAt（配合 server.js 5 分鐘 TTL 不清房）
// 3) 新增 turnInfo / yourTurn：方便前端做「回合形狀/顏色 + 箭頭 + 輪到你了」
// 4) 新增 setPlayerRole / rejoinByName：給 server.js 用，減少 roomUpdated 造成的選角 UI 中斷
// 5) 保留原本 UNDO：巴特/羅根可在本回合第 1 手悔棋（可反覆悔到你下完第 2 手才結束回合）

class GameManager {
  constructor(io, rooms) {
    this.io = io;
    this.rooms = rooms;

    // ✅ 與前端賽後倒數一致：10 秒後回 Lobby 並重選角
    this.POST_GAME_MS = 10500;

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

    // ✅ 角色說明（前端要做「技能說明清單」時可直接拿）
    //    （你前端也可以不聽這份，用自己寫的；但我先把資料放好方便你接）
    this.ROLE_INFO = {
      0: {
        name: '基紐',
        desc: '可發動「交換」：選自己的基紐棋，再選同列/同行任一敵方正常棋，兩者交換位置。',
      },
      1: {
        name: '巴特',
        desc: '每回合可下 2 手（同一角色連線勝利需 6 連線）。第 1 手可悔棋。',
      },
      2: {
        name: '力庫姆',
        desc: '可覆蓋「非叉叉」位置（可蓋掉一般棋），不能下在灰叉上。',
      },
      3: {
        name: '羅根',
        desc: '每回合 2 手：第 1 手下正常棋（可下空格或自己的灰叉上）；第 2 手下灰叉（只能下空格）。第 1 手可悔棋。',
      },
      4: {
        name: '古杜',
        desc: '可移動古杜周圍 8 格內的一顆「正常棋」到該棋周圍的空格（需有空格）。',
      },
      5: {
        name: '吉斯',
        desc: '先落子；若相鄰有敵方正常棋，可選 1 顆擊退（遠離落子方向）最多 2 格，需有空格才可推。',
      },
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
          if (board[y][x] < 0) throw new Error('不能放在叉叉上');
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
  now() {
    return Date.now();
  }

  // ✅ 每次互動都更新 room.lastActiveAt（配合 server.js 做 5 分鐘 TTL 清房）
  _touchRoom(room) {
    if (!room) return;
    room.lastActiveAt = this.now();
  }

  createEmptyBoard(size) {
    return Array.from({ length: size }, () => Array(size).fill(0));
  }

  _tokenOf(playerIndex, slot) {
    return playerIndex * 2 + slot; // 1-based token for pieces: (p0,s1)=1,(p0,s2)=2,(p1,s1)=3,(p1,s2)=4...
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

  _getTurnMeta(room) {
    const turnIndex = room.turnIndex || 0;
    const turnSlot = room.turnSlot || 1;
    const p = room.players?.[turnIndex] || null;
    const roleIndex = this._getActiveRoleIndex(room, p, turnSlot);
    const token = typeof turnIndex === 'number' ? this._tokenOf(turnIndex, turnSlot) : null;

    return {
      turnIndex,
      turnSlot,
      turnPlayerId: p?.id || null,
      turnPlayerName: p?.name || p?.nickname || null,
      roleIndex: typeof roleIndex === 'number' ? roleIndex : null,
      token,
      roleName: typeof roleIndex === 'number' ? this.ROLE_INFO?.[roleIndex]?.name || null : null,
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
      turnMeta, // ✅ 前端做回合提示(形狀/顏色/箭頭/輪到你) 的資料入口
      roleInfo: this.ROLE_INFO, // ✅ 前端想做技能說明清單可直接用
      ...extra,
    });
  }

  _emitRoomUpdated(roomId, room, extra = {}) {
    // ✅ 給 lobby / 選角時更新用。你也可以在 server.js 改成只 emit patch。
    const turnMeta = this._getTurnMeta(room);
    this.io.to(roomId).emit('roomUpdated', {
      ...room,
      turnMeta,
      roleInfo: this.ROLE_INFO,
      ...extra,
    });
  }

  _emitSfx(roomId, sfx) {
    try {
      this.io.to(roomId).emit('sfx', sfx);
    } catch (e) {}
  }

  _sfxForPlace(roleIndex, placedThisTurnBefore) {
    switch (roleIndex) {
      case 0:
        return this.SFX_KEYS.PLACE_GINYU;
      case 1:
        return placedThisTurnBefore === 0
          ? this.SFX_KEYS.PLACE_BURTER_1
          : this.SFX_KEYS.PLACE_BURTER_2;
      case 2:
        return this.SFX_KEYS.PLACE_RECOOME;
      case 3:
        return placedThisTurnBefore === 0
          ? this.SFX_KEYS.PLACE_LOGAN
          : this.SFX_KEYS.PLACE_LOGAN_CROSS;
      case 4:
        return this.SFX_KEYS.PLACE_GULDO;
      case 5:
        return this.SFX_KEYS.PLACE_JEICE;
      default:
        return this.SFX_KEYS.UI_CLICK;
    }
  }

  // ✅ 保存「本回合第 1 手」以供悔棋（只限巴特/羅根）
  _setFirstMoveSnapshot(player, snap) {
    player._firstMove = snap || null;
  }
  _getFirstMoveSnapshot(player) {
    return player?._firstMove || null;
  }
  _clearFirstMoveSnapshot(player) {
    if (player) player._firstMove = null;
  }

  // ✅ 讓前端做「輪到你了」提示＆回合箭頭
  _emitTurnInfo(roomId, room) {
    const meta = this._getTurnMeta(room);
    this.io.to(roomId).emit('turnInfo', meta);

    // ✅ 只推給當前玩家（若前端想做 popup/震動/提示音）
    if (meta.turnPlayerId) {
      this.io.to(meta.turnPlayerId).emit('yourTurn', meta);
    }
  }

  // ================= Lobby helpers (給 server.js 用) =================
  // ✅ 修正「伺服端更新角色會讓另一個人選角中斷」：建議 server.js 改用這個，只發 patch，不要一直整包 roomUpdated
  // data: { roomId, playerId, slot, roleIndex, name? }
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

    // ✅ 只發 patch：前端若支援可避免「整個 lobby state 被 reset」
    this.io.to(roomId).emit('rolePatched', {
      playerIndex: idx,
      playerId: p.id,
      name: p.name || null,
      slot: room.mode === 'DUAL' ? (slot === 2 ? 2 : 1) : 1,
      roleIndex,
      roleName: this.ROLE_INFO?.[roleIndex]?.name || null,
    });

    // ✅ 同時仍發 roomUpdated（如果你的前端仍依賴 roomUpdated）
    //    若你已經把前端改成吃 rolePatched，就可以在 server.js 不再呼叫 roomUpdated。
    this._emitRoomUpdated(roomId, room);

    cb?.({ ok: true });
  }

  // ✅ 讓「斷線重整」用名字回來（server.js 收到 joinRoom 時呼叫）
  // data: { roomId, name, newSocketId }
  rejoinByName(roomId, data, cb) {
    const room = this.rooms[roomId];
    if (!room) return cb?.({ ok: false, message: '房間不存在' });

    this._touchRoom(room);

    const { name, newSocketId } = data || {};
    if (!name || !newSocketId) return cb?.({ ok: false, message: '參數不足' });

    const idx = room.players?.findIndex((p) => (p.name || '') === name) ?? -1;
    if (idx === -1) return cb?.({ ok: false, message: '找不到同名玩家' });

    const p = room.players[idx];

    // ✅ 把玩家 socket id 換成新的，並標記連線狀態
    p.id = newSocketId;
    p.connected = true;
    p.lastRejoinAt = this.now();

    // ✅ 若正好輪到他，補推一次 yourTurn，避免重整後不知道輪到誰
    if (room.status === 'PLAYING') {
      const meta = this._getTurnMeta(room);
      if (meta.turnIndex === idx && meta.turnPlayerId) {
        this.io.to(meta.turnPlayerId).emit('yourTurn', meta);
      }
    }

    this._emitRoomUpdated(roomId, room, { rejoined: { playerIndex: idx, name } });
    cb?.({ ok: true, playerIndex: idx });
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

    this._emitSfx(roomId, {
      key: this.SFX_KEYS.BATTLE_BGM,
      scope: 'bgm',
      action: 'start',
    });

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

    this._emitSfx(roomId, {
      key: this.SFX_KEYS.LOBBY_BGM,
      scope: 'bgm',
      action: 'start',
    });

    this._emitTurnInfo(roomId, room);
  }

  // ================= UNDO (Burter / Logan) =================
  undoMove(socket, data, cb) {
    const { roomId } = data || {};
    const room = this.rooms[roomId];
    if (!room) return cb?.({ ok: false, message: '房間不存在' });

    this._touchRoom(room);

    if (room.status !== 'PLAYING')
      return cb?.({ ok: false, message: '遊戲未開始' });

    const playerIndex = room.players.findIndex((p) => p.id === socket.id);
    if (playerIndex === -1) return cb?.({ ok: false, message: '玩家不存在' });
    if (playerIndex !== room.turnIndex)
      return cb?.({ ok: false, message: '尚未輪到你' });

    const player = room.players[playerIndex];
    const slot = this._getActiveSlot(room);
    const roleIndex = this._getActiveRoleIndex(room, player, slot);

    if (roleIndex !== 1 && roleIndex !== 3) {
      return cb?.({ ok: false, message: '只有巴特/羅根可悔棋' });
    }

    // 只允許悔第一手：placedThisTurn 必須為 1
    if ((player.placedThisTurn || 0) !== 1) {
      return cb?.({ ok: false, message: '只能在本回合第 1 手悔棋（第 2 手後不可悔）' });
    }

    const snap = this._getFirstMoveSnapshot(player);
    if (!snap) return cb?.({ ok: false, message: '沒有可悔棋的紀錄' });

    // 防呆：確保還在同一個 turn key
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

    // 回復棋盤
    room.board[y][x] = prev;

    // 回復回合步數
    player.placedThisTurn = 0;

    // 清理能力流程（避免悔棋後殘留）
    room.ginyuState = null;
    room.gudoState = null;
    room.jeiceState = null;

    // 清除快照（悔完後可再次下新的第一手，再建立新快照）
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

    // ✅ 悔棋不換回合，但可以再提示一次「輪到你」
    this._emitTurnInfo(roomId, room);

    cb?.({ ok: true });
  }

  // ================= Normal Place =================
  placePiece(socket, data, cb) {
    const { roomId, x, y } = data || {};
    const room = this.rooms[roomId];
    if (!room) return cb?.({ ok: false, message: '房間不存在' });

    this._touchRoom(room);

    if (room.status !== 'PLAYING')
      return cb?.({ ok: false, message: '遊戲未開始' });

    const playerIndex = room.players.findIndex((p) => p.id === socket.id);
    if (playerIndex === -1) return cb?.({ ok: false, message: '玩家不存在' });
    if (playerIndex !== room.turnIndex)
      return cb?.({ ok: false, message: '尚未輪到你' });

    const player = room.players[playerIndex];
    const slot = this._getActiveSlot(room);
    const roleIndex = this._getActiveRoleIndex(room, player, slot);
    const role = this.roleAbilities[roleIndex];
    if (typeof roleIndex !== 'number' || !role)
      return cb?.({ ok: false, message: '角色未設定' });

    if (room.jeiceState && room.jeiceState.playerIndex === playerIndex) {
      return cb?.({ ok: false, message: '吉斯能力進行中，請先完成或取消' });
    }

    const board = room.board;
    const token = this._tokenOf(playerIndex, slot);

    const placedThisTurnBefore = player.placedThisTurn || 0;

    // ✅ 若是巴特/羅根，且即將下第 1 手：先準備快照（成功落子後才正式保存）
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
          prev: prevValue, // 通常是 0；羅根可能是自己的灰叉
          turnIndex: room.turnIndex,
          turnSlot: room.turnSlot || 1,
        });
      } else {
        // 第 2 手或其它角色：避免殘留
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

      const victorySfx = {
        key: this.SFX_KEYS.VICTORY,
        scope: 'sfx',
        action: 'play',
        meta: { durationMs: 10000 },
      };

      this._emitPlaced(roomId, room, {
        win: { winnerIndex: playerIndex, winnerId: player.id },
        sfx: {
          key: placeSfxKey,
          by: { playerIndex, slot, roleIndex },
          meta: { x, y, step: placedThisTurnBefore },
        },
        sfx2: victorySfx,
      });

      this._emitSfx(roomId, {
        key: placeSfxKey,
        scope: 'sfx',
        action: 'play',
        by: { playerIndex, slot, roleIndex },
        meta: { x, y, step: placedThisTurnBefore },
      });
      this._emitSfx(roomId, victorySfx);

      setTimeout(() => this.restartGame(roomId), this.POST_GAME_MS);
      return cb?.({ ok: true, win: true });
    }

    // 非勝利：先廣播落子音效
    this._emitSfx(roomId, {
      key: placeSfxKey,
      scope: 'sfx',
      action: 'play',
      by: { playerIndex, slot, roleIndex },
      meta: { x, y, step: placedThisTurnBefore },
    });

    if (player.placedThisTurn >= role.maxMoves) {
      this._advanceTurn(room);
    }

    this._emitPlaced(roomId, room, {
      sfx: {
        key: placeSfxKey,
        by: { playerIndex, slot, roleIndex },
        meta: { x, y, step: placedThisTurnBefore },
      },
    });

    // ✅ 若剛好換回合，_advanceTurn 裡也會 emit turnInfo；
    //    若沒換回合（巴特/羅根第 1 手），這裡再補一次 turnInfo 方便前端更新提示
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
        if (room.turnIndex < lastIdx) {
          room.turnIndex += 1;
        } else {
          room.turnIndex = 0;
          room.turnSlot = 2;
        }
      } else {
        if (room.turnIndex < lastIdx) {
          room.turnIndex += 1;
        } else {
          room.turnIndex = 0;
          room.turnSlot = 1;
        }
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

    if (room.status !== 'PLAYING')
      return cb?.({ ok: false, message: '遊戲未開始' });

    const playerIndex = room.players.findIndex((p) => p.id === socket.id);
    if (playerIndex === -1) return cb?.({ ok: false, message: '玩家不存在' });
    if (playerIndex !== room.turnIndex)
      return cb?.({ ok: false, message: '尚未輪到你' });

    const player = room.players[playerIndex];
    const slot = this._getActiveSlot(room);
    const roleIndex = this._getActiveRoleIndex(room, player, slot);
    if (roleIndex !== 0)
      return cb?.({ ok: false, message: '只有基紐可以取消此能力' });

    room.ginyuState = null;
    this.emitGinyuCancelled(socket, roomId, '已取消基紐能力');
    cb?.({ ok: true });
  }

  ginyuAbilityStart(socket, data, cb) {
    const { roomId } = data || {};
    const room = this.rooms[roomId];
    if (!room) return cb?.({ ok: false, message: '房間不存在' });

    this._touchRoom(room);

    if (room.status !== 'PLAYING')
      return cb?.({ ok: false, message: '遊戲未開始' });

    const playerIndex = room.players.findIndex((p) => p.id === socket.id);
    if (playerIndex === -1) return cb?.({ ok: false, message: '玩家不存在' });
    if (playerIndex !== room.turnIndex)
      return cb?.({ ok: false, message: '尚未輪到你' });

    const player = room.players[playerIndex];
    const slot = this._getActiveSlot(room);
    const roleIndex = this._getActiveRoleIndex(room, player, slot);
    if (roleIndex !== 0)
      return cb?.({ ok: false, message: '只有基紐可以使用此能力' });

    if (player.placedThisTurn && player.placedThisTurn > 0)
      return cb?.({ ok: false, message: '本回合已經落子，無法發動能力' });

    if (player.usedGinyuThisTurn)
      return cb?.({ ok: false, message: '本回合已使用過基紐能力' });

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
          if (v > 0 && v !== selfToken) {
            canSwap = true;
            break;
          }
        }
        if (!canSwap) {
          for (let cy = 0; cy < size; cy++) {
            const v = board[cy][xx];
            if (v > 0 && v !== selfToken) {
              canSwap = true;
              break;
            }
          }
        }
        if (canSwap) sources.push({ x: xx, y: yy });
      }
    }

    if (!sources.length)
      return cb?.({ ok: false, message: '目前沒有可以發動基紐能力的位置' });

    room.ginyuState = {
      playerIndex,
      selfToken,
      sources,
      source: null,
      targets: [],
    };

    this._emitSfx(roomId, {
      key: this.SFX_KEYS.SKILL_GINYU_SWAP,
      scope: 'sfx',
      action: 'prime',
      by: { playerIndex, slot, roleIndex },
    });

    cb?.({ ok: true, sources });
  }

  ginyuSelectSource(socket, data, cb) {
    const { roomId, x, y } = data || {};
    const room = this.rooms[roomId];
    if (!room) return cb?.({ ok: false, message: '房間不存在' });

    this._touchRoom(room);

    if (room.status !== 'PLAYING')
      return cb?.({ ok: false, message: '遊戲未開始' });

    const playerIndex = room.players.findIndex((p) => p.id === socket.id);
    if (playerIndex === -1) return cb?.({ ok: false, message: '玩家不存在' });
    if (playerIndex !== room.turnIndex)
      return cb?.({ ok: false, message: '尚未輪到你' });

    const player = room.players[playerIndex];
    const slot = this._getActiveSlot(room);
    const roleIndex = this._getActiveRoleIndex(room, player, slot);
    if (roleIndex !== 0)
      return cb?.({ ok: false, message: '只有基紐可以使用此能力' });

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
      if (
        v > 0 &&
        v !== selfToken &&
        !targets.some((t) => t.x === x && t.y === cy)
      ) {
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

    if (room.status !== 'PLAYING')
      return cb?.({ ok: false, message: '遊戲未開始' });

    const playerIndex = room.players.findIndex((p) => p.id === socket.id);
    if (playerIndex === -1) return cb?.({ ok: false, message: '玩家不存在' });
    if (playerIndex !== room.turnIndex)
      return cb?.({ ok: false, message: '尚未輪到你' });

    const player = room.players[playerIndex];
    const slot = this._getActiveSlot(room);
    const roleIndex = this._getActiveRoleIndex(room, player, slot);
    if (roleIndex !== 0)
      return cb?.({ ok: false, message: '只有基紐可以使用此能力' });

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

      const victorySfx = {
        key: this.SFX_KEYS.VICTORY,
        scope: 'sfx',
        action: 'play',
        meta: { durationMs: 10000 },
      };

      // ✅ 修正：不要用 room.id（可能不存在）
      this._emitPlaced(roomId, room, {
        win: { winnerIndex: winner, winnerId: winPlayer.id },
        sfx: swapSfx,
        sfx2: victorySfx,
      });

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

    if (room.status !== 'PLAYING')
      return cb?.({ ok: false, message: '遊戲未開始' });

    const playerIndex = room.players.findIndex((p) => p.id === socket.id);
    if (playerIndex === -1) return cb?.({ ok: false, message: '玩家不存在' });
    if (playerIndex !== room.turnIndex)
      return cb?.({ ok: false, message: '尚未輪到你' });

    const player = room.players[playerIndex];
    const slot = this._getActiveSlot(room);
    const roleIndex = this._getActiveRoleIndex(room, player, slot);
    if (roleIndex !== 4)
      return cb?.({ ok: false, message: '只有古杜可以使用此能力' });
    if (player.usedGudoThisTurn)
      return cb?.({ ok: false, message: '本回合已使用過古杜能力' });

    if (player.placedThisTurn && player.placedThisTurn > 0)
      return cb?.({ ok: false, message: '本回合已經落子，無法發動能力' });

    const board = room.board;
    const size = board.length;
    const selfToken = this._tokenOf(playerIndex, slot);
    const sources = [];

    for (let yy = 0; yy < size; yy++) {
      for (let xx = 0; xx < size; xx++) {
        if (board[yy][xx] === selfToken) sources.push({ x: xx, y: yy });
      }
    }

    if (!sources.length)
      return cb?.({ ok: false, message: '場上沒有古杜棋可使用能力' });

    room.gudoState = {
      playerIndex,
      selfToken,
      step: 'selectSource',
      source: null,
      target: null,
      emptyAround: [],
    };

    this._emitSfx(roomId, {
      key: this.SFX_KEYS.SKILL_GULDO,
      scope: 'sfx',
      action: 'prime',
      by: { playerIndex, slot, roleIndex },
    });

    cb?.({ ok: true, sources });
  }

  gudoSelectSource(socket, data, cb) {
    const { roomId, x, y } = data || {};
    const room = this.rooms[roomId];
    if (!room) return cb?.({ ok: false, message: '房間不存在' });

    this._touchRoom(room);

    if (room.status !== 'PLAYING')
      return cb?.({ ok: false, message: '遊戲未開始' });

    const playerIndex = room.players.findIndex((p) => p.id === socket.id);
    if (playerIndex === -1) return cb?.({ ok: false, message: '玩家不存在' });
    if (playerIndex !== room.turnIndex)
      return cb?.({ ok: false, message: '尚未輪到你' });

    const player = room.players[playerIndex];
    const slot = this._getActiveSlot(room);
    const roleIndex = this._getActiveRoleIndex(room, player, slot);
    if (roleIndex !== 4)
      return cb?.({ ok: false, message: '只有古杜可以使用此能力' });

    const state = room.gudoState;
    if (!state || state.playerIndex !== playerIndex)
      return cb?.({ ok: false, message: '尚未啟動古杜能力' });

    if (room.board?.[y]?.[x] !== state.selfToken)
      return cb?.({ ok: false, message: '請選擇自己的古杜棋' });

    state.source = { x, y };

    const offsets = [-1, 0, 1];
    const area = [];
    for (let dy of offsets) {
      for (let dx of offsets) {
        const nx = x + dx;
        const ny = y + dy;
        if (
          nx >= 0 &&
          nx < room.board.length &&
          ny >= 0 &&
          ny < room.board.length
        ) {
          area.push({ x: nx, y: ny });
        }
      }
    }

    let hasOther = false;
    for (const p of area) {
      const v = room.board[p.y][p.x];
      if (v > 0 && v !== state.selfToken) {
        hasOther = true;
        break;
      }
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

    if (room.status !== 'PLAYING')
      return cb?.({ ok: false, message: '遊戲未開始' });

    const playerIndex = room.players.findIndex((p) => p.id === socket.id);
    if (playerIndex === -1) return cb?.({ ok: false, message: '玩家不存在' });
    if (playerIndex !== room.turnIndex)
      return cb?.({ ok: false, message: '尚未輪到你' });

    const state = room.gudoState;
    if (!state || state.playerIndex !== playerIndex)
      return cb?.({ ok: false, message: '尚未啟動古杜能力' });

    if (!state.source) return cb?.({ ok: false, message: '請先選擇古杜棋' });

    if (Math.abs(x - state.source.x) > 1 || Math.abs(y - state.source.y) > 1)
      return cb?.({ ok: false, message: '只能選擇古杜周圍的棋子' });

    const v = room.board?.[y]?.[x];
    if (v === undefined) return cb?.({ ok: false, message: '座標錯誤' });

    if (v <= 0)
      return cb?.({ ok: false, message: '只能選正常棋（不能選空格/灰叉）' });
    if (v === state.selfToken)
      return cb?.({ ok: false, message: '不能選自己此角色的棋' });

    const offsets = [-1, 0, 1];
    const emptyAround = [];
    for (let dy of offsets) {
      for (let dx of offsets) {
        const nx = x + dx;
        const ny = y + dy;
        if (
          nx >= 0 &&
          nx < room.board.length &&
          ny >= 0 &&
          ny < room.board.length
        ) {
          if (room.board[ny][nx] === 0) {
            emptyAround.push({ x: nx, y: ny });
          }
        }
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

    if (room.status !== 'PLAYING')
      return cb?.({ ok: false, message: '遊戲未開始' });

    const playerIndex = room.players.findIndex((p) => p.id === socket.id);
    if (playerIndex === -1) return cb?.({ ok: false, message: '玩家不存在' });
    if (playerIndex !== room.turnIndex)
      return cb?.({ ok: false, message: '尚未輪到你' });

    const player = room.players[playerIndex];
    const slot = this._getActiveSlot(room);
    const roleIndex = this._getActiveRoleIndex(room, player, slot);

    const state = room.gudoState;
    if (!state || state.playerIndex !== playerIndex || !state.target)
      return cb?.({ ok: false, message: '尚未選定可移動棋' });

    if (room.board?.[y]?.[x] !== 0)
      return cb?.({ ok: false, message: '只能移動到空格' });

    const allowed = Array.isArray(state.emptyAround)
      ? state.emptyAround.some((p) => p.x === x && p.y === y)
      : false;

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

    const moveSfx = {
      key: this.SFX_KEYS.SKILL_GULDO,
      scope: 'sfx',
      action: 'play',
      by: { playerIndex, slot, roleIndex },
      meta: { from: targetPiece, to: { x, y } },
    };
    this._emitSfx(roomId, moveSfx);

    const winner = this.checkBoardForAnyWinner(room);
    if (winner !== null) {
      const winPlayer = room.players[winner];
      winPlayer.wins = (winPlayer.wins || 0) + 1;
      room.status = 'ENDED';

      const victorySfx = {
        key: this.SFX_KEYS.VICTORY,
        scope: 'sfx',
        action: 'play',
        meta: { durationMs: 10000 },
      };

      // ✅ 修正：不要用 room.id
      this._emitPlaced(roomId, room, {
        win: { winnerIndex: winner, winnerId: winPlayer.id },
        sfx: moveSfx,
        sfx2: victorySfx,
      });

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

    if (room.status !== 'PLAYING')
      return cb?.({ ok: false, message: '遊戲未開始' });

    const playerIndex = room.players.findIndex((p) => p.id === socket.id);
    if (playerIndex === -1) return cb?.({ ok: false, message: '玩家不存在' });
    if (playerIndex !== room.turnIndex)
      return cb?.({ ok: false, message: '尚未輪到你' });

    const player = room.players[playerIndex];
    const slot = this._getActiveSlot(room);
    const roleIndex = this._getActiveRoleIndex(room, player, slot);

    if (roleIndex !== 5)
      return cb?.({ ok: false, message: '只有吉斯可以使用此能力' });
    if (player.usedJeiceThisTurn)
      return cb?.({ ok: false, message: '本回合已使用過吉斯能力' });

    if (player.placedThisTurn && player.placedThisTurn > 0)
      return cb?.({ ok: false, message: '本回合已經落子，無法發動能力' });

    room.jeiceState = {
      playerIndex,
      slot,
      selfToken: this._tokenOf(playerIndex, slot),
      step: 'place',
      placed: null,
      targets: [],
    };

    this._emitSfx(roomId, {
      key: this.SFX_KEYS.SKILL_JEICE,
      scope: 'sfx',
      action: 'prime',
      by: { playerIndex, slot, roleIndex },
    });

    cb?.({ ok: true });
  }

  jeicePlace(socket, data, cb) {
    const { roomId, x, y } = data || {};
    const room = this.rooms[roomId];
    if (!room) return cb?.({ ok: false, message: '房間不存在' });

    this._touchRoom(room);

    if (room.status !== 'PLAYING')
      return cb?.({ ok: false, message: '遊戲未開始' });

    const playerIndex = room.players.findIndex((p) => p.id === socket.id);
    if (playerIndex === -1) return cb?.({ ok: false, message: '玩家不存在' });
    if (playerIndex !== room.turnIndex)
      return cb?.({ ok: false, message: '尚未輪到你' });

    const player = room.players[playerIndex];
    const state = room.jeiceState;

    if (!state || state.playerIndex !== playerIndex || state.step !== 'place') {
      room.jeiceState = null;
      this.emitJeiceCancelled(socket, roomId, '吉斯能力已取消');
      return cb?.({ ok: false, message: '尚未發動吉斯能力' });
    }

    const board = room.board;

    if (board?.[y]?.[x] === undefined)
      return cb?.({ ok: false, message: '座標錯誤' });
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

    const placeSfx = {
      key: this.SFX_KEYS.PLACE_JEICE,
      scope: 'sfx',
      action: 'play',
      by: { playerIndex, slot: state.slot, roleIndex: 5 },
      meta: { x, y },
    };
    this._emitSfx(roomId, placeSfx);

    const selfToken = state.selfToken;
    const targets = [];

    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        const tx = x + dx;
        const ty = y + dy;
        const v = board?.[ty]?.[tx];
        if (typeof v === 'number' && v > 0 && v !== selfToken) {
          targets.push({ x: tx, y: ty });
        }
      }
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

        const victorySfx = {
          key: this.SFX_KEYS.VICTORY,
          scope: 'sfx',
          action: 'play',
          meta: { durationMs: 10000 },
        };

        this._emitPlaced(roomId, room, {
          win: { winnerIndex: playerIndex, winnerId: player.id },
          sfx: placeSfx,
          sfx2: victorySfx,
        });

        this._emitSfx(roomId, victorySfx);
        setTimeout(() => this.restartGame(roomId), this.POST_GAME_MS);
        return cb?.({ ok: true, targets: [], win: true });
      }

      this._advanceTurn(room);
      this._emitPlaced(roomId, room, { sfx: placeSfx });
      this._emitTurnInfo(roomId, room);
      return cb?.({ ok: true, targets: [] });
    }

    // ✅ 不廣播 placed，讓前端可先 optimistic render
    cb?.({ ok: true, targets, placed: { x, y } });
  }

  jeiceSelectTarget(socket, data, cb) {
    const { roomId, x, y } = data || {};
    const room = this.rooms[roomId];
    if (!room) return cb?.({ ok: false, message: '房間不存在' });

    this._touchRoom(room);

    if (room.status !== 'PLAYING')
      return cb?.({ ok: false, message: '遊戲未開始' });

    const playerIndex = room.players.findIndex((p) => p.id === socket.id);
    if (playerIndex === -1) return cb?.({ ok: false, message: '玩家不存在' });
    if (playerIndex !== room.turnIndex)
      return cb?.({ ok: false, message: '尚未輪到你' });

    const state = room.jeiceState;

    if (
      !state ||
      state.playerIndex !== playerIndex ||
      state.step !== 'selectTarget' ||
      !state.placed
    ) {
      room.jeiceState = null;
      this.emitJeiceCancelled(socket, roomId, '吉斯能力已取消');
      return cb?.({ ok: false, message: '尚未進入選擇擊退目標階段' });
    }

    const isValid =
      Array.isArray(state.targets) &&
      state.targets.some((p) => p.x === x && p.y === y);
    if (!isValid) {
      return this.jeiceCancel(socket, { roomId }, cb);
    }

    const board = room.board;
    const from = state.placed;

    const tv = board?.[y]?.[x];
    if (tv === undefined) {
      room.jeiceState = null;
      this.emitJeiceCancelled(socket, roomId, '座標錯誤');
      return cb?.({ ok: false, message: '座標錯誤' });
    }

    if (tv <= 0) {
      return this.jeiceCancel(socket, { roomId }, cb);
    }

    const dx = Math.sign(x - from.x);
    const dy = Math.sign(y - from.y);
    if (dx === 0 && dy === 0) {
      return this.jeiceCancel(socket, { roomId }, cb);
    }

    const oneX = x + dx;
    const oneY = y + dy;
    const twoX = x + dx * 2;
    const twoY = y + dy * 2;

    const inBoard = (px, py) =>
      py >= 0 && py < board.length && px >= 0 && px < board.length;

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

    const jeiceSkillSfx = {
      key: this.SFX_KEYS.SKILL_JEICE,
      scope: 'sfx',
      action: 'play',
      by: { playerIndex, slot: state.slot, roleIndex: 5 },
      meta: { from, target: { x, y }, to: pushedTo },
    };
    this._emitSfx(roomId, jeiceSkillSfx);

    const winner = this.checkBoardForAnyWinner(room);
    if (winner !== null) {
      const winPlayer = room.players[winner];
      winPlayer.wins = (winPlayer.wins || 0) + 1;
      room.status = 'ENDED';

      const victorySfx = {
        key: this.SFX_KEYS.VICTORY,
        scope: 'sfx',
        action: 'play',
        meta: { durationMs: 10000 },
      };

      // ✅ 修正：不要用 room.id
      this._emitPlaced(roomId, room, {
        win: { winnerIndex: winner, winnerId: winPlayer.id },
        effect: { type: 'jeice', from, target: { x, y }, to: pushedTo },
        sfx: jeiceSkillSfx,
        sfx2: victorySfx,
      });

      this._emitSfx(roomId, victorySfx);
      setTimeout(() => this.restartGame(roomId), this.POST_GAME_MS);
      cb?.({ ok: true, win: true });
      return;
    }

    this._advanceTurn(room);

    this._emitPlaced(roomId, room, {
      effect: { type: 'jeice', from, target: { x, y }, to: pushedTo },
      sfx: jeiceSkillSfx,
    });

    this._emitTurnInfo(roomId, room);
    cb?.({ ok: true, pushedTo });
  }

  jeiceCancel(socket, data, cb) {
    const { roomId } = data || {};
    const room = this.rooms[roomId];
    if (!room) return cb?.({ ok: false, message: '房間不存在' });

    this._touchRoom(room);

    if (room.status !== 'PLAYING')
      return cb?.({ ok: false, message: '遊戲未開始' });

    const playerIndex = room.players.findIndex((p) => p.id === socket.id);
    if (playerIndex === -1) return cb?.({ ok: false, message: '玩家不存在' });
    if (playerIndex !== room.turnIndex)
      return cb?.({ ok: false, message: '尚未輪到你' });

    const player = room.players[playerIndex];

    const state = room.jeiceState;
    const hasPlaced = !!state?.placed || player.placedThisTurn > 0;

    if (!state || state.playerIndex !== playerIndex) {
      room.jeiceState = null;
      this.io.to(socket.id).emit('jeiceCancelled', { message: '已取消吉斯流程' });

      if (hasPlaced) {
        this._advanceTurn(room);
      }

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

    const dirs = [
      [1, 0],
      [0, 1],
      [1, 1],
      [1, -1],
    ];

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
}

module.exports = GameManager;
