// Solver de cotas: mínimos cuadrados no lineales (Levenberg–Marquardt).
// Incógnitas: coordenadas de los vértices. Restricciones duras: cotas medidas,
// diagonales y ángulos fijados. Previas blandas: la forma escaneada/dibujada.
import { interiorAngle, signedArea } from './geom.js';

const W_HARD_LEN = 1 / 0.0003;            // σ = 0,3 mm
const W_HARD_ANG = 1 / (0.02 * Math.PI / 180); // σ = 0,02°
const W_SOFT_LEN = 1 / 0.10;              // σ = 10 cm
const W_SOFT_ANG = 1 / (1.5 * Math.PI / 180);  // σ = 1,5°
const W_ANCHOR = 0.02;                    // fija traslación/rotación (gauge)

const P = (x, i) => ({ x: x[2 * i], y: x[2 * i + 1] });
const D = (x, i, j) => Math.hypot(x[2 * j] - x[2 * i], x[2 * j + 1] - x[2 * i + 1]);

function wrapPi(a) { while (a > Math.PI) a -= 2 * Math.PI; while (a < -Math.PI) a += 2 * Math.PI; return a; }

function angleAt(x, n, i) {
  const pts = [P(x, (i - 1 + n) % n), P(x, i), P(x, (i + 1) % n)];
  return interiorAngle(pts, 1);
}

/** Construye la lista de términos (residuos). kind: 'hard' | 'soft' | 'anchor' */
function buildTerms(room) {
  const n = room.pts.length;
  const base = room.base;
  const xb = base.flatMap((p) => [p.x, p.y]);
  const terms = [];
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n, L = room.edges[i].locked;
    if (L != null) terms.push({ kind: 'hard', ref: { type: 'edge', i }, target: L, f: (x) => (D(x, i, j) - L) * W_HARD_LEN, err: (x) => D(x, i, j) - L });
    else { const Lb = D(xb, i, j); terms.push({ kind: 'soft', f: (x) => (D(x, i, j) - Lb) * W_SOFT_LEN }); }
  }
  for (let i = 0; i < n; i++) {
    const A = room.corners[i].angle;
    if (A != null) { const t = (A * Math.PI) / 180; terms.push({ kind: 'hard', ref: { type: 'corner', i }, target: A, f: (x) => wrapPi(angleAt(x, n, i) - t) * W_HARD_ANG, err: (x) => (wrapPi(angleAt(x, n, i) - t) * 180) / Math.PI }); }
    else { const t = angleAt(xb, n, i); terms.push({ kind: 'soft', f: (x) => wrapPi(angleAt(x, n, i) - t) * W_SOFT_ANG }); }
  }
  for (const d of room.diagonals) {
    if (d.locked == null) continue;
    terms.push({ kind: 'hard', ref: { type: 'diag', id: d.id }, target: d.locked, f: (x) => (D(x, d.a, d.b) - d.locked) * W_HARD_LEN, err: (x) => D(x, d.a, d.b) - d.locked });
  }
  for (let k = 0; k < 2 * n; k++) terms.push({ kind: 'anchor', f: (x) => (x[k] - xb[k]) * W_ANCHOR });
  return { terms, xb };
}

function residuals(terms, x) { const r = new Float64Array(terms.length); for (let k = 0; k < terms.length; k++) r[k] = terms[k].f(x); return r; }

function jacobian(terms, x, r0, which = null) {
  const m = which ? which.length : terms.length, nv = x.length;
  const J = Array.from({ length: m }, () => new Float64Array(nv));
  const xx = Float64Array.from(x);
  for (let c = 0; c < nv; c++) {
    const h = 1e-7 * Math.max(1, Math.abs(x[c]));
    xx[c] = x[c] + h;
    for (let k = 0; k < m; k++) { const t = which ? which[k] : terms[k]; J[k][c] = (t.f(xx) - (which ? t.f(x) : r0[k])) / h; }
    xx[c] = x[c];
  }
  return J;
}

/** Resuelve A·x = b (A simétrica definida positiva) por eliminación gaussiana con pivoteo. */
function solveLinear(A, b) {
  const n = b.length, M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c; for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (Math.abs(M[p][c]) < 1e-300) return null;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = c + 1; r < n; r++) { const f = M[r][c] / M[c][c]; if (f) for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k]; }
  }
  const x = new Float64Array(n);
  for (let r = n - 1; r >= 0; r--) { let s = M[r][n]; for (let k = r + 1; k < n; k++) s -= M[r][k] * x[k]; x[r] = s / M[r][r]; }
  return x;
}

/** Rango numérico de una matriz (eliminación con pivoteo completo). */
export function matrixRank(J, tol = 1e-7) {
  const M = J.map((r) => Array.from(r));
  const rows = M.length, cols = rows ? M[0].length : 0;
  let scale = 0; for (const r of M) for (const v of r) scale = Math.max(scale, Math.abs(v));
  const eps = tol * (scale || 1);
  let rank = 0; const usedCol = new Array(cols).fill(false);
  for (let r = 0; r < rows && rank < cols; r++) {
    // pivote máximo entre filas restantes y columnas libres
    let best = 0, br = -1, bc = -1;
    for (let i = rank; i < rows; i++) for (let c = 0; c < cols; c++) if (!usedCol[c] && Math.abs(M[i][c]) > best) { best = Math.abs(M[i][c]); br = i; bc = c; }
    if (best <= eps) break;
    [M[rank], M[br]] = [M[br], M[rank]];
    usedCol[bc] = true;
    for (let i = rank + 1; i < rows; i++) { const f = M[i][bc] / M[rank][bc]; if (f) for (let c = 0; c < cols; c++) M[i][c] -= f * M[rank][c]; }
    rank++;
  }
  return rank;
}

/**
 * Resuelve la habitación. Devuelve { pts, report } sin mutar la habitación.
 * report = { converged, iterations, freeDof, hardCount, redundant, violations:[{ref, error}], maxError, flipped }
 */
export function solveRoom(room, { maxIter = 120 } = {}) {
  const n = room.pts.length;
  const { terms, xb } = buildTerms(room);
  let x = Float64Array.from(xb);
  let r = residuals(terms, x);
  let cost = r.reduce((s, v) => s + v * v, 0);
  let lambda = 1e-3, it = 0, converged = false;
  const nv = x.length;
  for (; it < maxIter; it++) {
    const J = jacobian(terms, x, r);
    const A = Array.from({ length: nv }, () => new Float64Array(nv));
    const g = new Float64Array(nv);
    for (let k = 0; k < terms.length; k++) {
      const row = J[k], rk = r[k];
      for (let a = 0; a < nv; a++) { const va = row[a]; if (!va) continue; g[a] += va * rk; for (let b = a; b < nv; b++) A[a][b] += va * row[b]; }
    }
    for (let a = 0; a < nv; a++) for (let b = 0; b < a; b++) A[a][b] = A[b][a];
    let improved = false;
    for (let tries = 0; tries < 12; tries++) {
      const Ad = A.map((row, a) => { const rr = Array.from(row); rr[a] += lambda * (row[a] + 1e-9); return rr; });
      const step = solveLinear(Ad, Array.from(g, (v) => -v));
      if (!step) { lambda *= 10; continue; }
      const xn = x.map((v, k) => v + step[k]);
      const rn = residuals(terms, xn);
      const cn = rn.reduce((s, v) => s + v * v, 0);
      if (cn < cost) {
        const stepNorm = Math.sqrt(step.reduce((s, v) => s + v * v, 0));
        x = xn; r = rn; const rel = (cost - cn) / (cost || 1); cost = cn;
        lambda = Math.max(lambda / 3, 1e-12); improved = true;
        if (stepNorm < 1e-10 || rel < 1e-14) converged = true;
        break;
      }
      lambda *= 4;
    }
    if (!improved) { converged = true; break; }
    if (converged) break;
  }

  // Análisis de grados de libertad (solo restricciones duras).
  const hard = terms.filter((t) => t.kind === 'hard');
  let rank = 0;
  if (hard.length) rank = matrixRank(jacobian(hard, x, null, hard));
  const freeDof = Math.max(0, 2 * n - 3 - rank);
  const violations = hard.map((t) => ({ ref: t.ref, target: t.target, error: t.err(x) }));
  const lenErr = violations.filter((v) => v.ref.type !== 'corner').reduce((m, v) => Math.max(m, Math.abs(v.error)), 0);
  const angErr = violations.filter((v) => v.ref.type === 'corner').reduce((m, v) => Math.max(m, Math.abs(v.error)), 0);
  const pts = []; for (let i = 0; i < n; i++) pts.push(P(x, i));
  return {
    pts,
    report: {
      converged, iterations: it, freeDof, hardCount: hard.length, redundant: hard.length - rank,
      violations, maxLenError: lenErr, maxAngError: angErr,
      flipped: signedArea(pts) <= 0,
    },
  };
}

/** Sugerencias de qué medir para definir la forma por completo. */
export function suggestMeasurements(room, report) {
  if (!report || report.freeDof <= 0) return [];
  const n = room.pts.length, out = [];
  for (let i = 0; i < n; i++) if (room.edges[i].locked == null) out.push({ type: 'edge', i });
  for (let i = 0; i < n; i++) if (room.corners[i].angle == null) out.push({ type: 'corner', i });
  if (n >= 4) {
    const has = (a, b) => room.diagonals.some((d) => (d.a === a && d.b === b) || (d.a === b && d.b === a));
    for (let a = 0; a < n; a++) for (let b = a + 2; b < n; b++) { if (a === 0 && b === n - 1) continue; if (!has(a, b)) out.push({ type: 'diag', a, b }); }
  }
  return out;
}
