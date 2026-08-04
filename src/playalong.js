// Play-along mode: Guitar-Hero-style pitch matching. Notes fall toward a hit
// line above the piano keyboard; the player "hits" a note by steering osc1's
// quantised pitch (via whatever gesture drives osc1_freq) onto the target
// note within the difficulty's timing window. A quiet guide melody plays via
// the engine's one-shot voice so it never disturbs the player's synth chain.

import { engine }       from './engine.js';
import { mtof }         from './scale.js';
import { mapper }       from './mapper.js';
import { SONGS }        from './songs.js';
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

// 'hit' | 'miss' | 'pending' for one note at one moment.
export function judge(playerMidi, noteMidi, nowMs, noteMs, cfg) {
  const dt = nowMs - noteMs;
  if (dt < -cfg.window) return 'pending';
  const match = cfg.pcMatch
    ? (((playerMidi - noteMidi) % 12) + 12) % 12 === 0
    : playerMidi === noteMidi;
  if (match) return 'hit';
  return dt > cfg.window ? 'miss' : 'pending';
}

export { mtof };                     // single source of truth lives in scale.js

// Game state ----------------------------------------------------------------

const COUNTDOWN_S = 3;

let state = 'idle';            // idle | countdown | playing | finished
let song = null, cfg = null, diffId = 'medium';
let notes = [];                // { m, tMs, durMs, status, hitAtMs? }
let t0 = 0;                    // engine.now() (s) at which beat 0 sounds
let schedIdx = 0, guideOn = true;
let score = 0, streak = 0, bestStreak = 0, hits = 0, judged = 0;
let endMs = 0;
let savedTuning = null;
let lastSongId = 'ode-to-joy', lastDiffId = 'medium';

function nowMs() { return (engine.now() - t0) * 1000; }

function restoreTuning() {
  if (savedTuning) { engine.setTuning(savedTuning); savedTuning = null; }
}

export const playalong = {
  get lastSong() { return lastSongId; },
  get lastDiff() { return lastDiffId; },
  get guide()    { return guideOn; },
  setGuide(on)   { guideOn = on; },

  start(songId, dId) {
    if (state !== 'idle') this.stop();
    if (!engine.started) { toast('Enable audio first'); return false; }
    song = SONGS.find(s => s.id === songId) ?? SONGS[0];
    cfg = DIFF[dId] ?? DIFF.medium;
    diffId = DIFF[dId] ? dId : 'medium';
    lastSongId = song.id; lastDiffId = diffId;

    const spb = 60 / song.bpm;
    const chart = filterNotes(song.notes, diffId, song.beatsPerBar);
    if (!chart.length) { toast('Empty chart'); return false; }
    notes = chart.map(n => ({ m: n.m, tMs: n.b * spb * 1000, durMs: n.d * spb * 1000, status: 'upcoming' }));
    endMs = notes[notes.length - 1].tMs + notes[notes.length - 1].durMs + 1500;

    // The song owns the quantiser while playing: every chart note must be
    // reachable, so force quantise on in the song's key. Restored on finish.
    savedTuning = engine.getTuning();
    engine.setTuning({ enabled: true, root: song.root, scale: song.scale, system: 'equal (12-TET)' });

    // The game is played through osc1 pitch — make sure something drives it.
    if (!mapper.mappings.some(m => m.audioParam === 'osc1_freq' && m.signal)) {
      mapper.add('osc1_freq', 'hand_L_y', 80, 880, 'quad');
      renderMapper();
      toast('Added mapping: Left Wrist Y → Osc1 pitch');
    }

    t0 = engine.now() + COUNTDOWN_S;
    schedIdx = 0;
    score = streak = bestStreak = hits = judged = 0;
    state = 'countdown';
    return true;
  },

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

    // Judge notes around the hit line.
    const pm = midiOf(engine.PARAMS.osc1_freq.val);
    for (const n of notes) {
      if (n.status !== 'upcoming') continue;
      if (n.tMs - t > cfg.window) break;          // notes sorted; rest are future
      const r = judge(pm, n.m, t, n.tMs, cfg);
      if (r === 'hit') {
        n.status = 'hit'; n.hitAtMs = t;
        hits++; judged++; streak++;
        bestStreak = Math.max(bestStreak, streak);
        score += 100 + 10 * Math.min(streak, 10);
        engine.playTone({ freq: 1568, dur: 0.06, type: 'square', gain: 0.05 });
      } else if (r === 'miss') {
        n.status = 'miss'; judged++; streak = 0;
        engine.playTone({ freq: 110, dur: 0.12, type: 'sawtooth', gain: 0.05 });
      }
    }

    if (t > endMs) {
      state = 'finished';
      restoreTuning();
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
      playerMidi: engine.started ? midiOf(engine.PARAMS.osc1_freq.val) : null,
      root: song?.root, scale: song?.scale,
      score, streak, bestStreak, hits, judged,
      accuracy: judged ? hits / judged : 1,
      total: notes.length,
    };
  },
};
