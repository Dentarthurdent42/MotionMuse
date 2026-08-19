// The gesture stage — a fullscreen glass control surface over the camera
// view, driven entirely by bare hands (DEV-gated while under construction).
//
// A "muse ring" breathes at the bottom of the view. Tap it and orbs bloom in
// orbit; tap an orb and its panel materializes as a glass card: PRESETS,
// SOUND KIT, MIXER, KEY. Cards are grabbed by their title bar (pinch-drag),
// scaled with two hands, thrown away with a fling, ripped across the screen
// into your hand with the claw, and a double-clap sweeps the stage clean.
//
// Division of labour: uicontrol.js decides what the hands are doing (it
// emits claw phases and, via uidriver's stage hooks, grabs/drags/drops on
// .stage-bar); stage.js moves the items (pure physics); this module owns the
// DOM, the scene semantics (which card the claw strains, the 2-second
// strain law, what a sweep clears) and the card contents — which reuse the
// app's real apply paths (mapper.applyPreset, applyKit, engine.set), so a
// card is another view of the same state, never a second copy of it.

import { STAGE, orbitSlots, pickTarget, stepPhysics, stretchScale } from '../stage.js';
import { uicontrol, cursorMap, UIC } from '../uicontrol.js';
import { setStageHooks }             from './uidriver.js';
import { fullscreen }                from './fullscreen.js';
import { toast }                     from './status.js';
import { devmode }                   from '../devmode.js';
import { mapper, PRESETS, trackersFor } from '../mapper.js';
import { KITS, applyKit, currentKit }   from '../soundkit.js';
import { engine }                    from '../engine.js';
import { SCALES, NOTE_NAMES }        from '../scale.js';
import { cvSource }                  from '../cv.js';
import { renderMapper }              from './mapper-ui.js';

let on = false;
let layer = null, ring = null;
let items = [];                       // stage.js item objects (+ el, title)
let orbsOut = false;
let lastT = 0;
let stretch = null;                   // { id, sides:[a,b], d0, s0 }
let lastStretchT = 0;
const claws = { L: null, R: null };   // { targetId, litT, ray(px) }
const cursors = { L: { x: 0, y: 0 }, R: { x: 0, y: 0 } };
let nextId = 1;

const vw = () => window.innerWidth;
const vh = () => window.innerHeight;
const byId = id => items.find(i => i.id === id);
const cards = () => items.filter(i => i.kind === 'card');

// ── Card contents ────────────────────────────────────────────────────────
// Each builder returns a DOM fragment wired straight into the app's real
// apply paths. Buttons and sliders inside a card are ordinary targets for
// the cursor's existing adapters — the stage adds no second input system.

const CARD_KINDS = {
  presets: {
    title: 'PRESETS',
    build(body) {
      PRESETS.forEach(p => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'stage-item-btn';
        b.textContent = p.name;
        b.title = p.hint;
        b.addEventListener('click', () => {
          mapper.applyPreset(p.id);
          renderMapper();
          const want = trackersFor(p);
          cvSource.setTracking({ handsL: want.handsL, handsR: want.handsR, pose: want.pose });
          toast(`${p.name} — ${p.hint}`);
        });
        body.appendChild(b);
      });
    },
  },
  kit: {
    title: 'SOUND KIT',
    build(body) {
      Object.entries(KITS).forEach(([id, kit]) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'stage-item-btn';
        b.textContent = kit.label;
        if (currentKit() === id) b.classList.add('sel');
        b.addEventListener('click', () => {
          applyKit(id);
          body.querySelectorAll('.sel').forEach(x => x.classList.remove('sel'));
          b.classList.add('sel');
          toast(`Sound kit: ${kit.label}`);
        });
        body.appendChild(b);
      });
    },
  },
  mixer: {
    title: 'MIXER',
    build(body) {
      // The keys a performer reaches for mid-set. Values sync FROM the
      // engine every frame (tickStage), so the panel sliders and these can
      // never disagree; writes go through engine.set like every other input.
      ['volume', 'osc_volume', 'chord_volume', 'filter_freq', 'reverb_mix']
        .filter(k => engine.PARAMS[k])
        .forEach(k => {
          const p = engine.PARAMS[k];
          const row = document.createElement('label');
          row.className = 'stage-mix-row';
          row.innerHTML = `<span>${p.label}</span>`;
          const r = document.createElement('input');
          r.type = 'range';
          r.min = p.min; r.max = p.max; r.step = (p.max - p.min) / 200;
          r.value = p.val;
          r.dataset.stageKey = k;
          r.addEventListener('input', () => engine.set(k, parseFloat(r.value)));
          row.appendChild(r);
          body.appendChild(row);
        });
    },
  },
  key: {
    title: 'KEY',
    build(body) {
      const t = engine.getTuning();
      const mk = (opts, val, apply) => {
        const s = document.createElement('select');
        opts.forEach(([v, l]) => {
          const o = document.createElement('option');
          o.value = v; o.textContent = l;
          if (v === val) o.selected = true;
          s.appendChild(o);
        });
        s.addEventListener('change', () => apply(s.value));
        body.appendChild(s);
        return s;
      };
      mk([['off', 'GLIDE'], ['on', 'IN KEY']], t.enabled ? 'on' : 'off',
         v => engine.setTuning({ enabled: v === 'on' }));
      mk(NOTE_NAMES.map(n => [n, n]), t.root, v => engine.setTuning({ root: v }));
      mk(Object.keys(SCALES).map(k => [k, k]), t.scale,
         v => engine.setTuning({ scale: v }));
    },
  },
};

// ── Item lifecycle ───────────────────────────────────────────────────────

function addItem(kind, el, x, y) {
  const it = { id: nextId++, kind, el, x, y, vx: 0, vy: 0, scale: 1,
               held: null, slot: null, anim: null };
  el.dataset.stageId = it.id;
  layer.appendChild(el);
  items.push(it);
  return it;
}

function removeItem(it) {
  it.el.remove();
  items = items.filter(x => x !== it);
  for (const s of ['L', 'R']) if (claws[s]?.targetId === it.id) claws[s] = null;
}

function openCard(kindId, x, y) {
  const spec = CARD_KINDS[kindId];
  const existing = cards().find(c => c.cardKind === kindId);
  if (existing) { removeItem(existing); return; }     // tap again = close
  const el = document.createElement('div');
  el.className = 'stage-card mat';
  el.innerHTML = `<div class="stage-bar">${spec.title}</div>`;
  const body = document.createElement('div');
  body.className = 'stage-body';
  spec.build(body);
  el.appendChild(body);
  const it = addItem('card', el, x, y);
  it.cardKind = kindId;
  setTimeout(() => el.classList.remove('mat'), 700);
  return it;
}

function buildRing() {
  ring = document.createElement('button');
  ring.type = 'button';
  ring.className = 'stage-ring';
  ring.innerHTML = `<span>M·U·S·E</span>`;
  ring.title = 'Tap to bloom the panels';
  ring.addEventListener('click', toggleOrbs);
  layer.appendChild(ring);
  const rx = vw() / 2, ry = vh() * 0.74;
  ring.style.left = `${rx}px`;
  ring.style.top  = `${ry}px`;
  ring.dataset.x = rx; ring.dataset.y = ry;
}

function toggleOrbs() {
  orbsOut = !orbsOut;
  if (!orbsOut) {
    items.filter(i => i.kind === 'orb').forEach(removeItem);
    return;
  }
  const kinds = Object.keys(CARD_KINDS);
  const rx = +ring.dataset.x, ry = +ring.dataset.y;
  const r = Math.min(STAGE.ORBIT_R, Math.min(vw(), vh()) * 0.3);
  const slots = orbitSlots(rx, ry, r, kinds.length);
  kinds.forEach((k, i) => {
    const el = document.createElement('button');
    el.type = 'button';
    el.className = 'stage-orb';
    el.textContent = CARD_KINDS[k].title;
    el.addEventListener('click', () =>
      openCard(k, vw() / 2, vh() * 0.4 + (cards().length % 3) * 40));
    const it = addItem('orb', el, rx, ry);       // born at the ring…
    it.slot = slots[i];                          // …blooms to its slot
  });
}

function sweep() {
  if (!on) return false;
  cards().forEach(removeItem);
  if (orbsOut) toggleOrbs();
  toast('STAGE CLEARED');
  return true;
}

// ── Grab / drag / drop (from uidriver's stage hooks) ─────────────────────

function grab(side, cardEl, x, y) {
  const it = byId(+cardEl.dataset.stageId);
  if (!it) return;
  cursors[side] = { x, y };
  if (it.held && it.held !== side) {
    // Second hand on a held card: stretch mode.
    stretch = {
      id: it.id, sides: [it.held, side],
      d0: Math.hypot(cursors.L.x - cursors.R.x, cursors.L.y - cursors.R.y) || 1,
      s0: it.scale,
    };
    return;
  }
  it.held = side;
  it.anim = null;
  it.vx = it.vy = 0;
  it.gox = it.x - x;
  it.goy = it.y - y;
  it.el.classList.add('held');
}

function drag(side, x, y) {
  cursors[side] = { x, y };
  if (stretch) {
    const it = byId(stretch.id);
    if (it) {
      const d = Math.hypot(cursors.L.x - cursors.R.x, cursors.L.y - cursors.R.y);
      it.scale = stretchScale(stretch.s0, stretch.d0, d);
      it.x = (cursors.L.x + cursors.R.x) / 2;
      it.y = (cursors.L.y + cursors.R.y) / 2;
      lastStretchT = performance.now();
    }
    return;
  }
  const it = items.find(i => i.held === side);
  if (it) { it.x = x + it.gox; it.y = y + it.goy; }
}

function drop(side, { kind, pvx = 0, pvy = 0 }) {
  if (stretch && stretch.sides.includes(side)) {
    const it = byId(stretch.id);
    const other = stretch.sides.find(s => s !== side);
    stretch = null;
    lastStretchT = performance.now();
    if (it) it.held = other;                 // the remaining hand keeps it
    return;
  }
  const it = items.find(i => i.held === side);
  if (!it) return;
  it.held = null;
  it.el.classList.remove('held');
  // A two-hand release moments ago is a let-go, never a throw.
  if (kind === 'fling' && performance.now() - lastStretchT > 700) {
    it.vx = pvx; it.vy = pvy;
  }
}

// ── The claw, scene side ─────────────────────────────────────────────────
// uicontrol says what the hand is doing; this decides what it does TO.
// The 2-second strain law lives here because "how long has this card been
// lit" is scene knowledge.

function rayToPx(ray) {
  const m = uicontrol.margin;
  const a = cursorMap(ray.ox, ray.oy, m, vw(), vh());
  const b = cursorMap(ray.ox + ray.dx * 0.05, ray.oy + ray.dy * 0.05, m, vw(), vh());
  let dx = b.x - a.x, dy = b.y - a.y;
  const n = Math.hypot(dx, dy) || 1e-6;
  return { ox: a.x, oy: a.y, dx: dx / n, dy: dy / n };
}

function clawEvent({ side, phase, ray }) {
  if (!on) return;
  const now = performance.now();
  const st = claws[side];
  if (phase === 'coach') { toast('claw ignored — flash OPEN first, then claw'); return; }
  if (phase === 'arm' || phase === 'hold') {
    const pxRay = rayToPx(ray);
    const target = pickTarget(pxRay, cards().filter(c => !c.held && !c.anim));
    if (!target) {
      if (st?.targetId) byId(st.targetId)?.el.style.setProperty('--ch', 0);
      claws[side] = { targetId: null, litT: 0, ray: pxRay };
      return;
    }
    if (st?.targetId !== target.id) {
      if (st?.targetId) byId(st.targetId)?.el.style.setProperty('--ch', 0);
      claws[side] = { targetId: target.id, litT: now, ray: pxRay };
      toast(`aiming: ${CARD_KINDS[target.cardKind].title} — hold the strain`);
    } else {
      st.ray = pxRay;
    }
    return;
  }
  if (phase === 'snap') {
    if (st?.targetId) {
      const it = byId(st.targetId);
      it?.el.style.setProperty('--ch', 0);
      if (it && now - st.litT >= UIC.CLAW_STRAIN_MS) {
        it.anim = { t0: now, from: { x: it.x, y: it.y },
                    to: { ...cursors[side] } };
        it.animSide = side;
      } else if (it) {
        toast('too soon — let it strain, then SNAP');
      }
    }
    claws[side] = null;
    return;
  }
  // drop / lost
  if (st?.targetId) byId(st.targetId)?.el.style.setProperty('--ch', 0);
  claws[side] = null;
}

// ── Enter / exit / per-frame ─────────────────────────────────────────────

export function initStage() {
  layer = document.getElementById('stage-layer');
  const btn = document.getElementById('stage-btn');
  if (!layer || !btn) return;

  btn.addEventListener('click', () => (on ? exit() : enter()));
  fullscreen.onChange(active => { if (!active && on) exit(); });
  // The stage is a DEV feature while under construction; switching DEV off
  // must not leave a hidden mode claiming both hands.
  devmode.onChange(d => { if (!d && on) exit(); });
  uicontrol.setSweep(sweep);
  uicontrol.onEvent(ev => { if (ev.type === 'claw') clawEvent(ev); });
  setStageHooks({ grab, drag, drop });
}

function enter() {
  on = true;
  layer.classList.add('on');
  document.getElementById('stage-btn')?.classList.add('on');
  uicontrol.setStageActive(true);
  if (!fullscreen.active) fullscreen.toggle();
  buildRing();
  toast('THE STAGE — both hands are cursors. Tap the ring; double-clap sweeps.');
}

function exit() {
  on = false;
  uicontrol.setStageActive(false);
  items.slice().forEach(removeItem);
  ring?.remove();
  ring = null;
  orbsOut = false;
  stretch = null;
  layer.classList.remove('on');
  document.getElementById('stage-btn')?.classList.remove('on');
  if (fullscreen.active) fullscreen.toggle();
}

export function updateStage() {
  if (!on) return;
  const now = performance.now();
  const dt = lastT ? Math.min(100, now - lastT) : 16;
  lastT = now;

  // A pulled card chases the hand it is flying to.
  for (const it of items) {
    if (it.anim && it.animSide) it.anim.to = { ...cursors[it.animSide] };
  }

  for (const ev of stepPhysics(items, dt, now, vw(), vh())) {
    if (ev.type === 'culled') removeItem(ev.it);       // thrown off = closed
    if (ev.type === 'arrived') ev.it.el.classList.add('smack');
  }

  // Strain visuals: charge + shake grow over the ramp; the card announces
  // "ready" by holding full charge.
  for (const s of ['L', 'R']) {
    const st = claws[s];
    if (!st?.targetId) continue;
    const it = byId(st.targetId);
    if (!it) continue;
    const hold = Math.min(1, (now - st.litT) / UIC.CLAW_RAMP_MS);
    it.el.style.setProperty('--ch', (0.35 + hold * 0.65).toFixed(3));
    const amp = 1 + hold * 5;
    it.jx = (Math.sin(now / 23) * amp);
    it.jy = (Math.cos(now / 31) * amp);
  }

  // Mixer sliders read back from the engine, so panel and stage agree.
  layer.querySelectorAll('[data-stage-key]').forEach(r => {
    const p = engine.PARAMS[r.dataset.stageKey];
    if (p && document.activeElement !== r) r.value = p.val;
  });

  for (const it of items) {
    const jx = it.jx || 0, jy = it.jy || 0;
    it.el.style.transform =
      `translate(${it.x + jx}px, ${it.y + jy}px) translate(-50%,-50%) scale(${it.scale})`;
    it.jx = it.jy = 0;
  }
}
