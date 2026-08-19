// Write build.json so the running app can say which commit it is.
//
//   node scripts/stamp.mjs
//
// Reads the commit from whichever CI is building — GITHUB_SHA on Actions,
// COMMIT_REF on Netlify — and falls back to asking git directly, so it also
// works when run by hand. build.json is generated, never committed: it is a
// property of a deploy, not of the source.
//
// Absent, src/build.js falls back to the Last-Modified header of index.html,
// so a host that never runs this still reports something useful.

import { writeFileSync } from 'fs';
import { execSync } from 'child_process';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const fromGit = () => {
  try { return execSync('git rev-parse HEAD', { cwd: ROOT }).toString().trim(); }
  catch { return null; }
};

const commit = process.env.GITHUB_SHA        // GitHub Actions
            ?? process.env.COMMIT_REF        // Netlify
            ?? fromGit()
            ?? 'unknown';

const stamp = { commit, built: new Date().toISOString() };
writeFileSync(join(ROOT, 'build.json'), JSON.stringify(stamp, null, 2) + '\n');
console.log(`build.json → ${commit.slice(0, 7)} @ ${stamp.built}`);
