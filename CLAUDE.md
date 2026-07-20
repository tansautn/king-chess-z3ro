# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

**King Chess z3ro** (a.k.a. *King Chess Zero*) — an ad-free, offline-first chess PWA that runs on Cloudflare Workers. Play vs. a built-in AI, works with no network, installable to the home screen, undo/redo, and background-syncs game history when the connection returns. Brand/authorship (keep consistent when touching user-facing strings): by **Zuko** — https://zuko.pro — "Ván cờ của bạn. Thiết bị của bạn. Quyền kiểm soát thuộc về bạn." The primary UI language is Vietnamese (`<html lang="vi">`).

## Commands

There is **no build step and no bundler** — the browser loads ES modules from `public/` directly. `chess.js` is vendored at `public/vendor/chess.js`.

```bash
npm run dev      # wrangler dev — local server for the Worker + static assets
npm run deploy   # wrangler deploy — publish to Cloudflare
npm run icons    # regenerate PWA icons from scripts/generate-icons.mjs
npm test         # stub only — echoes "No unit tests" and exits 0
```

`predev`/`predeploy` run `scripts/gen-version.mjs`, which stamps a build version (`<git-sha>.<epoch>`) into `public/version.js` **and** rewrites the `CACHE` name in `sw.js`. `public/version.js` is generated — don't hand-edit it.

There is **no linter and no test runner configured**. Source is Prettier-formatted (note the `// prettier-ignore` directives on the piece-square tables in `engine.js`); match that style. `wrangler dev` serves the app the same way production does, so verify changes by driving the running app.

## Architecture

Two layers: a static PWA under `public/` (the whole game) and a thin Cloudflare Worker (`src/worker.js`) that serves those assets and exposes a tiny sync API. `wrangler.toml` binds `public/` as static assets with SPA fallback; the Worker only runs for paths that miss an asset (i.e. `/api/*`).

**Client modules (all in `public/`, imported as native ES modules):**
- `app.js` — the whole UI controller: board rendering, click-to-move, promotion modal, history modal, install prompt, service-worker registration, online/offline status, and orchestration of the AI and persistence layers.
- `engine.js` — the chess "brain": negamax + alpha-beta search over `chess.js`'s legal moves, with material + piece-square-table evaluation. Exports `bestMove(fen, opts)` and `levelToParams(level)` (easy/medium/hard → search depth + random-blunder chance).
- `ai-worker.js` — runs `engine.js` in a Web Worker so search never blocks the board. `app.js` constructs it with `{ type: 'module' }` and **falls back to importing `engine.js` on the main thread** if the Worker can't be created.
- `db.js` — IndexedDB game history (`saveGame`/`getAllGames`/`getGame`/`deleteGame`/`getUnsynced`/`markSynced`). Every record carries a `synced` flag (0/1).
- `sw.js` — Service Worker: precaches the app shell for offline, cache-first fetch, and owns the background-sync unit.

**Server (`src/worker.js`):** serves static assets via the `ASSETS` binding and handles JSON endpoints `/api/health`, `POST /api/sync`, `GET /api/games`. Server-side persistence is **optional** — if the `GAMES_KV` namespace is bound it stores synced games, otherwise it still acknowledges the sync so the client can mark records synced.

### Cross-file invariants (the parts that bite)

These couplings span multiple files and are the main source of "why did my change not take effect":

1. **App-shell cache list is hand-maintained; the cache *version* is automatic.** When you add, remove, or rename any file under `public/`, update the `APP_SHELL` list in `sw.js`. You do **not** hand-bump the `CACHE` name anymore — `gen-version.mjs` rewrites it every build. The `activate` handler deletes any cache whose name isn't the current one; because the name changes each deploy, returning clients (and installed PWAs) get fresh assets, and `app.js` auto-reloads onto them: a new SW calls `skipWaiting()`, takes control, fires `controllerchange`, and the page reloads once (guarded by `hadController` so the first-ever visit doesn't reload). `app.js` also calls `reg.update()` on load, focus, and reconnect so long-lived sessions notice new deploys.

2. **IndexedDB constants are duplicated.** `sw.js` is a classic worker and embeds its **own** copy of the IndexedDB helper that mirrors `db.js`. `DB_NAME` (`king-chess`), `DB_VERSION` (1), and `STORE` (`games`) — plus the object-store schema in `onupgradeneeded` — **must stay identical** between the two files.

3. **Offline sync flow.** Games are written to IndexedDB with `synced: 0`. The SW pushes unsynced games to `POST /api/sync` on the Background Sync `'sync'` event, or — on browsers without Background Sync (e.g. Safari) — when the page posts a `{ type: 'sync-now' }` message. On success it marks records synced and notifies the page (`{ type: 'synced' }`), which re-renders history.

4. **Undo/redo model.** `app.js` keeps the full mainline in `sanHistory` and a `ply` pointer for how many moves are currently shown; undo/redo just move the pointer and rebuild the `Chess` position. Making a new move while "in the past" truncates the tail.

5. **Cloudflare Assets serves `/`, not `/index.html`.** `/index.html` 307-redirects to `/`, and `cache.addAll()` rejects on a redirected response — so `sw.js` caches and serves `/` for navigations. Don't add `/index.html` to `APP_SHELL`.

### Piece colours (configurable, local-only)

Both sides' piece colours are user-configurable, default **Red (white side) vs. Green (black side)**. Pieces are Unicode glyphs whose fill is driven by CSS custom properties `--piece-w` / `--piece-b`; `app.js` reads/writes them to `localStorage` under the key `kingchess.pieceColors` and applies them to the document root. The two `<input type="color">` controls live in the settings block in `index.html`.
