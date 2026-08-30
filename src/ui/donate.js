// Support/donations popover — a compact ♥ button on the camera view that opens
// a small dismissible list of donation links. Link handles are placeholders
// until the maintainer creates the accounts (see README "Support").
//
// The popover hangs off the camera frame rather than off the button's own bar:
// that bar clips its segments to its rounded corners, and a popover inside it
// would be clipped too. The frame is also what goes fullscreen, so the links
// stay reachable there.

const LINKS = [
  ['GitHub Sponsors',   'https://github.com/sponsors/Dentarthurdent42'],
  ['Ko-fi',             'https://ko-fi.com/mathieu71673'],
  ['Buy Me a Coffee',   'https://buymeacoffee.com/dentarthurdent'],
];

export function initDonate() {
  const btn = document.getElementById('donate-btn');
  if (!btn) return;

  const pop = document.createElement('div');
  pop.id = 'donate-pop';
  pop.setAttribute('role', 'menu');
  pop.hidden = true;
  pop.innerHTML = `
    <div class="donate-title">SUPPORT MOTIONMUSE</div>
    ${LINKS.map(([name, url]) => `
      <a href="${url}" target="_blank" rel="noopener" role="menuitem">${name} ↗</a>`).join('')}
  `;
  (document.getElementById('video-wrap') ?? btn.parentElement).appendChild(pop);

  const setOpen = open => {
    pop.hidden = !open;
    btn.setAttribute('aria-expanded', String(open));
  };
  btn.addEventListener('click', e => { e.stopPropagation(); setOpen(pop.hidden); });
  document.addEventListener('click', e => {
    if (!pop.hidden && !pop.contains(e.target)) setOpen(false);
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && !pop.hidden) setOpen(false);
  });
}
