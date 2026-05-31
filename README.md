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

## Available signals

| Key | Description |
|-----|-------------|
| `hand_L_x` / `hand_R_x` | Wrist X position (0 = left edge) |
| `hand_L_y` / `hand_R_y` | Wrist Y position (0 = bottom, 1 = top) |
| `hand_L_open` / `hand_R_open` | Hand openness (0 = fist, 1 = fully open) |
| `hand_L_spread` / `hand_R_spread` | Thumb-to-pinky spread |
| `pinch_L` / `pinch_R` | Thumb-to-index world-space distance (camera-independent) |
| `finger_L_thumb` … `finger_R_pinky` | Individual finger extension (0–1) |
| `elbow_L` / `elbow_R` | Elbow joint angle in degrees (0–180) |
| `shoulder_y_L` / `shoulder_y_R` | Shoulder height |
| `shoulder_width` | Distance between shoulders |
| `arm_raise_L` / `arm_raise_R` | Arm raise (0 = down, 1 = fully raised) |
| `torso_tilt` | Lateral torso lean (−1 = left, +1 = right) |
| `head_x` / `head_y` | Nose position |
| `nose_y` | Raw nose Y (high = head dipped) |

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
  bus.js            Signal registry
  math.js           Geometry helpers (dist3, angleBetween, handOpenness, fingerExt)
  engine.js         Web Audio API synthesiser
  mapper.js         Signal → audio parameter routing and curves
  cv.js             MediaPipe Hand + Pose source (includes latency HUD)
  main.js           Event handlers and RAF entry point
  ui/
    status.js       Status dot and toast notifications
    signals.js      Signal panel (build + live update)
    mapper-ui.js    Mapper rows (render + live bars)
    audio-ui.js     Audio panel (waveform buttons, sliders)
    viz.js          Waveform oscilloscope canvas
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

## UI/UX tests

The test suite takes Playwright screenshots across four viewports and evaluates them with Claude Vision:

```bash
npm install
ANTHROPIC_API_KEY=sk-ant-… npm run test:ui
# open test-results/ui-ux-report.html
```

Without `ANTHROPIC_API_KEY` the screenshots are still saved but LLM evaluation is skipped (CI exits 0).

## Browser requirements

- Chromium 90+, Firefox 90+, Safari 15.4+ (WebGL required for MediaPipe GPU delegate)
- Camera permission required
- HTTPS or `localhost` required (getUserMedia restriction)
