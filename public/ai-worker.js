/**
 * King Chess — AI Web Worker.
 *
 * Runs the (chess.js-powered) search off the main thread so the board stays
 * responsive while the computer "thinks". The page posts { id, fen, depth,
 * randomness } and gets back { id, move }.
 */
import { bestMove } from './engine.js';

self.addEventListener('message', (event) => {
  const { id, fen, depth, randomness } = event.data || {};
  try {
    const move = bestMove(fen, { depth, randomness });
    self.postMessage({ id, move });
  } catch (err) {
    self.postMessage({ id, move: null, error: String(err) });
  }
});
