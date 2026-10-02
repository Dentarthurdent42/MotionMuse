// The setup every packed share is written against — FROZEN.
//
// A "b" share (src/share.js) carries only what differs from this object, which
// is what took a typical setup from ~1 KB of compressed JSON to ~250 bytes and
// made a code small enough to live on the picture (src/densecode.js). It is
// the default Hands patch on a fresh install, as of the day the format shipped,
// because that is what most setups start from: a lightly tweaked Hands setup
// is a handful of bytes.
//
// NEVER EDIT THIS OBJECT. Every "b" link and every setup tag in every
// recording ever posted is a diff against exactly these values; change one and
// they all silently decode to something else. When the app grows new state, a
// snapshot carries it as part of the diff, which costs a few bytes and breaks
// nothing. If a better baseline is ever worth having, it is a NEW packing
// letter with a new constant beside this one — this one stays, so the old
// links keep opening. tests/unit/share-base.test.js pins it by hash.
export const BASE_B = Object.freeze({
  "app": "motionmuse-sound",
  "v": 2,
  "kit": "synth",
  "graph": [],
  "mappings": [
    {
      "audioParam": "osc1_freq",
      "signal": "hand_L_y",
      "outMin": 80,
      "outMax": 880,
      "curve": "quad",
      "steps": 0,
      "invert": false
    },
    {
      "audioParam": "osc2_freq",
      "signal": "hand_R_y",
      "outMin": 80,
      "outMax": 1320,
      "curve": "quad",
      "steps": 0,
      "invert": false
    },
    {
      "audioParam": "filter_freq",
      "signal": "hand_L_open",
      "outMin": 300,
      "outMax": 8000,
      "curve": "quad",
      "steps": 0,
      "invert": false
    },
    {
      "audioParam": "osc2_volume",
      "signal": "hand_R_open",
      "outMin": 0,
      "outMax": 1,
      "curve": "linear",
      "steps": 0,
      "invert": false
    },
    {
      "audioParam": "lfo_depth",
      "signal": "elbow_L",
      "outMin": 0,
      "outMax": 1,
      "curve": "linear",
      "steps": 0,
      "invert": false
    },
    {
      "audioParam": "reverb_mix",
      "signal": "hand_R_z",
      "outMin": 0,
      "outMax": 0.6,
      "curve": "linear",
      "steps": 0,
      "invert": false
    },
    {
      "audioParam": "volume",
      "signal": "pinch_R",
      "outMin": 0,
      "outMax": 1,
      "curve": "invquad",
      "steps": 0,
      "invert": false
    }
  ],
  "arp": {
    "enabled": false,
    "pattern": "up",
    "octaves": 1,
    "sync": 2
  },
  "audio": {
    "params": {
      "osc1_freq": 220,
      "osc1_detune": 0,
      "osc1_volume": 1,
      "osc2_freq": 330,
      "osc2_detune": 0,
      "osc2_volume": 0.5,
      "filter_freq": 3000,
      "filter_q": 1,
      "osc_volume": 1,
      "chord_filter_freq": 3000,
      "chord_filter_q": 1,
      "chord_volume": 1,
      "arp_rate": 4,
      "arp_gate": 0.9,
      "arp_sustain": 0.6,
      "lfo_rate": 1,
      "lfo_depth": 0,
      "reverb_mix": 0.12,
      "volume": 0.55,
      "loop_volume": 0.9
    },
    "tuning": {
      "enabled": false,
      "root": "C",
      "scale": "chromatic",
      "system": "equal (12-TET)"
    },
    "volStep": {
      "enabled": true,
      "steps": 6,
      "floorDb": -30,
      "gate": true,
      "hysteresis": 0.3,
      "edge": "key",
      "gateAt": 0.5
    },
    "oscCount": 2,
    "oscTypes": [
      "sine",
      "triangle"
    ],
    "filterType": "lowpass",
    "chordFilterType": "lowpass",
    "shepard": {
      "lead": false,
      "chord": false
    },
    "chordEnv": {
      "attack": 0.02,
      "decay": 0.12,
      "sustain": 0.7,
      "release": 0.35
    },
    "leadEnv": {
      "attack": 0.01,
      "decay": 0.12,
      "sustain": 0.75,
      "release": 0.25,
      "enabled": false
    }
  },
  "gestures": {
    "custom": [],
    "hidden": [],
    "recal": {},
    "renamed": {}
  },
  "chord": {
    "enabled": false,
    "key": {
      "root": "C",
      "mode": "major (ionian)",
      "octave": 4,
      "follow": true
    },
    "assignments": {
      "point": 0,
      "peace": 1,
      "asl3": 2,
      "asl4": 3,
      "palm": 4,
      "asl6": 5,
      "asl7": 6
    },
    "degrees": [
      "point",
      "peace",
      "asl3",
      "asl4",
      "palm",
      "asl6",
      "asl7"
    ],
    "sevenths": [
      false,
      false,
      true,
      false,
      true,
      false,
      false
    ],
    "releaseGesture": "fist",
    "expression": {
      "mode": "gesture",
      "hand": "L",
      "control": "gate",
      "lo": 0.42,
      "hi": 0.9,
      "deadzone": 0.12,
      "trigger": 0.45
    },
    "voicing": "chord",
    "namingHand": "any",
    "accidentals": {
      "sharp": "thumbs",
      "flat": "thumbsdown"
    },
    "qualities": {
      "major": "thumbs",
      "minor": "thumbsdown",
      "dim": "asl0",
      "aug": null,
      "sus2": null,
      "sus4": null,
      "dom7": "horns",
      "maj7": "iloveyou",
      "min7": null
    }
  },
  "radial": {
    "enabled": false,
    "joint": "wrist",
    "side": "R",
    "voicing": "note",
    "finger": "index",
    "volume": {
      "mode": "off",
      "lo": 0.42,
      "hi": 0.9
    },
    "shepAuto": true
  },
  "metronome": {
    "on": false,
    "bpm": 100,
    "sig": "4/4",
    "muted": true,
    "mask": [
      true,
      true,
      true,
      true
    ]
  },
  "shader": {
    "v": 2,
    "active": false,
    "graph": {
      "v": 1,
      "nodes": [],
      "links": []
    }
  },
  "ui": {}
});

// ── Baselines for the c packing — FROZEN, the same way ──────────────────
//
// A "c" share names which of these it is a diff against, in one byte, and the
// encoder takes whichever gives the smallest diff. Against the Hands baseline
// alone, a setup built on any other starting patch carries that patch's whole
// cable list — every starting patch but Hands came out at 150–250 bytes, a
// setup tag twice the width it needed to be. Against its own starting patch
// it is a handful of bytes, like a Hands setup. They are the starting
// patches as they were the day the packing shipped: only the cables differ
// from the Hands baseline, so each is that baseline with its cables swapped.
// The same rule as above: NEVER EDIT, NEVER REORDER — the index is the
// format. A new baseline goes on the END of the list.
const withCables = mappings => Object.freeze({ ...BASE_B, mappings: Object.freeze(mappings) });
export const BASES_C = Object.freeze([
  BASE_B,                                                // 0: hands
  withCables([
    {"audioParam":"osc1_freq","signal":"brow_raise","outMin":160,"outMax":660,"curve":"linear","steps":0,"invert":false},
    {"audioParam":"volume","signal":"mouth_open","outMin":0,"outMax":1,"curve":"linear","steps":0,"invert":false},
  ]), // 1: face-brow-mouth
  withCables([
    {"audioParam":"osc1_freq","signal":"brow_raise","outMin":160,"outMax":660,"curve":"linear","steps":0,"invert":false},
    {"audioParam":"volume","signal":"mouth_open","outMin":0,"outMax":1,"curve":"linear","steps":0,"invert":false},
    {"audioParam":"filter_freq","signal":"smile","outMin":400,"outMax":7000,"curve":"quad","steps":0,"invert":false},
    {"audioParam":"osc2_detune","signal":"pucker","outMin":-30,"outMax":30,"curve":"linear","steps":0,"invert":false},
    {"audioParam":"reverb_mix","signal":"cheek_puff","outMin":0,"outMax":0.7,"curve":"linear","steps":0,"invert":false},
    {"audioParam":"osc2_volume","signal":"head_roll","outMin":0,"outMax":1,"curve":"linear","steps":0,"invert":false},
  ]), // 2: face-expressive
  withCables([
    {"audioParam":"osc1_freq","signal":"gaze_x","outMin":160,"outMax":880,"curve":"linear","steps":0,"invert":false},
    {"audioParam":"filter_freq","signal":"gaze_y","outMin":300,"outMax":6000,"curve":"quad","steps":0,"invert":false},
    {"audioParam":"volume","signal":"mouth_open","outMin":0,"outMax":1,"curve":"linear","steps":0,"invert":false},
    {"audioParam":"reverb_mix","signal":"brow_raise","outMin":0,"outMax":0.6,"curve":"linear","steps":0,"invert":false},
  ]), // 3: gaze
  withCables([
    {"audioParam":"osc1_freq","signal":"arm_raise_R","outMin":110,"outMax":880,"curve":"quad","steps":0,"invert":false},
    {"audioParam":"filter_freq","signal":"arm_raise_L","outMin":300,"outMax":7000,"curve":"quad","steps":0,"invert":false},
    {"audioParam":"osc2_detune","signal":"torso_tilt","outMin":-40,"outMax":40,"curve":"linear","steps":0,"invert":false},
    {"audioParam":"lfo_rate","signal":"shoulder_width","outMin":0.5,"outMax":8,"curve":"linear","steps":0,"invert":false},
    {"audioParam":"volume","signal":"shoulder_y_R","outMin":0,"outMax":1,"curve":"linear","steps":0,"invert":false},
  ]), // 4: pose
]);
