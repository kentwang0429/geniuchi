// ================= gameManager.js (DUAL + role-token) =================

class GameManager {
  constructor(io, rooms) {
    this.io = io;
    this.rooms = rooms;

    // ✅ 與前端賽後倒數一致：10 秒後回 Lobby 並重選角
    this.POST_GAME_MS = 10500;

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
  }

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

    try {
      if (roleIndex === 3) {
        role.place(board, x, y, token, playerIndex, player.placedThisTurn);
      } else {
        role.place(board, x, y, token);
      }
      player.placedThisTurn++;
    } catch (err) {
      return cb({ ok: false, message: err.message });
    }

    const targetN = roleIndex === 1 ? 6 : room.targetN;
    const win = this.checkWinner(board, x, y, token, targetN);

    if (win) {
      player.wins = (player.wins || 0) + 1;
      room.status = 'ENDED';
      room.ginyuState = null;
      room.gudoState = null;
      room.jeiceState = null;

      this.io.to(roomId).emit('placed', {
        board,
        win: { winnerIndex: playerIndex, winnerId: player.id },
        turnIndex: room.turnIndex,
        turnSlot: room.turnSlot || 1,
        roundCount: room.roundCount,
        status: room.status,
      });

      // ✅ 延後 10 秒後回 Lobby（但不清空顏色/角色，允許先預選）
      setTimeout(() => this.restartGame(roomId), this.POST_GAME_MS);
      return cb({ ok: true, win: true });
    }

    if (player.placedThisTurn >= role.maxMoves) {
      this._advanceTurn(room);
    }

    this.io.to(roomId).emit('placed', {
      board,
      turnIndex: room.turnIndex,
      turnSlot: room.turnSlot || 1,
      roundCount: room.roundCount,
      status: room.status,
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

  emitGinyuCancelled(socket, roomId, message) {
    this.io.to(socket.id).emit('ginyuCancelled', { message });
    const room = this.rooms[roomId];
    if (room) {
      this.io.to(roomId).emit('placed', {
        board: room.board,
        turnIndex: room.turnIndex,
        turnSlot: room.turnSlot || 1,
        roundCount: room.roundCount,
        status: room.status,
      });
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

    const winner = this.checkBoardForAnyWinner(room);
    if (winner !== null) {
      const winPlayer = room.players[winner];
      winPlayer.wins = (winPlayer.wins || 0) + 1;
      room.status = 'ENDED';
      this.io.to(room.id).emit('placed', {
        board,
        win: { winnerIndex: winner, winnerId: winPlayer.id },
        turnIndex: room.turnIndex,
        turnSlot: room.turnSlot || 1,
        roundCount: room.roundCount,
        status: room.status,
      });
      setTimeout(() => this.restartGame(room.id), this.POST_GAME_MS);
      return cb({ ok: true, win: true });
    }

    this.io.to(roomId).emit('placed', {
      board,
      turnIndex: room.turnIndex,
      turnSlot: room.turnSlot || 1,
      roundCount: room.roundCount,
      status: room.status,
    });
    cb({ ok: true });
  }

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

    const winner = this.checkBoardForAnyWinner(room);
    if (winner !== null) {
      const winPlayer = room.players[winner];
      winPlayer.wins = (winPlayer.wins || 0) + 1;
      room.status = 'ENDED';
      this.io.to(room.id).emit('placed', {
        board: room.board,
        win: { winnerIndex: winner, winnerId: winPlayer.id },
        turnIndex: room.turnIndex,
        turnSlot: room.turnSlot || 1,
        roundCount: room.roundCount,
        status: room.status,
      });
      setTimeout(() => this.restartGame(room.id), this.POST_GAME_MS);
      return cb({ ok: true, win: true });
    }

    this.io.to(roomId).emit('placed', {
      board: room.board,
      turnIndex: room.turnIndex,
      turnSlot: room.turnSlot || 1,
      roundCount: room.roundCount,
      status: room.status,
    });
    cb({ ok: true });
  }

  emitJeiceCancelled(socket, roomId, message) {
    this.io.to(socket.id).emit('jeiceCancelled', { message });
    const room = this.rooms[roomId];
    if (room) {
      this.io.to(roomId).emit('placed', {
        board: room.board,
        turnIndex: room.turnIndex,
        turnSlot: room.turnSlot || 1,
        roundCount: room.roundCount,
        status: room.status,
      });
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
        this.io.to(roomId).emit('placed', {
          board,
          win: { winnerIndex: playerIndex, winnerId: player.id },
          turnIndex: room.turnIndex,
          turnSlot: room.turnSlot || 1,
          roundCount: room.roundCount,
          status: room.status,
        });
        setTimeout(() => this.restartGame(roomId), this.POST_GAME_MS);
        return cb({ ok: true, targets: [], win: true });
      }

      this._advanceTurn(room);

      this.io.to(roomId).emit('placed', {
        board,
        turnIndex: room.turnIndex,
        turnSlot: room.turnSlot || 1,
        roundCount: room.roundCount,
        status: room.status,
      });

      return cb({ ok: true, targets: [] });
    }

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

    const winner = this.checkBoardForAnyWinner(room);
    if (winner !== null) {
      const winPlayer = room.players[winner];
      winPlayer.wins = (winPlayer.wins || 0) + 1;
      room.status = 'ENDED';
      this.io.to(room.id).emit('placed', {
        board: room.board,
        win: { winnerIndex: winner, winnerId: winPlayer.id },
        turnIndex: room.turnIndex,
        turnSlot: room.turnSlot || 1,
        roundCount: room.roundCount,
        status: room.status,
        effect: {
          type: 'jeice',
          from,
          target: { x, y },
          to: pushedTo,
        },
      });
      setTimeout(() => this.restartGame(room.id), this.POST_GAME_MS);
      cb({ ok: true, win: true });
      return;
    }

    this._advanceTurn(room);

    this.io.to(roomId).emit('placed', {
      board: room.board,
      turnIndex: room.turnIndex,
      turnSlot: room.turnSlot || 1,
      roundCount: room.roundCount,
      status: room.status,
      effect: {
        type: 'jeice',
        from,
        target: { x, y },
        to: pushedTo,
      },
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

      this.io.to(roomId).emit('placed', {
        board: room.board,
        turnIndex: room.turnIndex,
        turnSlot: room.turnSlot || 1,
        roundCount: room.roundCount,
        status: room.status,
      });
      return cb({ ok: true });
    }

    if (!state.placed) {
      player.usedJeiceThisTurn = true;
      room.jeiceState = null;

      this.io
        .to(socket.id)
        .emit('jeiceCancelled', { message: '本回合不使用吉斯技能' });

      this.io.to(roomId).emit('placed', {
        board: room.board,
        turnIndex: room.turnIndex,
        turnSlot: room.turnSlot || 1,
        roundCount: room.roundCount,
        status: room.status,
      });

      return cb({ ok: true });
    }

    player.usedJeiceThisTurn = true;
    room.jeiceState = null;

    this._advanceTurn(room);

    this.io.to(roomId).emit('placed', {
      board: room.board,
      turnIndex: room.turnIndex,
      turnSlot: room.turnSlot || 1,
      roundCount: room.roundCount,
      status: room.status,
    });

    return cb({ ok: true });
  }

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
