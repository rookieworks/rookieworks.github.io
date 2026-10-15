// Plano 2D en SVG: render reutilizable (pantalla, SVG exportado, impresión a escala)
// y editor táctil (pan/zoom con dos dedos, arrastrar vértices, seleccionar cotas).
import * as G from './geom.js';
import { fmtLen, fmtArea, fmtDeg, wallName, translateRoom } from './model.js';

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const f = (v) => (Math.round(v * 100) / 100).toString();

export const PRINT_STYLE = `
.floor{fill:#fbfaf7}.wall{fill:#2b2a27;stroke:#2b2a27;stroke-width:var(--sw)}
.gap{fill:#fbfaf7}.jamb{stroke:#2b2a27;stroke-width:var(--sw)}
.door{stroke:#2b2a27;stroke-width:var(--sw);fill:none}.door-arc{stroke:#2b2a27;stroke-width:calc(var(--sw)*.6);fill:none;stroke-dasharray:calc(var(--sw)*4) calc(var(--sw)*3)}
.win{stroke:#2b2a27;stroke-width:calc(var(--sw)*.8);fill:#fbfaf7}.glass{stroke:#2b2a27;stroke-width:calc(var(--sw)*.6)}
.dim{stroke:#555;stroke-width:calc(var(--sw)*.5);fill:none}.dim.locked{stroke:#b4561a}.dim.bad{stroke:#c0262d}
.dt{fill:#444;font-family:Inter,system-ui,sans-serif}.dt.locked{fill:#b4561a;font-weight:600}.dt.bad{fill:#c0262d;font-weight:700}
.diag{stroke:#777;stroke-width:calc(var(--sw)*.5);stroke-dasharray:calc(var(--sw)*6) calc(var(--sw)*4)}
.cn{fill:#777;font-family:Inter,system-ui,sans-serif;font-weight:600}.ang{fill:#888;font-family:Inter,system-ui,sans-serif}
.rq{stroke:#b4561a;stroke-width:calc(var(--sw)*.5);fill:none}
.rl{fill:#222;font-family:Inter,system-ui,sans-serif;font-weight:600}.rs{fill:#666;font-family:Inter,system-ui,sans-serif}
.tb{fill:none}.chip{display:none}`;

/**
 * opt: { scale, ox, oy, width, height, units:'px'|'mm', font, sw, unit, thickness,
 *        interactive, tool, sel, reports, overall, grid, embedStyle, highlight }
 */
export function planSVG(project, opt) {
  const S = opt.scale, ox = opt.ox, oy = opt.oy;
  const X = (p) => ox + p.x * S, Y = (p) => oy + p.y * S;
  const P = (p) => `${f(X(p))},${f(Y(p))}`;
  const fs = opt.font, sw = opt.sw, th = opt.thickness;
  const unit = opt.unit || 'm';
  const out = [];
  const sizeAttr = opt.units === 'mm' ? `width="${opt.width}mm" height="${opt.height}mm"` : `width="${opt.width}" height="${opt.height}"`;
  out.push(`<svg xmlns="http://www.w3.org/2000/svg" ${sizeAttr} viewBox="0 0 ${f(opt.width)} ${f(opt.height)}" style="--sw:${sw}" class="${opt.embedStyle ? 'plan-doc' : 'plan-svg'}">`);
  if (opt.embedStyle) out.push(`<style>${PRINT_STYLE}</style>`);
  if (opt.grid) out.push(gridSVG(opt));
  const sel = opt.sel || {};
  const isSel = (type, roomId, key) => sel.type === type && sel.roomId === roomId && sel.key === key;

  for (const room of project.rooms) {
    const pts = room.pts, n = pts.length;
    const rep = opt.reports?.[room.id];
    const outer = G.offsetPolygon(pts, th);
    const poly = (arr) => 'M' + arr.map(P).join('L') + 'Z';
    const rid = room.id;
    out.push(`<g class="room${sel.roomId === rid ? ' room-sel' : ''}" data-room="${rid}">`);
    out.push(`<path class="floor" d="${poly(pts)}" ${opt.interactive ? `data-hit="room:${rid}"` : ''}/>`);
    out.push(`<path class="wall" fill-rule="evenodd" d="${poly(outer)}${poly([...pts].reverse())}"/>`);

    if (opt.minimal) { out.push('</g>'); continue; }
    // Aberturas
    for (const op of room.openings) {
      const a = pts[op.wall], b = pts[(op.wall + 1) % n];
      if (!a || !b) continue;
      const L = G.dist(a, b); if (L < 1e-6) continue;
      const u = G.norm(G.sub(b, a)), nin = G.inwardNormal(pts, op.wall), nout = G.mul(nin, -1);
      const s0 = Math.max(0, Math.min(L, op.offset)), s1 = Math.max(0, Math.min(L, op.offset + op.width));
      const i0 = G.add(a, G.mul(u, s0)), i1 = G.add(a, G.mul(u, s1));
      const o0 = G.add(i0, G.mul(nout, th)), o1 = G.add(i1, G.mul(nout, th));
      const selC = isSel('opening', rid, op.id) ? ' sel' : '';
      out.push(`<g class="op${selC}" ${opt.interactive ? `data-hit="opening:${rid}:${op.id}"` : ''}>`);
      out.push(`<path class="gap" d="M${P(i0)}L${P(i1)}L${P(o1)}L${P(o0)}Z"/>`);
      out.push(`<path class="jamb" d="M${P(i0)}L${P(o0)}M${P(i1)}L${P(o1)}"/>`);
      if (op.type === 'door') {
        const hingeAtStart = op.hinge !== 'end';
        const hinge = op.swing === 'out' ? (hingeAtStart ? o0 : o1) : (hingeAtStart ? i0 : i1);
        const other = op.swing === 'out' ? (hingeAtStart ? o1 : o0) : (hingeAtStart ? i1 : i0);
        const dirN = op.swing === 'out' ? nout : nin;
        const w = s1 - s0;
        const leafEnd = G.add(hinge, G.mul(dirN, w));
        // sentido del arco: de leafEnd a other alrededor de hinge
        const c = G.cross(G.sub(leafEnd, hinge), G.sub(other, hinge));
        const sweep = c > 0 ? 1 : 0;
        out.push(`<path class="door" d="M${P(hinge)}L${P(leafEnd)}"/>`);
        out.push(`<path class="door-arc" d="M${P(leafEnd)}A${f(w * S)},${f(w * S)} 0 0 ${sweep} ${P(other)}"/>`);
      } else if (op.type === 'window') {
        const m0 = G.lerp(i0, o0, 0.5), m1 = G.lerp(i1, o1, 0.5);
        const q0 = G.lerp(i0, o0, 0.25), q1 = G.lerp(i1, o1, 0.25), r0 = G.lerp(i0, o0, 0.75), r1 = G.lerp(i1, o1, 0.75);
        out.push(`<path class="win" d="M${P(i0)}L${P(i1)}L${P(o1)}L${P(o0)}Z"/>`);
        out.push(`<path class="glass" d="M${P(q0)}L${P(q1)}M${P(m0)}L${P(m1)}M${P(r0)}L${P(r1)}"/>`);
      } else {
        out.push(`<path class="door-arc" d="M${P(i0)}L${P(o1)}M${P(i1)}L${P(o0)}"/>`);
      }
      // cota del hueco (exterior)
      out.push(dimLine(G.add(i0, G.mul(nout, th)), G.add(i1, G.mul(nout, th)), nout, fs * 1.6 / S, opt, fmtLen(s1 - s0, unit, { suffix: false }), 'dim op-dim', 'dt op-dt', null, 0.8));
      out.push('</g>');
    }

    // Diagonales
    for (const d of room.diagonals) {
      const a = pts[d.a], b = pts[d.b]; if (!a || !b) continue;
      const v = rep?.violations?.find((x) => x.ref.type === 'diag' && x.ref.id === d.id);
      const bad = v && Math.abs(v.error) > 0.002;
      const cls = (d.locked != null ? ' locked' : '') + (bad ? ' bad' : '') + (isSel('diag', rid, d.id) ? ' sel' : '');
      out.push(`<g ${opt.interactive ? `data-hit="diag:${rid}:${d.id}"` : ''}>`);
      out.push(`<path class="diag${cls}" d="M${P(a)}L${P(b)}"/>`);
      if (opt.interactive) out.push(`<path class="hitline" d="M${P(a)}L${P(b)}"/>`);
      const m = G.lerp(a, b, 0.3);
      out.push(textAt(m, G.sub(b, a), fs * 0.95, `${d.locked != null ? '' : '≈'}${fmtLen(G.dist(a, b), unit, { suffix: false })}`, 'dt' + cls, opt, -fs * 0.5));
      out.push('</g>');
    }

    // Cotas interiores de cada pared
    const dimOff = (opt.dimOffset ?? fs * 2.2) / S;
    for (let i = 0; i < n; i++) {
      const a = pts[i], b = pts[(i + 1) % n];
      const nin = G.inwardNormal(pts, i);
      const locked = room.edges[i].locked != null;
      const v = rep?.violations?.find((x) => x.ref.type === 'edge' && x.ref.i === i);
      const bad = v && Math.abs(v.error) > 0.002;
      const cls = (locked ? ' locked' : '') + (bad ? ' bad' : '') + (isSel('wall', rid, i) ? ' sel' : '') + (opt.highlight && opt.highlight.roomId === rid && opt.highlight.type === 'edge' && opt.highlight.i === i ? ' hl' : '');
      const L = G.dist(a, b);
      const txt = (locked ? '' : (room.source === 'ar' ? '≈' : '')) + fmtLen(L, unit, { suffix: false });
      if (opt.interactive) out.push(`<path class="hitline${cls}" data-hit="wall:${rid}:${i}" d="M${P(a)}L${P(b)}"/>`);
      out.push(`<g class="cota${cls}" ${opt.interactive ? `data-hit="wall:${rid}:${i}"` : ''}>`);
      out.push(dimLine(a, b, nin, dimOff, opt, txt, 'dim' + cls, 'dt' + cls, opt.interactive ? `wall:${rid}:${i}` : null));
      out.push('</g>');
    }

    // Esquinas: letra, ángulo, escuadra
    for (let i = 0; i < n; i++) {
      const p = pts[i], prev = pts[(i - 1 + n) % n], next = pts[(i + 1) % n];
      const u1 = G.norm(G.sub(prev, p)), u2 = G.norm(G.sub(next, p));
      let bis = G.norm(G.add(u1, u2));
      const ang = (G.interiorAngle(pts, i) * 180) / Math.PI;
      if (G.len(G.add(u1, u2)) < 1e-6) bis = G.inwardNormal(pts, i);
      if (ang > 180) bis = G.mul(bis, -1);
      const outP = G.add(p, G.mul(bis, -(th + fs * 1.1 / S) / Math.max(0.35, Math.sin((Math.min(ang, 360 - ang) * Math.PI) / 360))));
      const A = room.corners[i].angle;
      const selC = isSel('corner', rid, i) ? ' sel' : '';
      const cName = G.cornerName(i);
      out.push(`<g class="corner${selC}" ${opt.interactive ? `data-hit="corner:${rid}:${i}"` : ''}>`);
      out.push(`<text class="cn${selC}" x="${f(X(outP))}" y="${f(Y(outP))}" font-size="${f(fs * 1.05)}" text-anchor="middle" dominant-baseline="central">${cName}</text>`);
      if (A != null && Math.abs(A - 90) < 1e-6) {
        const k = fs * 0.9 / S;
        const q1 = G.add(p, G.mul(u1, k)), q2 = G.add(p, G.mul(u2, k)), q3 = G.add(G.add(p, G.mul(u1, k)), G.mul(u2, k));
        out.push(`<path class="rq" d="M${P(q1)}L${P(q3)}L${P(q2)}"/>`);
      } else if ((A != null && Math.abs(A - 270) > 1e-6) || (A == null && Math.abs(ang - 90) > 0.4 && Math.abs(ang - 270) > 0.4 && Math.abs(ang - 180) > 0.4)) {
        const ip = G.add(p, G.mul(bis, (fs * 2.2) / S));
        out.push(`<text class="ang${A != null ? ' locked' : ''}" x="${f(X(ip))}" y="${f(Y(ip))}" font-size="${f(fs * 0.85)}" text-anchor="middle" dominant-baseline="central">${A != null ? '' : '≈'}${fmtDeg(ang)}</text>`);
      }
      if (opt.interactive) out.push(`<circle class="vh${opt.tool === 'shape' ? ' on' : ''}" cx="${f(X(p))}" cy="${f(Y(p))}" r="${opt.tool === 'shape' ? 11 : 16}"/>`);
      out.push('</g>');
    }

    // Etiqueta de la habitación
    const lp = G.labelPoint(pts);
    const a = G.area(pts);
    out.push(`<g class="rlabel" ${opt.interactive ? `data-hit="room:${rid}"` : ''}>`);
    out.push(`<text class="rl" x="${f(X(lp))}" y="${f(Y(lp) - fs * 0.7)}" font-size="${f(fs * 1.25)}" text-anchor="middle">${esc(room.name)}</text>`);
    out.push(`<text class="rs" x="${f(X(lp))}" y="${f(Y(lp) + fs * 0.75)}" font-size="${f(fs * 0.95)}" text-anchor="middle">${fmtArea(a)} · h ${room.heightLocked ? '' : '≈'}${fmtLen(room.height, unit, { suffix: false })}</text>`);
    out.push('</g>');
    out.push('</g>');
  }

  if (opt.overall && !opt.minimal && project.rooms.length) out.push(overallDims(project, opt));
  out.push('</svg>');
  return out.join('');
}

/** Línea de cota paralela a a→b, desplazada `off` (m) en la dirección `nrm`. */
function dimLine(a, b, nrm, off, opt, text, cls, tcls, hit = null, fscale = 1) {
  const S = opt.scale, fs = opt.font * fscale;
  const X = (p) => opt.ox + p.x * S, Y = (p) => opt.oy + p.y * S;
  const P = (p) => `${f(X(p))},${f(Y(p))}`;
  const a2 = G.add(a, G.mul(nrm, off)), b2 = G.add(b, G.mul(nrm, off));
  const gap = (fs * 0.3) / S, ext = (fs * 0.4) / S;
  const e1a = G.add(a, G.mul(nrm, gap)), e1b = G.add(a2, G.mul(nrm, ext));
  const e2a = G.add(b, G.mul(nrm, gap)), e2b = G.add(b2, G.mul(nrm, ext));
  const u = G.norm(G.sub(b, a)), tk = (fs * 0.45) / S;
  const tick = (p) => { const d = G.mul(G.norm(G.add(u, nrm)), tk); return `M${P(G.sub(p, d))}L${P(G.add(p, d))}`; };
  const s = [];
  s.push(`<path class="${cls}" d="M${P(e1a)}L${P(e1b)}M${P(e2a)}L${P(e2b)}M${P(a2)}L${P(b2)}${tick(a2)}${tick(b2)}"/>`);
  const m = G.lerp(a2, b2, 0.5);
  // texto del lado de la normal (hacia dentro de la sala para cotas interiores)
  const tp = G.add(m, G.mul(nrm, (fs * 0.75) / S));
  s.push(textAt(tp, G.sub(b, a), fs, text, tcls, opt, 0, hit));
  return s.join('');
}

function textAt(p, dir, fs, text, cls, opt, dy = 0, hit = null) {
  const S = opt.scale;
  const x = opt.ox + p.x * S, y = opt.oy + p.y * S;
  let ang = (Math.atan2(dir.y, dir.x) * 180) / Math.PI;
  if (ang > 90.01) ang -= 180; else if (ang <= -90) ang += 180;
  const w = text.length * fs * 0.58 + fs * 0.8, h = fs * 1.5;
  const bg = opt.interactive ? `<rect class="chip" x="${f(x - w / 2)}" y="${f(y - h / 2 + dy)}" width="${f(w)}" height="${f(h)}" rx="${f(h / 2)}" ${hit ? `data-hit="${hit}"` : ''}/>` : '';
  return `<g transform="rotate(${f(ang)} ${f(x)} ${f(y)})">${bg}<text class="${cls}" x="${f(x)}" y="${f(y + dy)}" font-size="${f(fs)}" text-anchor="middle" dominant-baseline="central">${esc(text)}</text></g>`;
}

function overallDims(project, opt) {
  const th = opt.thickness;
  const all = project.rooms.flatMap((r) => G.offsetPolygon(r.pts, th));
  const b = G.bbox(all);
  const off = (opt.font * 2.6) / opt.scale;
  const s = [];
  s.push(dimLine({ x: b.x0, y: b.y0 }, { x: b.x1, y: b.y0 }, { x: 0, y: -1 }, off, opt, fmtLen(b.w, opt.unit, { suffix: false }), 'dim total', 'dt total'));
  s.push(dimLine({ x: b.x0, y: b.y1 }, { x: b.x0, y: b.y0 }, { x: -1, y: 0 }, off, opt, fmtLen(b.h, opt.unit, { suffix: false }), 'dim total', 'dt total'));
  return s.join('');
}

function gridSVG(opt) {
  const S = opt.scale;
  let step = 1; while (step * S < 40) step *= 2; while (step * S > 160 && step > 0.1) step /= 2;
  const x0 = Math.floor(-opt.ox / S / step) * step, x1 = (opt.width - opt.ox) / S;
  const y0 = Math.floor(-opt.oy / S / step) * step, y1 = (opt.height - opt.oy) / S;
  let d = '';
  for (let x = x0; x <= x1; x += step) { const X = opt.ox + x * S; d += `M${f(X)},0V${f(opt.height)}`; }
  for (let y = y0; y <= y1; y += step) { const Y = opt.oy + y * S; d += `M0,${f(Y)}H${f(opt.width)}`; }
  return `<path class="grid" d="${d}"/>`;
}

// ------------------------------------------------------------------
// Editor interactivo
// ------------------------------------------------------------------
export class PlanEditor {
  constructor(host, { getProject, getReports, getSettings, onSelect, onShapeChange, onRoomMove, onDragStart }) {
    this.host = host; this.getProject = getProject; this.getReports = getReports; this.getSettings = getSettings;
    this.onSelect = onSelect; this.onShapeChange = onShapeChange; this.onRoomMove = onRoomMove; this.onDragStart = onDragStart;
    this.view = { scale: 80, ox: 40, oy: 40 };
    this.tool = 'dims';
    this.sel = null; this.highlight = null;
    this.pointers = new Map();
    this.drag = null;
    this._raf = 0;
    host.addEventListener('pointerdown', (e) => this._down(e));
    host.addEventListener('pointermove', (e) => this._move(e));
    host.addEventListener('pointerup', (e) => this._up(e));
    host.addEventListener('pointercancel', (e) => this._up(e, true));
    host.addEventListener('wheel', (e) => { e.preventDefault(); this._zoomAt(e.offsetX, e.offsetY, Math.exp(-e.deltaY * 0.0015)); }, { passive: false });
    new ResizeObserver(() => this.render()).observe(host);
  }

  setTool(t) { this.tool = t; this.render(); }
  select(sel) { this.sel = sel; this.render(); }

  fit() {
    const p = this.getProject();
    const r = this.host.getBoundingClientRect();
    if (!r.width || !p) return;
    const th = this.getSettings().wallThickness;
    const pts = p.rooms.flatMap((rm) => G.offsetPolygon(rm.pts, th));
    const b = pts.length ? G.bbox(pts) : { x0: -1, y0: -1, x1: 4, y1: 3, w: 5, h: 4 };
    // márgenes: arriba quedan las herramientas y el estado; abajo, los botones
    const padX = 56, padT = 150, padB = 96;
    const s = Math.min((r.width - padX * 2) / Math.max(b.w, 0.5), (r.height - padT - padB) / Math.max(b.h, 0.5));
    this.view.scale = Math.max(5, Math.min(800, s));
    this.view.ox = r.width / 2 - ((b.x0 + b.x1) / 2) * this.view.scale;
    this.view.oy = padT + (r.height - padT - padB) / 2 - ((b.y0 + b.y1) / 2) * this.view.scale;
    this.render();
  }

  toWorld(sx, sy) { return { x: (sx - this.view.ox) / this.view.scale, y: (sy - this.view.oy) / this.view.scale }; }

  render() {
    cancelAnimationFrame(this._raf);
    this._raf = requestAnimationFrame(() => this._render());
  }
  _render() {
    const p = this.getProject(); if (!p) return;
    const r = this.host.getBoundingClientRect();
    const st = this.getSettings();
    this.host.innerHTML = planSVG(p, {
      ...this.view, width: r.width, height: r.height, units: 'px', font: 12.5, sw: 1.4, unit: st.unit,
      thickness: st.wallThickness, interactive: true, tool: this.tool, sel: this.sel, highlight: this.highlight,
      reports: this.getReports(), grid: true, overall: p.rooms.length > 0,
    });
    this.host.dataset.tool = this.tool;
  }

  _local(e) { const r = this.host.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; }

  _down(e) {
    this.host.setPointerCapture?.(e.pointerId);
    const pt = this._local(e);
    this.pointers.set(e.pointerId, pt);
    if (this.pointers.size === 2) { this.drag = { kind: 'pinch', ...this._pinchState() }; return; }
    const hitEl = e.target.closest?.('[data-hit]');
    const hit = hitEl ? hitEl.dataset.hit.split(':') : null;
    this.drag = { kind: 'pan', start: pt, last: pt, moved: false, hit, t0: performance.now() };
    if (hit && hit[0] === 'corner' && this.tool === 'shape') {
      const room = this.getProject().rooms.find((r) => r.id === hit[1]);
      this.drag = { ...this.drag, kind: 'vertex', room, i: +hit[2] };
    } else if (hit && (hit[0] === 'room' || hit[0] === 'wall') && this.tool === 'move') {
      const room = this.getProject().rooms.find((r) => r.id === hit[1]);
      this.drag = { ...this.drag, kind: 'room', room };
    }
  }

  _pinchState() {
    const [a, b] = [...this.pointers.values()];
    return { d0: Math.hypot(a.x - b.x, a.y - b.y), c0: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, v0: { ...this.view } };
  }

  _move(e) {
    if (!this.pointers.has(e.pointerId)) return;
    const pt = this._local(e);
    this.pointers.set(e.pointerId, pt);
    const d = this.drag; if (!d) return;
    if (d.kind === 'pinch' && this.pointers.size >= 2) {
      const [a, b] = [...this.pointers.values()];
      const dd = Math.hypot(a.x - b.x, a.y - b.y), c = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const k = Math.max(5 / d.v0.scale, Math.min(800 / d.v0.scale, dd / (d.d0 || 1)));
      this.view.scale = d.v0.scale * k;
      this.view.ox = c.x - (d.c0.x - d.v0.ox) * k;
      this.view.oy = c.y - (d.c0.y - d.v0.oy) * k;
      this.render(); return;
    }
    if (!d.moved && Math.hypot(pt.x - d.start.x, pt.y - d.start.y) > 6) { d.moved = true; if (d.kind === 'vertex' || d.kind === 'room') this.onDragStart?.(d); }
    if (!d.moved) return;
    if (d.kind === 'pan') {
      this.view.ox += pt.x - d.last.x; this.view.oy += pt.y - d.last.y; d.last = pt; this.render();
    } else if (d.kind === 'vertex') {
      const w = this.toWorld(pt.x, pt.y);
      const r = d.room, n = r.pts.length, prev = r.pts[(d.i - 1 + n) % n], next = r.pts[(d.i + 1) % n];
      const tol = 9 / this.view.scale;
      for (const q of [prev, next]) { if (Math.abs(w.x - q.x) < tol) w.x = q.x; if (Math.abs(w.y - q.y) < tol) w.y = q.y; }
      this.onShapeChange?.(r, d.i, w);
    } else if (d.kind === 'room') {
      const a = this.toWorld(d.last.x, d.last.y), b = this.toWorld(pt.x, pt.y);
      translateRoom(d.room, b.x - a.x, b.y - a.y); d.last = pt; this.render();
    }
  }

  _up(e, cancel) {
    const d = this.drag;
    this.pointers.delete(e.pointerId);
    if (d && d.kind === 'pinch') { if (this.pointers.size === 1) { const pt = [...this.pointers.values()][0]; this.drag = { kind: 'pan', start: pt, last: pt, moved: true }; } else this.drag = null; return; }
    this.drag = null;
    if (!d || cancel) return;
    if (d.kind === 'room' && d.moved) { this.onRoomMove?.(d.room); return; }
    if (d.kind === 'vertex' && d.moved) { this.onShapeChange?.(d.room, d.i, null, true); return; }
    if (!d.moved) {
      const h = d.hit;
      let sel = null;
      if (h) {
        if (h[0] === 'room') sel = { type: 'room', roomId: h[1] };
        else if (h[0] === 'wall') sel = { type: 'wall', roomId: h[1], key: +h[2] };
        else if (h[0] === 'corner') sel = { type: 'corner', roomId: h[1], key: +h[2] };
        else if (h[0] === 'opening') sel = { type: 'opening', roomId: h[1], key: h[2] };
        else if (h[0] === 'diag') sel = { type: 'diag', roomId: h[1], key: h[2] };
      }
      const w = this.toWorld(d.start.x, d.start.y);
      this.sel = sel; this.render();
      this.onSelect?.(sel, w);
    }
  }

  _zoomAt(x, y, k) {
    const s = Math.max(5, Math.min(800, this.view.scale * k)); k = s / this.view.scale;
    this.view.ox = x - (x - this.view.ox) * k; this.view.oy = y - (y - this.view.oy) * k; this.view.scale = s;
    this.render();
  }
  zoom(k) { const r = this.host.getBoundingClientRect(); this._zoomAt(r.width / 2, r.height / 2, k); }
}

export { wallName };
