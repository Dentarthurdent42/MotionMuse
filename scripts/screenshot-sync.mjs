// Keep docs/screenshot.png — the README hero — matching the UI it depicts.
//
//   node scripts/screenshot-sync.mjs           refresh the shot if the UI moved
//   node scripts/screenshot-sync.mjs --check    report only, exit 1 if stale
//   node scripts/screenshot-sync.mjs --hook     as the default, emitting hook JSON
//
// "Whenever the UI changes" is not a question a source diff can answer: most
// edits under src/ change nothing you can see, and re-shooting for those would
// rewrite a 370 KB binary on every commit. So the source hash is only a cheap
// *first* gate — it says "a re-render is worth doing", not "the picture
// changed". The picture is then rendered and compared to the committed one, and
// the file is only rewritten if they actually differ. The comparison ignores
// the oscilloscope box (see lib/capture.mjs), which is live animation rather
// than layout and never matches between two runs.
//
// The hash lives in a gitignored cache, not in the repo: it is a memo saying
// "this source state was already checked", so nothing is committed that would
// itself need keeping in sync. A fresh clone just pays for one render.

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, mkdirSync } from 'fs';
import { join, relative, sep } from 'path';
import { createHash } from 'crypto';
import { capture, ROOT, SHOT } from './lib/capture.mjs';

// Anything that can change what the page looks like. Deliberately wider than
// "the UI files": the shot loads the default patch, so a preset or mapper edit
// shows up in it too. Over-inclusion costs a render that finds nothing;
// under-inclusion ships a stale picture, which is the failure this exists to
// prevent.
const SOURCES = ['index.html', 'css', 'src', 'scripts/screenshot.mjs', 'scripts/lib/capture.mjs'];
const CACHE   = join(ROOT, '.screenshot-cache');

// Two renders of an unchanged UI differ by exactly zero pixels outside the
// oscilloscope box — measured, not assumed — so this is slack rather than a
// tolerance. 64 device pixels is a 4x4 CSS-pixel patch: below anything a person
// could point at, above a stray pixel triggering a 370 KB rewrite.
const MIN_CHANGED = 64;

const walk = p => {
  const st = statSync(p);
  if (st.isFile()) return [p];
  return readdirSync(p).sort().flatMap(n => walk(join(p, n)));
};

function sourceHash() {
  const h = createHash('sha256');
  for (const s of SOURCES) {
    const abs = join(ROOT, s);
    if (!existsSync(abs)) continue;
    for (const f of walk(abs)) {
      h.update(relative(ROOT, f).split(sep).join('/'));
      h.update('\0');
      h.update(createHash('sha256').update(readFileSync(f)).digest());
    }
  }
  return h.digest('hex');
}

const mode  = process.argv.includes('--check') ? 'check'
            : process.argv.includes('--hook')  ? 'hook' : 'sync';
const emit  = o => { if (mode === 'hook') console.log(JSON.stringify(o)); else if (o.message) console.log(o.message); };

const hash = sourceHash();
const memo = existsSync(CACHE) ? readFileSync(CACHE, 'utf8').trim() : '';

// Nothing that feeds the picture has moved since the last check. This is the
// case on almost every run, and it must stay free — the hook fires on every
// turn, including the ones that never touch this project's UI.
if (mode !== 'check' && memo === hash && existsSync(SHOT)) process.exit(0);
if (mode === 'check' && memo === hash && existsSync(SHOT)) {
  emit({ message: 'docs/screenshot.png: up to date (sources unchanged since last check)' });
  process.exit(0);
}

const before = existsSync(SHOT) ? readFileSync(SHOT) : null;
const { png, diff } = await capture({ compareTo: before ?? undefined });

const changed = !before || diff.sizeChanged || diff.changed >= MIN_CHANGED;

if (!changed) {
  if (mode !== 'check') writeFileSync(CACHE, hash);
  emit({ message: `docs/screenshot.png: still accurate (${diff.changed} pixels differ, under the ${MIN_CHANGED}-pixel floor)` });
  process.exit(0);
}

const why = diff?.sizeChanged ? 'the viewport no longer matches'
          : `${diff.changed} pixels differ (${(100 * diff.changed / Math.max(1, diff.total)).toFixed(2)}% of the picture)`;

if (mode === 'check') {
  console.error(`docs/screenshot.png is stale — ${why}. Run: npm run screenshot`);
  process.exit(1);
}

mkdirSync(join(ROOT, 'docs'), { recursive: true });
writeFileSync(SHOT, png);
writeFileSync(CACHE, hash);

const note = `The UI changed (${why}), so docs/screenshot.png — the README hero — was regenerated. `
           + 'Commit it alongside the change that moved it.';

if (mode === 'hook') {
  // Blocking rather than merely reporting: the alternative is a regenerated
  // binary left uncommitted in the tree, which is a worse outcome than one
  // extra turn. Only ever fires once per source change — the cache is written
  // above, so the next stop is a free hit.
  console.log(JSON.stringify({ decision: 'block', reason: note, systemMessage: 'docs/screenshot.png regenerated — the UI changed.' }));
} else {
  console.log(note);
}
