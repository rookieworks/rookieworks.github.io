// Modelo de datos del proyecto + persistencia + formato de medidas.
import { clone, orientCCW, edgeLen, interiorAngle, area, perimeter, rotatePts, bbox, cornerName } from './geom.js';

export const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
const STORE_KEY = 'cotas.projects.v1';
const SETTINGS_KEY = 'cotas.settings.v1';

export const DEFAULT_SETTINGS = {
  unit: 'm',            // 'm' | 'cm' | 'mm'
  wallThickness: 0.15,  // grosor de muro para dibujo/3D (m)
  defaultHeight: 2.5,
  autoSquareDeg: 4,     // al escanear: esquinas a ±N° de 90 se fijan como rectas
  author: '',
};

export function newProject(name = 'Proyecto sin nombre') {
  const now = Date.now();
  return { id: uid(), name, createdAt: now, updatedAt: now, rooms: [], notes: '' };
}

/**
 * Habitación.
 *  base  = forma de referencia (escaneo / dibujo). El solver la respeta como "previa blanda".
 *  pts   = forma resuelta (cumple las cotas fijadas). Es la que se dibuja y exporta.
 *  edges[i].locked   = longitud medida (m) de la pared i (pts[i]→pts[i+1]) o null.
 *  corners[i].angle  = ángulo interior fijado (grados) o null. 90 = escuadra.
 *  diagonals = [{id,a,b,locked}]
 *  openings  = [{id,type:'door'|'window'|'opening', wall, offset, width, height, sill, hinge:'start'|'end', swing:'in'|'out'}]
 */
export function newRoom(pts, opts = {}) {
  const o = orientCCW(pts);
  const n = o.pts.length;
  const room = {
    id: uid(),
    name: opts.name || 'Habitación',
    height: opts.height ?? DEFAULT_SETTINGS.defaultHeight,
    heightLocked: !!opts.heightLocked,
    source: opts.source || 'manual', // 'ar' | 'manual'
    base: clone(o.pts),
    pts: clone(o.pts),
    edges: Array.from({ length: n }, () => ({ locked: null })),
    corners: Array.from({ length: n }, () => ({ angle: null })),
    diagonals: [],
    openings: [],
  };
  if (opts.openings) {
    for (const op of opts.openings) room.openings.push(remapOpening(op, o, room.pts));
  }
  return room;
}

function remapOpening(op, o, pts) {
  const out = { id: uid(), hinge: 'start', swing: 'in', ...op };
  if (o.reversed) {
    out.wall = o.wallMap[op.wall];
    const L = edgeLen(pts, out.wall);
    out.offset = Math.max(0, L - op.offset - op.width);
    out.hinge = op.hinge === 'end' ? 'start' : 'end';
  }
  return out;
}

export function roomStats(room) {
  const a = area(room.pts), p = perimeter(room.pts);
  return { area: a, perimeter: p, volume: a * (room.height || 0) };
}

export function wallName(room, i) {
  const n = room.pts.length;
  return `${cornerName(i)}–${cornerName((i + 1) % n)}`;
}

/** Inserta un vértice a mitad de la pared i (divide la pared). */
export function splitWall(room, i, t = 0.5) {
  const n = room.pts.length, j = (i + 1) % n;
  const L = edgeLen(room.pts, i);
  const mid = (P) => ({ x: P[i].x + (P[j].x - P[i].x) * t, y: P[i].y + (P[j].y - P[i].y) * t });
  room.pts.splice(i + 1, 0, mid(room.pts));
  room.base.splice(i + 1, 0, mid(room.base));
  room.edges.splice(i, 1, { locked: null }, { locked: null });
  room.corners.splice(i + 1, 0, { angle: null });
  for (const d of room.diagonals) { if (d.a > i) d.a++; if (d.b > i) d.b++; }
  const cut = L * t;
  for (const op of room.openings) {
    if (op.wall > i) op.wall++;
    else if (op.wall === i && op.offset >= cut) { op.wall = i + 1; op.offset -= cut; }
  }
}

/** Elimina el vértice k (une las dos paredes contiguas en una). */
export function removeCorner(room, k) {
  const n = room.pts.length;
  if (n <= 3) return false;
  const prevWall = (k - 1 + n) % n;
  const prevLen = edgeLen(room.pts, prevWall);
  const merged = k > 0 ? k - 1 : n - 2;
  const wallIdx = (w) => (w === prevWall || w === k ? merged : w > k ? w - 1 : w);
  const cornerIdx = (c) => (c > k ? c - 1 : c);
  const edges = new Array(n - 1);
  room.edges.forEach((e, w) => { if (w !== prevWall && w !== k) edges[wallIdx(w)] = e; });
  edges[merged] = { locked: null };
  room.edges = edges;
  room.pts.splice(k, 1); room.base.splice(k, 1); room.corners.splice(k, 1);
  for (const op of room.openings) {
    if (op.wall === k) op.offset += prevLen;
    op.wall = wallIdx(op.wall);
  }
  const m = n - 1;
  room.diagonals = room.diagonals
    .filter((d) => d.a !== k && d.b !== k)
    .map((d) => ({ ...d, a: cornerIdx(d.a), b: cornerIdx(d.b) }))
    .filter((d) => { const lo = Math.min(d.a, d.b), hi = Math.max(d.a, d.b); return hi - lo > 1 && !(lo === 0 && hi === m - 1); });
  return true;
}

export function translateRoom(room, dx, dy) {
  for (const P of [room.pts, room.base]) for (const p of P) { p.x += dx; p.y += dy; }
}
export function rotateRoom(room, ang) {
  const b = bbox(room.pts), c = { x: (b.x0 + b.x1) / 2, y: (b.y0 + b.y1) / 2 };
  room.pts = rotatePts(room.pts, ang, c);
  room.base = rotatePts(room.base, ang, c);
}

/** Marca como 90° las esquinas que están a ±tol grados de la escuadra. */
export function autoSquare(room, tolDeg = 4) {
  let count = 0;
  room.pts.forEach((_, i) => {
    const a = (interiorAngle(room.pts, i) * 180) / Math.PI;
    for (const target of [90, 270]) {
      if (Math.abs(a - target) <= tolDeg && room.corners[i].angle == null) { room.corners[i].angle = target; count++; }
    }
  });
  return count;
}

export function projectBBox(project) {
  const all = project.rooms.flatMap((r) => r.pts);
  return all.length ? bbox(all) : { x0: 0, y0: 0, x1: 4, y1: 3, w: 4, h: 3 };
}

// ---------- Persistencia (localStorage; los proyectos son JSON pequeños) ----------
function safeGet(key) { try { return localStorage.getItem(key); } catch { return null; } }
function safeSet(key, v) { try { localStorage.setItem(key, v); return true; } catch { return false; } }

export function loadProjects() {
  try { const v = JSON.parse(safeGet(STORE_KEY) || '[]'); return Array.isArray(v) ? v : []; } catch { return []; }
}
export function saveProjects(list) { return safeSet(STORE_KEY, JSON.stringify(list)); }
export function upsertProject(p) {
  p.updatedAt = Date.now();
  const list = loadProjects();
  const i = list.findIndex((q) => q.id === p.id);
  if (i >= 0) list[i] = p; else list.unshift(p);
  return saveProjects(list);
}
export function deleteProject(id) { saveProjects(loadProjects().filter((p) => p.id !== id)); }

export function loadSettings() {
  try { return { ...DEFAULT_SETTINGS, ...(JSON.parse(safeGet(SETTINGS_KEY) || '{}')) }; } catch { return { ...DEFAULT_SETTINGS }; }
}
export function saveSettings(s) { safeSet(SETTINGS_KEY, JSON.stringify(s)); }

/** Valida y normaliza un proyecto importado. Lanza Error si no es válido. */
export function validateProject(p) {
  if (!p || typeof p !== 'object' || !Array.isArray(p.rooms)) throw new Error('El archivo no es un proyecto de Cotas.');
  const num = (v) => typeof v === 'number' && Number.isFinite(v);
  for (const r of p.rooms) {
    if (!Array.isArray(r.pts) || r.pts.length < 3 || !r.pts.every((q) => num(q.x) && num(q.y))) throw new Error('Habitación con geometría inválida.');
    const n = r.pts.length;
    r.id ||= uid(); r.name ||= 'Habitación';
    r.base = Array.isArray(r.base) && r.base.length === n ? r.base : clone(r.pts);
    r.edges = Array.isArray(r.edges) && r.edges.length === n ? r.edges : Array.from({ length: n }, () => ({ locked: null }));
    r.corners = Array.isArray(r.corners) && r.corners.length === n ? r.corners : Array.from({ length: n }, () => ({ angle: null }));
    r.diagonals = Array.isArray(r.diagonals) ? r.diagonals.filter((d) => d.a < n && d.b < n) : [];
    r.openings = Array.isArray(r.openings) ? r.openings.filter((o) => o.wall < n) : [];
    if (!num(r.height)) r.height = DEFAULT_SETTINGS.defaultHeight;
  }
  p.id ||= uid(); p.name ||= 'Proyecto importado';
  p.createdAt ||= Date.now();
  return p;
}

// ---------- Formato y lectura de medidas ----------
const nf = (d) => new Intl.NumberFormat('es-ES', { minimumFractionDigits: d, maximumFractionDigits: d, useGrouping: false });
const NF = { 0: nf(0), 1: nf(1), 2: nf(2), 3: nf(3) };

export function fmtLen(m, unit = 'm', { suffix = true, approx = false } = {}) {
  if (m == null || !Number.isFinite(m)) return '—';
  let s;
  if (unit === 'mm') s = NF[0].format(m * 1000) + (suffix ? ' mm' : '');
  else if (unit === 'cm') s = NF[1].format(m * 100).replace(/,0$/, '') + (suffix ? ' cm' : '');
  else s = NF[2].format(m) + (suffix ? ' m' : '');
  return (approx ? '≈' : '') + s;
}
export const fmtArea = (a) => NF[2].format(a) + ' m²';
export const fmtDeg = (d) => NF[1].format(d).replace(/,0$/, '') + '°';
export const fmtNum = (v, d = 2) => NF[d].format(v);

/**
 * Interpreta lo que escribe el usuario. Acepta "3,42", "3.42", "342 cm", "3420mm", "3 m 42".
 * Sin unidad explícita usa `unit`; si unit = 'm' y el número es > 30 se asume cm (p.ej. "342").
 */
export function parseLen(str, unit = 'm') {
  if (str == null) return null;
  let s = String(str).trim().toLowerCase().replace(/\s+/g, ' ');
  if (!s) return null;
  const mcm = s.match(/^(\d+)\s*m\s*(\d{1,3})\s*(cm)?$/); // "3 m 42"
  if (mcm) return +mcm[1] + +mcm[2] / 100;
  let u = unit;
  const um = s.match(/(mm|cm|m)$/);
  if (um) { u = um[1]; s = s.slice(0, -um[1].length).trim(); }
  if (/^\d{1,3}(\.\d{3})+(,\d+)?$/.test(s)) s = s.replace(/\./g, ''); // 1.250,5
  s = s.replace(',', '.');
  if (!/^\d*\.?\d+$/.test(s) && !/^\d+\.$/.test(s)) return null;
  const v = parseFloat(s);
  if (!Number.isFinite(v) || v <= 0) return null;
  if (u === 'mm') return v / 1000;
  if (u === 'cm') return v / 100;
  if (!um && unit === 'm' && v > 30) return v / 100;
  return v;
}

export function parseDeg(str) {
  const v = parseFloat(String(str).replace(',', '.').replace('°', ''));
  return Number.isFinite(v) && v > 0 && v < 360 ? v : null;
}
