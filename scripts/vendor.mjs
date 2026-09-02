// Bundle the third-party libraries the app runs on into vendor/, as plain ES
// modules the browser loads directly.
//
//   node scripts/vendor.mjs
//
// The site is the repository: there is no build step between a commit and a
// deploy (see netlify.toml), and every module is loaded by the browser from
// the path it is committed at. A dependency therefore cannot be a bare `import
// 'lit-html'` resolved out of node_modules at build time — there is no build
// time. Instead each library is bundled ONCE, here, into a single-file ES
// module under vendor/ that is committed like any other source file and
// precached by the service worker like any other module.
//
// esbuild rather than a hand copy because these packages are many files with
// relative imports between them (lit-html's directives, d3-zoom's four
// sibling packages), and a bundle is the only honest way to get one file per
// library that resolves nothing at runtime.
//
// Re-run after bumping a version in package.json; vendor/LICENSES.md lists
// what is inside and under which terms.

import { build } from 'esbuild';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT  = join(ROOT, 'vendor');
mkdirSync(OUT, { recursive: true });

const pkg = name => JSON.parse(readFileSync(join(ROOT, 'node_modules', name, 'package.json'), 'utf8'));

// One entry per bundle: the packages it re-exports, and what for.
const BUNDLES = [
  {
    file: 'lit-html.js',
    packages: ['lit-html'],
    why: 'Templating for the node workspace: keyed, incremental DOM updates in place of innerHTML rebuilds.',
    entry: `export { html, svg, render, nothing } from 'lit-html';
            export { repeat } from 'lit-html/directives/repeat.js';
            export { classMap } from 'lit-html/directives/class-map.js';
            export { styleMap } from 'lit-html/directives/style-map.js';
            export { live } from 'lit-html/directives/live.js';
            export { ref, createRef } from 'lit-html/directives/ref.js';`,
  },
  {
    file: 'd3-zoom.js',
    packages: ['d3-zoom', 'd3-selection', 'd3-transition'],
    why: 'Pan and zoom of the workspace viewport — wheel, pinch, touch and programmatic transforms with transitions.',
    entry: `export { zoom, zoomIdentity, zoomTransform } from 'd3-zoom';
            export { select } from 'd3-selection';
            import 'd3-transition';`,
  },
  {
    file: 'dagre.js',
    packages: ['@dagrejs/dagre'],
    why: 'Layered graph layout behind the workspace’s TIDY button.',
    entry: `import dagre from '@dagrejs/dagre'; export default dagre; export const { graphlib, layout } = dagre;`,
  },
];

let licenses = `# Vendored libraries

Third-party code the app loads at runtime, bundled from node_modules by
\`scripts/vendor.mjs\` (\`npm run vendor\`). Each file is one ES module the
browser imports directly; nothing here is hand-edited. Versions and licences
are read from the packages at bundle time.

`;

for (const b of BUNDLES) {
  await build({
    stdin: { contents: b.entry, resolveDir: ROOT, loader: 'js' },
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: ['es2022'],
    minify: true,
    legalComments: 'none',
    outfile: join(OUT, b.file),
    logLevel: 'warning',
  });
  licenses += `## ${b.file}\n\n${b.why}\n\n`;
  for (const name of b.packages) {
    const p = pkg(name);
    licenses += `- **${name}** ${p.version} — ${p.license} — ${p.homepage ?? ''}\n`;
  }
  licenses += '\n';
  console.log(`vendor/${b.file}`);
}

writeFileSync(join(OUT, 'LICENSES.md'), licenses);
