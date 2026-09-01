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
//     thumb reads ~0.45 against ~0.90 carried clear — and it is now weighted
//     for that. It sat at 0.25 on the reasoning that `thumbOut` says where the
//     thumb is more directly, which is true right up until a template MASKS
//     thumbOut out. `peace` does exactly that (a peace sign turns up with the
//     thumb both tucked and clear), and ASL 3 is a peace sign plus a thumb —
//     so the one channel that separated them was voting at a quarter strength
//     and a real hand making a 3 was read as a 2. Reported from playing.
//     Still under the finger channels: `thumbOut` remains the more direct
//     statement where a template is willing to hear it.
//   - `spread` turned out to be unpredictable (a peace sign measured *lower*
//     spread than a fist), so it gets a light vote.
//   - the contacts are what separate the ASL number handshapes at all, so
//     they get the loudest.
export const WEIGHTS = [0.7, 1, 1, 1, 1, 0.7, 0.4, 1.1, 1.2, 1.2, 1.2, 1.2];

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

// ── Kinds: what a gesture is read FROM ────────────────────────────────────
//
// Everything above describes the hand vector, which is where this module
// started and is still where every built-in lives. But nothing in the metric
// is about hands: templateDistance is a weighted RMS over "some channels
// normalized to 0–1", and the bus already publishes two more sets of exactly
// that — the face model's expression channels and the pose model's joint
// angles. A kind is that: a named channel list with weights, plus whether it
// has sides.
//
// `hand` is sided because there are two of them and which one is making the
// shape is load-bearing (chord mode reads one hand and leaves the other free).
// A face or a torso is singular, so those kinds have no side — see activeOn.
//
// Channels are read through each signal's DECLARED min/max, not bus.norm():
// norm() adapts to the range actually observed, which would quietly move a
// template out from under a recording made an hour ago.
const KIND_LABEL = { hand: 'Hand', face: 'Face', body: 'Body' };

// Expression channels only. Gaze is deliberately absent: where you are
// looking is a continuous pointing control, and folding it in would make every
// recorded expression also demand that you look where you looked when you
// recorded it.
const FACE_FEATURES = [
  'brow_raise', 'brow_furrow', 'brow_L', 'brow_R',
  'mouth_open', 'smile', 'pucker', 'lips_funnel', 'tongue_out',
  'cheek_puff', 'cheek_squint_L', 'cheek_squint_R',
  'head_yaw', 'head_roll',
];
// brow_L/brow_R only add asymmetry on top of brow_raise, and head orientation
// is incidental to most expressions, so both vote quietly.
const FACE_WEIGHTS = [1, 1, 0.8, 0.8, 1, 1, 1, 1, 1, 1, 0.8, 0.8, 0.6, 0.6];

// Pose-intrinsic channels only. head_x/head_y (where you are standing) and
// shoulder_width (how far away you are) are excluded for the same reason gaze
// is: a gesture must not require you to stand where you stood.
const BODY_FEATURES = [
  'elbow_L', 'elbow_R', 'arm_raise_L', 'arm_raise_R',
  'shoulder_elev_L', 'shoulder_elev_R', 'shoulder_azim_L', 'shoulder_azim_R',
  'torso_tilt',
];
const BODY_WEIGHTS = [1, 1, 1.1, 1.1, 0.9, 0.9, 0.9, 0.9, 0.8];

export const KINDS = {
  hand: { label: KIND_LABEL.hand, sided: true,
          features: FEATURES, weights: WEIGHTS, neutral: NEUTRAL },
  face: { label: KIND_LABEL.face, sided: false, signals: FACE_FEATURES,
          features: FACE_FEATURES, weights: FACE_WEIGHTS,
          neutral: FACE_FEATURES.map(() => 0) },
  body: { label: KIND_LABEL.body, sided: false, signals: BODY_FEATURES,
          features: BODY_FEATURES, weights: BODY_WEIGHTS,
          neutral: BODY_FEATURES.map(() => 0) },
};

// A gesture with no `kind` is a hand gesture — every built-in, and everything
// any earlier version ever saved.
export const kindOf = g => (g?.kind && KINDS[g.kind] ? g.kind : 'hand');
export const specOf = g => KINDS[kindOf(g)];
export const SIDELESS_KINDS = Object.keys(KINDS).filter(k => !KINDS[k].sided);

// Kind-aware forms of padTemplate/maskFromLength above. Both exist because the
// hand vector grew once and may again: a template shorter than its channel
// list is padded, and the padded channels masked out of the metric — against
// ITS own channel list, never the hand's.
export const padFor = (kind, f) => {
  const spec = KINDS[kind] ?? KINDS.hand;
  return spec.features.map((_, i) => Number.isFinite(f?.[i]) ? f[i] : spec.neutral[i]);
};
export const maskFor = (kind, len) =>
  (KINDS[kind] ?? KINDS.hand).features.map((_, i) => (i < len ? 1 : 0));

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
// Which channels of a sideless kind a template cares about. The hand's
// `care()` names what to IGNORE, because a handshape cares about almost
// everything; a body pose is the opposite, so this names what to KEEP.
const only = (kind, keep) => KINDS[kind].features.map(f => (keep.includes(f) ? 1 : 0));
const ARM_HEIGHT = only('body',
  ['arm_raise_L', 'arm_raise_R', 'shoulder_elev_L', 'shoulder_elev_R']);

// The five heights an arm can take, as `arm_raise` reads them (elevation/180).
const DOWN = 0.00, LOW = 0.25, OUT = 0.50, HIGH = 0.75, UP = 1.00;
// [elbow_L, elbow_R, arm_raise_L, arm_raise_R, shoulder_elev_L,
//  shoulder_elev_R, shoulder_azim_L, shoulder_azim_R, torso_tilt]
// Straight arms (elbow 1.00), out to each side (azimuth 0.5 = 0°), standing
// upright (tilt 0.5) — all masked out of the metric, and written down anyway
// so the vector describes the whole pose rather than only the part it tests.
const semaphore = (L, R) => [1.00, 1.00, L, R, L, R, 0.50, 0.50, 0.50];
const SEMAPHORE = [
  ['sem_a', 'A', 'Right Low',  DOWN, LOW],
  ['sem_b', 'B', 'Right Out',  DOWN, OUT],
  ['sem_c', 'C', 'Right High', DOWN, HIGH],
  ['sem_d', 'D', 'Right Up',   DOWN, UP],
  ['sem_e', 'E', 'Left High',  HIGH, DOWN],
  ['sem_f', 'F', 'Left Out',   OUT,  DOWN],
  ['sem_g', 'G', 'Left Low',   LOW,  DOWN],
].map(([id, sem, name, L, R]) =>
  ({ id, name, sem, kind: 'body', m: ARM_HEIGHT, f: semaphore(L, R) }));
SEMAPHORE.push({ id: 'sem_rest', name: 'Semaphore Rest', kind: 'body',
                 m: ARM_HEIGHT, f: semaphore(DOWN, DOWN) });

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
  // Measured from TWO hands (tests/gesture-img/img/asl3.jpg and asl3b.jpg),
  // not one. Fitted to the first photo alone this template sat at ring/pinky
  // 0.52 — a half-curled hand — and a second person's 3, with those fingers
  // properly folded at 0.35, landed 0.102 away with `peace` only 0.023 further
  // off. That is the shape not being picked up. The midpoint of the two puts
  // it 0.048 from one hand and 0.053 from the other.
  { id: 'asl3',   name: 'Three',      asl: '3', m: care(CONTACTS),
    f: [0.93, 0.93, 0.90, 0.43, 0.43, 0.64, 0.64, 1.00, 0.00, 0.00, 0.00, 0.00] },
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

  // ── Flag semaphore, first circle ──────────────────────────────────────
  //
  // The hands can already count to ten; the arms can too, and from across a
  // room. Semaphore's first circle is seven positions of one straight arm
  // sweeping a clock face while the other hangs at rest — and because the
  // letters A–J double as the digits 1–0, A…G ARE 1…7. Seven arm positions
  // for the seven degrees of a key, in a notation that already means those
  // numbers.
  //
  // The circle, in the signaller's OWN frame, sweeping from their lower right
  // over the top to their lower left — which is the order the letters run in:
  //
  //   A · 1   right arm low   (45° below horizontal)
  //   B · 2   right arm out   (horizontal)
  //   C · 3   right arm high  (45° above horizontal)
  //   D · 4   right arm up    (vertical)
  //   E · 5   left arm high
  //   F · 6   left arm out
  //   G · 7   left arm low
  //
  // "In the first circle, the letters A to C are made with the right arm, and
  // E to G with the left, and D with either as convenient" — D is the right
  // arm here, which makes A–D one unbroken lift of the same arm.
  //
  // The mirror is the trap, and it is worth being explicit about: published
  // semaphore charts are drawn in RECEIVE mode, as the reader sees them, so
  // the arm drawn on the left of a chart is the signaller's right. Everything
  // here is the signaller's own body, because that is what the pose model
  // measures — `arm_raise_R` is the arm on the person's own right.
  //
  // Elevation is the whole of it: `arm_raise` is the angle from the torso's
  // downward axis over 180, so the five semaphore heights land on exact
  // quarters — 0.00 down, 0.25 low, 0.50 out, 0.75 high, 1.00 up. The mask
  // keeps only the two elevation channels per arm (`shoulder_elev` is the
  // same measurement in degrees, so it doubles the vote rather than adding a
  // second demand). Elbow, azimuth and torso tilt are left OUT, not because
  // they are noise but because caring about them would make each letter
  // demand a posture rather than a position: a slightly bent elbow, a step
  // toward the camera, or standing at an angle would each cost you the note.
  //
  // Not flagged `est`. That flag is for a template someone GUESSED at — the
  // geometric hand models, which describe a shape nobody measured. These are
  // not guesses: the positions are the semaphore specification, and 45° of
  // elevation is what `arm_raise` reads as 0.25 by its own definition. They
  // are still worth fitting to your own body with ⊙ if your arms sit
  // differently, like every other template.
  //
  // REST is shipped as a template rather than left as "no match", because
  // standing normally is 0.177 from A and from G — inside the match
  // threshold. Without a template for it, simply standing there would sound
  // a chord. It is also a real semaphore position: the interval signal.
  ...SEMAPHORE,
].map(g => ({ ...g, builtin: true, hand: 'any', est: !!g.est }));

// Display name, gloss first: "ASL 1 · Point". The gloss leads because it is
// what the list is ordered by — a name you are scanning for should be the
// thing your eye lands on, in the column the sort put it in.
export const gestureLabel = g =>
  g.asl ? `ASL ${g.asl} · ${g.name}`
: g.sem ? `Semaphore ${g.sem} · ${g.name}`
: g.name;

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
// The semaphore poses have a gloss of their own — a letter, in a different
// notation — so they are their own block rather than being sorted in among
// the ASL glosses or dropped in with the unglossed. Alphabetical is also the
// order the circle is signed in, so A…G reads as the sweep it is.
//
// Shapes with no gloss at all are not reordered: Rock Horns and Thumbs Down
// follow, in the order they are declared, and recorded shapes are the user's
// own and stay in the order they made them (they are appended by the caller,
// after this).
const byGloss = (a, b) => {
  const na = Number(a.asl), nb = Number(b.asl);
  const aNum = Number.isFinite(na), bNum = Number.isFinite(nb);
  if (aNum && bNum) return na - nb;
  if (aNum !== bNum) return aNum ? -1 : 1;
  return a.asl < b.asl ? -1 : a.asl > b.asl ? 1 : 0;
};
const bySem = (a, b) => (a.sem < b.sem ? -1 : a.sem > b.sem ? 1 : 0);
export const orderByGloss = list => [
  ...list.filter(g => g.asl).sort(byGloss),
  ...list.filter(g => !g.asl && g.sem).sort(bySem),
  ...list.filter(g => !g.asl && !g.sem),
];

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
                               threshold = MATCH_THRESHOLD, kind = 'hand') {
  // No hand, no gesture — whatever the classifier last said. This lives here
  // rather than only at the call site because this function IS the policy, and
  // "the hand left but the last classification stuck" is precisely the kind of
  // ghost the debounce below would then hold on to.
  if (!features) return null;
  const tmpl = matchGesture(features, templates, threshold, stickyId, kind);
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
  // Which channel list applies is the TEMPLATE's to say — a face template is
  // 14 expression channels, a hand template 12 finger ones, and the live
  // vector handed in was read for that kind by the caller.
  const spec = specOf(t);
  let d2 = 0, wsum = 0;
  for (let i = 0; i < spec.features.length; i++) {
    const w = spec.weights[i] * (t.m ? (t.m[i] ?? 1) : 1);
    if (!w) continue;
    const fv = Number.isFinite(features[i]) ? features[i] : spec.neutral[i];
    const tv = Number.isFinite(t.f?.[i])    ? t.f[i]      : spec.neutral[i];
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
// Two gestures read from different kinds are never asked at the same time, so
// they cannot collide however close their numbers happen to look.
export const templateSeparation = (a, b) =>
  (a.f && b.f && kindOf(a) === kindOf(b))
    ? Math.min(templateDistance(a.f, b), templateDistance(b.f, a)) : Infinity;

// Pure nearest-template match — unit-tested.
// features: number[]; templates: [{id, f}]; returns {id, dist} or null.
export function matchGesture(features, templates, threshold = MATCH_THRESHOLD,
                             stickyId = null, kind = 'hand') {
  let best = null;
  for (const t of templates) {
    if (!t.f) continue;          // classifier-only entry — nothing to match on
    // `features` was read for ONE kind; templates of any other are being
    // asked a question about channels this vector does not contain.
    if (kindOf(t) !== kind) continue;
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
  // The same recognition state for the kinds that have no sides — one slot
  // per kind rather than one per hand.
  const sideless = Object.fromEntries(SIDELESS_KINDS.map(k =>
    [k, { active: null, cand: null, candFrames: 0, missFrames: 0 }]));
  // Whether each sideless model is actually looking at anything. The hand kind
  // reads this off its own channels (a hand that leaves the frame decays to
  // zero), but a face at rest and no face at all are the same all-zero vector,
  // so the sources say so explicitly — the same way cv.js reports setCanned.
  const present = Object.fromEntries(SIDELESS_KINDS.map(k => [k, false]));
  const renamed = new Map();          // gesture id → user-chosen name
  let recording = null;          // { name, hand, kind, frames: [], onDone }
  // Latest canned classification per hand, written by cv.js each time the hand
  // model produces a frame. Stamped with the frame counter so a stale answer
  // from a hand that has since left the picture expires instead of sticking.
  const canned = { L: null, R: null };
  let frameNo = 0;
  const CANNED_TTL = 4;          // frames; the hand model runs every other one

  const named = g => renamed.has(g.id) ? { ...g, name: renamed.get(g.id) } : g;
  const all = () => [
    ...orderByGloss(BUILTINS.filter(g => !hiddenBuiltins.has(g.id)))
        .map(g => recal.has(g.id) ? { ...g, f: recal.get(g.id), est: false } : g)
        .map(named),
    ...custom.map(named),
  ];

  // One channel of a sideless kind, mapped through its DECLARED range so a
  // template keeps meaning the same pose for as long as it exists.
  const normSignal = key => {
    const sig = bus.signals.get(key);
    if (!sig) return 0;
    const lo = sig.min ?? 0, hi = sig.max ?? 1;
    if (hi === lo) return 0;
    return Math.min(1, Math.max(0, (sig.value - lo) / (hi - lo)));
  };
  const featuresForKind = kind =>
    present[kind] ? KINDS[kind].signals.map(normSignal) : null;

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
        const f = recording.kind === 'hand'
          ? (featuresFor(recording.hand === 'any' ? 'R' : recording.hand)
             ?? featuresFor(recording.hand === 'any' ? 'L' : recording.hand))
          : featuresForKind(recording.kind);
        if (f) recording.frames.push(f);
        if (recording.frames.length >= 10) {
          const n = recording.frames.length;
          const avg = KINDS[recording.kind].features.map((_, i) =>
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
                  builtin: false, hand: 'any', kind: recording.kind };
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
      // Debounce, shared by every slot. Switching costs the same as engaging:
      // without that, `active` was reassigned on *every* matching frame, so
      // with templates sitting close together the winner could flip frame to
      // frame — and gesture mode, which is edge-triggered on the active id,
      // would re-attack the chord each time.
      const settle = (st, m) => {
        if (m) {
          st.missFrames = 0;
          if (m.id === st.active) { st.cand = null; st.candFrames = 0; }
          else {
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
      };

      for (const side of ['L', 'R']) {
        const st = state[side];
        const f = featuresFor(side);
        // The classifier only speaks for a hand that is actually in frame, and
        // only for as long as its answer is fresh.
        const c = f && canned[side] && frameNo - canned[side].at <= CANNED_TTL
          ? canned[side] : null;
        // Hysteresis in matchGesture biases toward the currently-held gesture.
        settle(st, resolveGesture(f, templates, c, st.active));
      }
      // The sideless kinds run the same way minus the classifier, which only
      // ever had opinions about hands.
      for (const kind of SIDELESS_KINDS) {
        const st = sideless[kind];
        const f = featuresForKind(kind);
        settle(st, f
          ? matchGesture(f, templates, MATCH_THRESHOLD, st.active, kind) : null);
      }

      all().forEach(g => {
        if (matched.has(g.id)) bus.update(`gesture_${g.id}`, 1);
        else bus.decay(`gesture_${g.id}`, 0.7);
      });
    },

    // Currently engaged gesture ids (order: L then R, then sideless, deduped).
    current() {
      const ids = [];
      const add = a => { if (a && !ids.includes(a)) ids.push(a); };
      for (const side of ['L', 'R']) add(state[side].active);
      for (const kind of SIDELESS_KINDS) add(sideless[kind].active);
      return ids;
    },

    // The gesture held on ONE hand. current() dedupes across both, which is
    // right for "is this shape being made" and useless for two-handed play,
    // where which hand is making it is the whole point.
    //
    // A sideless gesture — an expression, a stance — is held on neither hand
    // and so is available to either: asking "what is the left hand doing"
    // while your eyebrows are up should answer the eyebrows, or NAMED BY: LEFT
    // would make face gestures unplayable. A hand gesture on that hand still
    // wins, being the more specific answer to the question asked.
    activeOn(side) {
      if (state[side]?.active) return state[side].active;
      for (const kind of SIDELESS_KINDS) {
        if (sideless[kind].active) return sideless[kind].active;
      }
      return null;
    },

    // Which model a sideless gesture needs running before it can ever match.
    // The UI uses this to say so instead of letting a recording sit at zero.
    setPresence(kind, on) { if (kind in present) present[kind] = !!on; },

    // Begin recording; resolves via callback once ~10 frames are captured.
    // Caller is responsible for checking that the camera is running.
    // Pass `target` to overwrite an existing gesture's template instead of
    // creating a new one — that's what calibration does.
    record(name, onDone, hand = 'any', target = null, kind = 'hand') {
      recording = { name: name || `Gesture ${nextCustom}`, hand, frames: [],
                    onDone, target, kind: KINDS[kind] ? kind : 'hand' };
    },
    // Recalibration always records the channels the gesture is already made
    // of: asking a face gesture to re-record as a hand would not calibrate it,
    // it would overwrite it with a vector of the wrong length.
    recalibrate(id, onDone, hand = 'any') {
      this.record(null, onDone, hand, id, kindOf(all().find(g => g.id === id)));
    },
    // Rename anything. Built-ins are code, so their new name is kept beside
    // them (like a recalibration) rather than edited into them; an ASL gloss
    // is not touched either way, since it is what the list is ordered by and
    // what the shape actually is.
    rename(id, name) {
      const clean = String(name ?? '').trim().slice(0, 40);
      const g = all().find(x => x.id === id);
      if (!g || !clean || clean === g.name) return null;
      if (BUILTINS.some(b => b.id === id)) renamed.set(id, clean);
      else {
        const own = custom.find(x => x.id === id);
        if (!own) return null;
        own.name = clean;
        renamed.delete(id);
      }
      const updated = all().find(x => x.id === id);
      bus.register(`gesture_${id}`, { label: gestureLabel(updated), group: 'gesture',
                                      min: 0, max: 1, source: 'gesture' });
      return updated;
    },
    get recordingActive() { return !!recording; },
    get recordingTarget() { return recording?.target ?? null; },
    cancelRecord() { recording = null; },

    // Gestures whose template is still a geometric estimate rather than
    // something measured — the ones worth calibrating first.
    estimated: () => all().filter(g => g.est).map(g => g.id),
    resetCalibration(id) { if (id) recal.delete(id); else recal.clear(); },
    // Give a built-in its shipped name back — the counterpart to
    // resetCalibration, and the only way back from a rename, since the
    // original name lives in the code rather than in the override.
    resetNames(id) {
      if (id) renamed.delete(id); else renamed.clear();
      this.registerSignals();
    },

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
      return { custom: custom.map(({ id, name, f, hand, m, kind }) =>
                                  ({ id, name, f, hand, m, kind })),
               hidden: [...hiddenBuiltins],
               recal: Object.fromEntries(recal),
               renamed: Object.fromEntries(renamed) };
    },
    load(data) {
      // Back-compat: older presets stored just an array of custom gestures.
      const arr = Array.isArray(data) ? data : (data?.custom ?? []);
      // Templates recorded against a shorter feature vector are padded to the
      // current length (left short they'd compare as NaN and become silently
      // unmatchable) and the padded channels are masked out of the metric —
      // the recording never saw them, so it has no opinion about them.
      custom = arr.map(g => {
        const kind = kindOf(g);
        return {
          ...g, kind,
          f: padFor(kind, g.f),
          m: g.m ?? maskFor(kind, Array.isArray(g.f) ? g.f.length : 0),
          builtin: false, hand: g.hand ?? 'any',
        };
      });
      hiddenBuiltins.clear();
      recal.clear();
      renamed.clear();
      for (const [id, name] of Object.entries((Array.isArray(data) ? {} : data?.renamed) ?? {})) {
        if (name) renamed.set(id, String(name));
      }
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
