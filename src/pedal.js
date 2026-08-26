// The pedal.
//
// A loop pedal is a foot switch because the player's hands are busy. Here they
// are busier than that — the hands ARE the instrument — so the switch is a
// sharp nod, or a flick of the eyebrows. Both are things you can do without
// interrupting what you are playing, which is the entire requirement.
//
// It reads a VELOCITY signal rather than a position, and that is what makes it
// usable. A head held low is a pose you might hold for a bar; a head that moves
// down FAST is a deliberate stab that nothing else about playing produces. The
// same distinction saves the eyebrow option: `brow_raise` is a mapped control
// in two of the shipped presets, so triggering on a raised brow would fire
// every time somebody played a high note — while a brow *flick* is a transient
// that a sustained raise never reaches.
//
// Hysteresis and a refractory window sit on top: one nod is one press, however
// many frames it spans, and a bounce on the way back up is not a second one.

import { bus } from './bus.js';

export const PEDAL_SOURCES = {
  // `nose_y` rises as the head dips (see cv.js), so a nod is a POSITIVE spike.
  // Pose-derived, which means the pedal works with just the camera — no face
  // model needed for the default.
  nod:  { key: 'nose_y_vel',     label: 'NOD',   group: 'pose', hint: 'Dip your head sharply' },
  brow: { key: 'brow_raise_vel', label: 'BROWS', group: 'face', hint: 'Flick your eyebrows up' },
};

export const DEFAULT_PEDAL = 'nod';

// Spans of the source signal per second. A deliberate nod moves the nose
// through perhaps a sixth of the frame in a sixth of a second — about 1.0 —
// and ordinary playing rarely passes 0.5, so this sits above the noise with
// room to spare. Adjustable, because necks differ and so do cameras.
export const DEFAULT_SENSITIVITY = 1.2;

// Re-arming needs the signal back under a fraction of the threshold: the head
// coming back up produces an equal spike the other way, and without this the
// return stroke would be read as a second press.
const REARM_FRACTION = 0.35;

// Nothing legitimate presses a pedal twice inside this. It also covers the
// overshoot at the bottom of a nod, which crosses the threshold again as the
// neck springs back.
const REFRACTORY_MS = 700;

export function makePedal({ source = DEFAULT_PEDAL, sensitivity = DEFAULT_SENSITIVITY } = {}) {
  let armed = true;
  let lastFire = -Infinity;
  return {
    source, sensitivity,
    // The live reading, 0–1 against the threshold, so a panel can show how
    // close a movement came. Calibrating by "it didn't work" is not calibrating.
    reading() {
      const sig = PEDAL_SOURCES[this.source];
      const v = sig ? (bus.signals.get(sig.key)?.value ?? 0) : 0;
      return Math.max(0, Math.min(1, v / this.sensitivity));
    },
    // Returns true on the frame the pedal goes down. `now` is injected so the
    // timing is testable without a clock.
    tick(now = performance.now()) {
      const sig = PEDAL_SOURCES[this.source];
      if (!sig) return false;
      const v = bus.signals.get(sig.key)?.value ?? 0;
      if (!armed) {
        if (v < this.sensitivity * REARM_FRACTION) armed = true;
        return false;
      }
      if (v < this.sensitivity) return false;
      armed = false;
      if (now - lastFire < REFRACTORY_MS) return false;
      lastFire = now;
      return true;
    },
    reset() { armed = true; lastFire = -Infinity; },
  };
}
