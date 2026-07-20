# BioSignal → Sound

A browser-based instrument that maps live webcam data — hand position, gesture, and body pose — to audio synthesis parameters in real time. No plugins, no install: pure Web APIs served as static files.

## Demo

![BioSignal → Sound screenshot](docs/screenshot.png)

Open `index.html` (or the Netlify deploy) and:
1. Click **START CAMERA** — MediaPipe loads and begins detecting hands and pose
2. Click **AUDIO ON** — the Web Audio synthesiser starts
3. Click **PRESET** — a default mapping is applied; move your hands to play

## How it works

```
Webcam → MediaPipe (Hand + Pose) → Signal Bus → Mapper → Web Audio Engine
```

- **Signal Bus** (`src/bus.js`): a central `Map` of named signals (e.g. `hand_L_y`, `pinch_R`, `elbow_L`). Any source can `register` and `update` signals; any consumer can `norm`-alise them to 0–1.
- **CV Source** (`src/cv.js`): runs MediaPipe `HandLandmarker` and `PoseLandmarker` on every video frame, extracts ~30 signals per frame, and writes them into the bus.
- **Mapper** (`src/mapper.js`): each mapping row takes one signal, applies a curve (linear, quad, cubic, log, sqrt, invert), scales it to an output range, and writes it to an audio parameter on every RAF tick.
- **Audio Engine** (`src/engine.js`): two oscillators through a BiquadFilter and a convolution reverb, all driven by the Web Audio API with 25 ms parameter smoothing.
- **Scale quantiser** (`src/scale.js`): optionally snaps oscillator frequencies onto a musical scale, root and tuning system before they reach the engine.

## Pitch quantisation (scales & tuning)

By default the oscillators glide continuously. The **Pitch Quantize** panel
(top of the Audio Engine column) snaps both oscillator frequencies onto the
nearest note of a chosen **root**, **scale** and **tuning system**, so gestures
play *in key* instead of sliding microtonally.

- **Scales:** chromatic, major, natural/harmonic minor, dorian, phrygian,
  mixolydian, major/minor pentatonic, blues, whole-tone.
- **Tunings:** equal temperament (12-TET), just intonation (5-limit),
  Pythagorean. Tunings are defined as the 12 interval ratios from the root, and
  scales pick which degrees are playable — so any scale renders in any tuning
  (e.g. *C minor, just intonation* or *major pentatonic, Pythagorean*).

While quantisation is on, a **piano keyboard** under the selectors shows the
scale at a glance: in-scale notes are tinted (the root most strongly) and two
coloured dots mark where **osc 1** (purple) and **osc 2** (cyan) are currently
snapped, moving live as you play. The note readout beneath it is colour-matched
to the two dots. The toggle defaults to **OFF** (continuous), so existing
behaviour is unchanged until you opt in. Quantisation is applied centrally in
`engine.set()`, so it affects both signal-driven mappings and manual slider moves.

## Sound kits

The **Sound Kit** selector (top of the Audio Engine column) applies instrument
timbre presets — **Synth, Piano, Organ, Trumpet, Strings, Flute, Bass** — built
from custom harmonic waveforms, filter and effect settings on the synth engine
(synthesized approximations, not samples; zero downloads, works offline).
A kit sets where the timbre parameters *rest*; gesture mappings keep modulating
on top. Tweaking any waveform, filter or timbre slider flips the selector to
"Custom". The chosen kit is saved with presets. Kits live in `src/soundkit.js`;
custom waveforms are registered through `engine.defineWave()`.

## Fullscreen camera view

**⛶ FULL** (below the camera toggles) makes the camera view fullscreen — via
the native Fullscreen API where available, or a CSS takeover on iPhone Safari
(which has no element fullscreen). In fullscreen, **🎹 KEYS** overlays the live
pitch-quantise keyboard along the bottom of the view. Gesture overlays keep
their alignment at any screen shape.

## Play along (Guitar Hero mode)

The **Play Along** section starts a falling-note game: notes descend toward a
hit line above the piano keys, and you *hit* a note by steering osc 1's
quantised pitch onto the target as it crosses the line — using whatever gesture
drives `osc1_freq` (a Left-Wrist-Y mapping is added automatically if none
exists). Starting a song turns pitch quantise on in the song's key and restores
your tuning afterwards. A quiet **guide** melody can be toggled; hits and
misses get audio feedback, and scoring tracks streaks and accuracy.

- **Songs** (public domain, bundled in `src/songs.js`): Ode to Joy, Twinkle
  Twinkle, When the Saints, Scarborough Fair. Chart format:
  `{ bpm, beatsPerBar, root, scale, notes: [{ b, m, d }] }` — beat, MIDI note,
  duration in beats.
- **Difficulties:** *easy* (downbeats & long notes only, ±250 ms window,
  slow fall, octave-agnostic matching), *medium* (on-the-beat notes, ±180 ms),
  *hard* (every note, ±120 ms, fast fall).
- The game renders in the panel and — best experience — on the fullscreen
  overlay. Game logic: `src/playalong.js`; renderer: `src/ui/playalong-ui.js`.

## Saving & loading

**SAVE** (in the mapper toolbar) downloads the entire instrument — every
mapping plus all audio parameters, waveform/filter choices and the pitch-quantise
tuning — as a single `.json` file you can keep or share. **LOAD** restores one.
The current session is also stored in `localStorage`, so your setup returns
automatically after a reload or PWA relaunch. Serialisation lives in
`src/preset.js`; `engine.snapshot()`/`restore()` and `mapper.serialize()`/`load()`
own their respective slices of state.

## Available signals

| Key | Description |
|-----|-------------|
| `hand_L_x` / `hand_R_x` | Wrist X position (0 = left edge) |
| `hand_L_y` / `hand_R_y` | Wrist Y position (0 = bottom, 1 = top) |
| `hand_L_open` / `hand_R_open` | Hand openness (0 = fist, 1 = fully open) |
| `hand_L_spread` / `hand_R_spread` | Thumb-to-pinky spread |
| `pinch_L` / `pinch_R` | Thumb-to-index world-space distance (camera-independent) |
| `finger_L_thumb` … `finger_R_pinky` | Individual finger extension (0–1) |
| `elbow_L` / `elbow_R` | Elbow joint angle in degrees — **self-calibrating**: the observed per-user range (nobody's elbow reaches 0° or 180°) maps to the full control range once ≥25° of motion has been seen |
| `shoulder_y_L` / `shoulder_y_R` | Shoulder height |
| `shoulder_width` | Distance between shoulders |
| `arm_raise_L` / `arm_raise_R` | Arm raise (0 = down, 1 = fully raised) |
| `torso_tilt` | Lateral torso lean (−1 = left, +1 = right) |
| `head_x` / `head_y` | Nose position |
| `nose_y` | Raw nose Y (high = head dipped) |
| `hand_L_z` / `hand_R_z` | Hand **distance from camera** (0 = far, 1 = near) |
| `hand_dz` | Depth difference between hands (push one hand forward) |
| `body_z` | Torso distance from camera |
| `depth_near` | Nearest surface in the scene, in metres (LiDAR only) |
| `depth_center` | Depth at frame centre, in metres (LiDAR only) |
| `brow_raise` / `brow_furrow` / `brow_L` / `brow_R` | Eyebrow raise / furrow, per-side outer raise (FACE) |
| `mouth_open` / `smile` / `pucker` / `lips_funnel` | Lip & jaw shapes (FACE) |
| `tongue_out` | Tongue sticking out (FACE) |
| `cheek_puff` / `cheek_squint_L` / `cheek_squint_R` | Cheek shapes (FACE) |
| `ear_L_x/y` / `ear_R_x/y` | Tracked ear positions (FACE) |
| `head_yaw` / `head_roll` | Head orientation derived from the ears, −1..1 (FACE) |
| `gaze_x` / `gaze_y` | Pupil orientation, −1..1, subject's frame (GAZE) |

## Face & gaze tracking (opt-in)

Once the camera is running, two toggles appear under the LiDAR button:

- **☺ FACE** loads MediaPipe `FaceLandmarker` (with blendshapes) and publishes
  eyebrow, lip, tongue, cheek and ear signals. Ears don't articulate, so their
  tracked positions are exposed directly plus derived `head_yaw` / `head_roll`.
- **◉ GAZE** publishes pupil orientation as `gaze_x` / `gaze_y` (−1..1, in the
  subject's frame), drawn live as vectors on the iris.

Both are **off by default** and independent; either loads the shared face model
on first use (`src/face.js`, own detection loop and overlay — the hand/pose
pipeline is untouched). All face/gaze signals are registered up front, so they
can be mapped (and saved in presets) before tracking is enabled.

## Resizable panels

On desktop, drag the dividers between the three columns to resize them
(double-click a divider to reset). Widths persist across sessions.

## Optical depth inputs (LiDAR / ToF)

Out of the box, depth-from-camera is estimated monocularly from MediaPipe
landmarks — apparent hand size and shoulder span. It needs no extra hardware
and works with any webcam, but it is relative and scale-ambiguous.

For **true metric depth**, the `◈ LiDAR` toggle (top-right of the camera view)
opts into the [WebXR Depth Sensing API](https://immersive-web.github.io/depth-sensing/),
which exposes the per-pixel depth map produced by an optical depth sensor —
Apple's **LiDAR** on iOS AR-capable devices, or **ToF** cameras on ARCore
Android. When active, per-landmark depth is sampled directly from the depth map
and transparently replaces the monocular estimate behind the same `*_z` signal
keys, so existing mappings keep working — just more accurately, including in
low-texture and low-light scenes. Two extra metric signals (`depth_near`,
`depth_center`, in metres) are also published.

The toggle is feature-detected: it dims when `immersive-ar` + `depth-sensing`
is unavailable (e.g. desktop browsers, iOS Safari without WebXR), and the app
silently falls back to the monocular estimate. The pluggable backend lives in
`src/depth.js` — additional optical sources (stereo, depth webcams via a
`getUserMedia` depth track) can be added there behind the same signal keys.

## Adding a new signal source

1. In your source module, call `bus.register(key, { label, group, min, max, source })` for each signal in `init()`.
2. Call `bus.update(key, value)` each sample.
3. Call `bus.decay(key)` when the source is absent to fade signals smoothly to zero.

## Project structure

```
index.html          HTML skeleton
css/
  main.css          All styles (CSS variables, layout, components)
src/
  bus.js            Signal registry (incl. adaptive per-user range calibration)
  math.js           Geometry helpers (dist3, angleBetween, handOpenness, fingerExt)
  engine.js         Web Audio API synthesiser
  scale.js          Scale + tuning pitch quantiser
  mapper.js         Signal → audio parameter routing and curves
  preset.js         Save/load of mappings + settings (file + localStorage)
  soundkit.js       Instrument timbre presets (synthesized)
  songs.js          Bundled play-along note charts
  playalong.js      Play-along game logic (scheduler, judging, difficulties)
  cv.js             MediaPipe Hand + Pose source (includes latency HUD)
  depth.js          Optical depth layer (monocular estimate + WebXR LiDAR/ToF)
  face.js           Opt-in face landmark + gaze tracking (blendshape signals)
  main.js           Event handlers and RAF entry point
  ui/
    status.js       Status dot and toast notifications
    resize.js       Draggable panel splitters (desktop)
    fullscreen.js   Fullscreen camera view + keyboard overlay
    keyboard.js     Shared piano-keyboard renderer
    playalong-ui.js Falling-note highway renderer + game panel
    signals.js      Signal panel (build + live update)
    mapper-ui.js    Mapper rows (render + live bars)
    audio-ui.js     Audio panel (waveform buttons, sliders)
    viz.js          Waveform oscilloscope canvas
scripts/
  mobile-serve.mjs  Local HTTPS server for on-device (phone) testing
tests/
  ui-ux/
    index.js        Playwright + Claude Vision UI/UX regression harness
    report.js       HTML report generator
netlify.toml        Deploy config (301 redirect from old URL, SPA fallback)
```

## Running locally

No build step required. Serve the repo root over HTTP (ES modules require a server, not `file://`):

```bash
npx serve .
# or
python3 -m http.server 8080
```

Then open `http://localhost:8080`.

## Testing on mobile

The camera and the WebXR LiDAR depth path both require a **secure context**, so
a phone can't load the app over `http://<lan-ip>` — it needs HTTPS. Rather than
cutting a Netlify deploy preview for every change, serve the repo straight to
your phone over the local network:

```bash
npm run serve:mobile            # HTTPS on https://<your-lan-ip>:8443
npm run serve:mobile -- 9000    # …or a custom port
```

The script generates a self-signed certificate once (into `.cert/`, gitignored)
covering `localhost` and every LAN address, prints the URLs, and — if
`qrcode-terminal` is installed (`npm i -D qrcode-terminal`) — a scannable QR
code. Connect the phone to the **same Wi-Fi**, open the URL, and accept the
certificate warning once (Android Chrome: *Advanced → proceed*; iOS: install +
trust the profile under *Settings → General → VPN & Device Management*).

Notes:
- **WebXR LiDAR depth** needs **Android Chrome + ARCore**. iOS Safari has no
  WebXR, so on iPhone the `◈ LiDAR` toggle stays dimmed and the app falls back
  to the monocular depth estimate — the camera, hand/pose tracking and all
  other signals still work for on-device testing.
- For a **zero-warning trusted URL** (handy for iOS), tunnel the local server
  instead — e.g. `npx localtunnel --port 8443` or `cloudflared tunnel --url
  https://localhost:8443` — or host the static site on **GitHub Pages** for a
  stable HTTPS URL that scales without per-deploy limits.

## UI/UX tests

The test suite takes Playwright screenshots across four viewports and evaluates them with Claude Vision:

```bash
npm install
ANTHROPIC_API_KEY=sk-ant-… npm run test:ui
# open test-results/ui-ux-report.html
```

Without `ANTHROPIC_API_KEY` the screenshots are still saved but LLM evaluation is skipped (CI exits 0).

## Hosting

No build step — serve the repo root as static files over HTTPS.

### Cloudflare Pages (recommended)

1. Go to [pages.cloudflare.com](https://pages.cloudflare.com), connect GitHub, select this repo
2. Build command: *(leave blank)*
3. Publish directory: `.`
4. Deploy — you'll get a free `*.pages.dev` URL

`_redirects` and `_headers` at the repo root are picked up automatically.

### GitHub Pages

Enable GitHub Pages in the repo settings (**Settings → Pages → GitHub Actions**). The included `.github/workflows/deploy.yml` deploys on every push to `main`. The site will be at `https://<user>.github.io/<repo>/`.

Note: GitHub Pages doesn't honour `_headers`, so the service worker is served without `Cache-Control: no-cache`. Chrome re-validates SW files by default regardless, so this is not a practical problem.

### Other static hosts (Render, Surge, etc.)

Serve the repo root. If the host supports Netlify-style redirect files, `_redirects` handles the SPA fallback and the legacy URL redirect automatically.

## Browser requirements

- Chromium 90+, Firefox 90+, Safari 15.4+ (WebGL required for MediaPipe GPU delegate)
- Camera permission required
- HTTPS or `localhost` required (getUserMedia restriction)
