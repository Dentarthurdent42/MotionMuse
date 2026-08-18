// Shepard tones — the endlessly-rising illusion, as pure maths.
//
// A Shepard tone is a stack of octave-spaced sine partials whose loudness is
// fixed in ABSOLUTE frequency rather than relative to the fundamental: a bell
// curve pinned to the middle of hearing. Slide the whole stack upward and each
// partial climbs into the fade-out at the top while a new one fades in at the
// bottom, so the pitch class rises continuously while the register never does.
// Cross a full octave and you are back exactly where you started, which is why
// the rise has no end.
//
// This is separate from engine.js and free of Web Audio on purpose: it is the
// part with the actual maths in it, and it is worth being able to test the
// spectrum without an AudioContext (see tests/unit/shepard.test.js).

// Partials span C1 upward. Seven octaves puts the top at ~2 kHz — high enough
// that a partial fading out there is genuinely leaving the useful range, low
// enough to stay clear of the sizzle where the illusion just sounds like noise.
export const SHEP_FMIN = 32.703;      // C1
export const SHEP_PARTIALS = 7;

// A raised cosine across the stack, NOT a Gaussian.
//
// A Gaussian is the textbook description and it is wrong here in a way you can
// hear: it never actually reaches zero, so at the top of the stack a partial
// still carrying real level simply vanishes as the sweep wraps, and a new one
// appears at the bottom at the same level. The first version of this used
// centre 3 / sigma 1.8, which left ~0.25 gain at the bottom edge — the wrap
// step was a hundred times larger than a normal step, and the test below caught
// it.
//
// A cosine bell is exactly zero at both ends by construction, so a partial has
// faded to nothing before it leaves and arrives from nothing. That makes the
// octave wrap seamless, which is the one property the illusion cannot do
// without.
const window = oct => 0.5 * (1 - Math.cos(2 * Math.PI * oct / SHEP_PARTIALS));

// The partials for a requested frequency.
//
// Only the PITCH CLASS of `hz` matters — its octave is deliberately discarded,
// because that is the whole trick: every octave of the same note produces an
// identical spectrum, so a rising sweep wraps seamlessly instead of running out
// of range. Returns [{ hz, gain }], gains summing to 1 so swapping a plain
// oscillator for a stack does not change how loud the voice is.
export function shepardPartials(hz) {
  if (!(hz > 0)) return [];
  // Fractional octave position within the stack, wrapped to [0, 1).
  const theta = ((Math.log2(hz / SHEP_FMIN) % 1) + 1) % 1;

  const out = [];
  let total = 0;
  for (let i = 0; i < SHEP_PARTIALS; i++) {
    const oct = i + theta;
    const gain = window(oct);
    out.push({ hz: SHEP_FMIN * Math.pow(2, oct), gain });
    total += gain;
  }
  if (total > 0) for (const p of out) p.gain /= total;
  return out;
}

// How many partials a voice needs to allocate. Fixed, so the node graph is
// built once and only its values change.
export const shepardVoiceSize = () => SHEP_PARTIALS;
