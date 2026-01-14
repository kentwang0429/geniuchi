// Quick sanity checks for AI threat detection (wouldOppWinAt) on multi-move/skill opponents.
// Run with: node tools/test_ai_threats.js

const GameManager = require('../gameManager');

// Minimal fake io that ignores all emits
const io = { to: () => ({ emit: () => {} }) };

const gm = new GameManager(io, {});

function makeRoom({ size = 5, targetN = 5, aiRole = 0, oppRole = 1 }) {
  const board = gm.createEmptyBoard(size);
  const room = {
    id: 'room1',
    status: 'PLAYING',
    mode: 'SINGLE',
    boardSize: size,
    size,
    board,
    targetN,
    turnIndex: 0,
    turnSlot: 1,
    roundCount: 1,
    players: [
      { id: 'ai', name: 'AI', isAI: true, roleIndex: aiRole, colorIndex: 0, placedThisTurn: 0 },
      { id: 'opp', name: 'Opp', isAI: false, roleIndex: oppRole, colorIndex: 1, placedThisTurn: 0 },
    ],
  };
  gm.rooms['room1'] = room;
  return room;
}

function asCandidates(board) {
  const res = [];
  for (let y = 0; y < board.length; y++) {
    for (let x = 0; x < board.length; x++) {
      if (board[y][x] === 0) res.push({ x, y });
    }
  }
  return res;
}

function testBurterTwoStep() {
  const room = makeRoom({ size: 6, targetN: 5, aiRole: 0, oppRole: 1 });
  const board = room.board;
  // Opponent (player 1, slot 1 => token = 3) has four in a row and one gap at (2,2)
  const oppToken = gm._tokenOf(1, 1);
  board[2][0] = oppToken;
  board[2][1] = oppToken;
  // gap at (2,2)
  board[2][3] = oppToken;
  board[2][4] = oppToken;
  const candidates = asCandidates(board);
  const block = gm._aiFindImmediateBlockMove(room, candidates, 0);
  return block && block.x === 2 && block.y === 2;
}

function testGinyuSwapThreat() {
  // Opponent Ginyu can place then swap to complete a line.
  // Board: row 0 has opponent tokens at x=1..4, our token blocks at x=0.
  // If Ginyu places at (0,1) then swaps with our (0,0), they win row 0.
  const room = makeRoom({ size: 5, targetN: 5, aiRole: 0, oppRole: 0 });
  const board = room.board;
  const oppToken = gm._tokenOf(1, 1);
  const myToken = gm._tokenOf(0, 1);
  board[0][1] = oppToken;
  board[0][2] = oppToken;
  board[0][3] = oppToken;
  board[0][4] = oppToken;
  board[0][0] = myToken; // blocker that Ginyu could swap with

  const candidates = asCandidates(board);
  const block = gm._aiFindImmediateBlockMove(room, candidates, 0);
  if (!block) console.log('Ginyu test: no block found');
  else console.log('Ginyu test block ->', block);
  return block && block.x === 0 && block.y === 1;
}

function run() {
  const cases = [
    ['Burter two-step threat should be blocked', testBurterTwoStep()],
    ['Ginyu swap threat should be blocked', testGinyuSwapThreat()],
    // Recoome: only blockable if the winning cover target is also a legal spot for us (e.g., we are Recoome too).
  ];
  let pass = 0;
  for (const [name, ok] of cases) {
    console.log(`${ok ? '✅' : '❌'} ${name}`);
    if (ok) pass++;
  }
  console.log(`\n${pass}/${cases.length} passed`);
}

run();
