/**
 * King Chess — main application.
 *
 * Ties together:
 *   • chess.js           → rules, legality, move generation, end-of-game
 *   • ai-worker.js       → computer's move (off the main thread)
 *   • db.js              → per-game history in IndexedDB (undo/redo + offline)
 *   • sw.js              → offline app shell + background sync of history
 */
import { Chess } from './vendor/chess.js';
import { levelToParams } from './engine.js';
import { saveGame, getAllGames, deleteGame, getGame } from './db.js';

// ---- Unicode glyphs --------------------------------------------------------
const GLYPH = { k: '♚', q: '♛', r: '♜', b: '♝', n: '♞', p: '♟' };
const FILES = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];

// ---- Element refs ----------------------------------------------------------
const $ = (id) => document.getElementById(id);
const boardEl = $('board');
const statusEl = $('status');
const moveListEl = $('movelist');
const netEl = $('net');

// ---- Game state ------------------------------------------------------------
let game = new Chess();
let sanHistory = []; // full mainline of SAN moves actually played
let ply = 0; // how many of them are currently shown
let humanColor = 'w';
let orientation = 'w';
let level = 'medium';
let gameId = crypto.randomUUID();
let startedAt = Date.now();

let selected = null; // currently selected square (e.g. "e2")
let legalTargets = new Map(); // target square -> move object
let lastMove = null; // { from, to } for highlighting
let hintMove = null; // { from, to } from the hint button
let thinking = false; // computer is searching
let swReg = null;

// ===========================================================================
// Piece colours — cấu hình màu quân 2 bên, lưu localStorage
// ===========================================================================

const PIECE_COLOR_KEY = 'kingchess.pieceColors';
const DEFAULT_PIECE_COLORS = { w: '#e23b3b', b: '#2fae4e' }; // Đỏ vs Xanh lá

function loadPieceColors() {
  try {
    const saved = JSON.parse(localStorage.getItem(PIECE_COLOR_KEY) || '{}');
    return {
      w: saved.w || DEFAULT_PIECE_COLORS.w,
      b: saved.b || DEFAULT_PIECE_COLORS.b,
    };
  } catch {
    return { ...DEFAULT_PIECE_COLORS };
  }
}

function applyPieceColors(colors) {
  document.documentElement.style.setProperty('--piece-w', colors.w);
  document.documentElement.style.setProperty('--piece-b', colors.b);
}

function initPieceColors() {
  const colors = loadPieceColors();
  applyPieceColors(colors);
  const inputW = $('color-w');
  const inputB = $('color-b');
  inputW.value = colors.w;
  inputB.value = colors.b;

  const persist = () => {
    const next = { w: inputW.value, b: inputB.value };
    applyPieceColors(next);
    localStorage.setItem(PIECE_COLOR_KEY, JSON.stringify(next));
  };
  inputW.addEventListener('input', persist);
  inputB.addEventListener('input', persist);
}

// ===========================================================================
// Board building & rendering
// ===========================================================================

function squareColorLight(r, f) {
  return (r + f) % 2 === 0;
}

/** Recompute `game` from the shown prefix of the mainline. */
function rebuild() {
  game = new Chess();
  for (let i = 0; i < ply; i++) game.move(sanHistory[i]);
  lastMove =
    ply > 0
      ? (() => {
          const h = game.history({ verbose: true });
          const last = h[h.length - 1];
          return last ? { from: last.from, to: last.to } : null;
        })()
      : null;
}

function render() {
  const board = game.board(); // rows a8..h1
  boardEl.innerHTML = '';

  const rows = orientation === 'w' ? [0, 1, 2, 3, 4, 5, 6, 7] : [7, 6, 5, 4, 3, 2, 1, 0];
  const cols = orientation === 'w' ? [0, 1, 2, 3, 4, 5, 6, 7] : [7, 6, 5, 4, 3, 2, 1, 0];

  const checkSquare = game.inCheck() ? kingSquare(game.turn()) : null;

  for (let ri = 0; ri < 8; ri++) {
    for (let ci = 0; ci < 8; ci++) {
      const r = rows[ri];
      const f = cols[ci];
      const squareName = FILES[f] + (8 - r);
      const cell = document.createElement('div');
      cell.className = 'sq ' + (squareColorLight(r, f) ? 'light' : 'dark');
      cell.dataset.square = squareName;

      if (lastMove && (lastMove.from === squareName || lastMove.to === squareName)) {
        cell.classList.add('last');
      }
      if (hintMove && (hintMove.from === squareName || hintMove.to === squareName)) {
        cell.classList.add('last');
      }
      if (selected === squareName) cell.classList.add('sel');
      if (checkSquare === squareName) cell.classList.add('check');

      const piece = board[r][f];
      if (piece) {
        const p = document.createElement('span');
        p.className = 'piece ' + piece.color;
        p.textContent = GLYPH[piece.type];
        cell.appendChild(p);
      }

      if (legalTargets.has(squareName)) {
        if (piece) cell.classList.add('capture');
        const dot = document.createElement('span');
        dot.className = 'dot';
        cell.appendChild(dot);
      }

      // coordinate labels along the two visible edges
      if (ri === 7) {
        const c = document.createElement('span');
        c.className = 'coord file';
        c.textContent = FILES[f];
        cell.appendChild(c);
      }
      if (ci === 0) {
        const c = document.createElement('span');
        c.className = 'coord rank';
        c.textContent = String(8 - r);
        cell.appendChild(c);
      }

      boardEl.appendChild(cell);
    }
  }

  renderStatus();
  renderMoveList();
  renderControls();
}

function kingSquare(color) {
  const board = game.board();
  for (let r = 0; r < 8; r++) {
    for (let f = 0; f < 8; f++) {
      const p = board[r][f];
      if (p && p.type === 'k' && p.color === color) return FILES[f] + (8 - r);
    }
  }
  return null;
}

function renderStatus() {
  statusEl.className = 'status';
  if (thinking) {
    statusEl.textContent = 'Máy đang suy nghĩ…';
    return;
  }
  if (game.isCheckmate()) {
    const humanWon = game.turn() !== humanColor;
    statusEl.textContent = humanWon ? 'Chiếu bí! Bạn thắng 🎉' : 'Chiếu bí! Máy thắng 🤖';
    statusEl.classList.add(humanWon ? 'win' : 'lose');
    return;
  }
  if (
    game.isStalemate() ||
    game.isInsufficientMaterial() ||
    game.isThreefoldRepetition() ||
    game.isDraw()
  ) {
    statusEl.textContent = 'Hòa cờ 🤝';
    statusEl.classList.add('draw');
    return;
  }
  const yourTurn = game.turn() === humanColor;
  let text = yourTurn ? 'Đến lượt bạn' : 'Đến lượt máy';
  if (game.inCheck()) text += ' — Chiếu!';
  statusEl.textContent = text;
}

function renderMoveList() {
  moveListEl.innerHTML = '';
  for (let i = 0; i < sanHistory.length; i += 2) {
    const li = document.createElement('li');
    const white = sanHistory[i] || '';
    const black = sanHistory[i + 1] || '';
    li.textContent = `${white} ${black}`.trim();
    moveListEl.appendChild(li);
  }
}

function renderControls() {
  const floor = humanColor === 'w' ? 0 : 1;
  $('undo').disabled = ply <= floor || thinking;
  $('redo').disabled = ply >= sanHistory.length || thinking;
  $('hint').disabled = thinking || game.isGameOver() || game.turn() !== humanColor;
}

// ===========================================================================
// Interaction
// ===========================================================================

boardEl.addEventListener('click', (e) => {
  const cell = e.target.closest('.sq');
  if (!cell) return;
  onSquareClick(cell.dataset.square);
});

async function onSquareClick(square) {
  if (thinking || game.isGameOver()) return;
  if (game.turn() !== humanColor) return;

  // Completing a move onto a highlighted target.
  if (selected && legalTargets.has(square)) {
    await commitHumanMove(selected, square);
    return;
  }

  // Selecting one of your own pieces.
  const piece = game.get(square);
  if (piece && piece.color === humanColor) {
    selectSquare(square);
  } else {
    clearSelection();
    render();
  }
}

function selectSquare(square) {
  selected = square;
  legalTargets = new Map();
  for (const m of game.moves({ square, verbose: true })) {
    legalTargets.set(m.to, m);
  }
  render();
}

function clearSelection() {
  selected = null;
  legalTargets = new Map();
}

async function commitHumanMove(from, to) {
  const candidates = game
    .moves({ square: from, verbose: true })
    .filter((m) => m.to === to);
  if (candidates.length === 0) return;

  let promotion;
  if (candidates.some((m) => m.promotion)) {
    promotion = await choosePromotion();
    if (!promotion) return; // cancelled
  }

  applyMove({ from, to, promotion });
}

// ===========================================================================
// Applying moves & the computer's reply
// ===========================================================================

function applyMove(move) {
  const result = game.move(move);
  if (!result) return false;

  // A new move from a rewound position discards the old future.
  sanHistory = sanHistory.slice(0, ply);
  sanHistory.push(result.san);
  ply++;
  lastMove = { from: result.from, to: result.to };

  clearSelection();
  hintMove = null;
  render();
  persist();

  if (!game.isGameOver() && game.turn() !== humanColor) {
    scheduleAI();
  }
  return true;
}

function scheduleAI() {
  // small delay so the human's move is visible before the machine replies
  setTimeout(aiMove, 220);
}

async function aiMove() {
  if (game.isGameOver() || game.turn() === humanColor) return;
  thinking = true;
  renderStatus();
  renderControls();

  const params = levelToParams(level);
  const move = await computeBestMove(game.fen(), params);

  thinking = false;
  if (!move) {
    render();
    return;
  }
  applyMove(move);
}

// ---- AI computation (worker with main-thread fallback) ---------------------
let aiWorker;
let fallbackEngine = null;

function ensureWorker() {
  if (aiWorker !== undefined) return aiWorker;
  try {
    aiWorker = new Worker('/ai-worker.js', { type: 'module' });
  } catch {
    aiWorker = null; // will use the main-thread fallback
  }
  return aiWorker;
}

function computeBestMove(fen, params) {
  const worker = ensureWorker();
  if (!worker) {
    return (fallbackEngine
      ? Promise.resolve(fallbackEngine)
      : import('./engine.js').then((m) => (fallbackEngine = m))
    ).then((m) => m.bestMove(fen, params));
  }
  return new Promise((resolve) => {
    const id = Math.random().toString(36).slice(2);
    const onMessage = (event) => {
      if (event.data?.id !== id) return;
      worker.removeEventListener('message', onMessage);
      resolve(event.data.move);
    };
    worker.addEventListener('message', onMessage);
    worker.postMessage({ id, fen, depth: params.depth, randomness: params.randomness });
  });
}

// ===========================================================================
// Undo / redo (navigate a full round at a time)
// ===========================================================================

function undo() {
  const floor = humanColor === 'w' ? 0 : 1;
  if (ply <= floor || thinking) return;
  ply = Math.max(floor, ply - 2);
  rebuild();
  clearSelection();
  hintMove = null;
  render();
  persist();
}

function redo() {
  if (ply >= sanHistory.length || thinking) return;
  ply = Math.min(sanHistory.length, ply + 2);
  rebuild();
  clearSelection();
  hintMove = null;
  render();
  persist();
  if (!game.isGameOver() && game.turn() !== humanColor) scheduleAI();
}

// ===========================================================================
// New game / flip / hint
// ===========================================================================

function newGame() {
  humanColor = $('side').value;
  level = $('level').value;
  orientation = humanColor;
  game = new Chess();
  sanHistory = [];
  ply = 0;
  gameId = crypto.randomUUID();
  startedAt = Date.now();
  selected = null;
  legalTargets = new Map();
  lastMove = null;
  hintMove = null;
  thinking = false;
  render();
  if (humanColor === 'b') scheduleAI(); // computer opens as White
}

function flip() {
  orientation = orientation === 'w' ? 'b' : 'w';
  render();
}

async function hint() {
  if (thinking || game.isGameOver() || game.turn() !== humanColor) return;
  const move = await computeBestMove(game.fen(), { depth: 2, randomness: 0 });
  if (!move) return;
  hintMove = { from: move.from, to: move.to };
  render();
  toast('Gợi ý: ' + move.san);
  setTimeout(() => {
    hintMove = null;
    render();
  }, 2600);
}

// ===========================================================================
// Promotion picker
// ===========================================================================

function choosePromotion() {
  const modal = $('promo');
  modal.hidden = false;
  return new Promise((resolve) => {
    const onClick = (e) => {
      const btn = e.target.closest('.promo');
      if (!btn) return;
      cleanup();
      resolve(btn.dataset.piece);
    };
    const onBackdrop = (e) => {
      if (e.target === modal) {
        cleanup();
        resolve(null);
      }
    };
    function cleanup() {
      modal.hidden = true;
      modal.removeEventListener('click', onBackdrop);
      modal.querySelector('.promo-choices').removeEventListener('click', onClick);
    }
    modal.querySelector('.promo-choices').addEventListener('click', onClick);
    modal.addEventListener('click', onBackdrop);
  });
}

// ===========================================================================
// Persistence + sync
// ===========================================================================

function currentResult() {
  if (game.isCheckmate()) return game.turn() === humanColor ? 'lose' : 'win';
  if (
    game.isStalemate() ||
    game.isInsufficientMaterial() ||
    game.isThreefoldRepetition() ||
    game.isDraw()
  ) {
    return 'draw';
  }
  return 'in_progress';
}

async function persist() {
  try {
    await saveGame({
      id: gameId,
      startedAt,
      humanColor,
      level,
      moves: sanHistory.slice(),
      ply,
      fen: game.fen(),
      pgn: game.pgn(),
      result: currentResult(),
    });
    requestSync();
  } catch {
    /* storage may be unavailable (private mode) — game still playable */
  }
}

async function requestSync() {
  if (!('serviceWorker' in navigator)) return;
  try {
    const reg = swReg || (await navigator.serviceWorker.ready);
    if ('sync' in reg) {
      // Queues until connectivity returns if currently offline.
      await reg.sync.register('sync-games');
      return;
    }
  } catch {
    /* fall through to the message-based trigger */
  }
  // Browsers without Background Sync: ask the SW to push right now.
  if (navigator.onLine) {
    navigator.serviceWorker.controller?.postMessage({ type: 'sync-now' });
  }
}

// ===========================================================================
// Saved-games history view
// ===========================================================================

async function openHistory() {
  const list = $('history-list');
  const empty = $('history-empty');
  list.innerHTML = '';
  const games = await getAllGames();
  empty.hidden = games.length > 0;

  for (const g of games) {
    const li = document.createElement('li');

    const meta = document.createElement('div');
    meta.className = 'meta';
    const title = document.createElement('span');
    title.className = 'title';
    title.textContent = formatDate(g.startedAt || g.updatedAt);
    const sub = document.createElement('span');
    sub.className = 'sub';
    const moveCount = Math.ceil((g.moves?.length || 0) / 2);
    sub.textContent = `${resultLabel(g.result)} · ${moveCount} nước · ${
      g.synced ? '✔ đã đồng bộ' : '⧗ chờ đồng bộ'
    }`;
    meta.append(title, sub);

    const actions = document.createElement('div');
    actions.className = 'row-actions';
    const open = document.createElement('button');
    open.className = 'btn';
    open.textContent = 'Mở';
    open.onclick = () => loadGame(g.id);
    const del = document.createElement('button');
    del.className = 'btn btn-ghost';
    del.textContent = '🗑';
    del.onclick = async () => {
      await deleteGame(g.id);
      openHistory();
    };
    actions.append(open, del);

    li.append(meta, actions);
    list.appendChild(li);
  }

  $('history').hidden = false;
}

async function loadGame(id) {
  const g = await getGame(id);
  if (!g) return;
  gameId = g.id;
  humanColor = g.humanColor || 'w';
  level = g.level || 'medium';
  orientation = humanColor;
  startedAt = g.startedAt || Date.now();
  sanHistory = Array.isArray(g.moves) ? g.moves.slice() : [];
  ply = typeof g.ply === 'number' ? g.ply : sanHistory.length;
  $('side').value = humanColor;
  $('level').value = level;
  rebuild();
  clearSelection();
  hintMove = null;
  thinking = false;
  render();
  $('history').hidden = true;
  if (!game.isGameOver() && game.turn() !== humanColor) scheduleAI();
}

function resultLabel(r) {
  return { win: 'Bạn thắng', lose: 'Máy thắng', draw: 'Hòa', in_progress: 'Đang chơi' }[r] || 'Đang chơi';
}

function formatDate(ts) {
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)} ${pad(d.getHours())}:${pad(
    d.getMinutes(),
  )}`;
}

// ===========================================================================
// Toast + network indicator
// ===========================================================================

let toastEl;
let toastTimer;
function toast(message) {
  if (!toastEl) {
    toastEl = document.createElement('div');
    toastEl.className = 'toast';
    document.body.appendChild(toastEl);
  }
  toastEl.textContent = message;
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), 2200);
}

function updateNet() {
  const online = navigator.onLine;
  netEl.classList.toggle('offline', !online);
  netEl.title = online ? 'Trực tuyến' : 'Ngoại tuyến';
}

// ===========================================================================
// Wiring
// ===========================================================================

$('new').onclick = newGame;
$('undo').onclick = undo;
$('redo').onclick = redo;
$('flip').onclick = flip;
$('hint').onclick = hint;
$('history-btn').onclick = openHistory;
$('history-close').onclick = () => ($('history').hidden = true);
$('history').addEventListener('click', (e) => {
  if (e.target === $('history')) $('history').hidden = true;
});

window.addEventListener('online', () => {
  updateNet();
  toast('Đã kết nối — đang đồng bộ');
  requestSync();
});
window.addEventListener('offline', () => {
  updateNet();
  toast('Mất mạng — vẫn chơi được offline');
});

// PWA install prompt
let deferredPrompt;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredPrompt = e;
  $('install').hidden = false;
});
$('install').onclick = async () => {
  $('install').hidden = true;
  if (!deferredPrompt) return;
  deferredPrompt.prompt();
  await deferredPrompt.userChoice;
  deferredPrompt = null;
};
window.addEventListener('appinstalled', () => ($('install').hidden = true));

// Service worker
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register('/sw.js')
      .then((reg) => {
        swReg = reg;
      })
      .catch(() => {});
  });
  navigator.serviceWorker.addEventListener('message', (event) => {
    if (event.data?.type === 'synced') {
      toast('Đã đồng bộ lịch sử ☁️');
      if (!$('history').hidden) openHistory();
    }
  });
}

// ---- Boot ------------------------------------------------------------------
initPieceColors();
updateNet();
newGame();
