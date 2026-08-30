// Hand-gesture recognition. A gesture is a template over the 12 normalized
// hand features the CV source publishes per hand: five finger extensions,
// openness, spread, how far the thumb is carried from the palm, and the four
// thumb-to-fingertip contacts. Recognition is nearest-template matching with
// per-feature weights, a distance threshold, frame debounce, and hysteresis
// so a held pose doesn't flicker.
//
// Built-in gestures ship as templates; the user records custom ones (or
// recalibrates the built-ins) by holding a pose while ~10 frames of live
// features are averaged. Every gesture is also published as a bus signal
// (`gesture_<id>`, 0/1-ish), so gestures can drive ordinary mappings too.

import { bus } from './bus.js';

export const FEATURES = [
  'thumb', 'index', 'middle', 'ring', 'pinky',   // finger extension
  'open', 'spread',                              // whole-hand shape
  'thumbOut',                                    // thumb carried clear of the palm
  'cIndex', 'cMiddle', 'cRing', 'cPinky',        // thumb-to-fingertip contact
];

// Not every channel is equally informative, and an unweighted metric lets the
// useless ones drown out the decisive ones. Measured spans across the
// reference photos justify these:
//   - `thumb` was nearly pure noise while extension was a distance: the
//     thumb's base-to-tip span barely changes as it moves, so it covered a
//     0.09 range in total. As a joint angle it earns its place — a tucked
//     thumb reads ~0.45 against ~0.90 carried clear — but the weight is left
//     low because `thumbOut` already says where the thumb is, more directly.
//   - `spread` turned out to be unpredictable (a peace sign measured *lower*
//     spread than a fist), so it gets a light vote.
//   - the contacts are what separate the ASL number handshapes at all, so
//     they get the loudest.
export const WEIGHTS = [0.25, 1, 1, 1, 1, 0.7, 0.4, 1.1, 1.2, 1.2, 1.2, 1.2];

// Value assumed for a channel a template doesn't carry. Templates recorded
// before the vector grew are padded with these on load rather than being left
// short — a short template used to produce a NaN distance, which silently made
// it unmatchable forever instead of failing loudly. (The padded channels are
// also masked out of the metric — see masks below — so these values never
// actually influence a match; they only keep the arrays rectangular.)
export const NEUTRAL = [0.40, 0.5, 0.5, 0.5, 0.5, 0.6, 0.3, 0.3, 0, 0, 0, 0];

export const padTemplate = f =>
  FEATURES.map((_, i) => Number.isFinite(f?.[i]) ? f[i] : NEUTRAL[i]);

// ── Don't-care masks ──────────────────────────────────────────────────────
//
// A template also declares WHICH channels define its shape. This exists
// because the first field reports came back "everything reads as point, or
// nothing": each template was demanding a match on channels that are
// *incidental* to its pose. The fist reference photo happened to have the
// thumb wrapped over the fingers (contact readings 0.95/0.90) — a live fist
// with the thumb resting beside them reads ~0.2 and sailed past the match
// threshold. The peace photo happened to have its thumb extended. None of the
// classic gestures are ABOUT where the thumb tip sits, so none of them should
// pay a penalty for it; conversely ASL 6–9 are about exactly that, so for
// them the contacts carry the match.
//
// Masks multiply the channel weights per template; distance is normalized by
// the cared weight (see templateDistance), so a template that cares about
// fewer channels isn't cheaper to match — its distance is an RMS over the
// channels it does care about, on the same scale for every template.
const care = (except = []) => FEATURES.map(f => (except.includes(f) ? 0 : 1));
const CONTACTS = ['cIndex', 'cMiddle', 'cRing', 'cPinky'];
export const maskFromLength = len => FEATURES.map((_, i) => (i < len ? 1 : 0));

// ── Built-in templates ────────────────────────────────────────────────────
//
// Every shape with a reference photo in tests/gesture-img is *measured*:
// MediaPipe run over the photo, features read straight out of math.js. That is
// now the classics and the whole ASL numeral set, 1 through 10. Run
// `npm run test:gesture-img -- --calibrate` to reprint them.
//
// Shapes photographed twice — once in a stock photo at arm's length, once on
// another hand up close — are the AVERAGE of both measurements. They are the
// same handshape, so a template that only fits one framing of it is a template
// fitted to a camera rather than to a shape.
//
// `horns`, `gun` and `asl0` still have no reference photo, so they keep the
// small geometric model: each shape described by which fingers are extended
// and where the thumb sits, run through the real feature formulas. Good
// starting points, not ground truth — hands differ, so they are worth
// recalibrating (Gestures → CALIBRATE) to fit your own, and stay flagged in
// the UI until you do.
//
// Distances below are in palm lengths (wrist → middle-finger MCP), the same
// unit math.js normalizes by. Reference values, all measured:
//   thumb tucked, fingers curled, thumb wrapped over them   0.20 0.22 0.40 0.58
//   thumb tucked beside the palm, fingers curled            0.50 0.52 0.56 0.63
//   thumb tucked, fingers extended                          1.03 1.15 1.25 1.35
//   thumb clear, fingers curled                             0.91 1.07 1.24 1.42
//   thumb clear, fingers extended                           1.98 2.01 2.05 2.10
//   pads actually touching                                  0.15
// Extension is NOT one of them: it is a joint angle now (math.js), so it has
// no distance to model. Its levels, measured: a straight finger reads ~0.93,
// one folded into the palm ~0.00–0.20, and the loose half-curl of a peace
// sign's ring finger ~0.40. Openness by extended-finger count:
// 0.38 0.50 0.70 0.80 0.87 0.92. Spread is always thumb↔pinky distance / 2.5.
const BUILTINS = [
  // id        name              ASL   f = [thumb,index,middle,ring,pinky, open,spread, thumbOut, cIdx,cMid,cRing,cPinky]
  //
  // Masks (`m`): the classic shapes ignore the contact channels — where the
  // thumb tip happens to rest against curled fingers varies hand to hand and
  // is not what makes a fist a fist. `peace` additionally ignores thumbOut:
  // its photo was shot thumb-extended, but ASL 2 is the same shape thumb-
  // tucked, and both must read as peace. The contact-defined numbers (0/6-9)
  // care about every contact; 3 and 4 are extension/thumb shapes like the
  // classics.
  { id: 'fist',   name: 'Fist',       asl: 'S',  canned: 'Closed_Fist', m: care(CONTACTS),
    f: [0.36, 0.20, 0.04, 0.00, 0.06, 0.40, 0.23, 0.04, 0.95, 0.90, 0.19, 0.00] },
  { id: 'point',  name: 'Point',      asl: '1',  canned: 'Pointing_Up', m: care(CONTACTS),
    f: [0.59, 0.94, 0.28, 0.22, 0.36, 0.49, 0.28, 0.08, 0.00, 0.28, 0.00, 0.00] },
  { id: 'peace',  name: 'Peace',      asl: '2',  canned: 'Victory', m: care([...CONTACTS, 'thumbOut']),
    f: [0.60, 0.92, 0.88, 0.39, 0.34, 0.65, 0.22, 0.50, 0.00, 0.00, 0.26, 0.00] },
  { id: 'thumbs', name: 'Thumbs Up',  asl: '10', canned: 'Thumb_Up', m: care(CONTACTS),
    f: [0.85, 0.21, 0.00, 0.00, 0.01, 0.51, 0.85, 1.00, 0.00, 0.00, 0.00, 0.00] },
  { id: 'palm',   name: 'Open Palm',  asl: '5', canned: 'Open_Palm', m: care(CONTACTS),
    f: [0.90, 0.92, 0.90, 0.90, 0.94, 0.77, 0.87, 1.00, 0.00, 0.00, 0.00, 0.00] },
  { id: 'horns',  name: 'Rock Horns', est: true, m: care(CONTACTS),
    f: [0.30, 0.93, 0.05, 0.05, 0.93, 0.70, 0.54, 0.04, 0.00, 0.00, 0.00, 0.00] },
  // Thumb and index extended, the rest curled — the ASL "L" handshape.
  // Derived from `point` (same one extended finger) with the thumb carried
  // clear, which is measured on `thumbs`: thumbOut 0.89 and spread 0.57 both
  // come from there. Openness sits just above point's 0.50 because the thumb
  // counts for less than a finger (thumbs, with no fingers extended, reads
  // 0.35 against the 0.38 of a closed hand). thumbOut is what separates it
  // from point, and the extended index is what separates it from thumbs.
  { id: 'gun',    name: 'Finger Gun', asl: 'L', est: true, m: care(CONTACTS),
    f: [0.90, 0.93, 0.05, 0.05, 0.05, 0.55, 0.55, 0.85, 0.00, 0.00, 0.00, 0.00] },
  // ASL numbers. 1, 2, 5 and 10 are the shapes above — one template each, with
  // both a descriptive name and the numeral, rather than duplicates that would
  // sit on top of each other and make the match a coin toss.
  { id: 'asl3',   name: 'Three',      asl: '3', m: care(CONTACTS),
    f: [0.89, 0.92, 0.91, 0.52, 0.52, 0.65, 0.70, 1.00, 0.00, 0.00, 0.00, 0.00] },
  { id: 'asl4',   name: 'Four',       asl: '4', m: care(CONTACTS),
    f: [0.48, 0.93, 0.88, 0.86, 0.93, 0.70, 0.28, 0.02, 0.00, 0.00, 0.00, 0.00] },
  { id: 'asl6',   name: 'Pinky Touch',asl: '6', m: care(),
    f: [0.58, 0.93, 0.88, 0.84, 0.39, 0.66, 0.04, 0.28, 0.00, 0.00, 0.00, 1.00] },
  { id: 'asl7',   name: 'Ring Touch', asl: '7', m: care(),
    f: [0.61, 0.94, 0.91, 0.40, 0.91, 0.67, 0.26, 0.25, 0.00, 0.00, 1.00, 0.00] },
  { id: 'asl8',   name: 'Middle Touch', asl: '8', m: care(),
    f: [0.67, 0.93, 0.37, 0.90, 0.93, 0.72, 0.54, 0.65, 0.00, 0.55, 0.00, 0.00] },
  { id: 'asl9',   name: 'Index Touch', asl: '9', m: care(),
    f: [0.56, 0.45, 0.94, 0.94, 0.93, 0.69, 0.58, 0.72, 1.00, 0.00, 0.00, 0.00] },
  { id: 'asl0',   name: 'Closed O',   asl: '0', est: true, m: care(),
    f: [0.45, 0.45, 0.47, 0.43, 0.40, 0.55, 0.14, 0.35, 0.93, 0.78, 0.56, 0.37] },
  // Brought by the classifier. No template: these have never been measured on
  // a hand here, and a made-up vector would be a false match waiting to happen
  // — matchGesture skips a template with no `f`. Record one (the ✎ button) and
  // it gains a template like any other, and then works with the classifier off.
  { id: 'thumbsdown', name: 'Thumbs Down', canned: 'Thumb_Down' },
  { id: 'iloveyou',   name: 'I Love You',  asl: 'ILY', canned: 'ILoveYou' },
].map(g => ({ ...g, builtin: true, hand: 'any', est: !!g.est }));

// Display name, gloss first: "ASL 1 · Point". The gloss leads because it is
// what the list is ordered by — a name you are scanning for should be the
// thing your eye lands on, in the column the sort put it in.
export const gestureLabel = g => g.asl ? `ASL ${g.asl} · ${g.name}` : g.name;

// Display order.
//
// Declaration order above is a *narrative* — the classic shapes, then the
// numbers, then the two the classifier brings — which is the right order to
// read the table in and the wrong one to hunt a shape in. Where a handshape
// IS an ASL handshape, its gloss is the name it already has in the language,
// so the gloss is what orders it.
//
// Numerals count, letters spell. A plain string sort would be lexicographic
// and would put "10" between "1" and "2", which is correct for strings and
// wrong for a person: these glosses are counted on the hand, so 10 belongs
// after 9. Letters have no numeric reading, so they sort among themselves and
// sit after the numbers — one sequence, 0-10 then ILY, L, S, with each half
// ordered the way that half is actually read.
//
// Handshapes with no gloss are not ASL and are not reordered: Rock Horns and
// Thumbs Down follow, in the order they are declared, and recorded shapes are
// the user's own and stay in the order they made them (they are appended by
// the caller, after this).
const byGloss = (a, b) => {
  const na = Number(a.asl), nb = Number(b.asl);
  const aNum = Number.isFinite(na), bNum = Number.isFinite(nb);
  if (aNum && bNum) return na - nb;
  if (aNum !== bNum) return aNum ? -1 : 1;
  return a.asl < b.asl ? -1 : a.asl > b.asl ? 1 : 0;
};
export const orderByGloss = list =>
  [...list.filter(g => g.asl).sort(byGloss), ...list.filter(g => !g.asl)];

// ── MediaPipe canned gestures ─────────────────────────────────────────────
//
// The hand model is now MediaPipe's GestureRecognizer, which is the same hand
// landmarker with a trained classifier head bundled alongside it (open the
// .task and you find hand_landmarker.task and hand_gesture_recognizer.task
// side by side). It classifies eight categories, verified from the bundle's
// own labels.txt: None, Closed_Fist, Open_Palm, Pointing_Up, Thumb_Down,
// Thumb_Up, Victory, ILoveYou.
//
// A trained classifier beats hand-measured templates on the shapes it knows —
// that is the whole point of adopting it. But it knows only those seven, and
// this app also recognizes the ASL number handshapes, rock horns, and whatever
// the user records. So the two run together, arbitrated by resolveGesture
// below rather than one replacing the other.
export const CANNED_TO_ID = {
  Closed_Fist: 'fist',
  Open_Palm:   'palm',
  Pointing_Up: 'point',
  Thumb_Up:    'thumbs',
  Thumb_Down:  'thumbsdown',
  Victory:     'peace',
  ILoveYou:    'iloveyou',
};

// Below this the classifier is guessing, and a guess should not outrank a
// template match. MediaPipe's own default score threshold for the canned
// classifier is 0.5; this is deliberately stricter, because a wrong confident
// answer here silently steals a pose from the template that would have caught
// it.
export const CANNED_MIN_SCORE = 0.6;

// Arbitration between the classifier and the template matcher. Pure, so the
// policy is testable without a camera.
//
// The rule that matters is the third one: the classifier cannot express ASL 3,
// 4, 6-9, 0, rock horns, or anything the user recorded. When the templates
// pick one of those, the classifier's opinion is not evidence against it —
// it was never offered that answer. "Open_Palm, 0.9" while the hand is making
// ASL 4 is the classifier saying the nearest thing it knows, not that the hand
// is open. So a template match the classifier can't name wins; a template
// match it CAN name loses to it, because there it is the better instrument.
export function resolveGesture(features, templates, canned, stickyId = null,
                               threshold = MATCH_THRESHOLD) {
  // No hand, no gesture — whatever the classifier last said. This lives here
  // rather than only at the call site because this function IS the policy, and
  // "the hand left but the last classification stuck" is precisely the kind of
  // ghost the debounce below would then hold on to.
  if (!features) return null;
  const tmpl = matchGesture(features, templates, threshold, stickyId);
  const cannedId = canned && canned.score >= CANNED_MIN_SCORE
    ? CANNED_TO_ID[canned.name] : null;
  // A canned id the user has hidden (or that no template list carries) is not
  // an answer this app can give.
  const known = cannedId && templates.some(t => t.id === cannedId) ? cannedId : null;
  if (!known) return tmpl;
  if (!tmpl) return { id: known, dist: 0, src: 'canned' };
  const expressible = templates.some(t => t.id === tmpl.id && t.canned);
  return expressible ? { id: known, dist: 0, src: 'canned' } : tmpl;
}

// The threshold is a *rejection* radius — "is this any of our gestures at
// all" — not a separation guarantee; which gesture wins is decided by nearest
// neighbour, and near-ties are arbitrated by the hysteresis + frame debounce
// below, not by the threshold. 0.20 sits at the measured knee of the
// operating curve (tests/unit/gesture-robust.test.js re-derives it): under a
// live-hand degradation model — compressed extensions, per-channel noise,
// randomized incidental contacts — 99.6% of classic-gesture poses are
// recognized, 0.2% misread, while only ~4% of relaxed non-gesture hands slip
// under it per frame (and engagement needs consecutive frames).
export const MATCH_THRESHOLD = 0.20;
// No two shipped templates may sit closer than this (see templateSeparation);
// the closest pair today is peace ~ asl6 at 0.167.
export const SEPARATION_FLOOR = 0.15;
const HYSTERESIS     = 0.06;   // extra slack to *keep* the current match
const HOLD_FRAMES    = 2;      // frames a new gesture must win before engaging
const RELEASE_FRAMES = 3;      // frames of no match before letting go

// Distance between a live feature vector and a template: weighted RMS over
// the channels the template cares about (its mask × the global weights),
// normalized by the total cared weight. Normalization is what makes ranking
// fair across templates with different masks: without it, a 12-channel
// template (the contact-defined ASL numbers) accumulates more noise-distance
// than a 7-channel classic, and the classic steals its poses — measured, that
// dropped asl6 recognition to 36%. For templates with identical masks (fist
// vs point) normalization cancels out of the comparison entirely, so it costs
// nothing where single-channel discrimination matters. Templates shorter than
// FEATURES (recorded before the vector grew) read NEUTRAL for missing
// channels, which their mask excludes anyway.
export function templateDistance(features, t) {
  let d2 = 0, wsum = 0;
  for (let i = 0; i < FEATURES.length; i++) {
    const w = WEIGHTS[i] * (t.m ? (t.m[i] ?? 1) : 1);
    if (!w) continue;
    const fv = Number.isFinite(features[i]) ? features[i] : NEUTRAL[i];
    const tv = Number.isFinite(t.f?.[i])    ? t.f[i]      : NEUTRAL[i];
    const dv = fv - tv;
    d2 += w * dv * dv;
    wsum += w;
  }
  return wsum > 0 ? Math.sqrt(d2 / wsum) : Infinity;
}

// Separation between two templates: how far each one's exact pose sits from
// the OTHER's acceptance region (min over both directions, since masks are
// asymmetric). This is what the separation floor is measured over — shared
// with tests/gesture-img so the definition can't drift.
//
// A template with no `f` — `thumbsdown` and `iloveyou`, which MediaPipe's own
// classifier recognizes rather than the feature metric — has no pose and so no
// acceptance region here: it can never collide with anything in this space,
// which is Infinity, not zero. templateDistance already tolerates a missing
// TEMPLATE vector; passing a missing FEATURE vector into it threw, which is
// why the gesture-image suite crashed the moment it had a model to run with.
export const templateSeparation = (a, b) =>
  (a.f && b.f) ? Math.min(templateDistance(a.f, b), templateDistance(b.f, a)) : Infinity;

// Pure nearest-template match — unit-tested.
// features: number[]; templates: [{id, f}]; returns {id, dist} or null.
export function matchGesture(features, templates, threshold = MATCH_THRESHOLD, stickyId = null) {
  let best = null;
  for (const t of templates) {
    if (!t.f) continue;          // classifier-only entry — nothing to match on
    const dist = templateDistance(features, t);
    if (!best || dist < best.dist) best = { id: t.id, dist };
  }
  if (!best) return null;
  const limit = best.id === stickyId ? threshold + HYSTERESIS : threshold;
  return best.dist <= limit ? best : null;
}

export const gesture = (() => {
  let custom = [];               // user-recorded templates
  let nextCustom = 1;
  const hiddenBuiltins = new Set();   // built-in ids the user removed
  const recal = new Map();            // built-in id → user-recalibrated vector
  // Per-hand recognition state. `cand`/`candFrames` debounce *switching*
  // between gestures, not just engaging one.
  const state = {
    L: { active: null, cand: null, candFrames: 0, missFrames: 0 },
    R: { active: null, cand: null, candFrames: 0, missFrames: 0 },
  };
  let recording = null;          // { name, hand, frames: [], onDone }
  // Latest canned classification per hand, written by cv.js each time the hand
  // model produces a frame. Stamped with the frame counter so a stale answer
  // from a hand that has since left the picture expires instead of sticking.
  const canned = { L: null, R: null };
  let frameNo = 0;
  const CANNED_TTL = 4;          // frames; the hand model runs every other one

  const all = () => [
    ...orderByGloss(BUILTINS.filter(g => !hiddenBuiltins.has(g.id)))
        .map(g => recal.has(g.id) ? { ...g, f: recal.get(g.id), est: false } : g),
    ...custom,
  ];

  const featuresFor = side => {
    const v = k => bus.signals.get(k)?.value ?? 0;
    // A hand that isn't currently tracked decays toward 0 — treat a
    // near-zero openness+extension sum as "no hand" to avoid ghost fists.
    const f = [
      v(`finger_${side}_thumb`), v(`finger_${side}_index`), v(`finger_${side}_middle`),
      v(`finger_${side}_ring`), v(`finger_${side}_pinky`),
      v(`hand_${side}_open`), v(`hand_${side}_spread`),
      v(`thumb_out_${side}`),
      v(`contact_${side}_index`), v(`contact_${side}_middle`),
      v(`contact_${side}_ring`),  v(`contact_${side}_pinky`),
    ];
    // Only the extension/openness channels are evidence of a hand: the
    // contacts legitimately sit at 0 for most poses, so they must not count
    // toward "is anything there".
    const present = bus.signals.get(`hand_${side}_x`)?.value > 0.001 ||
                    f.slice(0, 6).reduce((s, x) => s + x, 0) > 0.05;
    return present ? f : null;
  };

  return {
    list: all,
    listCustom: () => custom.slice(),

    registerSignals() {
      all().forEach(g => bus.register(`gesture_${g.id}`, {
        label: gestureLabel(g), group: 'gesture', min: 0, max: 1, source: 'gesture',
      }));
    },

    // Called by cv.js with the hand model's canned classification for a side.
    // `name` is a MediaPipe category ("Open_Palm"); null clears it.
    setCanned(side, name, score) {
      canned[side] = name ? { name, score, at: frameNo } : null;
    },

    // Called every RAF. Updates per-hand matches, debounce, bus signals,
    // and an in-progress recording.
    tick() {
      frameNo++;
      // Recording captures raw features, bypassing recognition.
      if (recording) {
        const f = featuresFor(recording.hand === 'any' ? 'R' : recording.hand)
               ?? featuresFor(recording.hand === 'any' ? 'L' : recording.hand);
        if (f) recording.frames.push(f);
        if (recording.frames.length >= 10) {
          const n = recording.frames.length;
          const avg = FEATURES.map((_, i) =>
            +(recording.frames.reduce((s, fr) => s + fr[i], 0) / n).toFixed(3));
          let g;
          if (recording.target) {
            // Recalibrating a built-in: replace its template in place, keeping
            // its id (so chord assignments and mappings survive) and clearing
            // the "estimated" flag now that it's been measured on a real hand.
            recal.set(recording.target, avg);
            g = all().find(x => x.id === recording.target);
          } else {
            g = { id: `custom${nextCustom++}`, name: recording.name, f: avg,
                  builtin: false, hand: 'any' };
            custom.push(g);
            bus.register(`gesture_${g.id}`,
              { label: gestureLabel(g), group: 'gesture', min: 0, max: 1, source: 'gesture' });
          }
          const done = recording.onDone; recording = null;
          done?.(g);
        }
        return;   // don't recognize while recording
      }

      const matched = new Set();
      const templates = all();
      for (const side of ['L', 'R']) {
        const st = state[side];
        const f = featuresFor(side);
        // The classifier only speaks for a hand that is actually in frame, and
        // only for as long as its answer is fresh.
        const c = f && canned[side] && frameNo - canned[side].at <= CANNED_TTL
          ? canned[side] : null;
        // Hysteresis in matchGesture biases toward the currently-held gesture.
        const m = resolveGesture(f, templates, c, st.active);
        if (m) {
          st.missFrames = 0;
          if (m.id === st.active) {
            st.cand = null; st.candFrames = 0;
          } else {
            // Switching costs the same debounce as engaging. Without this,
            // `active` was reassigned on *every* matching frame, so with
            // templates sitting close together the winner could flip frame to
            // frame — and gesture mode, which is edge-triggered on the active
            // id, would re-attack the chord each time.
            if (m.id === st.cand) st.candFrames++;
            else { st.cand = m.id; st.candFrames = 1; }
            if (st.candFrames >= HOLD_FRAMES) {
              st.active = m.id; st.cand = null; st.candFrames = 0;
            }
          }
        } else {
          st.cand = null; st.candFrames = 0;
          // Tolerate a few dropped frames before releasing, so one bad
          // detection doesn't cut a sustained chord.
          if (++st.missFrames >= RELEASE_FRAMES) st.active = null;
        }
        if (st.active) matched.add(st.active);
      }

      all().forEach(g => {
        if (matched.has(g.id)) bus.update(`gesture_${g.id}`, 1);
        else bus.decay(`gesture_${g.id}`, 0.7);
      });
    },

    // Currently engaged gesture ids (order: L then R, deduped).
    current() {
      const ids = [];
      for (const side of ['L', 'R']) {
        const a = state[side].active;
        if (a && !ids.includes(a)) ids.push(a);
      }
      return ids;
    },

    // The gesture held on ONE hand. current() dedupes across both, which is
    // right for "is this shape being made" and useless for two-handed play,
    // where which hand is making it is the whole point.
    activeOn(side) { return state[side]?.active ?? null; },

    // Begin recording; resolves via callback once ~10 frames are captured.
    // Caller is responsible for checking that the camera is running.
    // Pass `target` to overwrite an existing gesture's template instead of
    // creating a new one — that's what calibration does.
    record(name, onDone, hand = 'any', target = null) {
      recording = { name: name || `Gesture ${nextCustom}`, hand, frames: [], onDone, target };
    },
    recalibrate(id, onDone, hand = 'any') { this.record(null, onDone, hand, id); },
    get recordingActive() { return !!recording; },
    get recordingTarget() { return recording?.target ?? null; },
    cancelRecord() { recording = null; },

    // Gestures whose template is still a geometric estimate rather than
    // something measured — the ones worth calibrating first.
    estimated: () => all().filter(g => g.est).map(g => g.id),
    resetCalibration(id) { if (id) recal.delete(id); else recal.clear(); },

    remove(id) {
      if (BUILTINS.some(g => g.id === id)) {
        hiddenBuiltins.add(id);          // built-ins are code — hide, don't delete
      } else {
        const i = custom.findIndex(g => g.id === id);
        if (i >= 0) custom.splice(i, 1);
      }
      bus.update(`gesture_${id}`, 0);     // clear any lingering match signal
    },

    // Restore all removed built-ins (custom gestures are untouched).
    restoreBuiltins() { hiddenBuiltins.clear(); },
    hiddenCount: () => hiddenBuiltins.size,

    serialize() {
      return { custom: custom.map(({ id, name, f, hand, m }) => ({ id, name, f, hand, m })),
               hidden: [...hiddenBuiltins],
               recal: Object.fromEntries(recal) };
    },
    load(data) {
      // Back-compat: older presets stored just an array of custom gestures.
      const arr = Array.isArray(data) ? data : (data?.custom ?? []);
      // Templates recorded against a shorter feature vector are padded to the
      // current length (left short they'd compare as NaN and become silently
      // unmatchable) and the padded channels are masked out of the metric —
      // the recording never saw them, so it has no opinion about them.
      custom = arr.map(g => ({
        ...g,
        f: padTemplate(g.f),
        m: g.m ?? maskFromLength(Array.isArray(g.f) ? g.f.length : 0),
        builtin: false, hand: g.hand ?? 'any',
      }));
      hiddenBuiltins.clear();
      recal.clear();
      for (const [id, f] of Object.entries((Array.isArray(data) ? {} : data?.recal) ?? {})) {
        if (BUILTINS.some(g => g.id === id)) recal.set(id, padTemplate(f));
      }
      (Array.isArray(data) ? [] : (data?.hidden ?? [])).forEach(id => hiddenBuiltins.add(id));
      // Keep ids unique for future recordings.
      nextCustom = 1 + custom.reduce((mx, g) => {
        const n = /^custom(\d+)$/.exec(g.id)?.[1];
        return n ? Math.max(mx, +n) : mx;
      }, 0);
      this.registerSignals();
    },
  };
})();
