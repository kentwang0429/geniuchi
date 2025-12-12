// ================= gameManager.js (12111904) =================
// 修正：古杜 gudoMovePiece 只能移動到「空格」且必須在目標周圍的空格
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
    room.players.forEach((p) => {
      p.placedThisTurn = 0;
      p.ready = false;
      p.usedGinyuThisTurn = false;
      p.usedGudoThisTurn = false;
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
    room.players.forEach((p) => {
      p.ready = false;
      p.placedThisTurn = 0;
      p.colorIndex = null;
      p.roleIndex = null;
      p.usedGinyuThisTurn = false;
      p.usedGudoThisTurn = false;
    });
    this.io.to(roomId).emit('roomUpdated', room);
  }

  // === 放置棋子 ===
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

    const board = room.board;

    try {
      role.place(board, x, y, playerIndex, player.placedThisTurn);
      player.placedThisTurn++;
    } catch (err) {
      return cb({ ok: false, message: err.message });
    }

    const win = this.checkWinner(board, x, y, playerIndex + 1, room.targetN);
    if (win) {
      player.wins = (player.wins || 0) + 1;
      room.status = 'ENDED';
      room.ginyuState = null;
      room.gudoState = null;
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
      player.placedThisTurn = 0;
      room.turnIndex = (room.turnIndex + 1) % room.players.length;
      room.roundCount = (room.roundCount || 0) + 1;
      room.ginyuState = null;
      room.gudoState = null;
      const next = room.players[room.turnIndex];
      if (next) {
        next.usedGinyuThisTurn = false;
        next.usedGudoThisTurn = false;
      }
    }

    // 每次落子後廣播最新回合資訊
    this.io.to(roomId).emit('placed', {
      board,
      turnIndex: room.turnIndex,
      roundCount: room.roundCount,
      status: room.status,
    });
    cb({ ok: true });
  }

  // ====== 基紐能力取消（防呆） ======
  emitGinyuCancelled(socket, roomId, message) {
    // 只通知該玩家就好（避免其他人也被跳提示）
    this.io.to(socket.id).emit('ginyuCancelled', { message });

    // 同步一次（讓 turnIndex / roundCount 不會跑掉）
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

    // ✅ 防呆：必須選到自己的古杜棋
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

    // ✅ 必須先選 source
    if (!state.source) return cb({ ok: false, message: '請先選擇古杜棋' });

    // ✅ 只能選 source 周圍 1 格內的棋
    if (Math.abs(x - state.source.x) > 1 || Math.abs(y - state.source.y) > 1)
      return cb({ ok: false, message: '只能選擇古杜周圍的棋子' });

    const v = room.board?.[y]?.[x];
    if (v === undefined) return cb({ ok: false, message: '座標錯誤' });

    // ✅ 只能選「其他玩家的正常棋」（不能選空格、不能選叉叉、不能選自己）
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
    state.emptyAround = emptyAround; // ✅ 存起來讓 move 時驗證
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

    // ✅ 只能移動到空格
    if (room.board?.[y]?.[x] !== 0)
      return cb({ ok: false, message: '只能移動到空格' });

    // ✅ 只能移動到「目標周圍的空格」
    const allowed = Array.isArray(state.emptyAround)
      ? state.emptyAround.some((p) => p.x === x && p.y === y)
      : false;

    if (!allowed) return cb({ ok: false, message: '只能移動到目標周圍的空格' });

    const targetPiece = state.target;

    // 防呆：目標棋仍需存在且是正常棋
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

  checkBoardForAnyWinner(room) {
    const board = room.board;
    const n = room.targetN;
    for (let y = 0; y < board.length; y++) {
      for (let x = 0; x < board[y].length; x++) {
        const v = board[y][x];
        if (v > 0 && this.checkWinner(board, x, y, v, n)) return v - 1;
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
