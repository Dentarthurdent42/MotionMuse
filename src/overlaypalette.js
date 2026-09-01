// The camera overlay's skeleton palette, derived from the ACTIVE THEME.
//
// The overlay used to paint each hand in one hardcoded colour and the pose in
// another — three hexes that ignored the theme entirely and, within a
// skeleton, made every bone and joint the same mark. Both asks land here at
// once: the palette is derived from the theme's own accent tokens (which
// main.css authors in OKLCH), and it is derived INTO structure — a hue per
// finger, a lightness ramp along each chain — so joints and bones are
// tellable apart.
//
// Space: OKLab, in its polar OKLCH form. Not OKHSL/OKHSV — those renormalise
// lightness and saturation against the sRGB gamut's shape, so "the token's
// lightness, one step lighter" would stop being that the moment it was
// computed. The tokens are OKLCH; the derivation is OKLCH arithmetic (rotate
// h, step L, keep C); and what leaves this module is oklch() STRINGS handed
// straight to the canvas, so the browser renders the skeleton through the
// same code that renders the stylesheet. The palette cannot drift from the
// theme, because it never leaves the theme's colour space.
//
// Structure, per side (the side anchor is the theme accent that already
// identifies that hand — R = --cyan, L = --purple, whatever the theme has
// remapped those to; ember's "--cyan" is orange, and so is its right hand):
//
//   palm/web   the anchor itself — the hand's chassis keeps its side identity
//   fingers    the RAINBOW, thumb → pinky = red, yellow, green, blue, violet,
//              the same on both hands, at the theme's chroma and lightness.
//              The first cut spread each hand's hues around its own anchor —
//              every hand a monotonic sweep, and the pair of them illegible:
//              two sweeps starting from different anchors read as ten
//              assorted colours ("they just look random"). An ordering is
//              only an ordering if the viewer already knows it, and the
//              spectrum is the one hue order everyone arrives knowing.
//   ramp       along each chain, joints step through four lightnesses
//              (knuckle darkest → tip lightest) and bones take the midpoints,
//              so every joint also differs from the bones it connects.
//   arm        the pose's upper arm and forearm ramp the side anchor, darker
//              to lighter toward the wrist, where the palm takes over — the
//              arm flows into the hand it belongs to. With the fingers shared
//              between hands, the chassis and arms are what say L from R.
//
// The torso is the theme's --amber: furniture, one colour, deliberately not
// competing with the limbs.

import { themeToken } from './ui/theme.js';
import { parseColor } from './okcolor.js';

// The midnight tokens, for contexts with no stylesheet (tests, a detached
// canvas): the default theme's values, not a second design.
const FALLBACK = {
  cyan:   { L: 0.86, C: 0.130, h: 195 },
  purple: { L: 0.80, C: 0.150, h: 300 },
  amber:  { L: 0.86, C: 0.150, h: 80 },
};

// Thumb → pinky, in OKLab hue: red, yellow, green, blue, violet — increasing
// hue angle IS spectral order in OKLab, so "chromatic order" is checkable.
export const FINGER_HUES = [27, 97, 142, 245, 305];
// Knuckle → tip, in OKLab lightness around the ramp's base.
export const JOINT_RAMP = [-0.12, -0.04, 0.04, 0.12];
const BONE_RAMP = [-0.08, 0, 0.08];   // midpoints of the joint steps

// Where a chain's ramp is centred. The anchor's own L where it fits — but a
// ramp cannot be allowed to run off the top of the sRGB gamut, because up
// there chroma has nowhere to live and the browser's clip crushes the steps
// together: measured on the contrast theme's cyan (L 0.90), the two tip
// steps rendered ΔEok 0.003 apart — one colour wearing two names. Sliding
// the window down keeps every step a step; on high-L themes the TIP sits at
// the anchor's lightness and the chain reaches down from it.
const RAMP_TOP = 0.90, RAMP_BOT = 0.28;
const rampBase = L => Math.max(RAMP_BOT + 0.12, Math.min(RAMP_TOP - 0.12, L));
const clampL = v => Math.max(0.22, Math.min(0.95, v));
const okstr = (L, C, h, a = 1) =>
  a >= 1 ? `oklch(${clampL(L).toFixed(3)} ${C.toFixed(3)} ${Math.round(h * 10) / 10})`
         : `oklch(${clampL(L).toFixed(3)} ${C.toFixed(3)} ${Math.round(h * 10) / 10} / ${a})`;

// Pure: tokens in, palette out — what the unit tests measure. `tokens` are
// the raw CSS token strings ({ cyan, purple, amber }).
export function buildPalette(tokens = {}) {
  const anchor = {
    R: parseColor(tokens.cyan)   ?? FALLBACK.cyan,
    L: parseColor(tokens.purple) ?? FALLBACK.purple,
  };
  const amber = parseColor(tokens.amber) ?? FALLBACK.amber;

  const side = {};
  for (const s of ['L', 'R']) {
    const A = anchor[s];
    const base = rampBase(A.L);
    side[s] = {
      // The chassis wears the anchor's hue at HALF its chroma: side identity
      // without competing. At full chroma the middle finger's centre bone —
      // which sits exactly on the anchor hue — measured ΔEok 0.000 from the
      // palm: the same colour twice, on a feature whose whole job is telling
      // marks apart. Muting the palm is what gives the fingers the stage.
      // …and its lightness sits clearly BELOW the whole finger ramp. Chroma
      // alone cannot be trusted to separate palm from bones: several themes
      // author accents at the sRGB gamut edge (sepia's cyan among them), and
      // there the browser's clip eats most of a chroma difference — a raw
      // ΔEok 0.068 pair rendered at 0.029. Lightness survives clipping, so
      // the chassis is the darkest thing on the hand, 0.06 under the deepest
      // knuckle, and the fingers rise out of it.
      palm: okstr(base - 0.14, A.C * 0.5, A.h),
      web:  okstr(base - 0.14, A.C * 0.5, A.h, 0.6),
      fingers: FINGER_HUES.map(h => ({
        joints: JOINT_RAMP.map(d => okstr(base + d, A.C, h)),
        bones:  BONE_RAMP.map(d => okstr(base + d, A.C, h, 0.78)),
      })),
      upperArm: okstr(base - 0.08, A.C, A.h, 0.85),
      forearm:  okstr(base + 0.08, A.C, A.h, 0.85),
      elbow:    okstr(base + 0.08, A.C, A.h),
      wrist:    okstr(base - 0.14, A.C * 0.5, A.h),
    };
  }
  return {
    side,
    shoulder:  okstr(amber.L, amber.C, amber.h),
    torsoBone: okstr(amber.L, amber.C, amber.h, 0.55),
  };
}

// Theme-following accessor for the overlay. Rebuilt only when the tokens'
// values actually change — setTheme() clears themeToken's cache, so the first
// frame after a switch reads new strings and the key stops matching.
let cache = null, cacheKey = null;
export function overlayPalette() {
  const cyan   = themeToken('--cyan',   'oklch(0.86 0.130 195)');
  const purple = themeToken('--purple', 'oklch(0.80 0.150 300)');
  const amber  = themeToken('--amber',  'oklch(0.86 0.150 80)');
  const key = `${cyan}|${purple}|${amber}`;
  if (key !== cacheKey) { cache = buildPalette({ cyan, purple, amber }); cacheKey = key; }
  return cache;
}
