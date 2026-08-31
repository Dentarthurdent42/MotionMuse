// The skeleton palette: derived from the ACTIVE THEME, and provably
// distinguishable.
//
// Two asks from playing, together: "color-code the skeletons such that their
// joints and bones are distinguishable from each other" and "make them blend
// as part of the chosen theme setting". The palette answers both by deriving
// per-finger hues and per-chain lightness ramps FROM the theme's own OKLCH
// accent tokens — so these tests read the real tokens out of css/main.css and
// measure the result, for every theme that exists and every theme anyone adds.
//
// "Distinguishable" is measured, not asserted: pairwise ΔEok between the
// colours as the browser will RENDER them. That last word is where the two
// bugs these floors caught actually lived — a middle-finger bone that was the
// palm's exact colour, and ramp steps that a high-lightness theme's gamut
// clipping crushed to ΔEok 0.003 apart.
//
// Run: npm run test:unit

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

globalThis.localStorage ??= {
  getItem: () => null, setItem: () => {}, removeItem: () => {},
};

const { buildPalette, FINGER_HUES } = await import('../../src/overlaypalette.js');
const { parseColor, oklchToHex, hexToOklab, oklabDist, srgbToOklab } =
  await import('../../src/okcolor.js');

const HERE = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(join(HERE, '../../css/main.css'), 'utf8');

// Every theme's accent tokens, straight from the stylesheet — a palette test
// against copies of the tokens is a test that goes stale the day a theme is
// retuned.
const THEMES = {};
for (const m of css.matchAll(/:root\[data-theme="([a-z]+)"\]\s*\{([^}]+)\}/g)) {
  const tok = t => (new RegExp(`--${t}:\\s*([^;]+);`).exec(m[2]) || [])[1]?.trim();
  if (tok('cyan')) THEMES[m[1]] = { cyan: tok('cyan'), purple: tok('purple'), amber: tok('amber') };
}

// What the browser paints for an oklch() string (okcolor.js's conversion is
// verified against Chrome's canvas — raw conversion, channels clipped).
const rendered = str => {
  const c = parseColor(str);
  return hexToOklab(oklchToHex(c.L, c.C, c.h));
};

// Floors, from measurement: the worst within-hand pair across all five themes
// sits at 0.057 and the worst adjacent ramp step at 0.058 — both about three
// times the ~0.02 just-noticeable difference. The floors sit under those with
// margin for a retuned theme, and well above the JND.
const PAIR_FLOOR = 0.045;
const RAMP_FLOOR = 0.045;
const CROSS_FLOOR = 0.08;

test('the stylesheet actually yielded themes to test', () => {
  assert.ok(Object.keys(THEMES).length >= 5, Object.keys(THEMES).join(','));
  for (const t of Object.values(THEMES)) {
    assert.ok(parseColor(t.cyan) && parseColor(t.purple) && parseColor(t.amber));
  }
});

for (const [name, tokens] of Object.entries(THEMES)) {
  test(`${name}: every mark on a hand is tellable from every other`, () => {
    const p = buildPalette(tokens);
    for (const s of ['L', 'R']) {
      const S = p.side[s];
      const marks = [['palm', S.palm]];
      S.fingers.forEach((f, i) => f.bones.forEach((b, k) => marks.push([`finger${i}·bone${k}`, b])));
      for (let i = 0; i < marks.length; i++) {
        for (let j = i + 1; j < marks.length; j++) {
          const d = oklabDist(rendered(marks[i][1]), rendered(marks[j][1]));
          assert.ok(d >= PAIR_FLOOR,
            `${s} ${marks[i][0]} ~ ${marks[j][0]} render ΔEok ${d.toFixed(3)} < ${PAIR_FLOOR}`);
        }
      }
    }
  });

  test(`${name}: each chain's joints step visibly toward the tip`, () => {
    const p = buildPalette(tokens);
    for (const s of ['L', 'R']) {
      p.side[s].fingers.forEach((f, i) => {
        for (let k = 0; k < 3; k++) {
          const a = rendered(f.joints[k]), b = rendered(f.joints[k + 1]);
          assert.ok(oklabDist(a, b) >= RAMP_FLOOR,
            `${s} finger${i} step ${k}→${k + 1} ΔEok ${oklabDist(a, b).toFixed(3)}`);
          // …and toward, not merely apart: the ramp must actually get lighter,
          // or "lighter means closer to the tip" stops being readable.
          assert.ok(b.L > a.L, `${s} finger${i} step ${k}→${k + 1} got darker`);
        }
      });
    }
  });

  test(`${name}: the two hands stay tellable apart`, () => {
    const p = buildPalette(tokens);
    const d = oklabDist(rendered(p.side.L.palm), rendered(p.side.R.palm));
    assert.ok(d >= CROSS_FLOOR, `palms ΔEok ${d.toFixed(3)}`);
  });

  test(`${name}: the palette IS this theme — anchors carry the tokens' hues`, () => {
    const p = buildPalette(tokens);
    const hueOf = str => parseColor(str).h;
    const near = (a, b) => Math.abs(((a - b + 540) % 360) - 180) < 1;
    assert.ok(near(hueOf(p.side.R.palm), parseColor(tokens.cyan).h), 'R chassis = --cyan hue');
    assert.ok(near(hueOf(p.side.L.palm), parseColor(tokens.purple).h), 'L chassis = --purple hue');
    assert.ok(near(hueOf(p.shoulder), parseColor(tokens.amber).h), 'torso = --amber hue');
  });

  test(`${name}: fingers run the spectrum, thumb to pinky, on both hands alike`, () => {
    // "Maybe color the fingers in chromatic order? they just look random
    // currently" — the first cut anchored each hand's hues to its own theme
    // accent, which made every hand a monotonic sweep and the pair of them
    // illegible. Chromatic order in OKLab is increasing hue angle, so it is
    // exactly assertable — and it must be the SAME rainbow on both hands, or
    // it is two orderings pretending to be one.
    const p = buildPalette(tokens);
    const hueOf = str => parseColor(str).h;
    for (const s of ['L', 'R']) {
      const hues = p.side[s].fingers.map(f => hueOf(f.joints[0]));
      for (let i = 0; i < 4; i++) {
        assert.ok(hues[i] < hues[i + 1],
          `${s} finger ${i} (${hues[i]}°) should precede finger ${i + 1} (${hues[i + 1]}°)`);
      }
      assert.deepEqual(hues, FINGER_HUES, `${s} wears the shared rainbow`);
    }
  });
}

test('switching themes actually recolours the skeleton', () => {
  const a = buildPalette(THEMES.midnight);
  const b = buildPalette(THEMES.ember);
  // ember's "--cyan" slot holds orange, so the right hand must follow it there.
  const d = oklabDist(rendered(a.side.R.palm), rendered(b.side.R.palm));
  assert.ok(d > 0.1, `midnight vs ember right palm ΔEok ${d.toFixed(3)}`);
});

test('missing tokens fall back to the default theme, not to black', () => {
  const p = buildPalette({});
  assert.ok(p.side.L.palm.startsWith('oklch(') && p.side.R.fingers.length === 5);
});

// ── The conversion the measurements above stand on ──

test('okcolor round-trips hex through OKLab exactly', () => {
  for (const hx of ['#9d5cff', '#00e5cc', '#f0a500', '#123456', '#ffffff', '#000000']) {
    const o = hexToOklab(hx);
    const C = Math.hypot(o.a, o.b);
    const h = ((Math.atan2(o.b, o.a) * 180) / Math.PI + 360) % 360;
    assert.equal(oklchToHex(o.L, C, h), hx);
  }
});

test('oklchToHex matches the browser, in and out of gamut', () => {
  // Pinned from a 192-case sweep against Chrome's canvas: in-gamut exact,
  // out-of-gamut resolved by per-channel clip (NOT css-color-4 chroma
  // mapping, which disagreed with the browser by up to ΔEok 0.22).
  assert.equal(oklchToHex(0.86, 0.13, 195), '#4aebeb');
  assert.equal(oklchToHex(0.9, 0.3, 0), '#ff68d6');
  const clipish = oklchToHex(0.5, 0.4, 195);
  assert.ok(oklabDist(hexToOklab(clipish), hexToOklab('#0091a9')) < 0.004, clipish);
});

test('parseColor reads the forms the tokens are written in', () => {
  assert.deepEqual(parseColor('oklch(0.86 0.130 195)'), { L: 0.86, C: 0.13, h: 195 });
  assert.deepEqual(parseColor('oklch(0.49 0.110 205 / 0.14)'), { L: 0.49, C: 0.11, h: 205 });
  assert.deepEqual(parseColor('oklch(86% 0.130 195)'), { L: 0.86, C: 0.13, h: 195 });
  const hx = parseColor('#9d5cff');
  assert.ok(Math.abs(hx.L - srgbToOklab(0x9d / 255, 0x5c / 255, 0xff / 255).L) < 1e-9);
  assert.equal(parseColor('nonsense'), null);
  assert.equal(parseColor(''), null);
});
