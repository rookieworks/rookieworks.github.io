// Geometría plana pura (sin DOM). Coordenadas en metros.
// Convención: un polígono de habitación tiene área con signo > 0
// (antihorario en ejes matemáticos). El interior queda a la izquierda
// de cada pared, así que la normal interior de la arista (dx,dy) es (-dy,dx).

export const EPS = 1e-9;

export const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y });
export const add = (a, b) => ({ x: a.x + b.x, y: a.y + b.y });
export const mul = (a, k) => ({ x: a.x * k, y: a.y * k });
export const dot = (a, b) => a.x * b.x + a.y * b.y;
export const cross = (a, b) => a.x * b.y - a.y * b.x;
export const len = (a) => Math.hypot(a.x, a.y);
export const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
export const lerp = (a, b, t) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
export const norm = (a) => { const l = len(a) || 1; return { x: a.x / l, y: a.y / l }; };
export const perpL = (a) => ({ x: -a.y, y: a.x });
export const clone = (pts) => pts.map((p) => ({ x: p.x, y: p.y }));

export function signedArea(pts) {
  let s = 0;
  for (let i = 0, n = pts.length; i < n; i++) {
    const a = pts[i], b = pts[(i + 1) % n];
    s += a.x * b.y - b.x * a.y;
  }
  return s / 2;
}
export const area = (pts) => Math.abs(signedArea(pts));

export function perimeter(pts) {
  let s = 0;
  for (let i = 0; i < pts.length; i++) s += dist(pts[i], pts[(i + 1) % pts.length]);
  return s;
}

export function centroid(pts) {
  const A = signedArea(pts);
  if (Math.abs(A) < 1e-9) {
    const c = pts.reduce((s, p) => add(s, p), { x: 0, y: 0 });
    return mul(c, 1 / pts.length);
  }
  let cx = 0, cy = 0;
  for (let i = 0, n = pts.length; i < n; i++) {
    const a = pts[i], b = pts[(i + 1) % n], f = a.x * b.y - b.x * a.y;
    cx += (a.x + b.x) * f; cy += (a.y + b.y) * f;
  }
  return { x: cx / (6 * A), y: cy / (6 * A) };
}

/** Punto interior razonable para la etiqueta (centroide si cae dentro). */
export function labelPoint(pts) {
  const c = centroid(pts);
  if (pointInPolygon(c, pts)) return c;
  // Barrido horizontal por el centroide: punto medio del tramo interior más largo.
  const xs = [];
  for (let i = 0, n = pts.length; i < n; i++) {
    const a = pts[i], b = pts[(i + 1) % n];
    if ((a.y > c.y) !== (b.y > c.y)) xs.push(a.x + ((c.y - a.y) / (b.y - a.y)) * (b.x - a.x));
  }
  xs.sort((p, q) => p - q);
  let best = null;
  for (let i = 0; i + 1 < xs.length; i += 2) {
    if (!best || xs[i + 1] - xs[i] > best[1] - best[0]) best = [xs[i], xs[i + 1]];
  }
  return best ? { x: (best[0] + best[1]) / 2, y: c.y } : c;
}

export function pointInPolygon(p, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const a = pts[i], b = pts[j];
    if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

export const edgeVec = (pts, i) => sub(pts[(i + 1) % pts.length], pts[i]);
export const edgeLen = (pts, i) => len(edgeVec(pts, i));

/** Ángulo interior (radianes, 0..2π) en el vértice i de un polígono con área > 0. */
export function interiorAngle(pts, i) {
  const n = pts.length;
  const cur = pts[i], prev = pts[(i - 1 + n) % n], next = pts[(i + 1) % n];
  const a = sub(prev, cur), b = sub(next, cur);
  let ang = Math.atan2(cross(b, a), dot(b, a));
  if (ang < 0) ang += Math.PI * 2;
  return ang;
}

/** Normal interior unitaria de la pared i (polígono con área > 0). */
export function inwardNormal(pts, i) {
  return norm(perpL(edgeVec(pts, i)));
}

/** Intersección de dos rectas (p + t·d). Devuelve null si son casi paralelas. */
export function intersectLines(p1, d1, p2, d2, minSin = Math.sin((4 * Math.PI) / 180)) {
  const c = cross(d1, d2);
  if (Math.abs(c) < minSin * len(d1) * len(d2)) return null;
  const t = cross(sub(p2, p1), d2) / c;
  return add(p1, mul(d1, t));
}

/** Recta de mejor ajuste (PCA) por un conjunto de puntos. */
export function fitLine(points) {
  const n = points.length;
  const c = mul(points.reduce((s, p) => add(s, p), { x: 0, y: 0 }), 1 / n);
  if (n < 2) return { p: c, d: { x: 1, y: 0 } };
  let sxx = 0, syy = 0, sxy = 0;
  for (const p of points) { const dx = p.x - c.x, dy = p.y - c.y; sxx += dx * dx; syy += dy * dy; sxy += dx * dy; }
  const theta = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  let d = { x: Math.cos(theta), y: Math.sin(theta) };
  // Orientar en el sentido en que se marcaron los puntos.
  if (dot(d, sub(points[n - 1], points[0])) < 0) d = mul(d, -1);
  return { p: c, d };
}

/** Proyección escalar de q sobre la recta a→b (en metros desde a). */
export function projectParam(q, a, b) {
  const d = sub(b, a), L = len(d) || 1;
  return dot(sub(q, a), d) / L;
}

/** Desplazamiento (offset) de un polígono con inglete; d > 0 hacia fuera. */
export function offsetPolygon(pts, d, miterLimit = 4) {
  const n = pts.length, out = [];
  for (let i = 0; i < n; i++) {
    const prev = pts[(i - 1 + n) % n], cur = pts[i], next = pts[(i + 1) % n];
    const n1 = mul(inwardNormal([prev, cur, next], 0), -1); // normal exterior de prev→cur
    const n2 = mul(norm(perpL(sub(next, cur))), -1);
    const p1 = add(prev, mul(n1, d)), q1 = add(cur, mul(n1, d));
    const p2 = add(cur, mul(n2, d)), q2 = add(next, mul(n2, d));
    let x = intersectLines(p1, sub(q1, p1), p2, sub(q2, p2), 1e-4);
    if (!x || dist(x, cur) > Math.abs(d) * miterLimit) x = add(cur, mul(norm(add(n1, n2)), d));
    out.push(x);
  }
  return out;
}

/** Garantiza área > 0. Si invierte, devuelve el mapa de índices de pared viejo→nuevo. */
export function orientCCW(pts) {
  if (signedArea(pts) >= 0) return { pts: clone(pts), reversed: false, wallMap: pts.map((_, i) => i), cornerMap: pts.map((_, i) => i) };
  const n = pts.length;
  // Invertimos manteniendo el vértice 0 como primero: [0, n-1, n-2, ..., 1]
  const order = [0]; for (let i = n - 1; i >= 1; i--) order.push(i);
  const out = order.map((k) => ({ ...pts[k] }));
  // Pared vieja i (i→i+1) pasa a ser la nueva (n-1-i).
  const wallMap = pts.map((_, i) => (n - 1 - i + n) % n);
  const cornerMap = pts.map((_, i) => (i === 0 ? 0 : n - i));
  return { pts: out, reversed: true, wallMap, cornerMap };
}

export function bbox(pts) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of pts) { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); }
  return { x0, y0, x1, y1, w: x1 - x0, h: y1 - y0 };
}

export function rotatePts(pts, ang, c = { x: 0, y: 0 }) {
  const cs = Math.cos(ang), sn = Math.sin(ang);
  return pts.map((p) => { const dx = p.x - c.x, dy = p.y - c.y; return { x: c.x + dx * cs - dy * sn, y: c.y + dx * sn + dy * cs }; });
}

/** Letras de esquina: A..Z, AA, AB... */
export function cornerName(i) {
  let s = ''; i += 1;
  while (i > 0) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); }
  return s;
}

/** ¿Se cortan dos aristas no adyacentes? (polígono autointersectado) */
export function selfIntersects(pts) {
  const n = pts.length;
  const segX = (a, b, c, d) => {
    const d1 = cross(sub(b, a), sub(c, a)), d2 = cross(sub(b, a), sub(d, a));
    const d3 = cross(sub(d, c), sub(a, c)), d4 = cross(sub(d, c), sub(b, c));
    return d1 * d2 < 0 && d3 * d4 < 0;
  };
  for (let i = 0; i < n; i++) for (let j = i + 2; j < n; j++) {
    if (i === 0 && j === n - 1) continue;
    if (segX(pts[i], pts[(i + 1) % n], pts[j], pts[(j + 1) % n])) return true;
  }
  return false;
}
