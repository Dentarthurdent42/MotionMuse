export function setStatus(state, text) {
  const dot = document.getElementById('cv-dot');
  const lbl = document.getElementById('status-lbl');
  const cls = state === 'active' ? 'on' : state === 'loading' ? 'warn' : state === 'error' ? 'err' : '';
  dot.className = `dot ${cls}`;
  // The label is coloured per state in CSS, so the whole chip reads as an
  // indicator rather than a lit dot beside inert text.
  lbl.dataset.state = state;
  lbl.textContent = text;
}

let _toastTimer;
export function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => el.classList.remove('show'), 1400);
}
