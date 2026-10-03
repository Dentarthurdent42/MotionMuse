// Does the setup tag survive being in a video?
//
// The question the tag exists to answer is "can somebody watching a recording
// of me open my setup?" — so this records one. A phone's and two monitors'
// screens, each a moving, noisy picture with the tag in its corner, are
// encoded with H.264 (yuv420p — colour at half the resolution of brightness,
// the way every phone records and every feed re-encodes), scaled to a feed's
// size and compressed at several strengths; a frame is pulled back out and
// the reader has to find the tag in it. Three different setups (seeds) per
// case, because one is an anecdote: near the limit, a single run passes or
// fails on luck.
//
// The app's own choice — tagPitch() for that screen — must pass every
// required case, every seed. The row a pixel smaller is printed beside it, so
// the trade can be re-measured rather than remembered.
//
// Needs ffmpeg with libx264 on the PATH; skips (exit 0) without it.
// Run: npm run test:tag-recording

import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodeTag, rasterize, readTag, tagPitch } from '../../src/densecode.js';

let encoders = '';
try { encoders = execFileSync('ffmpeg', ['-hide_banner', '-encoders'], { stdio: 'pipe' }).toString(); } catch { /* no ffmpeg */ }
if (!encoders.includes('libx264')) {
  console.log('ffmpeg with libx264 not found — skipping the recording test.');
  process.exit(0);
}

// Three screens, recorded at their own resolution and posted to feeds of the
// sizes people actually watch at. A feed is sized by its SHORT side — 1080p
// and 720p are 1920×1080 or 1080×1920 alike — so a phone held upright
// (1170px wide) and a monitor (1080 or 1440 tall) are each scaled by feed ÷
// their short side. Only a 700px band of the frame is drawn: the scale is
// what matters, and the rest is time.
const SOURCES = [
  { name: 'phone 1170×2532 @3x', W: 1170, short: 1170 },
  { name: 'monitor 1920×1080', W: 1920, short: 1080 },
  { name: 'monitor 2560×1440', W: 2560, short: 1440 },
];
const H = 700;
const FRAMES = 8;
// [feed short side, x264 CRF]. CRF 23 is x264's default; 33 a hard squeeze.
// The 540 rows are reported, not required: a recording squeezed below 720p
// is past what the tag is sized for.
const FEEDS = [
  { s: 1080, crf: 23, required: true },
  { s: 1080, crf: 33, required: true },
  { s: 720, crf: 28, required: true },
  { s: 720, crf: 33, required: true },
  { s: 540, crf: 28, required: false },
];
const SEEDS = [42, 7, 1234];
// The app's pitch, and one pixel under it, so the margin stays visible.
const OFFSETS = (process.env.OFFSETS ?? "0,-1").split(",").map(Number);

const dir = mkdtempSync(join(tmpdir(), 'tag-rec-'));
const ppm = (path, rgb, w, h) => writeFileSync(path, Buffer.concat([Buffer.from(`P6\n${w} ${h}\n255\n`), rgb]));
function readPPM(path) {
  const b = readFileSync(path);
  let i = 0;
  const f = [];
  while (f.length < 4) {
    let t = '';
    while (b[i] <= 32) i++;
    while (b[i] > 32) t += String.fromCharCode(b[i++]);
    f.push(t);
  }
  i++;
  const w = +f[1], h = +f[2];
  const data = new Uint8ClampedArray(w * h * 4);
  for (let k = 0; k < w * h; k++) {
    data[k * 4] = b[i + k * 3]; data[k * 4 + 1] = b[i + k * 3 + 1]; data[k * 4 + 2] = b[i + k * 3 + 2]; data[k * 4 + 3] = 255;
  }
  return { width: w, height: h, data };
}

let failed = 0;
for (const src of SOURCES) {
  for (const off of OFFSETS) {
    const cell = tagPitch(src.short) + off;
    if (cell < 1) continue;
    const app = off === 0;
    const wins = FEEDS.map(() => 0);
    for (const seedStart of SEEDS) {
      let seed = seedStart;
      const rnd = () => { seed = (seed * 1103515245 + 12345) >>> 0; return seed / 2 ** 32; };
      // A realistic payload: a setup built on a starting patch is ~30–100
      // bytes in the 'c' packing — an order-3 island.
      const payload = Uint8Array.from({ length: 30 + Math.floor(rnd() * 70) }, () => Math.floor(rnd() * 256));
      const tag = rasterize(encodeTag(payload), cell);
      const W = src.W;
      for (let fr = 0; fr < FRAMES; fr++) {
        const rgb = Buffer.alloc(W * H * 3);
        for (let y = 0; y < H; y++) {
          for (let x = 0; x < W; x++) {
            const o = (y * W + x) * 3;
            const v = 60 + 40 * Math.sin((x + fr * 9) / 23) * Math.cos((y - fr * 5) / 31) + rnd() * 60;
            rgb[o] = v + 30; rgb[o + 1] = v; rgb[o + 2] = v * 0.7;
          }
        }
        const ox = W - tag.width - 24, oy = H - tag.height - 24;   // bottom-right, as in the app
        for (let y = 0; y < tag.height; y++) {
          for (let x = 0; x < tag.width; x++) {
            for (let k = 0; k < 3; k++) rgb[((oy + y) * W + ox + x) * 3 + k] = tag.data[(y * tag.width + x) * 4 + k];
          }
        }
        ppm(join(dir, `f${String(fr).padStart(2, '0')}.ppm`), rgb, W, H);
      }
      FEEDS.forEach(({ s, crf }, i) => {
        const w = 2 * Math.round(src.W * s / src.short / 2);
        const vid = join(dir, 'v.mp4'), grab = join(dir, 'g.ppm');
        execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', '30', '-i', join(dir, 'f%02d.ppm'),
          '-vf', `scale=${w}:-2:flags=bicubic`, '-c:v', 'libx264', '-preset', 'medium', '-crf', String(crf),
          '-pix_fmt', 'yuv420p', vid]);
        execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', vid, '-vf', 'select=eq(n\\,5)', '-frames:v', '1', grab]);
        const out = readTag(readPPM(grab));
        if (out && out.length === payload.length && out.every((v, k) => v === payload[k])) wins[i]++;
      });
    }
    console.log(`\n${src.name}, ${cell}px a cell${app ? '   ← the app' : ''}`);
    FEEDS.forEach(({ s, crf, required }, i) => {
      const all = wins[i] === SEEDS.length;
      const mark = all ? 'PASS' : app && required ? 'FAIL' : 'miss';
      const scaleNote = `cells ${(cell * s / src.short).toFixed(2)}px in the feed`;
      console.log(`  [ ${mark} ]  → ${s}p crf ${crf}: ${wins[i]}/${SEEDS.length}  (${scaleNote})${required ? '' : '   (reported only)'}`);
      if (app && required && !all) failed++;
    });
  }
}
rmSync(dir, { recursive: true, force: true });
if (failed) {
  console.log(`\n${failed} failure(s) for the app's own tag`);
  process.exit(1);
}
console.log('\nThe app\'s tag survived every required recording.');
