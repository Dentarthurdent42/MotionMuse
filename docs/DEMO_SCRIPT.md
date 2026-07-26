# MotionMuse — Live Demo Script

A ~8-minute walkthrough for a technical interviewer or hiring manager. It moves
in three beats: **hook them in 60 seconds → show range → prove depth.** Talk
tracks are in plain text; **[DO]** lines are the exact actions to take.

> **Before they arrive:** open the app in Chrome (desktop), grant camera
> permission once so you don't fumble the prompt live, then reload to a clean
> state. Good lighting, plain background, sit an arm's length back. Have the
> repo open in a second tab for the code portion. If Wi-Fi is shaky, note that
> MediaPipe model files load once — warm them up beforehand.

---

## 0. One-liner (say this before you touch anything) — 15 sec

> "MotionMuse turns your webcam into a musical instrument. Your hands and body
> become the controls — no MIDI hardware, no plugins, no install. It's just a
> static website: pure browser APIs. I built the whole signal chain from the
> camera to the sound."

Why this framing works: it states the product *and* the engineering claim
("I built the whole chain") in one breath.

---

## 1. The hook — make sound with your hand — 60 sec

**[DO]** Click **START CAMERA**. Wait for the hand skeleton overlay to appear.
**[DO]** Click **AUDIO ON**.
**[DO]** Click **PRESET**.
**[DO]** Raise and lower your hand, open and close your fist.

> "Everything you're hearing is driven live off the camera. As my hand goes up,
> pitch goes up; as I open my hand, the filter opens. There's a webcam frame
> being analysed, thirty-odd control signals extracted from it, and those are
> wired to a Web Audio synthesiser — all running about sixty times a second in
> the browser."

Let the sound carry the moment. Don't over-talk here — the point is that it
*just works* and feels responsive.

---

## 2. Show range — the feature tour — 3 min

Move briskly. The goal is breadth: "this isn't a toy, it's a real instrument."

### 2a. Play in key (Pitch Quantize)
**[DO]** Open **Pitch Quantize**, toggle it **ON**, pick a **root**, a **scale**
(try minor pentatonic), and a **tuning** (try just intonation).

> "By default the pitch slides continuously — great for theremin-style playing.
> But I can snap it to a scale so it always plays in key. And these aren't just
> the twelve equal-tempered notes — I implemented just intonation and Pythagorean
> tuning as interval ratios, so any scale can render in any tuning system."

**[DO]** Point at the on-screen piano. Move your hand.

> "The keyboard shows the scale live — the two dots are my two oscillators
> snapping to notes as I move."

### 2b. Change the instrument (Sound Kits)
**[DO]** Open the **Sound Kit** selector, switch from Synth → Piano → Organ →
Strings.

> "Seven instrument timbres — piano, organ, trumpet, strings, flute, bass —
> built from custom harmonic waveforms, not audio samples. So there are zero
> downloads and it works fully offline."

### 2c. Play a song (Play Along)
**[DO]** Open **Play Along**, start **Ode to Joy** on *easy*.

> "There's a Guitar-Hero-style mode: notes fall toward a line and you hit them by
> steering the pitch with your hand. It sets the key automatically and restores
> your setup afterward."

Play a few notes so they see the hit feedback and scoring.

### 2d. Go fullscreen (optional, if screen-sharing allows)
**[DO]** Click **⛶ FULL**, then **🎹 KEYS**.

> "Fullscreen performance view with the keyboard overlaid — this uses the native
> Fullscreen API, with a CSS fallback for iPhone Safari, which doesn't support
> element fullscreen."

---

## 3. Prove depth — the engineering story — 3 min

This is the part interviewers remember. Switch to the code tab. You're
demonstrating *architecture judgment*, not just that it runs.

### 3a. The architecture — draw it in words
> "The design is a one-way data flow with a decoupling layer in the middle:"

```
Webcam → MediaPipe (Hand + Pose) → Signal Bus → Mapper → Web Audio Engine
```

**[DO]** Open `src/bus.js`.

> "The key decision is this Signal Bus — a central map of named, normalised
> signals like `hand_L_y` or `pinch_R`. The camera source doesn't know anything
> about audio; the audio engine doesn't know anything about the camera. They
> only agree on signal names. That decoupling is what let me keep adding
> inputs — pose, gestures — and outputs — synth params, a shader, a game —
> without any of them knowing about each other."

### 3b. The node graph — the feature I'm proudest of
**[DO]** Back to the app. Open the mapper (the node-graph canvas).
**[DO]** Drag a cable from one input socket to a parameter. Then drag the *same*
input to a second parameter.

> "Mapping is a visual patchbay, modelled on Blender's geometry nodes and Unreal
> Blueprints. The important idea is input *reuse*: one signal is a single node
> whose output fans out to as many parameters as you want. Each cable's
> thickness pulses with its live value, so you can literally see the signal
> flowing."

If they seem interested, mention the hard part:

> "Getting drag-to-wire working on *touch* was subtle — on mobile the origin
> element implicitly captures the pointer, so the target never receives the
> drop. I resolve the drop target with `elementFromPoint` instead, plus a
> tap-to-connect fallback and keyboard support for accessibility."

### 3c. Gesture recognition — a debugging war story
**[DO]** Turn on **DEV** mode (header). Open **Gestures**. Make a fist, a peace
sign, a point — show the "matched" indicators light up.

> "Gestures are recognised by nearest-template matching over seven hand features.
> Here's a real bug I hit and fixed: my first templates were idealised — a fist
> was 'all fingers at zero.' But real MediaPipe output never hits clean zeros
> and ones; the values cluster in a compressed range. So *nothing* matched.
> I caught it by writing a test that runs the actual hand-detection pipeline over
> reference photos and asserts each maps to the right gesture — then recalibrated
> the templates to measured values. That test is in the repo and runs in CI."

**[DO]** (Optional, if you have a terminal) run `npm run test:gesture-img` — it
prints a PASS table over the fist / peace / point / thumbs-up photos.

### 3d. Craft signals — accessibility and offline
> "A few things I care about that aren't flashy but matter:"
- **"It's a PWA with a service worker, so it installs and runs offline."**
- **"Colours are defined in OKLab and I have an automated contrast test — every
  text/background pair is checked against WCAG ratios in CI."**
- **"Experimental features hide behind the DEV toggle — progressive disclosure so
  a newcomer meets a simple surface."**
- **"No build step. It's vanilla ES modules served as static files — which keeps
  it dependency-light and trivially deployable."**

---

## 4. Close — 20 sec

> "So that's MotionMuse: a real-time computer-vision instrument, entirely in the
> browser, with a decoupled signal architecture, a visual node-graph mapper, and
> a test suite covering the tricky parts. Happy to go deeper on any layer — the
> audio graph, the CV feature extraction, the mapping curves, whatever you'd like."

Then stop talking and let them drive the questions.

---

## Anticipated questions — quick answers

**"Why no framework / build step?"**
> The app is DOM-light and the hot path is a requestAnimationFrame loop, not
> re-rendering a component tree. A framework would add weight and a build
> pipeline for little gain. Vanilla ES modules keep it deployable as static
> files and easy to reason about. I'd reach for a framework if the UI state
> grew significantly.

**"How do you keep it running at 60fps?"**
> MediaPipe runs on the GPU via WebGL/WASM. The per-frame work is bounded:
> extract signals into the bus, then the mapper writes audio params with 25ms
> smoothing ramps so there's no zipper noise. Audio param changes are cheap;
> the expensive part is inference, which the browser offloads.

**"How is state saved?"**
> A single JSON snapshot — every mapping, all audio params, waveform/filter
> choices, tuning. Downloadable as a file to share, and mirrored to
> localStorage so a reload restores your setup. `src/preset.js` owns it;
> the engine and mapper each serialise their own slice.

**"What was the hardest part?"**
> Two things: the touch drag-to-wire pointer-capture problem, and the gesture
> template calibration — both cases where the naïve solution looked right but
> failed against real device/model behaviour, and a test is what caught it.

**"What would you do next?"**
> The EEG/EMG input tabs are stubbed as future signal sources — the bus
> architecture means they'd plug in without touching the audio side. I'd also
> add two-hand chord polyphony and a way to record/export performances.

**"How do you test something this interactive?"**
> Three layers: unit tests for the pure logic (chord construction, scale
> quantising, gesture matching), a headless Playwright harness that drives the
> real DOM and a fake webcam, and the image-based gesture test that runs the
> actual MediaPipe pipeline over reference photos.

---

## Cheat sheet — click order

1. START CAMERA → AUDIO ON → PRESET → move hand
2. Pitch Quantize: ON, root, minor pentatonic, just intonation
3. Sound Kit: Synth → Piano → Organ → Strings
4. Play Along: Ode to Joy, easy
5. ⛶ FULL → 🎹 KEYS (optional)
6. Node graph: wire one input to two params
7. DEV on → Gestures: fist / peace / point
8. Terminal (optional): `npm run test:gesture-img`, `npm run test:unit`

## If the camera fails live (have a fallback)
- The node graph, sound kits, pitch quantiser and tests all demo **without** a
  camera — you can move sliders by hand and still tell the architecture story.
- Keep the Netlify deploy-preview URL handy as a backup to a local server.
- Worst case, walk the code: `bus.js` → `cv.js` → `mapper.js` → `engine.js`
  is a five-minute tour that shows the whole design.
