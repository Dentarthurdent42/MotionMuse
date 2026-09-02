# Vendored libraries

Third-party code the app loads at runtime, bundled from node_modules by
`scripts/vendor.mjs` (`npm run vendor`). Each file is one ES module the
browser imports directly; nothing here is hand-edited. Versions and licences
are read from the packages at bundle time.

## lit-html.js

Templating for the node workspace: keyed, incremental DOM updates in place of innerHTML rebuilds.

- **lit-html** 3.3.1 — BSD-3-Clause — https://lit.dev/

## d3-zoom.js

Pan and zoom of the workspace viewport — wheel, pinch, touch and programmatic transforms with transitions.

- **d3-zoom** 3.0.0 — ISC — https://d3js.org/d3-zoom/
- **d3-selection** 3.0.0 — ISC — https://d3js.org/d3-selection/
- **d3-transition** 3.0.1 — ISC — https://d3js.org/d3-transition/

## dagre.js

Layered graph layout behind the workspace’s TIDY button.

- **@dagrejs/dagre** 1.1.5 — MIT — 

