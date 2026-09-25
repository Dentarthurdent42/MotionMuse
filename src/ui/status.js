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
// `ms` is how long it stays. The default suits a confirmation ("Copied");
// an error someone has to read and act on needs several seconds.
export function toast(msg, ms = 1400) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => el.classList.remove('show'), ms);
}
