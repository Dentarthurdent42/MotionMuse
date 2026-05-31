export const push30 = (arr, v) => { arr.push(v); if (arr.length > 30) arr.shift(); };

export const dist3 = (a, b) => {
  const dx = a.x - b.x, dy = a.y - b.y, dz = (a.z || 0) - (b.z || 0);
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
};

export const angleBetween = (a, b, c) => {
  // Angle at joint b using vectors ba and bc
  const ba = [a.x - b.x, a.y - b.y, (a.z || 0) - (b.z || 0)];
  const bc = [c.x - b.x, c.y - b.y, (c.z || 0) - (b.z || 0)];
  const dot = ba[0] * bc[0] + ba[1] * bc[1] + ba[2] * bc[2];
  const mag = Math.sqrt(ba[0] ** 2 + ba[1] ** 2 + ba[2] ** 2)
            * Math.sqrt(bc[0] ** 2 + bc[1] ** 2 + bc[2] ** 2);
  return mag < 1e-6 ? 0 : Math.acos(Math.min(1, Math.max(-1, dot / mag))) * (180 / Math.PI);
};

export const handOpenness = (lm) => {
  const handSize = dist3(lm[0], lm[9]);
  if (handSize < 1e-4) return 0;
  const tips = [4, 8, 12, 16, 20];
  const avg = tips.reduce((s, i) => s + dist3(lm[0], lm[i]), 0) / tips.length;
  return Math.min(1, avg / (handSize * 2.2));
};

export const fingerExt = (lm, f) => {
  const bases = [2, 5, 9, 13, 17];
  const tips  = [4, 8, 12, 16, 20];
  const norm  = dist3(lm[0], lm[9]);
  return norm < 1e-4 ? 0 : Math.min(1, dist3(lm[bases[f]], lm[tips[f]]) / (norm * 1.5));
};
