// Service-worker freshness guard.
//
// Regression test for a real field report: a phone that hadn't opened the site
// in a couple of weeks rendered a build from before several releases, and the
// features added since looked "removed". Cause: the SW served
// `cached || network`, so a returning visitor always got the PREVIOUS deploy.
//
// This boots the app from a mutable copy of the tree, lets the service worker
// install, then "redeploys" by editing files on disk and reloading. The new
// content must appear immediately — not on the load after. It also checks the
// other half of the contract: with the network down, the cached app still
// loads, so the PWA stays offline-capable.
//
// Run:  npm run test:sw   (needs a Chromium; no network, no API keys)

import { chromium } from 'playwright';
import { readFileSync, writeFileSync, existsSync, cpSync, rmSync, mkdtempSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { tmpdir } from 'os';
import { createServer } from 'http';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '../..');
const CHROME = process.env.CHROME
  ?? ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome'].find(existsSync);

// Serve from a throwaway copy so the test can mutate files freely.
const ROOT = mkdtempSync(join(tmpdir(), 'bb-sw-'));
for (const p of ['index.html', 'sw.js', 'manifest.json', 'css', 'src', 'vendor', 'icons'])
  cpSync(join(REPO, p), join(ROOT, p), { recursive: true });

const MIME = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.json': 'application/json', '.png': 'image/png' };
let offline = false;
const server = createServer((req, res) => {
  if (offline) { req.socket.destroy(); return; }          // simulate no network
  let path = req.url.split('?')[0];
  // Mirror Netlify's SPA rewrite (_redirects): "/" and any extensionless path
  // serve index.html. The SW pre-caches "/" in STATIC, so without this its
  // install rejects and the worker never activates.
  if (path === '/' || !path.slice(path.lastIndexOf('/')).includes('.')) path = '/index.html';
  const p = join(ROOT, path);
  let body;
  try { body = readFileSync(p); }
  catch { res.writeHead(404); res.end(); return; }
  // Netlify serves sw.js no-cache (see _headers); mirror that here so the test
  // exercises the same update path production uses.
  const headers = { 'Content-Type': MIME[p.slice(p.lastIndexOf('.'))] || 'application/octet-stream' };
  if (req.url.startsWith('/sw.js')) headers['Cache-Control'] = 'no-cache';
  res.writeHead(200, headers);
  res.end(body);
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const URL_ = `http://127.0.0.1:${port}/index.html`;

const b = await chromium.launch(CHROME ? { executablePath: CHROME } : {});
const ctx = await b.newContext();
const p = await ctx.newPage();

const logoText = () => p.evaluate(() => document.querySelector('.logo')?.textContent ?? '(none)');
const swReady = () => p.evaluate(() => navigator.serviceWorker.ready.then(() => true));
const controlled = () => p.evaluate(() => !!navigator.serviceWorker.controller);

// ── 1. First load: SW installs and takes control ──
await p.goto(URL_, { waitUntil: 'networkidle' });
await swReady();
const first = await logoText();
// Reload so the SW is actually controlling this page (first load usually isn't).
await p.reload({ waitUntil: 'networkidle' });
const isControlled = await controlled();
const secondLoad = await logoText();

// ── 2. "Redeploy": mutate the served files, reload once ──
const MARK = 'FRESHMARK';
writeFileSync(join(ROOT, 'index.html'),
  readFileSync(join(ROOT, 'index.html'), 'utf8')
    .replace('<div class="logo">', `<div class="logo" data-mark="${MARK}">`));
writeFileSync(join(ROOT, 'css/main.css'),
  readFileSync(join(ROOT, 'css/main.css'), 'utf8') + `\n/* ${MARK} */\n.logo { letter-spacing: 3.5px; }\n`);

await p.reload({ waitUntil: 'networkidle' });
const sawNewHtml = await p.evaluate(m => document.querySelector('.logo')?.dataset.mark === m, MARK);
const sawNewCss = await p.evaluate(() =>
  getComputedStyle(document.querySelector('.logo')).letterSpacing === '3.5px');

// ── 3. Offline: the cached app still loads ──
offline = true;
let offlineLoaded = false, offlineLogo = '(failed)';
try {
  await p.reload({ waitUntil: 'domcontentloaded', timeout: 15000 });
  offlineLogo = await logoText();
  offlineLoaded = offlineLogo !== '(none)';
} catch { /* recorded as failure below */ }
offline = false;

await b.close(); server.close();
rmSync(ROOT, { recursive: true, force: true });

let fail = 0;
const check = (ok, label, detail = '') => {
  if (!ok) fail++;
  console.log(`  [${ok ? ' PASS ' : ' FAIL '}]  ${label}${detail ? '  — ' + detail : ''}`);
};

console.log('\nService-worker freshness\n');
check(first !== '(none)', 'app renders on first load', first);
check(isControlled, 'service worker controls the page after one reload');
check(secondLoad !== '(none)', 'app renders while SW-controlled', secondLoad);
check(sawNewHtml, 'a redeployed index.html appears on the NEXT load, not the one after');
check(sawNewCss, 'redeployed CSS is picked up too (no mixed-version render)');
check(offlineLoaded, 'the cached app still loads with the network down', offlineLogo);

console.log(`\n${fail} failure(s)\n`);
process.exit(fail ? 1 : 0);
