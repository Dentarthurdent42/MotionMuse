// Shared "is this a desktop-sized window" check, kept in sync with the
// `@media (min-width: 1200px)` desktop breakpoint in css/main.css. A few
// canvases (piano keyboards, the game highway, the oscilloscope) draw at a
// JS-specified pixel size rather than reading their CSS box size, so their
// larger desktop dimensions have to be picked in JS to match the CSS bump —
// this is the one number both sides agree on.
export const DESKTOP_MIN_WIDTH = 1200;
export const isDesktop = () => window.innerWidth >= DESKTOP_MIN_WIDTH;
