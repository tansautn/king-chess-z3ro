/**
 * King Chess — move-generation engine.
 *
 * Rules, legality and move generation are ALL handled by chess.js (the well
 * known library). On top of chess.js's legal-move generator we run a small
 * negamax search with alpha-beta pruning and a material + piece-square-table
 * evaluation to pick the computer's next move.
 *
 * Exported: bestMove(fen, options) -> { from, to, promotion, san } | null
 */
import { Chess } from './vendor/chess.js';

// Centipawn material values.
const VALUE = { p: 100, n: 320, b: 330, r: 500, q: 900, k: 0 };
const MATE = 1_000_000;

// Piece-square tables (white's point of view, a8..h1 reading order = the
// order chess.js's board() yields). Encourage sensible development.
// prettier-ignore
const PST = {
  p: [
      0,  0,  0,  0,  0,  0,  0,  0,
     50, 50, 50, 50, 50, 50, 50, 50,
     10, 10, 20, 30, 30, 20, 10, 10,
      5,  5, 10, 25, 25, 10,  5,  5,
      0,  0,  0, 20, 20,  0,  0,  0,
      5, -5,-10,  0,  0,-10, -5,  5,
      5, 10, 10,-20,-20, 10, 10,  5,
      0,  0,  0,  0,  0,  0,  0,  0,
  ],
  n: [
    -50,-40,-30,-30,-30,-30,-40,-50,
    -40,-20,  0,  0,  0,  0,-20,-40,
    -30,  0, 10, 15, 15, 10,  0,-30,
    -30,  5, 15, 20, 20, 15,  5,-30,
    -30,  0, 15, 20, 20, 15,  0,-30,
    -30,  5, 10, 15, 15, 10,  5,-30,
    -40,-20,  0,  5,  5,  0,-20,-40,
    -50,-40,-30,-30,-30,-30,-40,-50,
  ],
  b: [
    -20,-10,-10,-10,-10,-10,-10,-20,
    -10,  0,  0,  0,  0,  0,  0,-10,
    -10,  0,  5, 10, 10,  5,  0,-10,
    -10,  5,  5, 10, 10,  5,  5,-10,
    -10,  0, 10, 10, 10, 10,  0,-10,
    -10, 10, 10, 10, 10, 10, 10,-10,
    -10,  5,  0,  0,  0,  0,  5,-10,
    -20,-10,-10,-10,-10,-10,-10,-20,
  ],
  r: [
      0,  0,  0,  0,  0,  0,  0,  0,
      5, 10, 10, 10, 10, 10, 10,  5,
     -5,  0,  0,  0,  0,  0,  0, -5,
     -5,  0,  0,  0,  0,  0,  0, -5,
     -5,  0,  0,  0,  0,  0,  0, -5,
     -5,  0,  0,  0,  0,  0,  0, -5,
     -5,  0,  0,  0,  0,  0,  0, -5,
      0,  0,  0,  5,  5,  0,  0,  0,
  ],
  q: [
    -20,-10,-10, -5, -5,-10,-10,-20,
    -10,  0,  0,  0,  0,  0,  0,-10,
    -10,  0,  5,  5,  5,  5,  0,-10,
     -5,  0,  5,  5,  5,  5,  0, -5,
      0,  0,  5,  5,  5,  5,  0, -5,
    -10,  5,  5,  5,  5,  5,  0,-10,
    -10,  0,  5,  0,  0,  0,  0,-10,
    -20,-10,-10, -5, -5,-10,-10,-20,
  ],
  k: [
    -30,-40,-40,-50,-50,-40,-40,-30,
    -30,-40,-40,-50,-50,-40,-40,-30,
    -30,-40,-40,-50,-50,-40,-40,-30,
    -30,-40,-40,-50,-50,-40,-40,-30,
    -20,-30,-30,-40,-40,-30,-30,-20,
    -10,-20,-20,-20,-20,-20,-20,-10,
     20, 20,  0,  0,  0,  0, 20, 20,
     20, 30, 10,  0,  0, 10, 30, 20,
  ],
};

/** Static evaluation from White's perspective (positive favours White). */
function evaluateWhite(chess) {
  const board = chess.board(); // rows a8..h1
  let score = 0;
  for (let r = 0; r < 8; r++) {
    for (let f = 0; f < 8; f++) {
      const piece = board[r][f];
      if (!piece) continue;
      const idx = r * 8 + f;
      const base = VALUE[piece.type];
      if (piece.color === 'w') {
        score += base + PST[piece.type][idx];
      } else {
        // Mirror the table vertically for black.
        const mirrored = (7 - r) * 8 + f;
        score -= base + PST[piece.type][mirrored];
      }
    }
  }
  return score;
}

/** Negamax leaf value, relative to the side to move. */
function evaluateRelative(chess) {
  const sign = chess.turn() === 'w' ? 1 : -1;
  return sign * evaluateWhite(chess);
}

/** Order moves so captures/promotions are searched first (better pruning). */
function orderedMoves(chess) {
  const moves = chess.moves({ verbose: true });
  moves.sort((a, b) => moveScore(b) - moveScore(a));
  return moves;
}

function moveScore(m) {
  let s = 0;
  if (m.captured) s += 10 * VALUE[m.captured] - VALUE[m.piece];
  if (m.promotion) s += VALUE[m.promotion];
  if (m.flags.includes('k') || m.flags.includes('q')) s += 30; // castling
  return s;
}

function negamax(chess, depth, alpha, beta, ply) {
  if (chess.isCheckmate()) return -(MATE - ply); // side to move is mated
  if (
    chess.isStalemate() ||
    chess.isInsufficientMaterial() ||
    chess.isThreefoldRepetition() ||
    chess.isDraw()
  ) {
    return 0;
  }
  if (depth === 0) return evaluateRelative(chess);

  let best = -Infinity;
  for (const m of orderedMoves(chess)) {
    chess.move(m);
    const score = -negamax(chess, depth - 1, -beta, -alpha, ply + 1);
    chess.undo();
    if (score > best) best = score;
    if (best > alpha) alpha = best;
    if (alpha >= beta) break; // beta cut-off
  }
  return best;
}

/**
 * Pick the best move for the side to move in `fen`.
 *
 * @param {string} fen
 * @param {object} [options]
 * @param {number} [options.depth=2]     search depth in plies
 * @param {number} [options.randomness=0] 0..1 chance of playing a random legal
 *                                        move instead (for easy difficulty)
 * @returns {{from:string,to:string,promotion?:string,san:string}|null}
 */
export function bestMove(fen, { depth = 2, randomness = 0 } = {}) {
  const chess = new Chess(fen);
  const legal = chess.moves({ verbose: true });
  if (legal.length === 0) return null;

  // Easy mode: sometimes just blunder around like a beginner.
  if (randomness > 0 && Math.random() < randomness) {
    return pack(legal[(Math.random() * legal.length) | 0]);
  }

  let bestScore = -Infinity;
  const bestMoves = [];
  let alpha = -Infinity;
  const beta = Infinity;

  for (const m of orderedMoves(chess)) {
    chess.move(m);
    const score = -negamax(chess, depth - 1, -beta, -alpha, 1);
    chess.undo();
    if (score > bestScore) {
      bestScore = score;
      bestMoves.length = 0;
      bestMoves.push(m);
    } else if (score === bestScore) {
      bestMoves.push(m); // collect ties for variety
    }
    if (bestScore > alpha) alpha = bestScore;
  }

  const pick = bestMoves[(Math.random() * bestMoves.length) | 0];
  return pack(pick);
}

function pack(m) {
  return { from: m.from, to: m.to, promotion: m.promotion, san: m.san };
}

/** Map a difficulty label to search parameters. */
export function levelToParams(level) {
  switch (level) {
    case 'easy':
      return { depth: 1, randomness: 0.35 };
    case 'hard':
      return { depth: 3, randomness: 0 };
    case 'medium':
    default:
      return { depth: 2, randomness: 0.05 };
  }
}
