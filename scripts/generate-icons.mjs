/**
 * Generate the PWA PNG icons by rendering an SVG with headless Chromium.
 *
 *   node scripts/generate-icons.mjs
 *
 * Looks for a Chromium/Chrome binary (Playwright's bundled one, or $CHROME_BIN)
 * and screenshots a full-viewport SVG at each required size.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(__dirname, '..', 'public', 'icons');
mkdirSync(OUT_DIR, { recursive: true });

function findChrome() {
  if (process.env.CHROME_BIN && existsSync(process.env.CHROME_BIN)) {
    return process.env.CHROME_BIN;
  }
  const base = process.env.PLAYWRIGHT_BROWSERS_PATH || '/opt/pw-browsers';
  if (existsSync(base)) {
    for (const dir of readdirSync(base)) {
      for (const rel of [
        'chrome-linux/chrome',
        'chrome-linux/headless_shell',
        'chrome-linux/chrome-headless-shell',
      ]) {
        const candidate = join(base, dir, rel);
        if (existsSync(candidate)) return candidate;
      }
    }
  }
  for (const p of ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome']) {
    if (existsSync(p)) return p;
  }
  throw new Error('No Chromium/Chrome binary found. Set CHROME_BIN.');
}

function svg(size, kingScale) {
  const font = size * kingScale;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#20344a"/>
      <stop offset="1" stop-color="#0f1720"/>
    </linearGradient>
    <radialGradient id="glow" cx="0.5" cy="0.44" r="0.5">
      <stop offset="0" stop-color="#f5b30155"/>
      <stop offset="1" stop-color="#f5b30100"/>
    </radialGradient>
    <linearGradient id="gold" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#ffd85e"/>
      <stop offset="1" stop-color="#f5a201"/>
    </linearGradient>
  </defs>
  <rect width="${size}" height="${size}" fill="url(#bg)"/>
  <circle cx="${size / 2}" cy="${size * 0.46}" r="${size * 0.42}" fill="url(#glow)"/>
  <text x="50%" y="52%" text-anchor="middle" dominant-baseline="central"
        font-family="'DejaVu Sans','FreeSerif',sans-serif" font-size="${font}"
        fill="url(#gold)" stroke="#7a5300" stroke-width="${size * 0.006}">♚</text>
</svg>`;
}

function html(size, kingScale) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    html,body{margin:0;padding:0;background:#0f1720}
    .wrap{width:${size}px;height:${size}px;overflow:hidden}
  </style></head><body><div class="wrap">${svg(size, kingScale)}</div></body></html>`;
}

function shoot(chrome, size, kingScale, outName) {
  const htmlPath = join(tmpdir(), `icon-${size}-${outName}.html`);
  const outPath = join(OUT_DIR, outName);
  writeFileSync(htmlPath, html(size, kingScale));
  execFileSync(
    chrome,
    [
      '--headless=new',
      '--no-sandbox',
      '--disable-gpu',
      '--hide-scrollbars',
      '--force-device-scale-factor=1',
      '--default-background-color=00000000',
      `--window-size=${size},${size}`,
      `--screenshot=${outPath}`,
      `file://${htmlPath}`,
    ],
    { stdio: 'ignore' },
  );
  console.log('wrote', outPath);
}

const chrome = findChrome();
console.log('using', chrome);
// "any" icons fill more of the tile; maskable keeps content in the safe zone.
shoot(chrome, 192, 0.66, 'icon-192.png');
shoot(chrome, 512, 0.66, 'icon-512.png');
shoot(chrome, 512, 0.54, 'icon-maskable-512.png');
console.log('done');
