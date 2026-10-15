// Lógica del escaneo AR, independiente de WebXR (se prueba con rayos sintéticos).
//
// Principio anti-muebles: nunca se reconstruye la nube de puntos de la sala.
// 1) Se fija el plano del suelo con un hit-test de ARCore.
// 2) Las esquinas/paredes se obtienen intersecando el rayo de la cámara con ese
//    plano (o con una pared detectada). Los muebles no forman parte del modelo.
// 3) En modo "paredes", cada pared se define con 2+ puntos visibles en cualquier
//    tramo libre de muebles y las esquinas se calculan intersecando rectas,
//    así que las esquinas tapadas por un armario no hace falta verlas.
// 4) Alturas, puertas y ventanas: intersección del rayo con el plano vertical
//    de la pared ya conocida (funciona en paredes lisas sin textura).
import { fitLine, intersectLines, orientCCW, dist, sub, dot, len, signedArea, selfIntersects, edgeLen } from './geom.js';

const v3 = (a) => ({ x: a[0], y: a[1], z: a[2] });
const toPlan = (p) => ({ x: p.x, y: p.z });

export const MSG = {
  floor: 'Apunta al suelo y pulsa «Fijar suelo»',
  floorHigh: 'Eso parece una mesa o un mueble: apunta al suelo',
  floorNone: 'Mueve el móvil despacio mirando al suelo hasta que aparezca el círculo',
  aimDown: 'Apunta hacia el suelo',
  tooFar: 'Demasiado lejos: acércate (máx. 8 m)',
  occluded: 'Algo tapa ese punto del suelo (un mueble o la pared). Apunta a la unión pared‑suelo; si la esquina está tapada, usa el modo Paredes',
  corner: 'Apunta a una esquina a ras de suelo y pulsa ＋',
  closeHint: 'Cerca del primer punto: pulsa ＋ para cerrar',
  wallPts: 'Marca 2 o más puntos de esta pared (rodapié o pared visible)',
  wallNext: 'Pulsa «Siguiente pared» o añade más puntos',
  noWall: 'Apunta a una pared de la habitación',
};

export class ScanCore {
  constructor({ mode = 'corners', floorY = null, defaultHeight = 2.5 } = {}) {
    this.mode = mode;
    this.floorY = floorY;
    this.state = floorY == null ? 'floor' : 'walls';
    this.points = [];          // modo esquinas: [{x,y}] en planta
    this.walls = [[]];         // modo paredes: [[{x,y,y3}]]
    this.poly = null;          // polígono cerrado (área > 0)
    this.heightSamples = [];
    this.defaultHeight = defaultHeight;
    this.openings = [];
    this.pending = null;       // {type, step, wall, s:[], y:[]}
    this.reticle = null;
    this.version = 0;          // cambia cuando cambia lo marcado (para redibujar)
    this.warnings = [];
  }

  get height() {
    if (!this.heightSamples.length) return null;
    const s = [...this.heightSamples].sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)];
  }

  // ---------- por fotograma ----------
  /** input: { origin:[x,y,z], dir:[x,y,z] (unitario), hit: {p:[x,y,z], n:[x,y,z]} | null } */
  update(input) {
    const o = v3(input.origin), d = v3(input.dir);
    const hit = input.hit ? { p: v3(input.hit.p), n: v3(input.hit.n) } : null;
    let r;
    if (this.state === 'floor') r = this._floorReticle(o, hit);
    else if (this.state === 'walls') r = this._planReticle(o, d, hit);
    else if (this.state === 'room') r = this._wallReticle(o, d, this.pending && this.pending.step > 0 ? this.pending.wall : null);
    this.reticle = r || null;
    return this.reticle;
  }

  _floorReticle(o, hit) {
    if (!hit) return { kind: 'none', ok: false, msg: MSG.floorNone };
    const horizontal = hit.n.y > 0.85;
    if (!horizontal) return { kind: 'none', ok: false, msg: MSG.floorNone };
    const tooHigh = hit.p.y > o.y - 0.45;
    return { kind: 'floor', ok: !tooHigh, p: hit.p, msg: tooHigh ? MSG.floorHigh : MSG.floor };
  }

  _planReticle(o, d, hit) {
    const tFloor = d.y < -0.03 ? (this.floorY - o.y) / d.y : Infinity;
    const tHit = hit ? Math.hypot(hit.p.x - o.x, hit.p.y - o.y, hit.p.z - o.z) : Infinity;
    const vertical = hit && Math.abs(hit.n.y) < 0.5;
    let p, kind = 'floor', warn = null;
    if (this.mode === 'lines' && vertical && tHit < tFloor - 0.10 && tHit < 8) {
      p = { x: hit.p.x, y: hit.p.y, z: hit.p.z }; kind = 'wall';
    } else {
      if (!Number.isFinite(tFloor)) return { kind: 'none', ok: false, msg: MSG.aimDown };
      if (tFloor > 8) return { kind: 'none', ok: false, msg: MSG.tooFar };
      p = { x: o.x + d.x * tFloor, y: this.floorY, z: o.z + d.z * tFloor };
      if (hit && tHit < tFloor - 0.10 && (vertical || (hit.n.y > 0.85 && hit.p.y > this.floorY + 0.08))) warn = MSG.occluded;
    }
    const plan = toPlan(p);
    let msg = this.mode === 'corners' ? MSG.corner : (this._curWall().length >= 2 ? MSG.wallNext : MSG.wallPts);
    let snapClose = false, live = null;
    if (this.mode === 'corners') {
      if (this.points.length >= 3 && dist(plan, this.points[0]) < 0.2) { snapClose = true; p = { x: this.points[0].x, y: this.floorY, z: this.points[0].y }; msg = MSG.closeHint; }
      if (this.points.length) live = dist(this.points[this.points.length - 1], toPlan(p));
    } else {
      const w = this._curWall();
      if (w.length) live = dist(w[0], plan);
    }
    return { kind, ok: true, p, plan: toPlan(p), warn, msg: warn || msg, snapClose, live };
  }

  /** Rayo contra los planos verticales de las paredes del polígono. */
  _wallReticle(o, d, onlyWall = null) {
    const P = this.poly, n = P.length;
    let best = null;
    const oh = { x: o.x, y: o.z }, dh = { x: d.x, y: d.z };
    for (let i = 0; i < n; i++) {
      if (onlyWall != null && i !== onlyWall) continue;
      const a = P[i], b = P[(i + 1) % n], e = sub(b, a), L = len(e);
      const den = dh.x * e.y - dh.y * e.x;
      if (Math.abs(den) < 1e-6) continue;
      const w = sub(a, oh);
      const t = (w.x * e.y - w.y * e.x) / den;        // parámetro a lo largo del rayo
      const s = (w.x * dh.y - w.y * dh.x) / den * L;   // metros desde a sobre la pared
      if (t <= 0.05) continue;
      const margin = onlyWall != null ? 3 : 0.25;
      if (s < -margin || s > L + margin) continue;
      if (!best || t < best.t) best = { t, wall: i, s: Math.min(Math.max(s, 0), L), L };
    }
    if (!best) return { kind: 'none', ok: false, msg: MSG.noWall };
    const p = { x: o.x + d.x * best.t, y: o.y + d.y * best.t, z: o.z + d.z * best.t };
    const h = p.y - this.floorY;
    return { kind: 'wallplane', ok: h > -0.05 && h < 6, p, wall: best.wall, s: best.s, h, msg: this._roomMsg() };
  }

  _roomMsg() {
    if (!this.pending) return 'Elige: altura, puerta, ventana o terminar';
    const p = this.pending;
    const steps = p.type === 'door' ? ['Apunta a un lateral del hueco de la puerta', 'Apunta al otro lateral', 'Apunta a la parte superior del hueco'] :
      p.type === 'window' ? ['Apunta a un lateral de la ventana', 'Apunta al otro lateral', 'Apunta al alféizar (borde inferior)', 'Apunta al borde superior'] :
        ['Apunta a la unión pared‑techo y pulsa ＋ (puedes repetir para promediar)'];
    return steps[p.step] || '';
  }

  _curWall() { return this.walls[this.walls.length - 1]; }

  // ---------- acciones ----------
  /** Pulsación principal (botón ＋ o tocar pantalla). Devuelve un texto de evento o null. */
  tap() {
    const r = this.reticle;
    if (!r || !r.ok) return null;
    if (this.state === 'floor') {
      this.floorY = r.p.y; this.state = 'walls'; this.version++;
      return 'floor';
    }
    if (this.state === 'walls') {
      if (this.mode === 'corners') {
        if (r.snapClose) return this.close() ? 'closed' : null;
        const last = this.points[this.points.length - 1];
        if (last && dist(last, r.plan) < 0.05) return null; // doble toque
        this.points.push(r.plan); this.version++;
        return 'point';
      }
      this._curWall().push({ ...r.plan, onWall: r.kind === 'wall' }); this.version++;
      return 'point';
    }
    if (this.state === 'room' && this.pending) {
      const p = this.pending;
      if (p.type === 'height') { if (r.h > 1.2) { this.heightSamples.push(r.h); this.version++; return 'height'; } return null; }
      if (p.step === 0) p.wall = r.wall;
      if (p.step <= 1) p.s.push(r.s); else p.y.push(Math.max(0, r.h));
      p.step++; this.version++;
      const need = p.type === 'door' ? 3 : 4;
      if (p.step >= need) {
        const s0 = Math.min(...p.s), s1 = Math.max(...p.s);
        let sill = 0, top = p.y[0];
        if (p.type === 'window') { sill = Math.min(p.y[0], p.y[1]); top = Math.max(p.y[0], p.y[1]); }
        if (s1 - s0 > 0.2 && top - sill > 0.2) {
          this.openings.push({ type: p.type, wall: p.wall, offset: s0, width: s1 - s0, sill, height: top - sill, hinge: 'start', swing: 'in' });
        }
        this.pending = null;
        return 'opening';
      }
      return 'step';
    }
    return null;
  }

  nextWall() {
    if (this.mode !== 'lines') return false;
    const w = this._curWall();
    if (w.length < 2 || this._spread(w) < 0.25) return false;
    this.walls.push([]); this.version++;
    return true;
  }

  _spread(w) { let m = 0; for (const a of w) for (const b of w) m = Math.max(m, dist(a, b)); return m; }

  completeWalls() { return this.walls.filter((w) => w.length >= 2 && this._spread(w) >= 0.25); }

  /** Esquinas calculadas por intersección de rectas consecutivas (modo paredes). */
  lineCorners(closed) {
    const W = this.completeWalls();
    const lines = W.map((w) => fitLine(w));
    const n = lines.length, out = [];
    for (let i = 0; i < n; i++) {
      if (!closed && i === 0) { out.push(null); continue; }
      const A = lines[(i - 1 + n) % n], B = lines[i];
      let c = intersectLines(A.p, A.d, B.p, B.d);
      if (!c) { // casi paralelas: punto medio entre el final de una y el inicio de la otra
        const wa = W[(i - 1 + n) % n], wb = W[i];
        const pa = wa[wa.length - 1], pb = wb[0];
        c = { x: (pa.x + pb.x) / 2, y: (pa.y + pb.y) / 2 };
      }
      out.push(c);
    }
    return { lines, corners: out };
  }

  canClose() {
    return this.mode === 'corners' ? this.points.length >= 3 : this.completeWalls().length >= 3;
  }

  close() {
    if (!this.canClose()) return false;
    let pts = this.mode === 'corners' ? this.points.map((p) => ({ ...p })) : this.lineCorners(true).corners;
    this.warnings = [];
    if (Math.abs(signedArea(pts)) < 0.5) { this.warnings.push('El área es muy pequeña: revisa los puntos.'); return false; }
    if (selfIntersects(pts)) this.warnings.push('Las paredes se cruzan: revisa el orden de los puntos en el editor.');
    const o = orientCCW(pts);
    this.poly = o.pts; this.reversedFrom = o.reversed;
    this.state = 'room'; this.pending = null; this.version++;
    return true;
  }

  reopen() { this.state = 'walls'; this.poly = null; this.openings = []; this.heightSamples = []; this.pending = null; this.version++; }

  begin(type) { // 'height' | 'door' | 'window'
    if (this.state !== 'room') return false;
    this.pending = { type, step: 0, wall: null, s: [], y: [] }; this.version++;
    return true;
  }
  cancelPending() { this.pending = null; this.version++; }

  undo() {
    if (this.state === 'room') {
      if (this.pending) {
        const p = this.pending;
        if (p.type === 'height') { if (this.heightSamples.length) this.heightSamples.pop(); else this.pending = null; }
        else if (p.step === 0) this.pending = null;
        else { p.step--; if (p.step <= 1) p.s.pop(); else p.y.pop(); }
      } else if (this.openings.length) this.openings.pop();
      else this.reopen();
      this.version++; return true;
    }
    if (this.state === 'walls') {
      if (this.mode === 'corners') { if (this.points.length) { this.points.pop(); this.version++; return true; } }
      else {
        const w = this._curWall();
        if (w.length) w.pop(); else if (this.walls.length > 1) { this.walls.pop(); this._curWall().pop(); }
        this.version++; return true;
      }
      if (this.floorY != null) { this.state = 'floor'; this.floorY = null; this.version++; return true; }
    }
    return false;
  }

  /** Resultado en coordenadas de planta (x, z→y). */
  result() {
    if (!this.poly) return null;
    return {
      pts: this.poly.map((p) => ({ ...p })),
      height: this.height ?? this.defaultHeight,
      heightMeasured: this.heightSamples.length > 0,
      openings: this.openings.map((o) => ({ ...o })),
      mode: this.mode,
      warnings: [...this.warnings],
      wallLengths: this.poly.map((_, i) => edgeLen(this.poly, i)),
    };
  }

  // ---------- geometría para dibujar en AR ----------
  visual() {
    const fy = this.floorY ?? 0;
    const P3 = (p, y = fy) => [p.x, y, p.y];
    const out = { points: [], segments: [], labels: [] };
    const seg = (a, b, kind, label) => { out.segments.push({ a, b, kind }); if (label) out.labels.push({ at: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2], text: label }); };
    if (this.state === 'walls') {
      if (this.mode === 'corners') {
        this.points.forEach((p, i) => { out.points.push({ p: P3(p), first: i === 0 }); if (i) seg(P3(this.points[i - 1]), P3(p), 'wall', dist(this.points[i - 1], p)); });
      } else {
        this.walls.forEach((w) => w.forEach((p) => out.points.push({ p: P3(p) })));
        const W = this.completeWalls();
        if (W.length) {
          const { lines, corners } = this.lineCorners(false);
          lines.forEach((l, i) => {
            const c0 = corners[i], c1 = corners[i + 1];
            const w = W[i];
            const along = w.map((p) => dot(sub(p, l.p), l.d));
            const a = c0 || { x: l.p.x + l.d.x * (Math.min(...along) - 0.5), y: l.p.y + l.d.y * (Math.min(...along) - 0.5) };
            const b = c1 || { x: l.p.x + l.d.x * (Math.max(...along) + 0.5), y: l.p.y + l.d.y * (Math.max(...along) + 0.5) };
            seg(P3(a), P3(b), c0 && c1 ? 'wall' : 'guide', c0 && c1 ? dist(a, b) : null);
          });
          corners.forEach((c) => c && out.points.push({ p: P3(c), corner: true }));
        }
      }
    } else if (this.state === 'room') {
      const P = this.poly, n = P.length, h = this.height ?? this.defaultHeight;
      for (let i = 0; i < n; i++) {
        const a = P[i], b = P[(i + 1) % n];
        seg(P3(a), P3(b), 'wall', dist(a, b));
        seg(P3(a, fy + h), P3(b, fy + h), this.heightSamples.length ? 'top' : 'guide');
        seg(P3(a), P3(a, fy + h), this.heightSamples.length ? 'top' : 'guide');
        out.points.push({ p: P3(a), corner: true });
      }
      for (const op of this.openings) {
        const a = P[op.wall], b = P[(op.wall + 1) % n], L = dist(a, b);
        const q = (s) => ({ x: a.x + (b.x - a.x) * (s / L), y: a.y + (b.y - a.y) * (s / L) });
        const q0 = q(op.offset), q1 = q(op.offset + op.width), y0 = fy + op.sill, y1 = fy + op.sill + op.height;
        seg(P3(q0, y0), P3(q1, y0), 'opening', op.width); seg(P3(q0, y1), P3(q1, y1), 'opening');
        seg(P3(q0, y0), P3(q0, y1), 'opening'); seg(P3(q1, y0), P3(q1, y1), 'opening', op.height);
      }
    }
    return out;
  }
}
