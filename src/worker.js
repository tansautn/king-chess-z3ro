/**
 * King Chess — Cloudflare Worker entry point.
 *
 * Responsibilities:
 *   1. Serve the static PWA (handled by the [assets] binding).
 *   2. Expose a tiny JSON API used by the Service Worker to sync game
 *      history that was recorded while the device was offline.
 *
 * Sync storage is optional: if a `GAMES_KV` namespace is bound (see
 * wrangler.toml), synced games are persisted there; otherwise the endpoint
 * still acknowledges the sync so the client can mark records as synced.
 */
import { VERSION } from '../public/version.js';

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  // The PWA is same-origin, but keep sync robust if hosted on a subdomain.
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'content-type, x-zuko-debug',
};

// Anonymous "is anyone playing?" counter. Each client counts New Game presses
// locally and periodically syncs the delta up; we accumulate it here.
const PLAYS_KEY = 'stats:plays';

async function readPlays(env) {
  if (!env.GAMES_KV) return 0;
  const raw = await env.GAMES_KV.get(PLAYS_KEY);
  return raw ? parseInt(raw, 10) || 0 : 0;
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname.startsWith('/api/')) {
      return handleApi(request, env, url);
    }

    // Everything else is a static asset (index.html, sw.js, manifest, etc.).
    return env.ASSETS.fetch(request);
  },
};

async function handleApi(request, env, url) {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: JSON_HEADERS });
  }

  // Health check.
  if (url.pathname === '/api/health') {
    return json({
      ok: true,
      version: VERSION,
      kv: Boolean(env.GAMES_KV),
      time: Date.now(),
    });
  }

  // Usage counter. POST adds the client's pending count into the running total
  // and (when asked) reports it back so the client can reset to 0. Any request
  // carrying the `X-Zuko-Debug` header gets the current total in the response.
  if (url.pathname === '/api/plays') {
    const debug = request.headers.has('x-zuko-debug');

    if (request.method === 'POST') {
      let payload;
      try {
        payload = await request.json();
      } catch {
        payload = {};
      }
      // Clamp to a sane range so a bad/hostile client can't skew the counter.
      const count = Math.max(0, Math.min(1000, Math.floor(Number(payload?.count) || 0)));
      let total = await readPlays(env);
      total += count;
      if (count > 0 && env.GAMES_KV) {
        await env.GAMES_KV.put(PLAYS_KEY, String(total));
      }
      const body = { ok: true, accepted: count };
      if (debug) body.total = total;
      return json(body);
    }

    if (request.method === 'GET') {
      const body = { ok: true };
      if (debug) body.total = await readPlays(env);
      return json(body);
    }
  }

  // Receive a batch of games from the Service Worker's background sync.
  if (url.pathname === '/api/sync' && request.method === 'POST') {
    let payload;
    try {
      payload = await request.json();
    } catch {
      return json({ ok: false, error: 'invalid_json' }, 400);
    }

    const games = Array.isArray(payload?.games) ? payload.games : [];
    const accepted = [];

    for (const game of games) {
      if (!game || typeof game.id !== 'string') continue;
      accepted.push(game.id);
      if (env.GAMES_KV) {
        try {
          await env.GAMES_KV.put(
            `game:${game.id}`,
            JSON.stringify({ ...game, syncedAt: Date.now() }),
          );
        } catch {
          // Storage is best-effort; the client keeps its local copy anyway.
        }
      }
    }

    return json({ ok: true, accepted, stored: Boolean(env.GAMES_KV) });
  }

  // List previously synced games (only meaningful when KV is configured).
  if (url.pathname === '/api/games' && request.method === 'GET') {
    if (!env.GAMES_KV) return json({ ok: true, games: [], stored: false });
    const list = await env.GAMES_KV.list({ prefix: 'game:' });
    const games = [];
    for (const key of list.keys) {
      const value = await env.GAMES_KV.get(key.name, 'json');
      if (value) games.push(value);
    }
    return json({ ok: true, games, stored: true });
  }

  return json({ ok: false, error: 'not_found' }, 404);
}
