// Play-along mode: Guitar-Hero-style pitch matching. Notes fall toward a hit
// line above the piano keyboard; the player "hits" a note by steering osc1's
// quantised pitch (via whatever gesture drives osc1_freq) onto the target
// note within the difficulty's timing window. A quiet guide melody plays via
// the engine's one-shot voice so it never disturbs the player's synth chain.

import { engine }       from './engine.js';
import { mtof }         from './scale.js';
import { lsGet, lsSet } from './storage.js';
import { mapper }       from './mapper.js';
import { SONGS, songById } from './songs.js';
import { isGenSong, genModeOf, generateSong } from './songgen.js';
import { chordmode }    from './chordmode.js';
import { radial }       from './radial.js';
import { midiOf }       from './ui/keyboard.js';
import { toast }        from './ui/status.js';
import { renderMapper } from './ui/mapper-ui.js';

export const DIFF = {
  easy:   { window: 250, fallSec: 3.0, pcMatch: true  },   // octave-agnostic
  medium: { window: 180, fallSec: 2.2, pcMatch: false },
  hard:   { window: 120, fallSec: 1.6, pcMatch: false },
};

// Pure helpers (unit-tested) ------------------------------------------------

// easy: bar downbeats and long notes; medium: on-the-beat notes; hard: all.
export function filterNotes(notes, diffId, beatsPerBar) {
  if (diffId === 'hard')   return notes.slice();
  if (diffId === 'medium') return notes.filter(n => n.b % 1 === 0);
  return notes.filter(n => n.b % beatsPerBar === 0 || n.d >= 2);
}

// Timing tiers: a hit inside the central PERFECT_FRAC of the window is
// 'perfect', anywhere else inside the window is 'good'.
export const PERFECT_FRAC = 0.4;
export const POINTS = { perfect: 150, good: 100 };   // + streak bonus on both

// 'perfect' | 'good' | 'miss' | 'pending' for one note at one moment.
export function judge(playerMidi, noteMidi, nowMs, noteMs, cfg) {
  const dt = nowMs - noteMs;
  if (dt < -cfg.window) return 'pending';
  const match = cfg.pcMatch
    ? (((playerMidi - noteMidi) % 12) + 12) % 12 === 0
    : playerMidi === noteMidi;
  if (match) return Math.abs(dt) <= cfg.window * PERFECT_FRAC ? 'perfect' : 'good';
  return dt > cfg.window ? 'miss' : 'pending';
}

// Letter grade from final accuracy.
export function gradeOf(acc) {
  return acc >= 0.95 ? 'S' : acc >= 0.9 ? 'A' : acc >= 0.75 ? 'B' : acc >= 0.6 ? 'C' : 'D';
}

export { mtof };                     // single source of truth lives in scale.js

// Game state ----------------------------------------------------------------

const COUNTDOWN_S = 3;

let state = 'idle';            // idle | countdown | playing | finished
let song = null, cfg = null, diffId = 'medium';
// Which input the chart judges: the quantised lead pitch (every stored song),
// or a DEGREE — gesture mode's sounding degree, or the ring's pointed
// section. Degree charts come from the generator and carry `deg` per note.
let mode = 'pitch';
let notes = [];                // { m, tMs, durMs, status, hitAtMs? }
let t0 = 0;                    // engine.now() (s) at which beat 0 sounds
let schedIdx = 0, guideOn = true;
let score = 0, streak = 0, bestStreak = 0, hits = 0, judged = 0;
let perfects = 0, goods = 0;
let lastJudge = null;          // { tier, atMs } — drives the floating hit text
let startBest = null;          // previous best for this song+difficulty
let isNewBest = false;
let endMs = 0;
let savedTuning = null;
let lastSongId = 'ode-to-joy', lastDiffId = 'medium';

// Best scores persist per song per difficulty — own key, NOT the preset
// snapshot (presets are shareable files; scores are personal).
const SCORES_KEY = 'motionmuse-scores';
function loadScores() {
  try { return JSON.parse(lsGet(SCORES_KEY)) || {}; } catch { return {}; }
}
function saveBest(songId, dId, entry) {
  const s = loadScores();
  (s[songId] ??= {})[dId] = entry;
  lsSet(SCORES_KEY, JSON.stringify(s));
}

function nowMs() { return (engine.now() - t0) * 1000; }

function restoreTuning() {
  if (savedTuning) { engine.setTuning(savedTuning); savedTuning = null; }
}

export const playalong = {
  get lastSong() { return lastSongId; },
  // The importer selects what it just imported — a fresh song the picker
  // then hides behind the old selection would look like a failed import.
  setLastSong(id) { lastSongId = id; },
  get lastDiff() { return lastDiffId; },
  get guide()    { return guideOn; },
  setGuide(on)   { guideOn = on; },

  start(songId, dId) {
    if (state !== 'idle') this.stop();
    // The engine starts with the page, so this is an unavailable-audio path
    // now, not a "you forgot to switch it on" one.
    if (!engine.started) { toast('Audio engine unavailable'); return false; }
    diffId = DIFF[dId] ? dId : 'medium';
    cfg = DIFF[diffId];
    if (isGenSong(songId)) {
      // A generated chart: fresh from the grammar, in the key the instrument
      // is currently set to — the shared key both play modes read — and
      // sized by the difficulty. The stable id is what best scores key on.
      mode = genModeOf(songId);
      song = generateSong(mode, { key: chordmode.effectiveKey(), diffId });
      song.id = songId;
    } else {
      mode = 'pitch';
      song = songById(songId) ?? SONGS[0];
    }
    lastSongId = song.id; lastDiffId = diffId;

    const spb = 60 / song.bpm;
    const chart = filterNotes(song.notes, diffId, song.beatsPerBar);
    if (!chart.length) { toast('Empty chart'); return false; }
    notes = chart.map(n => ({ m: n.m, deg: n.deg, tMs: n.b * spb * 1000, durMs: n.d * spb * 1000, status: 'upcoming' }));
    endMs = notes[notes.length - 1].tMs + notes[notes.length - 1].durMs + 1500;

    if (mode === 'pitch') {
      // The song owns the quantiser while playing: every chart note must be
      // reachable, so force quantise on in the song's key. Restored on finish.
      savedTuning = engine.getTuning();
      engine.setTuning({ enabled: true, root: song.root, scale: song.scale, system: 'equal (12-TET)' });

      // The game is played through oscillator 1's pitch — so it needs one to
      // exist. The bank can be emptied (gesture mode alone), and the game is not a
      // reason to refuse that; it just has to put a lead voice back before it can
      // score anything.
      if (!engine.PARAMS.osc1_freq) engine.setOscCount(1);
      // …and make sure something drives it.
      if (!mapper.mappings.some(m => m.audioParam === 'osc1_freq' && m.signal)) {
        mapper.add('osc1_freq', 'hand_L_y', 80, 880, 'quad');
        renderMapper();
        toast('Added mapping: Left Wrist Y → Osc1 pitch');
      }
    } else {
      // A degree chart is played through a play mode, so that mode has to be
      // on — same rule as the lead voice above: the game sets up what it
      // needs and says so, rather than starting a round nobody can score in.
      if (mode === 'gesture' && !chordmode.enabled) {
        radial.setEnabled(false);
        chordmode.setEnabled(true);
        toast('Gesture Mode switched on for the game');
      } else if (mode === 'radial' && !radial.enabled) {
        radial.setEnabled(true);
        toast('Radial Mode switched on for the game');
      }
    }

    t0 = engine.now() + COUNTDOWN_S;
    schedIdx = 0;
    score = streak = bestStreak = hits = judged = perfects = goods = 0;
    lastJudge = null;
    isNewBest = false;
    startBest = this.bestFor(song.id, diffId);
    state = 'countdown';
    return true;
  },

  // Previous best { score, grade, acc, date } or null.
  bestFor(songId, dId) { return loadScores()[songId]?.[dId] ?? null; },

  stop() {
    restoreTuning();
    state = 'idle';
    notes = [];
    song = null;
  },

  tick() {
    if (state === 'idle' || state === 'finished') return;
    const t = nowMs();
    if (state === 'countdown' && t >= 0) state = 'playing';

    // Guide melody: schedule slightly ahead on the audio clock.
    const horizonS = engine.now() - t0 + 0.35;
    while (schedIdx < notes.length && notes[schedIdx].tMs / 1000 <= horizonS) {
      const n = notes[schedIdx++];
      if (guideOn) engine.playTone({
        freq: mtof(n.m),
        when: t0 + n.tMs / 1000 - engine.now(),
        dur: Math.max(0.15, (n.durMs / 1000) * 0.9),
        type: 'triangle',
        gain: 0.07,
      });
    }

    // Judge notes around the hit line, against whichever input this chart is
    // for. No lead oscillator means no pitch to judge — the bank can be
    // emptied mid-song from the panel; a play mode switched off mid-game
    // reads as "not sounding", which misses honestly.
    let pm, jcfg = cfg;
    if (mode === 'pitch') {
      if (!engine.PARAMS.osc1_freq) return;
      pm = midiOf(engine.PARAMS.osc1_freq.val);
    } else {
      pm = mode === 'gesture' ? chordmode.soundingDegree() : (radial.soundingSection() ?? -1);
      // Octave-agnostic matching is a pitch idea; degree lanes are exact.
      jcfg = cfg.pcMatch ? { ...cfg, pcMatch: false } : cfg;
    }
    for (const n of notes) {
      if (n.status !== 'upcoming') continue;
      if (n.tMs - t > cfg.window) break;          // notes sorted; rest are future
      const r = judge(pm, n.deg ?? n.m, t, n.tMs, jcfg);
      if (r === 'perfect' || r === 'good') {
        n.status = 'hit'; n.tier = r; n.hitAtMs = t;
        hits++; judged++; streak++;
        if (r === 'perfect') perfects++; else goods++;
        bestStreak = Math.max(bestStreak, streak);
        score += POINTS[r] + 10 * Math.min(streak, 10);
        lastJudge = { tier: r, atMs: t };
        // Perfect hits chirp a fifth higher than good ones.
        engine.playTone({ freq: r === 'perfect' ? 2093 : 1568, dur: 0.06, type: 'square', gain: 0.05 });
      } else if (r === 'miss') {
        n.status = 'miss'; judged++; streak = 0;
        lastJudge = { tier: 'miss', atMs: t };
        engine.playTone({ freq: 110, dur: 0.12, type: 'sawtooth', gain: 0.05 });
      }
    }

    if (t > endMs) {
      state = 'finished';
      restoreTuning();
      const acc = judged ? hits / judged : 1;
      isNewBest = judged > 0 && score > (startBest?.score ?? -1);
      if (isNewBest) saveBest(song.id, diffId, { score, grade: gradeOf(acc), acc, date: Date.now() });
    }
  },

  get view() {
    return {
      state,
      songName: song?.name ?? null,
      diffId, cfg,
      nowMs: state === 'idle' ? 0 : nowMs(),
      countdown: state === 'countdown' ? Math.max(1, Math.ceil(-nowMs() / 1000)) : 0,
      notes,
      mode,
      laneCount: song?.laneCount ?? null,
      laneLabels: song?.laneLabels ?? null,
      playerLane: mode === 'gesture' ? chordmode.soundingDegree()
                : mode === 'radial' ? (radial.soundingSection() ?? -1) : -1,
      playerMidi: mode === 'pitch' && engine.started && engine.PARAMS.osc1_freq
        ? midiOf(engine.PARAMS.osc1_freq.val) : null,
      root: song?.root, scale: song?.scale,
      score, streak, bestStreak, hits, judged,
      perfects, goods,
      misses: judged - hits,
      lastJudge,
      accuracy: judged ? hits / judged : 1,
      grade: state === 'finished' ? gradeOf(judged ? hits / judged : 1) : null,
      best: startBest,       // cached at start() — no localStorage read per frame
      isNewBest,
      total: notes.length,
    };
  },
};
