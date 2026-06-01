#!/usr/bin/env node
// ── On-device mobile test server ─────────────────────────────────────────
//
// Serves the repo to a phone on the same Wi-Fi over HTTPS, so the camera and
// the WebXR LiDAR depth path work (both require a secure context — plain
// http://<lan-ip> is rejected by mobile browsers). This replaces leaning on
// Netlify deploy previews for every test: it is instant, offline, and has no
// per-deploy limit.
//
//   npm run serve:mobile            # default port 8443
//   npm run serve:mobile -- 9000    # custom port
//
// A self-signed certificate is generated once into ./.cert (gitignored). The
// phone will warn the first time — accept it (Android Chrome: "Advanced →
// proceed"; iOS: install + trust the profile once). For a zero-warning
// trusted URL instead, see the tunnel / GitHub Pages notes in the README.

import { createServer } from 'node:https';
import { readFile }     from 'node:fs/promises';
import { existsSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { networkInterfaces } from 'node:os';
import { extname, join, normalize, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT     = normalize(join(dirname(fileURLToPath(import.meta.url)), '..'));
const CERT_DIR = join(ROOT, '.cert');
const KEY      = join(CERT_DIR, 'key.pem');
const CERT     = join(CERT_DIR, 'cert.pem');
const PORT     = parseInt(process.argv[2], 10) || 8443;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'text/javascript; charset=utf-8',
  '.mjs':  'text/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg':  'image/svg+xml',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.ico':  'image/x-icon',
  '.wasm': 'application/wasm',
  '.task': 'application/octet-stream',
};

// ── LAN addresses ────────────────────────────────────────────────────────
function lanIPs() {
  const out = [];
  for (const addrs of Object.values(networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family === 'IPv4' && !a.internal) out.push(a.address);
    }
  }
  return out;
}

// ── Self-signed cert (generated once, covers localhost + every LAN IP) ────
function ensureCert(ips) {
  if (existsSync(KEY) && existsSync(CERT)) return true;
  mkdirSync(CERT_DIR, { recursive: true });
  const san = ['DNS:localhost', 'IP:127.0.0.1', ...ips.map(ip => `IP:${ip}`)].join(',');
  try {
    execFileSync('openssl', [
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
      '-keyout', KEY, '-out', CERT, '-days', '365',
      '-subj', '/CN=music-maker-dev',
      '-addext', `subjectAltName=${san}`,
    ], { stdio: 'ignore' });
    return true;
  } catch {
    console.error('\n  ✗ Could not generate a certificate — is `openssl` installed and on PATH?');
    console.error('    Install it, or use a tunnel instead (see README → Testing on mobile).\n');
    return false;
  }
}

// ── Static file serving (with index + SPA fallback, no path traversal) ────
async function serveFile(res, urlPath) {
  let rel = normalize(decodeURIComponent(urlPath.split('?')[0])).replace(/^(\.\.[/\\])+/, '');
  if (rel === '/' || rel === '\\' || rel === '.') rel = 'index.html';
  let file = join(ROOT, rel);
  if (!file.startsWith(ROOT)) { res.writeHead(403).end('Forbidden'); return; }

  try {
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': TYPES[extname(file)] || 'application/octet-stream' });
    res.end(body);
  } catch {
    // Unknown route → fall back to index.html (mirrors the Netlify SPA rule).
    try {
      const body = await readFile(join(ROOT, 'index.html'));
      res.writeHead(200, { 'content-type': TYPES['.html'] });
      res.end(body);
    } catch {
      res.writeHead(404).end('Not found');
    }
  }
}

// ── QR code for the first LAN URL (optional, if qrcode-terminal present) ──
async function printQR(url) {
  try {
    const qr = (await import('qrcode-terminal')).default;
    qr.generate(url, { small: true });
  } catch {
    console.log('  (install `qrcode-terminal` for a scannable QR: npm i -D qrcode-terminal)\n');
  }
}

// ── Boot ──────────────────────────────────────────────────────────────────
const ips = lanIPs();
if (!ensureCert(ips)) process.exit(1);

const server = createServer(
  { key: await readFile(KEY), cert: await readFile(CERT) },
  (req, res) => serveFile(res, req.url),
);

server.listen(PORT, '0.0.0.0', async () => {
  const primary = ips[0];
  console.log('\n  🎛  Music-Maker mobile test server (HTTPS)\n');
  console.log(`     local:   https://localhost:${PORT}`);
  for (const ip of ips) console.log(`     network: https://${ip}:${PORT}`);
  if (!primary) {
    console.log('\n  ⚠ No LAN address found — connect to Wi-Fi to reach this from a phone.\n');
  } else {
    console.log('\n  Scan on your phone (same Wi-Fi), accept the certificate warning once:\n');
    await printQR(`https://${primary}:${PORT}`);
    console.log('  Note: WebXR LiDAR depth needs Android Chrome + ARCore. iOS Safari can');
    console.log('  exercise the camera, pose/hand tracking and the monocular depth estimate.\n');
  }
});
