// Every module the app imports must be in the service worker's precache list.
//
// This drifted for twelve modules before anyone noticed, and the failure is
// invisible in development: online, the fetch handler falls through to the
// network and everything works. It only shows up offline — on the one load the
// PWA install exists for — as an app that boots to a blank page because a
// module it needs was never cached.
//
// A list maintained by hand cannot keep up with a directory. This is the check
// that makes adding a file to one require adding it to the other.
//
// Run: npm run test:unit

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const sw = readFileSync(join(ROOT, 'sw.js'), 'utf8');

const jsIn = dir => readdirSync(join(ROOT, dir))
  .filter(f => f.endsWith('.js'))
  .map(f => `/${dir}/${f}`);

const modules = [...jsIn('src'), ...jsIn('src/ui')];

test('the precache list names every module in src/', () => {
  const missing = modules.filter(m => !sw.includes(`'${m}'`));
  assert.deepEqual(missing, [],
    `not precached, so an offline load would fail on them: ${missing.join(', ')}`);
});

test('the precache list names nothing that no longer exists', () => {
  // The other direction: a stale entry makes install() fetch a 404, and a
  // failed precache rejects the whole install — so one deleted file left in
  // the list stops the service worker updating at all.
  const listed = [...sw.matchAll(/'(\/src\/[^']+\.js)'/g)].map(m => m[1]);
  const gone = listed.filter(p => !modules.includes(p));
  assert.deepEqual(gone, [], `listed but missing from disk: ${gone.join(', ')}`);
});

test('the app shell and stylesheet are precached', () => {
  for (const p of ['/index.html', '/css/main.css', '/manifest.json'])
    assert.ok(sw.includes(`'${p}'`), `${p} is not precached`);
});
