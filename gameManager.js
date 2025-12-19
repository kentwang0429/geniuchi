// ================= gameManager.js (DUAL + role-token + SFX hooks) =================
// ✅ 本檔新增：在既有 socket 事件不破壞的前提下，額外送出「音效提示」資料
// - placed payload 會多帶：sfx: { key, by:{playerIndex,slot,roleIndex}, meta:{} }
// - 也會額外廣播：io.to(roomId).emit('sfx', {...})（前端可選擇監聽）
//
// ⚠️ 你之後在 index.html 只要：
// 1) 監聽 socket.on('sfx', ...) 或 socket.on('placed', payload => payload.sfx)
// 2) 用 key 對應到你的音檔路徑即可（目前先當占位）

class GameManager {
  constructor(io, rooms) {
    this.io = io;
    this.rooms = rooms;

    // ✅ 與前端賽後倒數一致：10 秒後回 Lobby 並重選角
    this.POST_GAME_MS = 10500;

    // ✅ 音效 key 占位：你之後只要用這些 key 對應到音檔即可
    // - lobby_bgm / battle_bgm / victory
    // - ui_click / role_hover_* / role_confirm
    // - place_* / skill_*
    this.SFX_KEYS = {
      // BGM / Flow
      LOBBY_BGM: 'bgm_lobby_chala',
      BATTLE_BGM: 'bgm_battle',
      VICTORY: 'sfx_victory_10s',

      // UI
      UI_CLICK: 'sfx_ui_click',
      ROLE_CONFIRM: 'sfx_role_confirm',

      // Role hover (角色被點到/滑到)
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
            if (board[y][x] === -(playerIndex + 1)) {
              board[y][x] = token;
            } else if (board[y][x] === 0) {
              board[y][x] = token;
            } else {
              throw new Error('此處不可放置');
            }
          } else if (placedThisTurn === 1) {
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
  createEmptyBoard(size) {
    return Array.from({ length: size }, () => Array(size).fill(0));
  }

  _tokenOf(playerIndex, slot) {
    return playerIndex * 2 + slot;
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

  _emitPlaced(roomId, room, extra = {}) {
    this.io.to(roomId).emit('placed', {
      board: room.board,
      turnIndex: room.turnIndex,
      turnSlot: room.turnSlot || 1,
      roundCount: room.roundCount,
      status: room.status,
      ...extra,
    });
  }

  // ✅ 額外音效事件（前端可選擇監聽）
  _emitSfx(roomId, sfx) {
    try {
      this.io.to(roomId).emit('sfx', sfx);
    } catch (e) {}
  }

  _sfxForPlace(roleIndex, placedThisTurnBefore) {
    // placedThisTurnBefore：落子前的 placedThisTurn（0=第一步，1=第二步）
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

  // ================= Game Flow =================
  startGame(roomId) {
    const room = this.rooms[roomId];
    if (!room) return;

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
      if (p.wins === undefined) p.wins = 0;
    });

    this.io.to(roomId).emit('roomUpdated', room);

    // ✅ BGM：通知前端切到戰鬥音樂（占位 key）
    this._emitSfx(roomId, {
      key: this.SFX_KEYS.BATTLE_BGM,
      scope: 'bgm',
      action: 'start',
    });
  }

  restartGame(roomId) {
    const room = this.rooms[roomId];
    if (!room) return;

    room.status = 'LOBBY';
    room.board = this.createEmptyBoard(room.boardSize || 15);
    room.ginyuState = null;
    room.gudoState = null;
    room.jeiceState = null;

    room.turnIndex = 0;
    room.turnSlot = room.mode === 'DUAL' ? 1 : 1;
    room.roundCount = 1;

    // ✅ 修改：不再清空顏色/角色，讓玩家可在賽後提前預選下一局
    room.players.forEach((p) => {
      p.ready = false;
      p.placedThisTurn = 0;

      // 不清空：
      // p.colorIndex = null;
      // p.roleIndex = null;
      // p.roleIndex1 = null;
      // p.roleIndex2 = null;

      p.usedGinyuThisTurn = false;
      p.usedGudoThisTurn = false;
      p.usedJeiceThisTurn = false;
    });

    this.io.to(roomId).emit('roomUpdated', room);

    // ✅ 回 Lobby：通知前端恢復主題曲（占位 key）
    this._emitSfx(roomId, {
      key: this.SFX_KEYS.LOBBY_BGM,
      scope: 'bgm',
      action: 'start',
    });
  }

  // ================= Normal Place =================
  placePiece(socket, data, cb) {
    const { roomId, x, y } = data;
    const room = this.rooms[roomId];
    if (!room) return cb({ ok: false, message: '房間不存在' });
    if (room.status !== 'PLAYING')
      return cb({ ok: false, message: '遊戲未開始' });

    const playerIndex = room.players.findIndex((p) => p.id === socket.id);
    if (playerIndex === -1) return cb({ ok: false, message: '玩家不存在' });
    if (playerIndex !== room.turnIndex)
      return cb({ ok: false, message: '尚未輪到你' });

    const player = room.players[playerIndex];
    const slot = this._getActiveSlot(room);
    const roleIndex = this._getActiveRoleIndex(room, player, slot);
    const role = this.roleAbilities[roleIndex];
    if (typeof roleIndex !== 'number' || !role)
      return cb({ ok: false, message: '角色未設定' });

    if (room.jeiceState && room.jeiceState.playerIndex === playerIndex) {
      return cb({ ok: false, message: '吉斯能力進行中，請先完成或取消' });
    }

    const board = room.board;
    const token = this._tokenOf(playerIndex, slot);

    // ✅ 用於音效判斷（巴特/羅根需要知道是第幾步）
    const placedThisTurnBefore = player.placedThisTurn || 0;

    try {
      if (roleIndex === 3) {
        role.place(board, x, y, token, playerIndex, placedThisTurnBefore);
      } else {
        role.place(board, x, y, token);
      }
      player.placedThisTurn = placedThisTurnBefore + 1;
    } catch (err) {
      return cb({ ok: false, message: err.message });
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

      // ✅ 勝利音效（10 秒）
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
        // 額外附一個 victory（前端可選擇只用 sfx 或用 sfx2）
        sfx2: victorySfx,
      });

      // 也額外送出 sfx event（前端可選擇監聽）
      this._emitSfx(roomId, {
        key: placeSfxKey,
        scope: 'sfx',
        action: 'play',
        by: { playerIndex, slot, roleIndex },
        meta: { x, y, step: placedThisTurnBefore },
      });
      this._emitSfx(roomId, victorySfx);

      // ✅ 延後 10 秒後回 Lobby（但不清空顏色/角色，允許先預選）
      setTimeout(() => this.restartGame(roomId), this.POST_GAME_MS);
      return cb({ ok: true, win: true });
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

    cb({ ok: true });
  }

  _advanceTurn(room) {
    const current = room.players[room.turnIndex];
    if (current) current.placedThisTurn = 0;

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
    }
  }

  // ================= Ginyu =================
  emitGinyuCancelled(socket, roomId, message) {
    this.io.to(socket.id).emit('ginyuCancelled', { message });
    const room = this.rooms[roomId];
    if (room) {
      this._emitPlaced(roomId, room);
    }
  }

  ginyuCancel(socket, data, cb) {
    const { roomId } = data;
    const room = this.rooms[roomId];
    if (!room) return cb({ ok: false, message: '房間不存在' });
    if (room.status !== 'PLAYING')
      return cb({ ok: false, message: '遊戲未開始' });

    const playerIndex = room.players.findIndex((p) => p.id === socket.id);
    if (playerIndex === -1) return cb({ ok: false, message: '玩家不存在' });
    if (playerIndex !== room.turnIndex)
      return cb({ ok: false, message: '尚未輪到你' });

    const player = room.players[playerIndex];
    const slot = this._getActiveSlot(room);
    const roleIndex = this._getActiveRoleIndex(room, player, slot);
    if (roleIndex !== 0)
      return cb({ ok: false, message: '只有基紐可以取消此能力' });

    room.ginyuState = null;
    this.emitGinyuCancelled(socket, roomId, '已取消基紐能力');
    cb({ ok: true });
  }

  ginyuAbilityStart(socket, data, cb) {
    const { roomId } = data;
    const room = this.rooms[roomId];
    if (!room) return cb({ ok: false, message: '房間不存在' });
    if (room.status !== 'PLAYING')
      return cb({ ok: false, message: '遊戲未開始' });

    const playerIndex = room.players.findIndex((p) => p.id === socket.id);
    if (playerIndex === -1) return cb({ ok: false, message: '玩家不存在' });
    if (playerIndex !== room.turnIndex)
      return cb({ ok: false, message: '尚未輪到你' });

    const player = room.players[playerIndex];
    const slot = this._getActiveSlot(room);
    const roleIndex = this._getActiveRoleIndex(room, player, slot);
    if (roleIndex !== 0)
      return cb({ ok: false, message: '只有基紐可以使用此能力' });

    if (player.placedThisTurn && player.placedThisTurn > 0)
      return cb({ ok: false, message: '本回合已經落子，無法發動能力' });

    if (player.usedGinyuThisTurn)
      return cb({ ok: false, message: '本回合已使用過基紐能力' });

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
      return cb({ ok: false, message: '目前沒有可以發動基紐能力的位置' });

    room.ginyuState = {
      playerIndex,
      selfToken,
      sources,
      source: null,
      targets: [],
    };

    // ✅ 技能音效（開始）——占位
    this._emitSfx(roomId, {
      key: this.SFX_KEYS.SKILL_GINYU_SWAP,
      scope: 'sfx',
      action: 'prime',
      by: { playerIndex, slot, roleIndex },
    });

    cb({ ok: true, sources });
  }

  ginyuSelectSource(socket, data, cb) {
    const { roomId, x, y } = data;
    const room = this.rooms[roomId];
    if (!room) return cb({ ok: false, message: '房間不存在' });
    if (room.status !== 'PLAYING')
      return cb({ ok: false, message: '遊戲未開始' });

    const playerIndex = room.players.findIndex((p) => p.id === socket.id);
    if (playerIndex === -1) return cb({ ok: false, message: '玩家不存在' });
    if (playerIndex !== room.turnIndex)
      return cb({ ok: false, message: '尚未輪到你' });

    const player = room.players[playerIndex];
    const slot = this._getActiveSlot(room);
    const roleIndex = this._getActiveRoleIndex(room, player, slot);
    if (roleIndex !== 0)
      return cb({ ok: false, message: '只有基紐可以使用此能力' });

    const state = room.ginyuState;
    if (!state || state.playerIndex !== playerIndex) {
      room.ginyuState = null;
      this.emitGinyuCancelled(socket, roomId, '基紐能力已取消');
      return cb({ ok: false, message: '尚未發動基紐能力' });
    }

    const isSourceValid = state.sources?.some((p) => p.x === x && p.y === y);
    if (!isSourceValid) {
      room.ginyuState = null;
      this.emitGinyuCancelled(socket, roomId, '已取消基紐能力');
      return cb({ ok: false, message: '已取消基紐能力' });
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
      return cb({ ok: false, message: '此基紐棋沒有可交換目標' });
    }

    state.source = { x, y };
    state.targets = targets;

    cb({ ok: true, targets });
  }

  ginyuSelectTarget(socket, data, cb) {
    const { roomId, x, y } = data;
    const room = this.rooms[roomId];
    if (!room) return cb({ ok: false, message: '房間不存在' });
    if (room.status !== 'PLAYING')
      return cb({ ok: false, message: '遊戲未開始' });

    const playerIndex = room.players.findIndex((p) => p.id === socket.id);
    if (playerIndex === -1) return cb({ ok: false, message: '玩家不存在' });
    if (playerIndex !== room.turnIndex)
      return cb({ ok: false, message: '尚未輪到你' });

    const player = room.players[playerIndex];
    const slot = this._getActiveSlot(room);
    const roleIndex = this._getActiveRoleIndex(room, player, slot);
    if (roleIndex !== 0)
      return cb({ ok: false, message: '只有基紐可以使用此能力' });

    const state = room.ginyuState;
    if (!state || state.playerIndex !== playerIndex || !state.source) {
      room.ginyuState = null;
      this.emitGinyuCancelled(socket, roomId, '基紐能力已取消');
      return cb({ ok: false, message: '尚未選擇基紐棋' });
    }

    const isTargetValid = state.targets?.some((p) => p.x === x && p.y === y);
    if (!isTargetValid) {
      room.ginyuState = null;
      this.emitGinyuCancelled(socket, roomId, '已取消基紐能力');
      return cb({ ok: false, message: '已取消基紐能力' });
    }

    const board = room.board;
    const sx = state.source.x;
    const sy = state.source.y;

    const tmp = board[sy][sx];
    board[sy][sx] = board[y][x];
    board[y][x] = tmp;

    player.usedGinyuThisTurn = true;
    room.ginyuState = null;

    // ✅ 交換音效（所有人聽到）
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

      this._emitPlaced(room.id, room, {
        win: { winnerIndex: winner, winnerId: winPlayer.id },
        sfx: swapSfx,
        sfx2: victorySfx,
      });

      this._emitSfx(room.id, victorySfx);
      setTimeout(() => this.restartGame(room.id), this.POST_GAME_MS);
      return cb({ ok: true, win: true });
    }

    this._emitPlaced(roomId, room, { sfx: swapSfx });
    cb({ ok: true });
  }

  // ================= Guldo =================
  gudoAbilityStart(socket, data, cb) {
    const { roomId } = data;
    const room = this.rooms[roomId];
    if (!room) return cb({ ok: false, message: '房間不存在' });
    if (room.status !== 'PLAYING')
      return cb({ ok: false, message: '遊戲未開始' });

    const playerIndex = room.players.findIndex((p) => p.id === socket.id);
    if (playerIndex === -1) return cb({ ok: false, message: '玩家不存在' });
    if (playerIndex !== room.turnIndex)
      return cb({ ok: false, message: '尚未輪到你' });

    const player = room.players[playerIndex];
    const slot = this._getActiveSlot(room);
    const roleIndex = this._getActiveRoleIndex(room, player, slot);
    if (roleIndex !== 4)
      return cb({ ok: false, message: '只有古杜可以使用此能力' });
    if (player.usedGudoThisTurn)
      return cb({ ok: false, message: '本回合已使用過古杜能力' });

    if (player.placedThisTurn && player.placedThisTurn > 0)
      return cb({ ok: false, message: '本回合已經落子，無法發動能力' });

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
      return cb({ ok: false, message: '場上沒有古杜棋可使用能力' });

    room.gudoState = {
      playerIndex,
      selfToken,
      step: 'selectSource',
      source: null,
      target: null,
      emptyAround: [],
    };

    // ✅ 技能音效（開始）——占位
    this._emitSfx(roomId, {
      key: this.SFX_KEYS.SKILL_GULDO,
      scope: 'sfx',
      action: 'prime',
      by: { playerIndex, slot, roleIndex },
    });

    cb({ ok: true, sources });
  }

  gudoSelectSource(socket, data, cb) {
    const { roomId, x, y } = data;
    const room = this.rooms[roomId];
    if (!room) return cb({ ok: false, message: '房間不存在' });

    if (room.status !== 'PLAYING')
      return cb({ ok: false, message: '遊戲未開始' });

    const playerIndex = room.players.findIndex((p) => p.id === socket.id);
    if (playerIndex === -1) return cb({ ok: false, message: '玩家不存在' });
    if (playerIndex !== room.turnIndex)
      return cb({ ok: false, message: '尚未輪到你' });

    const player = room.players[playerIndex];
    const slot = this._getActiveSlot(room);
    const roleIndex = this._getActiveRoleIndex(room, player, slot);
    if (roleIndex !== 4)
      return cb({ ok: false, message: '只有古杜可以使用此能力' });

    const state = room.gudoState;
    if (!state || state.playerIndex !== playerIndex)
      return cb({ ok: false, message: '尚未啟動古杜能力' });

    if (room.board?.[y]?.[x] !== state.selfToken)
      return cb({ ok: false, message: '請選擇自己的古杜棋' });

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
      return cb({ ok: false, message: '周圍沒有可移動目標，古杜能力取消' });
    }

    state.step = 'selectTarget';
    cb({ ok: true, highlights: area });
  }

  gudoSelectTarget(socket, data, cb) {
    const { roomId, x, y } = data;
    const room = this.rooms[roomId];
    if (!room) return cb({ ok: false, message: '房間不存在' });

    if (room.status !== 'PLAYING')
      return cb({ ok: false, message: '遊戲未開始' });

    const playerIndex = room.players.findIndex((p) => p.id === socket.id);
    if (playerIndex === -1) return cb({ ok: false, message: '玩家不存在' });
    if (playerIndex !== room.turnIndex)
      return cb({ ok: false, message: '尚未輪到你' });

    const state = room.gudoState;
    if (!state || state.playerIndex !== playerIndex)
      return cb({ ok: false, message: '尚未啟動古杜能力' });

    if (!state.source) return cb({ ok: false, message: '請先選擇古杜棋' });

    if (Math.abs(x - state.source.x) > 1 || Math.abs(y - state.source.y) > 1)
      return cb({ ok: false, message: '只能選擇古杜周圍的棋子' });

    const v = room.board?.[y]?.[x];
    if (v === undefined) return cb({ ok: false, message: '座標錯誤' });

    if (v <= 0)
      return cb({ ok: false, message: '只能選正常棋（不能選空格/灰叉）' });
    if (v === state.selfToken)
      return cb({ ok: false, message: '不能選自己此角色的棋' });

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
      return cb({ ok: false, message: '該棋周圍沒有空格，古杜能力取消' });
    }

    state.target = { x, y };
    state.emptyAround = emptyAround;
    state.step = 'move';
    cb({ ok: true, emptyAround });
  }

  gudoMovePiece(socket, data, cb) {
    const { roomId, x, y } = data;
    const room = this.rooms[roomId];
    if (!room) return cb({ ok: false, message: '房間不存在' });

    if (room.status !== 'PLAYING')
      return cb({ ok: false, message: '遊戲未開始' });

    const playerIndex = room.players.findIndex((p) => p.id === socket.id);
    if (playerIndex === -1) return cb({ ok: false, message: '玩家不存在' });
    if (playerIndex !== room.turnIndex)
      return cb({ ok: false, message: '尚未輪到你' });

    const player = room.players[playerIndex];
    const slot = this._getActiveSlot(room);
    const roleIndex = this._getActiveRoleIndex(room, player, slot);

    const state = room.gudoState;
    if (!state || state.playerIndex !== playerIndex || !state.target)
      return cb({ ok: false, message: '尚未選定可移動棋' });

    if (room.board?.[y]?.[x] !== 0)
      return cb({ ok: false, message: '只能移動到空格' });

    const allowed = Array.isArray(state.emptyAround)
      ? state.emptyAround.some((p) => p.x === x && p.y === y)
      : false;

    if (!allowed) return cb({ ok: false, message: '只能移動到目標周圍的空格' });

    const targetPiece = state.target;
    const tv = room.board?.[targetPiece.y]?.[targetPiece.x];
    if (tv === undefined || tv <= 0) {
      room.gudoState = null;
      this.io.to(roomId).emit('gudoCancelled');
      return cb({ ok: false, message: '目標棋已不存在，古杜能力取消' });
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

      this._emitPlaced(room.id, room, {
        win: { winnerIndex: winner, winnerId: winPlayer.id },
        sfx: moveSfx,
        sfx2: victorySfx,
      });

      this._emitSfx(room.id, victorySfx);
      setTimeout(() => this.restartGame(room.id), this.POST_GAME_MS);
      return cb({ ok: true, win: true });
    }

    this._emitPlaced(roomId, room, { sfx: moveSfx });
    cb({ ok: true });
  }

  // ================= Jeice =================
  emitJeiceCancelled(socket, roomId, message) {
    this.io.to(socket.id).emit('jeiceCancelled', { message });
    const room = this.rooms[roomId];
    if (room) {
      this._emitPlaced(roomId, room);
    }
  }

  jeiceAbilityStart(socket, data, cb) {
    const { roomId } = data;
    const room = this.rooms[roomId];
    if (!room) return cb({ ok: false, message: '房間不存在' });
    if (room.status !== 'PLAYING')
      return cb({ ok: false, message: '遊戲未開始' });

    const playerIndex = room.players.findIndex((p) => p.id === socket.id);
    if (playerIndex === -1) return cb({ ok: false, message: '玩家不存在' });
    if (playerIndex !== room.turnIndex)
      return cb({ ok: false, message: '尚未輪到你' });

    const player = room.players[playerIndex];
    const slot = this._getActiveSlot(room);
    const roleIndex = this._getActiveRoleIndex(room, player, slot);

    if (roleIndex !== 5)
      return cb({ ok: false, message: '只有吉斯可以使用此能力' });
    if (player.usedJeiceThisTurn)
      return cb({ ok: false, message: '本回合已使用過吉斯能力' });

    if (player.placedThisTurn && player.placedThisTurn > 0)
      return cb({ ok: false, message: '本回合已經落子，無法發動能力' });

    room.jeiceState = {
      playerIndex,
      slot,
      selfToken: this._tokenOf(playerIndex, slot),
      step: 'place',
      placed: null,
      targets: [],
    };

    // ✅ 技能音效（開始）——占位
    this._emitSfx(roomId, {
      key: this.SFX_KEYS.SKILL_JEICE,
      scope: 'sfx',
      action: 'prime',
      by: { playerIndex, slot, roleIndex },
    });

    cb({ ok: true });
  }

  jeicePlace(socket, data, cb) {
    const { roomId, x, y } = data;
    const room = this.rooms[roomId];
    if (!room) return cb({ ok: false, message: '房間不存在' });
    if (room.status !== 'PLAYING')
      return cb({ ok: false, message: '遊戲未開始' });

    const playerIndex = room.players.findIndex((p) => p.id === socket.id);
    if (playerIndex === -1) return cb({ ok: false, message: '玩家不存在' });
    if (playerIndex !== room.turnIndex)
      return cb({ ok: false, message: '尚未輪到你' });

    const player = room.players[playerIndex];
    const state = room.jeiceState;

    if (!state || state.playerIndex !== playerIndex || state.step !== 'place') {
      room.jeiceState = null;
      this.emitJeiceCancelled(socket, roomId, '吉斯能力已取消');
      return cb({ ok: false, message: '尚未發動吉斯能力' });
    }

    const board = room.board;

    if (board?.[y]?.[x] === undefined)
      return cb({ ok: false, message: '座標錯誤' });
    if (board[y][x] !== 0) return cb({ ok: false, message: '只能落子在空格' });

    try {
      this.roleAbilities[5].place(board, x, y, state.selfToken);
      player.placedThisTurn = 1;
      player.usedJeiceThisTurn = true;
    } catch (err) {
      room.jeiceState = null;
      this.emitJeiceCancelled(socket, roomId, err.message);
      return cb({ ok: false, message: err.message });
    }

    // ✅ 吉斯落子音效
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

      const roleIndex = this._getActiveRoleIndex(room, player, state.slot);
      const targetN = roleIndex === 1 ? 6 : room.targetN;
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
        return cb({ ok: true, targets: [], win: true });
      }

      this._advanceTurn(room);
      this._emitPlaced(roomId, room, { sfx: placeSfx });
      return cb({ ok: true, targets: [] });
    }

    // ✅ 這裡不廣播 placed（因為前端會先 optimistic render），等選/取消後再廣播
    cb({ ok: true, targets });
  }

  jeiceSelectTarget(socket, data, cb) {
    const { roomId, x, y } = data;
    const room = this.rooms[roomId];
    if (!room) return cb({ ok: false, message: '房間不存在' });
    if (room.status !== 'PLAYING')
      return cb({ ok: false, message: '遊戲未開始' });

    const playerIndex = room.players.findIndex((p) => p.id === socket.id);
    if (playerIndex === -1) return cb({ ok: false, message: '玩家不存在' });
    if (playerIndex !== room.turnIndex)
      return cb({ ok: false, message: '尚未輪到你' });

    const state = room.jeiceState;

    if (
      !state ||
      state.playerIndex !== playerIndex ||
      state.step !== 'selectTarget' ||
      !state.placed
    ) {
      room.jeiceState = null;
      this.emitJeiceCancelled(socket, roomId, '吉斯能力已取消');
      return cb({ ok: false, message: '尚未進入選擇擊退目標階段' });
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
      return cb({ ok: false, message: '座標錯誤' });
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

      this._emitPlaced(room.id, room, {
        win: { winnerIndex: winner, winnerId: winPlayer.id },
        effect: { type: 'jeice', from, target: { x, y }, to: pushedTo },
        sfx: jeiceSkillSfx,
        sfx2: victorySfx,
      });

      this._emitSfx(room.id, victorySfx);
      setTimeout(() => this.restartGame(room.id), this.POST_GAME_MS);
      cb({ ok: true, win: true });
      return;
    }

    this._advanceTurn(room);

    this._emitPlaced(roomId, room, {
      effect: { type: 'jeice', from, target: { x, y }, to: pushedTo },
      sfx: jeiceSkillSfx,
    });

    cb({ ok: true, pushedTo });
  }

  jeiceCancel(socket, data, cb) {
    const { roomId } = data;
    const room = this.rooms[roomId];
    if (!room) return cb({ ok: false, message: '房間不存在' });
    if (room.status !== 'PLAYING')
      return cb({ ok: false, message: '遊戲未開始' });

    const playerIndex = room.players.findIndex((p) => p.id === socket.id);
    if (playerIndex === -1) return cb({ ok: false, message: '玩家不存在' });
    if (playerIndex !== room.turnIndex)
      return cb({ ok: false, message: '尚未輪到你' });

    const player = room.players[playerIndex];

    const state = room.jeiceState;
    const hasPlaced = !!state?.placed || player.placedThisTurn > 0;

    if (!state || state.playerIndex !== playerIndex) {
      room.jeiceState = null;
      this.io
        .to(socket.id)
        .emit('jeiceCancelled', { message: '已取消吉斯流程' });

      if (hasPlaced) {
        this._advanceTurn(room);
      }

      this._emitPlaced(roomId, room);
      return cb({ ok: true });
    }

    if (!state.placed) {
      player.usedJeiceThisTurn = true;
      room.jeiceState = null;

      this.io
        .to(socket.id)
        .emit('jeiceCancelled', { message: '本回合不使用吉斯技能' });

      this._emitPlaced(roomId, room);
      return cb({ ok: true });
    }

    player.usedJeiceThisTurn = true;
    room.jeiceState = null;

    this._advanceTurn(room);

    this._emitPlaced(roomId, room);

    return cb({ ok: true });
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
