// ================= gameManager.js (Jeice push fix) =================
// 特色修正：
// 1) 吉斯（Jeice）「粉碎球・擊退」：落子後可選相鄰敵方一般棋，往遠離方向擊退（優先 2 格，否則 1 格；需落點空格；不能推灰叉）
// 2) 修正 UI 卡住常見原因：jeiceSelectTarget / jeiceCancel 一定會 cb + 一定會結束回合（或取消）
// 3) 保留既有：巴特 6 連線勝利、古杜 move 只能到目標周圍空格、基紐 swap 後檢查全盤勝利

class GameManager {
  constructor(io, rooms) {
    this.io = io;
    this.rooms = rooms;

    // 定義角色能力統一結構
    this.roleAbilities = {
      0: {
        name: '基紐',
        maxMoves: 1,
        canOverride: false,
        canUseCross: false,
        place(board, x, y, playerIndex) {
          if (board[y][x] !== 0) throw new Error('該位置已有棋子');
          board[y][x] = playerIndex + 1;
        },
      },
      1: {
        name: '巴特',
        maxMoves: 2,
        canOverride: false,
        canUseCross: false,
        place(board, x, y, playerIndex) {
          if (board[y][x] !== 0) throw new Error('該位置已有棋子');
          board[y][x] = playerIndex + 1;
        },
      },
      2: {
        name: '力庫姆',
        maxMoves: 1,
        canOverride: true,
        canUseCross: false,
        place(board, x, y, playerIndex) {
          if (board[y][x] < 0) throw new Error('不能放在叉叉上');
          board[y][x] = playerIndex + 1;
        },
      },
      3: {
        name: '羅根',
        maxMoves: 2,
        canOverride: false,
        canUseCross: true,
        place(board, x, y, playerIndex, placedThisTurn) {
          if (placedThisTurn === 0) {
            if (board[y][x] === -(playerIndex + 1)) {
              board[y][x] = playerIndex + 1;
            } else if (board[y][x] === 0) {
              board[y][x] = playerIndex + 1;
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
        place(board, x, y, playerIndex) {
          if (board[y][x] !== 0) throw new Error('該位置已有棋子');
          board[y][x] = playerIndex + 1;
        },
      },
      5: {
        name: '吉斯',
        maxMoves: 1,
        canOverride: false,
        canUseCross: false,
        place(board, x, y, playerIndex) {
          if (board[y][x] !== 0) throw new Error('該位置已有棋子');
          board[y][x] = playerIndex + 1;
        },
      },
    };
  }

  createEmptyBoard(size) {
    return Array.from({ length: size }, () => Array(size).fill(0));
  }

  // === 遊戲控制 ===
  startGame(roomId) {
    const room = this.rooms[roomId];
    if (!room) return;
    room.status = 'PLAYING';
    room.turnIndex = 0;
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
    room.players.forEach((p) => {
      p.ready = false;
      p.placedThisTurn = 0;
      p.colorIndex = null;
      p.roleIndex = null;
      p.usedGinyuThisTurn = false;
      p.usedGudoThisTurn = false;
      p.usedJeiceThisTurn = false;
    });
    this.io.to(roomId).emit('roomUpdated', room);
  }

  // === 放置棋子（一般落子） ===
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
    const role = this.roleAbilities[player.roleIndex];
    if (!role) return cb({ ok: false, message: '角色未設定' });

    // 若玩家正在吉斯流程中，禁止用一般 place（避免卡死）
    if (room.jeiceState && room.jeiceState.playerIndex === playerIndex) {
      return cb({ ok: false, message: '吉斯能力進行中，請先完成或取消' });
    }

    const board = room.board;

    try {
      role.place(board, x, y, playerIndex, player.placedThisTurn);
      player.placedThisTurn++;
    } catch (err) {
      return cb({ ok: false, message: err.message });
    }

    const targetN = player.roleIndex === 1 ? 6 : room.targetN; // ✅ 巴特(1) 需要 6 連線
    const win = this.checkWinner(board, x, y, playerIndex + 1, targetN);

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
        roundCount: room.roundCount,
      });
      setTimeout(() => this.restartGame(roomId), 2000);
      return cb({ ok: true, win: true });
    }

    if (player.placedThisTurn >= role.maxMoves) {
      this._advanceTurn(room);
    }

    this.io.to(roomId).emit('placed', {
      board,
      turnIndex: room.turnIndex,
      roundCount: room.roundCount,
      status: room.status,
    });
    cb({ ok: true });
  }

  _advanceTurn(room) {
    const current = room.players[room.turnIndex];
    if (current) current.placedThisTurn = 0;

    room.turnIndex = (room.turnIndex + 1) % room.players.length;
    room.roundCount = (room.roundCount || 0) + 1;

    room.ginyuState = null;
    room.gudoState = null;
    room.jeiceState = null;

    const next = room.players[room.turnIndex];
    if (next) {
      next.usedGinyuThisTurn = false;
      next.usedGudoThisTurn = false;
      next.usedJeiceThisTurn = false;
    }
  }

  // ====== 基紐能力取消（防呆） ======
  emitGinyuCancelled(socket, roomId, message) {
    this.io.to(socket.id).emit('ginyuCancelled', { message });

    const room = this.rooms[roomId];
    if (room) {
      this.io.to(roomId).emit('placed', {
        board: room.board,
        turnIndex: room.turnIndex,
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
    if (player.roleIndex !== 0)
      return cb({ ok: false, message: '只有基紐可以取消此能力' });

    room.ginyuState = null;
    this.emitGinyuCancelled(socket, roomId, '已取消基紐能力');
    cb({ ok: true });
  }

  // === 基紐能力 ===
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
    if (player.roleIndex !== 0)
      return cb({ ok: false, message: '只有基紐可以使用此能力' });

    if (player.placedThisTurn && player.placedThisTurn > 0)
      return cb({ ok: false, message: '本回合已經落子，無法發動能力' });

    if (player.usedGinyuThisTurn)
      return cb({ ok: false, message: '本回合已使用過基紐能力' });

    const board = room.board;
    const size = board.length;
    const selfValue = playerIndex + 1;
    const sources = [];

    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        if (board[y][x] !== selfValue) continue;

        let canSwap = false;
        for (let cx = 0; cx < size; cx++) {
          const v = board[y][cx];
          if (v > 0 && v !== selfValue) {
            canSwap = true;
            break;
          }
        }
        if (!canSwap) {
          for (let cy = 0; cy < size; cy++) {
            const v = board[cy][x];
            if (v > 0 && v !== selfValue) {
              canSwap = true;
              break;
            }
          }
        }
        if (canSwap) sources.push({ x, y });
      }
    }

    if (!sources.length)
      return cb({ ok: false, message: '目前沒有可以發動基紐能力的位置' });

    room.ginyuState = {
      playerIndex,
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
    if (player.roleIndex !== 0)
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
    const selfValue = playerIndex + 1;
    const targets = [];

    for (let cx = 0; cx < size; cx++) {
      const v = board[y][cx];
      if (v > 0 && v !== selfValue) targets.push({ x: cx, y });
    }

    for (let cy = 0; cy < size; cy++) {
      const v = board[cy][x];
      if (
        v > 0 &&
        v !== selfValue &&
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
    if (player.roleIndex !== 0)
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
        roundCount: room.roundCount,
      });
      setTimeout(() => this.restartGame(room.id), 2000);
      return cb({ ok: true, win: true });
    }

    this.io.to(roomId).emit('placed', {
      board,
      turnIndex: room.turnIndex,
      roundCount: room.roundCount,
      status: room.status,
    });
    cb({ ok: true });
  }

  // === 古杜能力 ===
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
    if (player.roleIndex !== 4)
      return cb({ ok: false, message: '只有古杜可以使用此能力' });
    if (player.usedGudoThisTurn)
      return cb({ ok: false, message: '本回合已使用過古杜能力' });

    if (player.placedThisTurn && player.placedThisTurn > 0)
      return cb({ ok: false, message: '本回合已經落子，無法發動能力' });

    const board = room.board;
    const size = board.length;
    const selfValue = playerIndex + 1;
    const sources = [];

    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        if (board[y][x] === selfValue) sources.push({ x, y });
      }
    }

    if (!sources.length)
      return cb({ ok: false, message: '場上沒有古杜棋可使用能力' });

    room.gudoState = {
      playerIndex,
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
    if (player.roleIndex !== 4)
      return cb({ ok: false, message: '只有古杜可以使用此能力' });

    const state = room.gudoState;
    if (!state || state.playerIndex !== playerIndex)
      return cb({ ok: false, message: '尚未啟動古杜能力' });

    if (room.board?.[y]?.[x] !== playerIndex + 1)
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
      if (v > 0 && v !== playerIndex + 1) {
        hasOther = true;
        break;
      }
    }

    if (!hasOther) {
      room.gudoState = null;
      this.io.to(roomId).emit('gudoCancelled');
      return cb({ ok: false, message: '周圍沒有其他玩家棋子，古杜能力取消' });
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

    const player = room.players[playerIndex];
    if (player.roleIndex !== 4)
      return cb({ ok: false, message: '只有古杜可以使用此能力' });

    const state = room.gudoState;
    if (!state || state.playerIndex !== playerIndex)
      return cb({ ok: false, message: '尚未啟動古杜能力' });

    if (!state.source) return cb({ ok: false, message: '請先選擇古杜棋' });

    if (Math.abs(x - state.source.x) > 1 || Math.abs(y - state.source.y) > 1)
      return cb({ ok: false, message: '只能選擇古杜周圍的棋子' });

    const v = room.board?.[y]?.[x];
    if (v === undefined) return cb({ ok: false, message: '座標錯誤' });

    if (v <= 0) return cb({ ok: false, message: '只能選其他玩家的正常棋' });
    if (v === playerIndex + 1)
      return cb({ ok: false, message: '不能選自己的棋' });

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
          if (room.board[ny][nx] === 0) emptyAround.push({ x: nx, y: ny });
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
    if (player.roleIndex !== 4)
      return cb({ ok: false, message: '只有古杜可以使用此能力' });

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

    const tmp = tv;
    room.board[targetPiece.y][targetPiece.x] = 0;
    room.board[y][x] = tmp;

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
        roundCount: room.roundCount,
      });
      setTimeout(() => this.restartGame(room.id), 2000);
      return cb({ ok: true, win: true });
    }

    this.io.to(roomId).emit('placed', {
      board: room.board,
      turnIndex: room.turnIndex,
      roundCount: room.roundCount,
      status: room.status,
    });
    cb({ ok: true });
  }

  // === 吉斯（Jeice）能力：粉碎球・擊退 ===
  emitJeiceCancelled(socket, roomId, message) {
    this.io.to(socket.id).emit('jeiceCancelled', { message });

    const room = this.rooms[roomId];
    if (room) {
      this.io.to(roomId).emit('placed', {
        board: room.board,
        turnIndex: room.turnIndex,
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
    if (player.roleIndex !== 5)
      return cb({ ok: false, message: '只有吉斯可以使用此能力' });
    if (player.usedJeiceThisTurn)
      return cb({ ok: false, message: '本回合已使用過吉斯能力' });

    if (player.placedThisTurn && player.placedThisTurn > 0)
      return cb({ ok: false, message: '本回合已經落子，無法發動能力' });

    room.jeiceState = {
      playerIndex,
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
    if (player.roleIndex !== 5)
      return cb({ ok: false, message: '只有吉斯可以使用此能力' });

    const state = room.jeiceState;
    if (!state || state.playerIndex !== playerIndex || state.step !== 'place') {
      room.jeiceState = null;
      this.emitJeiceCancelled(socket, roomId, '吉斯能力已取消');
      return cb({ ok: false, message: '尚未發動吉斯能力' });
    }

    const board = room.board;

    // 只能落子在空格（不能覆蓋，不能叉叉）
    if (board?.[y]?.[x] === undefined)
      return cb({ ok: false, message: '座標錯誤' });
    if (board[y][x] !== 0) return cb({ ok: false, message: '只能落子在空格' });

    try {
      // 正常落子
      this.roleAbilities[5].place(board, x, y, playerIndex, 0);
      player.placedThisTurn = 1; // 吉斯回合只有 1 步，但先不結束回合，等待是否擊退
      player.usedJeiceThisTurn = true;
    } catch (err) {
      room.jeiceState = null;
      this.emitJeiceCancelled(socket, roomId, err.message);
      return cb({ ok: false, message: err.message });
    }

    const selfValue = playerIndex + 1;
    const targets = [];

    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        const tx = x + dx;
        const ty = y + dy;
        const v = board?.[ty]?.[tx];
        // 敵方一般棋：v > 0 且不是自己
        if (typeof v === 'number' && v > 0 && v !== selfValue) {
          targets.push({ x: tx, y: ty });
        }
      }
    }

    state.step = 'selectTarget';
    state.placed = { x, y };
    state.targets = targets;

    // 若沒有可擊退目標：直接視為正常落子，結束回合並廣播
    if (!targets.length) {
      room.jeiceState = null;

      const targetN = player.roleIndex === 1 ? 6 : room.targetN;
      const win = this.checkWinner(board, x, y, selfValue, targetN);
      if (win) {
        player.wins = (player.wins || 0) + 1;
        room.status = 'ENDED';
        this.io.to(roomId).emit('placed', {
          board,
          win: { winnerIndex: playerIndex, winnerId: player.id },
          turnIndex: room.turnIndex,
          roundCount: room.roundCount,
        });
        setTimeout(() => this.restartGame(roomId), 2000);
        return cb({ ok: true, targets: [], win: true });
      }

      // 結束回合
      this._advanceTurn(room);

      this.io.to(roomId).emit('placed', {
        board,
        turnIndex: room.turnIndex,
        roundCount: room.roundCount,
        status: room.status,
      });

      return cb({ ok: true, targets: [] });
    }

    // 有目標：回傳 targets，等待選擇；不廣播 placed，避免前端 placed handler 把 jeice UI 清掉
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

    const player = room.players[playerIndex];
    if (player.roleIndex !== 5)
      return cb({ ok: false, message: '只有吉斯可以使用此能力' });

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
      // 點錯：視為取消擊退，但落子仍有效 -> 走 cancel 的邏輯
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

    // 不能擊退灰叉（tv < 0）/ 空格
    if (tv <= 0) {
      return this.jeiceCancel(socket, { roomId }, cb);
    }

    // 方向：從新落子(from) -> 目標(target)
    const dx = Math.sign(x - from.x);
    const dy = Math.sign(y - from.y);
    if (dx === 0 && dy === 0) {
      return this.jeiceCancel(socket, { roomId }, cb);
    }

    // 往遠離方向推：同 dx/dy 往外
    const oneX = x + dx;
    const oneY = y + dy;
    const twoX = x + dx * 2;
    const twoY = y + dy * 2;

    const inBoard = (px, py) =>
      py >= 0 && py < board.length && px >= 0 && px < board.length;

    let pushedTo = null;

    // 優先 2 格
    if (inBoard(twoX, twoY) && board[twoY][twoX] === 0) {
      // 注意：若中間一格不是空，也仍允許「飛躍」嗎？規格：
      // "目標後面那格必須是空格，才能被推過去" => 2 格推表示落點(two)要空格
      // 但同時也寫："如果後方只有一格空格 也能擊退到該格"，代表 one 空也可
      // 這裡採：two 空就推 two；不要求 one 必須空（等於直接擊退 2 格）。
      board[y][x] = 0;
      board[twoY][twoX] = tv;
      pushedTo = { x: twoX, y: twoY };
    } else if (inBoard(oneX, oneY) && board[oneY][oneX] === 0) {
      board[y][x] = 0;
      board[oneY][oneX] = tv;
      pushedTo = { x: oneX, y: oneY };
    } else {
      // 擊退失敗：落子仍有效
      pushedTo = null;
    }

    room.jeiceState = null;

    // 擊退後檢查勝利（任何人都可能因為被推而連線）
    const winner = this.checkBoardForAnyWinner(room);
    if (winner !== null) {
      const winPlayer = room.players[winner];
      winPlayer.wins = (winPlayer.wins || 0) + 1;
      room.status = 'ENDED';
      this.io.to(room.id).emit('placed', {
        board: room.board,
        win: { winnerIndex: winner, winnerId: winPlayer.id },
        turnIndex: room.turnIndex,
        roundCount: room.roundCount,
        effect: {
          type: 'jeice',
          from,
          target: { x, y },
          to: pushedTo,
        },
      });
      setTimeout(() => this.restartGame(room.id), 2000);
      cb({ ok: true, win: true });
      return;
    }

    // 結束回合
    this._advanceTurn(room);

    this.io.to(roomId).emit('placed', {
      board: room.board,
      turnIndex: room.turnIndex,
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
    if (player.roleIndex !== 5)
      return cb({ ok: false, message: '只有吉斯可以取消此能力' });

    const state = room.jeiceState;
    if (!state || state.playerIndex !== playerIndex) {
      room.jeiceState = null;
      this.emitJeiceCancelled(socket, roomId, '吉斯能力已取消');
      cb({ ok: true });
      return;
    }

    // 若已落子（selectTarget 階段） => 視為放棄擊退，但落子仍有效，需要結束回合
    const hasPlaced = state.step === 'selectTarget' && state.placed;

    room.jeiceState = null;

    if (!hasPlaced) {
      this.emitJeiceCancelled(socket, roomId, '已取消吉斯能力');
      cb({ ok: true });
      return;
    }

    // 已落子：結束回合（不擊退）
    this._advanceTurn(room);

    this.io.to(roomId).emit('placed', {
      board: room.board,
      turnIndex: room.turnIndex,
      roundCount: room.roundCount,
      status: room.status,
    });

    cb({ ok: true });
  }

  checkBoardForAnyWinner(room) {
    const board = room.board;
    for (let y = 0; y < board.length; y++) {
      for (let x = 0; x < board[y].length; x++) {
        const v = board[y][x];
        if (v > 0) {
          const ownerIndex = v - 1;
          const owner = room.players[ownerIndex];
          const n = owner?.roleIndex === 1 ? 6 : room.targetN; // ✅ 巴特 6 連線
          if (this.checkWinner(board, x, y, v, n)) return ownerIndex;
        }
      }
    }
    return null;
  }

  checkWinner(board, x, y, player, targetN) {
    if (board[y][x] !== player) return false;

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
        if (v === player) c++;
        else break;
      }
      for (let i = 1; i < targetN; i++) {
        const v = board[y - dy * i]?.[x - dx * i];
        if (v === player) c++;
        else break;
      }
      if (c >= targetN) return true;
    }

    return false;
  }
}

module.exports = GameManager;
