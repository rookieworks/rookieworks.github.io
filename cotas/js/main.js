// Cotas — controlador de la app.
import * as G from './geom.js';
import * as M from './model.js';
import { solveRoom, suggestMeasurements } from './solver.js';
import { PlanEditor, planSVG } from './plan2d.js';
import * as X from './export.js';

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const params = new URLSearchParams(location.search);

const S = {
  settings: M.loadSettings(),
  project: null,
  reports: {},
  history: [], future: [],
  tab: 'plan',
  editor: null, viewer: null, v3dDirty: true,
  arSupport: null,
};
const U = () => S.settings.unit;
const fl = (m, o) => M.fmtLen(m, U(), o);
const icon = (id) => `<svg><use href="#${id}"/></svg>`;

// ------------------------------------------------------------------ util UI
function toast(msg, ms = 2600) {
  const t = $('#toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toast._t); toast._t = setTimeout(() => (t.hidden = true), ms);
}
function openSheet(html, { onMount, light = false, onClose } = {}) {
  const sh = $('#sheet'), sc = $('#scrim');
  sh.innerHTML = `<div class="grab"></div>${html}`;
  sh.hidden = false; sc.hidden = false; sc.classList.toggle('light', light);
  S.sheetClose = onClose;
  const opened = performance.now();
  // Ignora el «clic fantasma» que llega justo después del toque que abrió la hoja.
  sc.onclick = () => { if (performance.now() - opened > 450) closeSheet(); };
  onMount?.(sh);
  return sh;
}
function closeSheet() {
  $('#sheet').hidden = true; $('#scrim').hidden = true;
  const f = S.sheetClose; S.sheetClose = null; f?.();
}
function showView(v) { $('#v-home').hidden = v !== 'home'; $('#v-project').hidden = v !== 'project'; }

// ------------------------------------------------------------------ datos
function room(id) { return S.project?.rooms.find((r) => r.id === id); }
function solveAll(rooms = S.project.rooms) {
  for (const r of rooms) {
    const { pts, report } = solveRoom(r);
    if (!report.flipped && pts.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y))) r.pts = pts;
    else report.failed = true;
    S.reports[r.id] = report;
  }
}
function save() { if (S.project && !M.upsertProject(S.project)) toast('No se pudo guardar en este dispositivo (¿almacenamiento lleno?)'); }

/** Aplica un cambio con deshacer, re-resuelve y refresca. */
function mutate(fn, { rooms = null, fit = false } = {}) {
  const snap = JSON.stringify(S.project);
  const res = fn();
  if (res === false) return false;
  S.history.push(snap); if (S.history.length > 80) S.history.shift();
  S.future = [];
  solveAll(rooms || S.project.rooms);
  save(); refresh({ fit });
  return true;
}
function undo() { if (!S.history.length) return; S.future.push(JSON.stringify(S.project)); S.project = JSON.parse(S.history.pop()); solveAll(); save(); refresh(); closeSheet(); }
function redo() { if (!S.future.length) return; S.history.push(JSON.stringify(S.project)); S.project = JSON.parse(S.future.pop()); solveAll(); save(); refresh(); closeSheet(); }

function refresh({ fit = false } = {}) {
  if (!S.project) return;
  $('[data-act="undo"]').disabled = !S.history.length;
  $('[data-act="redo"]').disabled = !S.future.length;
  if (fit) S.editor.fit(); else S.editor.render();
  renderStatus();
  if (S.tab === 'dims') renderDims();
  if (S.tab === 'export') renderExport();
  S.v3dDirty = true;
  if (S.tab === '3d') load3D();
}

// ------------------------------------------------------------------ estado de cotas
function roomStatus(r) {
  const rep = S.reports[r.id];
  if (!rep) return { level: 'warn', text: 'Sin resolver' };
  const badLen = rep.violations.filter((v) => v.ref.type !== 'corner' && Math.abs(v.error) > 0.002);
  const badAng = rep.violations.filter((v) => v.ref.type === 'corner' && Math.abs(v.error) > 0.05);
  if (rep.failed) return { level: 'bad', text: `«${r.name}»: las medidas son imposibles (la forma se invierte). Revisa la última cota.` };
  if (badLen.length) {
    const worst = [...badLen].sort((a, b) => Math.abs(b.error) - Math.abs(a.error))[0];
    const where = worst.ref.type === 'edge' ? 'la pared ' + M.wallName(r, worst.ref.i) : 'la diagonal';
    return { level: 'bad', text: `«${r.name}»: las medidas no cierran por ${fl(Math.abs(worst.error))} en ${where}. Vuelve a medir o libera alguna cota.` };
  }
  if (badAng.length) {
    const worst = [...badAng].sort((a, b) => Math.abs(b.error) - Math.abs(a.error))[0];
    return { level: 'bad', text: `«${r.name}»: tus medidas no encajan con los ángulos fijados (desvío ${M.fmtDeg(Math.abs(worst.error))} en ${G.cornerName(worst.ref.i)}). Revisa las cotas o deja libre algún ángulo si la sala no está escuadrada.` };
  }
  const locked = r.edges.filter((e) => e.locked != null).length;
  if (rep.freeDof > 0) return { level: 'warn', text: `«${r.name}»: falta${rep.freeDof > 1 ? 'n' : ''} ${rep.freeDof} medida${rep.freeDof > 1 ? 's' : ''} para fijar la forma${locked ? '' : ' (ahora es la del escaneo)'}` };
  return { level: 'ok', text: `«${r.name}»: forma totalmente definida por tus medidas` };
}
function renderStatus() {
  const el = $('#plan-status');
  const rs = S.project.rooms;
  if (!rs.length) { el.hidden = true; return; }
  el.hidden = false;
  const st = rs.map(roomStatus);
  const pick = st.find((s) => s.level === 'bad') || st.find((s) => s.level === 'warn') || st[0];
  const all = st.every((s) => s.level === 'ok');
  el.className = 'status-chip ' + pick.level;
  el.innerHTML = icon(pick.level === 'ok' ? 'i-check' : 'i-warn') + `<span>${esc(all && rs.length > 1 ? 'Todas las habitaciones están definidas por tus medidas' : pick.text)}</span>`;
}

// ------------------------------------------------------------------ INICIO
function renderHome() {
  const list = M.loadProjects();
  const host = $('#project-list');
  if (!list.length) { host.innerHTML = `<div class="empty">Aún no hay proyectos. Empieza escaneando una habitación o creando un plano por medidas.</div>`; return; }
  host.innerHTML = list.map((p) => {
    const area = p.rooms.reduce((s, r) => s + G.area(r.pts), 0);
    const d = new Date(p.updatedAt).toLocaleDateString('es-ES', { day: 'numeric', month: 'short' });
    return `<button class="pcard" data-open="${p.id}"><span class="thumb">${thumb(p)}</span><span class="meta"><b>${esc(p.name)}</b><small>${p.rooms.length} espacio${p.rooms.length === 1 ? '' : 's'} · ${M.fmtArea(area)} · ${d}</small></span></button>`;
  }).join('');
}
function thumb(p) {
  if (!p.rooms.length) return '';
  const b = M.projectBBox(p), W = 56, H = 44, pad = 4;
  const s = Math.min((W - pad * 2) / Math.max(b.w, 0.1), (H - pad * 2) / Math.max(b.h, 0.1));
  return planSVG(p, { scale: s, ox: W / 2 - ((b.x0 + b.x1) / 2) * s, oy: H / 2 - ((b.y0 + b.y1) / 2) * s, width: W, height: H, units: 'px', font: 4, sw: 0.6, thickness: 0.12, minimal: true });
}

function openProject(p) {
  S.project = p; S.history = []; S.future = []; S.reports = {};
  solveAll();
  $('#proj-name').value = p.name;
  showView('project');
  setTab('plan');
  if (!S.editor) S.editor = new PlanEditor($('#plan-host'), {
    getProject: () => S.project, getReports: () => S.reports, getSettings: () => S.settings,
    onSelect: onPlanSelect, onShapeChange, onRoomMove: () => { save(); refresh(); },
    onDragStart: (d) => { S.history.push(JSON.stringify(S.project)); S.future = []; if (d.kind === 'vertex') d.room.base = G.clone(d.room.pts); },
  });
  S.editor.sel = null;
  setTool('dims');
  requestAnimationFrame(() => { S.editor.fit(); refresh(); });
}
function goHome() { closeSheet(); S.project = null; showView('home'); renderHome(); }

// ------------------------------------------------------------------ PESTAÑAS
function setTab(t) {
  S.tab = t;
  $$('.tabbar button').forEach((b) => b.classList.toggle('on', b.dataset.tab === t));
  for (const k of ['plan', 'dims', '3d', 'export']) $('#tab-' + k).hidden = k !== t;
  if (t === 'plan') S.editor?.render();
  if (t === 'dims') renderDims();
  if (t === 'export') renderExport();
  if (t === '3d') load3D();
}
const HINTS = {
  dims: 'Toca una cota para escribir la medida real. Toca una letra para el ángulo.',
  shape: 'Arrastra las esquinas. Toca una pared para dividirla.',
  openings: 'Toca una pared para añadir una puerta o ventana.',
  move: 'Arrastra una habitación para colocarla junto a otra.',
};
function setTool(t) {
  $$('#tools button').forEach((b) => b.classList.toggle('on', b.dataset.tool === t));
  S.editor.setTool(t);
  $('#tool-hint').textContent = HINTS[t];
}

// ------------------------------------------------------------------ EDITOR: selección
function onPlanSelect(sel, world) {
  if (!sel) { closeSheet(); return; }
  const r = room(sel.roomId); if (!r) return;
  const tool = S.editor.tool;
  if (tool === 'move') { if (sel.type === 'room' || sel.type === 'wall') roomSheet(r); return; }
  if (sel.type === 'wall') {
    if (tool === 'openings') return addOpeningAt(r, sel.key, world);
    if (tool === 'shape') return wallSheet(r, sel.key, { shape: true, world });
    return wallSheet(r, sel.key);
  }
  if (sel.type === 'corner') return cornerSheet(r, sel.key);
  if (sel.type === 'opening') return openingSheet(r, sel.key);
  if (sel.type === 'diag') return diagSheet(r, sel.key);
  if (sel.type === 'room') return roomSheet(r);
}

function onShapeChange(r, i, w, end) {
  if (end) { save(); refresh(); return; }
  r.base[i] = w;
  solveAll([r]);
  S.editor.render(); renderStatus();
}

// ------------------------------------------------------------------ HOJA: pared (medida)
function wallSheet(r, i, { shape = false, world = null } = {}) {
  const n = r.pts.length;
  const L = G.edgeLen(r.pts, i), locked = r.edges[i].locked;
  const baseL = G.edgeLen(r.base, i);
  const ph = U() === 'm' ? 'p. ej. 3,42' : U() === 'cm' ? 'p. ej. 342' : 'p. ej. 3420';
  const val = locked != null ? fl(locked, { suffix: false }) : '';
  S.editor.select({ type: 'wall', roomId: r.id, key: i });
  openSheet(`
    <h3>Pared ${M.wallName(r, i)} <small class="sub">· ${i + 1} de ${n}</small></h3>
    <p class="sub">${locked != null ? `Medida fijada: <b>${fl(locked)}</b>` : `Estimada: ${fl(L, { approx: r.source === 'ar' })}${r.source === 'ar' ? ` (escaneo ${fl(baseL)})` : ''}`}</p>
    <div class="measure">
      <input id="m-in" class="num" inputmode="decimal" enterkeyhint="next" autocomplete="off" placeholder="${ph}" value="${esc(val)}" aria-label="Medida real en ${U()}">
      <button class="btn primary" data-s="ok">${icon('i-check')}</button>
    </div>
    <div class="acts">
      <button class="btn sm" data-s="prev">‹ Anterior</button>
      <button class="btn sm" data-s="next">Siguiente ›</button>
      ${locked != null ? '<button class="btn sm danger" data-s="unlock">Quitar medida</button>' : ''}
    </div>
    <div class="acts">
      <button class="btn sm" data-s="door">+ Puerta</button>
      <button class="btn sm" data-s="window">+ Ventana</button>
      <button class="btn sm" data-s="split">Dividir pared</button>
    </div>`, {
    light: true,
    onClose: () => S.editor.select(null),
    onMount: (sh) => {
      const inp = $('#m-in', sh);
      if (!shape) setTimeout(() => inp.focus(), 60);
      const go = (k) => { const nx = (i + k + n) % n; wallSheet(r, nx); };
      const commit = () => {
        const raw = inp.value.trim();
        if (!raw) { if (locked != null) mutate(() => { r.edges[i].locked = null; }); return true; }
        const v = M.parseLen(raw, U());
        if (v == null || v < 0.05 || v > 200) { toast('Medida no válida'); inp.select(); return false; }
        mutate(() => { r.edges[i].locked = v; });
        if (U() === 'm' && !/[a-z]/i.test(raw) && parseFloat(raw.replace(',', '.')) > 30) toast(`Interpretado como ${fl(v)}`);
        return true;
      };
      inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); if (commit()) nextUnmeasured(r, i); } });
      sh.onclick = (e) => {
        const a = e.target.closest('[data-s]')?.dataset.s; if (!a) return;
        if (a === 'ok') { if (commit()) nextUnmeasured(r, i); }
        else if (a === 'next') { if (inp.value.trim() && inp.value.trim() !== val) commit(); go(1); }
        else if (a === 'prev') { if (inp.value.trim() && inp.value.trim() !== val) commit(); go(-1); }
        else if (a === 'unlock') { mutate(() => { r.edges[i].locked = null; }); wallSheet(r, i); }
        else if (a === 'split') {
          let t = 0.5;
          if (world) { const s = G.projectParam(world, r.pts[i], r.pts[(i + 1) % n]); t = Math.min(0.9, Math.max(0.1, s / G.edgeLen(r.pts, i))); }
          mutate(() => M.splitWall(r, i, t)); closeSheet(); setTool('shape'); toast('Pared dividida: arrastra la nueva esquina');
        } else if (a === 'door' || a === 'window') { closeSheet(); addOpening(r, i, a, G.edgeLen(r.pts, i) / 2); }
      };
    },
  });
}
function nextUnmeasured(r, i) {
  const n = r.pts.length;
  for (let k = 1; k <= n; k++) { const j = (i + k) % n; if (r.edges[j].locked == null) return wallSheet(r, j); }
  closeSheet();
  const st = roomStatus(r);
  toast(st.level === 'ok' ? 'Todas las paredes medidas ✓' : st.text, 4200);
}

// ------------------------------------------------------------------ HOJA: esquina
function cornerSheet(r, i) {
  const ang = (G.interiorAngle(r.pts, i) * 180) / Math.PI, A = r.corners[i].angle;
  const n = r.pts.length;
  const opts = [];
  for (let k = 0; k < n; k++) { if (k === i || k === (i + 1) % n || k === (i - 1 + n) % n) continue; if (!r.diagonals.some((d) => (d.a === i && d.b === k) || (d.a === k && d.b === i))) opts.push(k); }
  S.editor.select({ type: 'corner', roomId: r.id, key: i });
  openSheet(`
    <h3>Esquina ${G.cornerName(i)}</h3>
    <p class="sub">Ángulo interior ${A != null ? 'fijado' : 'actual'}: <b>${M.fmtDeg(A ?? ang)}</b></p>
    <div class="row3">
      <button class="toggle" data-s="a90" aria-pressed="${A === 90}">90°</button>
      <button class="toggle" data-s="a270" aria-pressed="${A === 270}">270° (entrante)</button>
      <button class="toggle" data-s="free" aria-pressed="${A == null}">Libre</button>
    </div>
    <label class="f">Ángulo exacto medido (grados)<input id="ang-in" class="num" inputmode="decimal" placeholder="${M.fmtNum(ang, 1)}" value="${A != null && A !== 90 && A !== 270 ? M.fmtNum(A, 2) : ''}"></label>
    <div class="acts">
      ${opts.length ? `<button class="btn sm" data-s="diag">Medir diagonal ${G.cornerName(i)}–…</button>` : ''}
      <button class="btn sm danger" data-s="del" ${n <= 3 ? 'disabled' : ''}>Eliminar esquina</button>
    </div>
    <div id="diag-pick" class="acts" hidden>${opts.map((k) => `<button class="btn sm" data-d="${k}">${G.cornerName(i)}–${G.cornerName(k)}</button>`).join('')}</div>`, {
    light: true, onClose: () => S.editor.select(null),
    onMount: (sh) => {
      const inp = $('#ang-in', sh);
      inp.addEventListener('change', () => { const v = M.parseDeg(inp.value); if (v) { mutate(() => { r.corners[i].angle = v; }); cornerSheet(r, i); } });
      sh.onclick = (e) => {
        const d = e.target.closest('[data-d]');
        if (d) { const k = +d.dataset.d; let id; mutate(() => { id = M.uid(); r.diagonals.push({ id, a: i, b: k, locked: null }); }); diagSheet(r, id); return; }
        const a = e.target.closest('[data-s]')?.dataset.s; if (!a) return;
        if (a === 'a90') mutate(() => { r.corners[i].angle = 90; });
        else if (a === 'a270') mutate(() => { r.corners[i].angle = 270; });
        else if (a === 'free') mutate(() => { r.corners[i].angle = null; });
        else if (a === 'diag') { $('#diag-pick', sh).hidden = false; return; }
        else if (a === 'del') { mutate(() => M.removeCorner(r, i)); closeSheet(); return; }
        cornerSheet(r, i);
      };
    },
  });
}

// ------------------------------------------------------------------ HOJA: diagonal
function diagSheet(r, id) {
  const d = r.diagonals.find((x) => x.id === id); if (!d) return closeSheet();
  const L = G.dist(r.pts[d.a], r.pts[d.b]);
  S.editor.select({ type: 'diag', roomId: r.id, key: id });
  openSheet(`
    <h3>Diagonal ${G.cornerName(d.a)}–${G.cornerName(d.b)}</h3>
    <p class="sub">Mide de esquina a esquina a ras de suelo. ${d.locked != null ? 'Fijada: <b>' + fl(d.locked) + '</b>' : 'Estimada: ' + fl(L, { approx: true })}</p>
    <div class="measure"><input id="m-in" class="num" inputmode="decimal" enterkeyhint="done" placeholder="${fl(L, { suffix: false })}" value="${d.locked != null ? esc(fl(d.locked, { suffix: false })) : ''}"><button class="btn primary" data-s="ok">${icon('i-check')}</button></div>
    <div class="acts"><button class="btn sm danger" data-s="del">Eliminar diagonal</button></div>`, {
    light: true, onClose: () => S.editor.select(null),
    onMount: (sh) => {
      const inp = $('#m-in', sh); setTimeout(() => inp.focus(), 60);
      const ok = () => { const raw = inp.value.trim(); if (!raw) { mutate(() => { d.locked = null; }); closeSheet(); return; } const v = M.parseLen(raw, U()); if (!v) return toast('Medida no válida'); mutate(() => { d.locked = v; }); closeSheet(); toast(roomStatus(r).text, 3500); };
      inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); ok(); } });
      sh.onclick = (e) => { const a = e.target.closest('[data-s]')?.dataset.s; if (a === 'ok') ok(); if (a === 'del') { mutate(() => { r.diagonals = r.diagonals.filter((x) => x.id !== id); }); closeSheet(); } };
    },
  });
}

// ------------------------------------------------------------------ HOJA: habitación
function roomSheet(r) {
  const st = M.roomStats(r);
  S.editor.select({ type: 'room', roomId: r.id });
  openSheet(`
    <h3>${esc(r.name)}</h3>
    <p class="sub num">${M.fmtArea(st.area)} · perímetro ${fl(st.perimeter)} · ${M.fmtNum(st.volume, 1)} m³</p>
    <div class="row2">
      <label class="f">Nombre<input id="r-name" value="${esc(r.name)}" maxlength="60"></label>
      <label class="f">Altura libre ${r.heightLocked ? '(medida)' : '(estimada)'}<input id="r-h" class="num" inputmode="decimal" value="${fl(r.height, { suffix: false })}"></label>
    </div>
    <div class="acts">
      <button class="btn sm" data-s="square">Escuadrar ≈90°</button>
      <button class="btn sm" data-s="rotL">↺ 90°</button>
      <button class="btn sm" data-s="rotR">↻ 90°</button>
      <button class="btn sm" data-s="rot1">↻ 1°</button>
    </div>
    <div class="acts">
      <button class="btn sm" data-s="dup">Duplicar</button>
      <button class="btn sm danger" data-s="del">Eliminar habitación</button>
    </div>`, {
    onClose: () => S.editor.select(null),
    onMount: (sh) => {
      $('#r-name', sh).addEventListener('change', (e) => mutate(() => { r.name = e.target.value.trim() || 'Habitación'; }));
      $('#r-h', sh).addEventListener('change', (e) => { const v = M.parseLen(e.target.value, U()); if (!v || v > 20) return toast('Altura no válida'); mutate(() => { r.height = v; r.heightLocked = true; }); });
      sh.onclick = (e) => {
        const a = e.target.closest('[data-s]')?.dataset.s; if (!a) return;
        if (a === 'square') { let c = 0; mutate(() => { c = M.autoSquare(r, 6); }); toast(c ? `${c} esquina${c > 1 ? 's' : ''} escuadrada${c > 1 ? 's' : ''}` : 'No hay esquinas cerca de 90°'); }
        if (a === 'rotL') mutate(() => M.rotateRoom(r, -Math.PI / 2));
        if (a === 'rotR') mutate(() => M.rotateRoom(r, Math.PI / 2));
        if (a === 'rot1') mutate(() => M.rotateRoom(r, Math.PI / 180));
        if (a === 'dup') { mutate(() => { const c = JSON.parse(JSON.stringify(r)); c.id = M.uid(); c.name = r.name + ' (copia)'; c.openings.forEach((o) => (o.id = M.uid())); c.diagonals.forEach((d) => (d.id = M.uid())); M.translateRoom(c, G.bbox(r.pts).w + 1, 0); S.project.rooms.push(c); }, { fit: true }); closeSheet(); }
        if (a === 'del') { if (confirm(`¿Eliminar «${r.name}»?`)) { mutate(() => { S.project.rooms = S.project.rooms.filter((x) => x !== r); }); closeSheet(); } }
      };
    },
  });
}

// ------------------------------------------------------------------ HUECOS
const OP_DEF = { door: { width: 0.8, height: 2.03, sill: 0 }, window: { width: 1.2, height: 1.2, sill: 0.9 }, opening: { width: 0.9, height: 2.1, sill: 0 } };
function addOpeningAt(r, wall, world) {
  const a = r.pts[wall], b = r.pts[(wall + 1) % r.pts.length];
  const s = G.projectParam(world, a, b);
  addOpening(r, wall, 'door', s);
}
function addOpening(r, wall, type, center) {
  const L = G.edgeLen(r.pts, wall), d = OP_DEF[type];
  const width = Math.min(d.width, Math.max(0.3, L - 0.1));
  const offset = Math.max(0, Math.min(L - width, center - width / 2));
  const op = { id: M.uid(), type, wall, offset, width, height: d.height, sill: d.sill, hinge: 'start', swing: 'in' };
  mutate(() => { r.openings.push(op); });
  openingSheet(r, op.id);
}
function openingSheet(r, id) {
  const op = r.openings.find((o) => o.id === id); if (!op) return closeSheet();
  const n = r.pts.length, A = G.cornerName(op.wall), B = G.cornerName((op.wall + 1) % n);
  const L = G.edgeLen(r.pts, op.wall);
  S.editor.select({ type: 'opening', roomId: r.id, key: id });
  const T = { door: 'Puerta', window: 'Ventana', opening: 'Hueco' };
  const v = (m) => fl(m, { suffix: false });
  openSheet(`
    <h3>${T[op.type]} en pared ${A}–${B}</h3>
    <p class="sub">Medidas en ${U()}. La pared mide ${fl(L)}.</p>
    <div class="seg" style="box-shadow:none;margin-bottom:6px">${Object.entries(T).map(([k, t]) => `<button data-type="${k}" class="${op.type === k ? 'on' : ''}">${t}</button>`).join('')}</div>
    <div class="row2">
      <label class="f">Ancho<input data-k="width" class="num" inputmode="decimal" value="${v(op.width)}"></label>
      <label class="f">Distancia desde ${A}<input data-k="offset" class="num" inputmode="decimal" value="${v(op.offset)}"></label>
      <label class="f">Alto del hueco<input data-k="height" class="num" inputmode="decimal" value="${v(op.height)}"></label>
      ${op.type !== 'door' ? `<label class="f">Alféizar (desde suelo)<input data-k="sill" class="num" inputmode="decimal" value="${v(op.sill)}"></label>` : '<div></div>'}
    </div>
    ${op.type === 'door' ? `<div class="row2">
      <button class="toggle" data-s="hinge">Bisagra junto a ${op.hinge === 'end' ? B : A}</button>
      <button class="toggle" data-s="swing">Abre hacia ${op.swing === 'out' ? 'fuera' : 'dentro'}</button></div>` : ''}
    <div class="acts"><button class="btn sm" data-s="center">Centrar en la pared</button><button class="btn sm danger" data-s="del">Eliminar</button><button class="btn sm primary" data-s="close">Listo</button></div>`, {
    onClose: () => S.editor.select(null),
    onMount: (sh) => {
      $$('[data-k]', sh).forEach((inp) => inp.addEventListener('change', () => {
        const val = inp.dataset.k === 'sill' && /^0+([,.]0*)?$/.test(inp.value.trim()) ? 0 : M.parseLen(inp.value, U());
        if (val == null) return toast('Medida no válida');
        mutate(() => { op[inp.dataset.k] = val; if (op.offset + op.width > L) op.offset = Math.max(0, L - op.width); });
      }));
      sh.onclick = (e) => {
        const t = e.target.closest('[data-type]');
        if (t) { mutate(() => { const prev = OP_DEF[op.type], d = OP_DEF[t.dataset.type]; if (Math.abs(op.width - prev.width) < 1e-6) op.width = Math.min(d.width, L); op.type = t.dataset.type; op.sill = d.sill; op.height = d.height; if (op.offset + op.width > L) op.offset = Math.max(0, L - op.width); }); return openingSheet(r, id); }
        const a = e.target.closest('[data-s]')?.dataset.s; if (!a) return;
        if (a === 'hinge') mutate(() => { op.hinge = op.hinge === 'end' ? 'start' : 'end'; });
        if (a === 'swing') mutate(() => { op.swing = op.swing === 'out' ? 'in' : 'out'; });
        if (a === 'center') mutate(() => { op.offset = Math.max(0, (L - op.width) / 2); });
        if (a === 'del') { mutate(() => { r.openings = r.openings.filter((o) => o !== op); }); return closeSheet(); }
        if (a === 'close') return closeSheet();
        openingSheet(r, id);
      };
    },
  });
}

// ------------------------------------------------------------------ PESTAÑA COTAS
const fieldKey = (el) => `input[data-room="${el.dataset.room}"]` + (el.dataset.edge != null ? `[data-edge="${el.dataset.edge}"]` : el.dataset.diag ? `[data-diag="${el.dataset.diag}"]` : el.dataset.op ? `[data-op="${el.dataset.op}"]` : '[data-height]');
function renderDims() {
  const host = $('#tab-dims');
  if (!S.project.rooms.length) { host.innerHTML = `<div class="dims"><div class="empty">Añade una habitación para ver sus cotas.</div></div>`; return; }
  const ph = U() === 'm' ? 'medir' : 'medir';
  host.innerHTML = `<div class="dims">${S.project.rooms.map((r) => {
    const st = roomStatus(r), rep = S.reports[r.id], n = r.pts.length;
    const sug = suggestMeasurements(r, rep);
    const sugDiag = sug.find((s) => s.type === 'diag');
    const viol = (type, key) => rep?.violations.find((v) => v.ref.type === type && (type === 'edge' ? v.ref.i === key : type === 'corner' ? v.ref.i === key : v.ref.id === key));
    const rowsW = r.pts.map((_, i) => {
      const L = G.edgeLen(r.pts, i), lk = r.edges[i].locked, v = viol('edge', i), bad = v && Math.abs(v.error) > 0.002;
      return `<div class="drow"><div class="lbl">Pared ${M.wallName(r, i)}${r.openings.some((o) => o.wall === i) ? '<small>con huecos</small>' : ''}</div>
        <div class="est ${bad ? 'bad' : ''}">${bad ? 'cierra a ' + fl(L, { suffix: false }) : lk != null ? '' : fl(L, { suffix: false, approx: r.source === 'ar' })}</div>
        <input class="field ${lk != null ? 'locked' : ''}" inputmode="decimal" enterkeyhint="next" placeholder="${ph}" data-room="${r.id}" data-edge="${i}" value="${lk != null ? esc(fl(lk, { suffix: false })) : ''}"></div>`;
    }).join('');
    const rowsA = r.pts.map((_, i) => {
      const a = (G.interiorAngle(r.pts, i) * 180) / Math.PI, A = r.corners[i].angle;
      return `<div class="drow"><div class="lbl">Esquina ${G.cornerName(i)}</div><div class="est">${A == null ? M.fmtDeg(a) : ''}</div>
        <button class="toggle" data-room="${r.id}" data-corner="${i}" aria-pressed="${A != null}">${A != null ? M.fmtDeg(A) : 'Libre'}</button></div>`;
    }).join('');
    const rowsD = r.diagonals.map((d) => {
      const L = G.dist(r.pts[d.a], r.pts[d.b]), v = viol('diag', d.id), bad = v && Math.abs(v.error) > 0.002;
      return `<div class="drow"><div class="lbl">Diagonal ${G.cornerName(d.a)}–${G.cornerName(d.b)}</div><div class="est ${bad ? 'bad' : ''}">${bad ? 'cierra a ' + fl(L, { suffix: false }) : d.locked != null ? '' : fl(L, { suffix: false, approx: true })}</div>
        <input class="field ${d.locked != null ? 'locked' : ''}" inputmode="decimal" placeholder="${ph}" data-room="${r.id}" data-diag="${d.id}" value="${d.locked != null ? esc(fl(d.locked, { suffix: false })) : ''}"></div>`;
    }).join('');
    const sugRow = sugDiag && rep.freeDof > 0 && r.edges.every((e) => e.locked != null) ? `<div class="drow suggest"><div class="lbl">Diagonal ${G.cornerName(sugDiag.a)}–${G.cornerName(sugDiag.b)}<small>Sugerida: con ella la forma queda fijada</small></div><div class="est">${fl(G.dist(r.pts[sugDiag.a], r.pts[sugDiag.b]), { suffix: false, approx: true })}</div>
        <button class="btn sm" data-room="${r.id}" data-adddiag="${sugDiag.a},${sugDiag.b}">Añadir</button></div>` : '';
    const rowsO = r.openings.map((o, k) => `<div class="drow"><div class="lbl">${o.type === 'door' ? 'Puerta' : o.type === 'window' ? 'Ventana' : 'Hueco'} ${k + 1}<small>pared ${M.wallName(r, o.wall)} · a ${fl(o.offset)} de ${G.cornerName(o.wall)}</small></div><div class="est">alto ${fl(o.height, { suffix: false })}</div>
        <input class="field" inputmode="decimal" data-room="${r.id}" data-op="${o.id}" value="${esc(fl(o.width, { suffix: false }))}" aria-label="Ancho"></div>`).join('');
    return `<section class="dcard">
      <div class="dhead"><b>${esc(r.name)}</b><small class="num">${M.fmtArea(G.area(r.pts))}</small></div>
      <div class="dstat ${st.level}">${icon(st.level === 'ok' ? 'i-check' : 'i-warn')}<span>${esc(st.text)}</span></div>
      <div class="dgroup">Paredes (${U()})</div>${rowsW}
      <div class="drow"><div class="lbl">Altura libre</div><div class="est">${r.heightLocked ? '' : fl(r.height, { suffix: false, approx: true })}</div>
        <input class="field ${r.heightLocked ? 'locked' : ''}" inputmode="decimal" placeholder="${ph}" data-room="${r.id}" data-height="1" value="${r.heightLocked ? esc(fl(r.height, { suffix: false })) : ''}"></div>
      <div class="dgroup">Diagonales</div>${rowsD}${sugRow}${!rowsD && !sugRow ? '<div class="drow"><div class="lbl"><small>Una diagonal fija la forma sin depender de los ángulos. Añádela desde una esquina en el plano.</small></div></div>' : ''}
      <div class="dgroup">Ángulos</div>${rowsA}
      ${rowsO ? `<div class="dgroup">Huecos (ancho)</div>${rowsO}` : ''}
      <div class="dactions"><button class="btn sm" data-room="${r.id}" data-square="1">Escuadrar ≈90°</button><button class="btn sm" data-room="${r.id}" data-clear="1">Borrar medidas</button></div>
    </section>`;
  }).join('')}</div>`;

  const fields = $$('input.field', host);
  fields.forEach((inp, idx) => {
    inp.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      const nx = fields[idx + 1], key = nx && fieldKey(nx);
      inp.blur(); // dispara «change» → se recalcula y se vuelve a pintar la lista
      if (key) setTimeout(() => { const el = $(key, host); el?.focus(); el?.scrollIntoView({ block: 'center', behavior: 'smooth' }); }, 40);
    });
    inp.addEventListener('change', () => {
      const r = room(inp.dataset.room); const raw = inp.value.trim();
      const v = raw ? M.parseLen(raw, U()) : null;
      if (raw && v == null) { toast('Medida no válida'); return; }
      if (inp.dataset.edge != null) mutate(() => { r.edges[+inp.dataset.edge].locked = v; });
      else if (inp.dataset.diag) mutate(() => { r.diagonals.find((d) => d.id === inp.dataset.diag).locked = v; });
      else if (inp.dataset.height) mutate(() => { if (v) { r.height = v; r.heightLocked = true; } else r.heightLocked = false; });
      else if (inp.dataset.op && v) mutate(() => { const o = r.openings.find((x) => x.id === inp.dataset.op); o.width = v; });
    });
  });
  host.onclick = (e) => {
    const b = e.target.closest('button[data-room]'); if (!b) return;
    const r = room(b.dataset.room);
    if (b.dataset.corner != null) { const i = +b.dataset.corner; mutate(() => { const a = (G.interiorAngle(r.pts, i) * 180) / Math.PI; r.corners[i].angle = r.corners[i].angle != null ? null : (Math.abs(a - 270) < Math.abs(a - 90) ? 270 : 90); }); }
    if (b.dataset.adddiag) { const [a, c] = b.dataset.adddiag.split(',').map(Number); let id; mutate(() => { id = M.uid(); r.diagonals.push({ id, a, b: c, locked: null }); }); setTimeout(() => $(`[data-diag="${id}"]`, host)?.focus(), 30); }
    if (b.dataset.square) { let c = 0; mutate(() => { c = M.autoSquare(r, 6); }); toast(c ? `${c} esquinas escuadradas` : 'No hay esquinas cerca de 90°'); }
    if (b.dataset.clear && confirm('¿Quitar todas las medidas y ángulos fijados de esta habitación?')) mutate(() => { r.edges.forEach((x) => (x.locked = null)); r.corners.forEach((x) => (x.angle = null)); r.diagonals.forEach((x) => (x.locked = null)); r.heightLocked = false; });
  };
}

// ------------------------------------------------------------------ PESTAÑA EXPORTAR
function renderExport() {
  const p = S.project;
  const area = p.rooms.reduce((s, r) => s + G.area(r.pts), 0);
  const per = p.rooms.reduce((s, r) => s + G.perimeter(r.pts), 0);
  const vol = p.rooms.reduce((s, r) => s + G.area(r.pts) * r.height, 0);
  const items = [
    ['pdf-a4', 'PDF A4', 'Lámina a escala con cajetín (imprimir → Guardar como PDF)'],
    ['pdf-a3', 'PDF A3', 'Para planos grandes o escala mayor'],
    ['dxf-mm', 'DXF (mm)', 'AutoCAD, LibreCAD, BricsCAD… por capas'],
    ['dxf-m', 'DXF (m)', 'Mismo dibujo con unidad = metro'],
    ['svg', 'SVG a escala', 'Vectorial para Illustrator / Inkscape'],
    ['png', 'Imagen PNG', 'Para enviar por WhatsApp'],
    ['glb', 'Modelo 3D (GLB)', 'SketchUp, Blender, visores 3D'],
    ['obj', 'Modelo 3D (OBJ)', 'Formato 3D universal'],
    ['csv', 'Tabla de medidas', 'CSV para Excel / Sheets'],
    ['json', 'Copia del proyecto', 'Para guardar o abrir en otro móvil'],
  ];
  $('#tab-export').innerHTML = `<div class="exp">
    <div class="exp-summary"><div><b>${M.fmtArea(area)}</b><small>superficie</small></div><div><b>${fl(per)}</b><small>perímetro</small></div><div><b>${M.fmtNum(vol, 1)} m³</b><small>volumen</small></div></div>
    <h3>Exportar y compartir</h3>
    <div class="exp-grid">${items.map(([k, t, d]) => `<button class="exp-item" data-exp="${k}"><b>${t}</b><small>${d}</small></button>`).join('')}</div>
    <p class="note">Las cotas que aún llevan «≈» son estimaciones del escaneo. Escribe las medidas reales en la pestaña Cotas antes de usar el plano para obra o presupuesto.</p>
  </div>`;
}
async function doExport(k) {
  const p = S.project, st = S.settings, base = X.slug(p.name);
  if (!p.rooms.length) return toast('No hay nada que exportar');
  try {
    if (k === 'pdf-a4' || k === 'pdf-a3') { const lay = X.printSheet(p, st, k === 'pdf-a4' ? 'A4' : 'A3'); toast(`Escala 1:${lay.denom}. Elige «Guardar como PDF».`, 4000); return; }
    let blob, name;
    if (k === 'dxf-mm' || k === 'dxf-m') { blob = X.dxfBlob(p, st, { units: k === 'dxf-mm' ? 'mm' : 'm' }); name = `${base}${k === 'dxf-m' ? '-m' : ''}.dxf`; }
    if (k === 'svg') { blob = new Blob([X.toSVGFile(p, st).svg], { type: 'image/svg+xml' }); name = base + '.svg'; }
    if (k === 'png') { blob = await X.toPNG(p, st); name = base + '.png'; }
    if (k === 'glb' || k === 'obj') { const V = await import('./view3d.js'); blob = k === 'glb' ? await V.exportGLB(p, st) : await V.exportOBJ(p, st); name = `${base}.${k}`; }
    if (k === 'csv') { blob = new Blob([X.toCSV(p, st)], { type: 'text/csv' }); name = base + '-medidas.csv'; }
    if (k === 'json') { blob = new Blob([JSON.stringify({ app: 'cotas', version: 1, ...p }, null, 1)], { type: 'application/json' }); name = base + '.cotas.json'; }
    await X.share(blob, name, p.name);
  } catch (e) { console.error(e); toast('Error al exportar: ' + e.message, 4000); }
}

// ------------------------------------------------------------------ 3D
async function load3D() {
  const host = $('#v3d-host');
  if (!S.viewer) {
    host.innerHTML = '<div class="empty" style="margin:20px">Cargando 3D…</div>';
    const V = await import('./view3d.js');
    host.innerHTML = '';
    S.viewer = new V.Viewer3D(host);
    S.v3dDirty = true;
  }
  if (S.v3dDirty && S.tab === '3d') { S.viewer.resize(); S.viewer.load(S.project, S.settings, !S._v3dFitted); S._v3dFitted = true; S.v3dDirty = false; }
}

// ------------------------------------------------------------------ NUEVO: escaneo
async function newScanSheet() {
  const sim = params.has('sim');
  openSheet(`
    <h3>Escanear habitación</h3>
    <p class="sub">Con Chrome y ARCore. Sujeta el móvil vertical y muévete despacio. Buena luz ayuda mucho.</p>
    <div class="opt-list">
      <button class="opt on" data-mode="corners">${icon('i-scan')}<span><b>Esquinas</b><small>Lo más rápido. Marca cada esquina a ras de suelo, en orden.</small></span></button>
      <button class="opt" data-mode="lines">${icon('i-ruler')}<span><b>Paredes (con muebles)</b><small>Marca 2 o más puntos de cada pared donde se vea, por encima o entre los muebles. Las esquinas tapadas se calculan solas.</small></span></button>
    </div>
    <div id="ar-check" class="note">Comprobando AR…</div>
    <div class="acts"><button class="btn" data-s="cancel">Cancelar</button><button class="btn primary" data-s="start" disabled>Empezar</button></div>
    <div class="acts" id="sim-row" ${sim ? '' : 'hidden'}><button class="btn sm" data-s="sim">Probar en simulador</button></div>`, {
    onMount: async (sh) => {
      let mode = 'corners';
      const arMod = import('./ar.js');
      sh.onclick = async (e) => {
        const o = e.target.closest('[data-mode]');
        if (o) { mode = o.dataset.mode; $$('.opt', sh).forEach((x) => x.classList.toggle('on', x === o)); return; }
        const a = e.target.closest('[data-s]')?.dataset.s; if (!a) return;
        if (a === 'cancel') return closeSheet();
        if (a === 'start' || a === 'sim') { closeSheet(); startScan(await arMod, mode, a === 'sim'); }
      };
      const A = await arMod;
      S.arSupport ||= await A.arSupport();
      const box = $('#ar-check', sh); if (!box) return;
      if (S.arSupport.ok) { box.innerHTML = '<b>AR disponible.</b> Primero apunta al suelo para fijarlo.'; $('[data-s="start"]', sh).disabled = false; }
      else { box.innerHTML = `<b>AR no disponible aquí.</b> ${esc(S.arSupport.reason)} Mientras tanto puedes crear el plano por medidas.`; $('#sim-row', sh).hidden = false; }
    },
  });
}

async function startScan(A, mode, sim) {
  let created = false;
  if (!S.project) { S.project = M.newProject('Escaneo ' + new Date().toLocaleString('es-ES', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })); created = true; S.history = []; S.future = []; S.reports = {}; }
  const proj = S.project;
  const existing = proj.rooms.length ? M.projectBBox(proj) : null;
  const ctrl = new A.ScanController({
    overlay: $('#ar-overlay'), settings: S.settings, sim, existingBBox: existing,
    onRoom: (res) => {
      const r = M.newRoom(res.pts, { name: `Habitación ${proj.rooms.length + 1}`, source: 'ar', height: res.height, heightLocked: false, openings: res.openings });
      M.autoSquare(r, S.settings.autoSquareDeg);
      if (proj.rooms.length) { S.history.push(JSON.stringify(proj)); S.future = []; }
      proj.rooms.push(r);
      S.project = proj; solveAll([r]); save();
      return { summary: `${M.fmtArea(G.area(r.pts))} · ${r.pts.length} paredes${res.heightMeasured ? ' · h ' + fl(res.height) : ''}` };
    },
    onExit: (count) => {
      if (!proj.rooms.length) { if (created) { M.deleteProject(proj.id); S.project = null; } if (!S.project) goHome(); else refresh(); return; }
      if (created || $('#v-project').hidden) openProject(proj); else { refresh({ fit: true }); }
      if (count) toast('Ahora escribe tus medidas reales: toca cada cota', 4200);
    },
  });
  try { await ctrl.start(mode); }
  catch (e) {
    console.error(e);
    ctrl._cleanup?.();
    toast('No se pudo iniciar la cámara AR: ' + (e.message || e), 5000);
  }
}

// ------------------------------------------------------------------ NUEVO: por medidas
function manualSheet() {
  const u = U(), v = (m) => M.fmtLen(m, u, { suffix: false });
  openSheet(`
    <h3>Plano por medidas</h3>
    <p class="sub">Medidas en ${u === 'm' ? 'metros' : u}. Quedan fijadas como cotas reales.</p>
    <div class="seg" style="box-shadow:none" id="tpl">
      <button data-t="rect" class="on">Rectángulo</button><button data-t="L">Forma L</button><button data-t="walk">Recorrido</button><button data-t="free">Dibujar</button>
    </div>
    <div id="tpl-body"></div>
    <label class="f">Nombre del espacio<input id="t-name" value="Habitación ${S.project ? S.project.rooms.length + 1 : 1}" maxlength="60"></label>
    <div class="acts"><button class="btn" data-s="cancel">Cancelar</button><button class="btn primary" data-s="create">Crear</button></div>`, {
    onMount: (sh) => {
      let t = 'rect';
      const body = $('#tpl-body', sh);
      const draw = () => {
        if (t === 'rect') body.innerHTML = `<div class="row3"><label class="f">Ancho<input id="t-a" class="num" inputmode="decimal" value="${v(4)}"></label><label class="f">Fondo<input id="t-b" class="num" inputmode="decimal" value="${v(3)}"></label><label class="f">Altura<input id="t-h" class="num" inputmode="decimal" value="${v(S.settings.defaultHeight)}"></label></div>`;
        if (t === 'L') body.innerHTML = `<svg viewBox="0 0 120 70" style="width:150px;height:84px;display:block;margin:8px auto;color:var(--muted)"><path d="M10 10h100v25H60v25H10z" fill="none" stroke="currentColor" stroke-width="2"/><g font-size="9" fill="currentColor" text-anchor="middle"><text x="60" y="8">A</text><text x="4" y="38">B</text><text x="85" y="44">a</text><text x="70" y="50">b</text></g></svg>
          <div class="row2"><label class="f">A · ancho total<input id="t-a" class="num" inputmode="decimal" value="${v(5)}"></label><label class="f">B · fondo total<input id="t-b" class="num" inputmode="decimal" value="${v(4)}"></label>
          <label class="f">a · ancho del entrante<input id="t-c" class="num" inputmode="decimal" value="${v(2)}"></label><label class="f">b · fondo del entrante<input id="t-d" class="num" inputmode="decimal" value="${v(2)}"></label></div>
          <label class="f">Altura<input id="t-h" class="num" inputmode="decimal" value="${v(S.settings.defaultHeight)}"></label>`;
        if (t === 'walk') {
          body.innerHTML = `<p class="sub" style="margin-top:10px">Recorre la sala por dentro empezando en una esquina. Para cada pared escribe su longitud y hacia dónde giras al final. La última pared se cierra sola.</p><div id="walk"></div>
            <div class="acts"><button class="btn sm" data-s="wadd">+ Pared</button><button class="btn sm" data-s="wdel">− Quitar</button></div>
            <label class="f">Altura<input id="t-h" class="num" inputmode="decimal" value="${v(S.settings.defaultHeight)}"></label>`;
          for (let i = 0; i < 3; i++) addWalk(i === 0 ? 4 : i === 1 ? 3 : 4);
        }
        if (t === 'free') body.innerHTML = `<p class="sub" style="margin-top:10px">Se crea un rectángulo de 4 × 3 m sin cotas fijadas. Usa la herramienta <b>Forma</b> para arrastrar esquinas y dividir paredes, y después escribe las medidas.</p><label class="f">Altura<input id="t-h" class="num" inputmode="decimal" value="${v(S.settings.defaultHeight)}"></label>`;
      };
      const addWalk = (len = '') => {
        const w = $('#walk', sh), k = w.children.length + 1;
        w.insertAdjacentHTML('beforeend', `<div class="walk-row"><b>${k}</b><input class="num" inputmode="decimal" placeholder="longitud" value="${len === '' ? '' : v(len)}"><select><option value="R">gira a la derecha</option><option value="L">gira a la izquierda</option></select></div>`);
      };
      draw();
      sh.onclick = (e) => {
        const tb = e.target.closest('[data-t]');
        if (tb) { t = tb.dataset.t; $$('#tpl button', sh).forEach((b) => b.classList.toggle('on', b === tb)); draw(); return; }
        const a = e.target.closest('[data-s]')?.dataset.s; if (!a) return;
        if (a === 'cancel') return closeSheet();
        if (a === 'wadd') return addWalk();
        if (a === 'wdel') { const w = $('#walk', sh); if (w.children.length > 2) w.lastElementChild.remove(); return; }
        if (a === 'create') {
          const num = (id) => M.parseLen($(id, sh)?.value, u);
          const h = num('#t-h') || S.settings.defaultHeight;
          let pts, lockAll = true;
          if (t === 'rect') { const A = num('#t-a'), B = num('#t-b'); if (!A || !B) return toast('Revisa las medidas'); pts = [{ x: 0, y: 0 }, { x: A, y: 0 }, { x: A, y: B }, { x: 0, y: B }]; }
          if (t === 'L') { const A = num('#t-a'), B = num('#t-b'), c = num('#t-c'), d = num('#t-d'); if (!A || !B || !c || !d || c >= A || d >= B) return toast('Revisa las medidas: el entrante debe ser menor que el total'); pts = [{ x: 0, y: 0 }, { x: A, y: 0 }, { x: A, y: B - d }, { x: A - c, y: B - d }, { x: A - c, y: B }, { x: 0, y: B }]; }
          let walkInfo = null;
          if (t === 'walk') {
            const rows = $$('#walk .walk-row', sh).map((rw) => ({ L: M.parseLen($('input', rw).value, u), turn: $('select', rw).value }));
            if (rows.some((r) => !r.L)) return toast('Falta alguna longitud');
            pts = [{ x: 0, y: 0 }]; let dir = { x: 1, y: 0 };
            for (const r of rows) { const p = pts[pts.length - 1]; pts.push({ x: p.x + dir.x * r.L, y: p.y + dir.y * r.L }); dir = r.turn === 'R' ? { x: -dir.y, y: dir.x } : { x: dir.y, y: -dir.x }; }
            const gap = G.dist(pts[pts.length - 1], pts[0]);
            const closed = rows.length >= 3 && gap < 0.15; // cierra (con un pequeño error de medida)
            if (closed) pts.pop();
            if (pts.length < 3 || G.area(pts) < 0.3) return toast('El recorrido no forma una sala cerrada');
            const nP = pts.length;
            walkInfo = { closed, entered: rows.map((r, k) => ({ a: pts[k], b: pts[(k + 1) % nP], L: r.L })) };
          }
          if (t === 'free') { pts = [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 3 }, { x: 0, y: 3 }]; lockAll = false; }
          const name = $('#t-name', sh).value.trim() || 'Habitación';
          closeSheet();
          createManualRoom(pts, { name, height: h, lockAll, walkInfo });
        }
      };
    },
  });
}
function createManualRoom(pts, { name, height, lockAll, walkInfo }) {
  const fresh = !S.project;
  if (fresh) { S.project = M.newProject(name === 'Habitación 1' ? 'Proyecto ' + new Date().toLocaleDateString('es-ES') : name); S.reports = {}; }
  const r = M.newRoom(pts, { name, height, heightLocked: lockAll, source: 'manual' });
  const n = r.pts.length;
  const edgeOf = (a, b) => r.pts.findIndex((p, i) => { const q = r.pts[(i + 1) % n]; return (G.dist(p, a) < 1e-6 && G.dist(q, b) < 1e-6) || (G.dist(p, b) < 1e-6 && G.dist(q, a) < 1e-6); });
  if (lockAll) {
    r.corners.forEach((c, i) => { const a = (G.interiorAngle(r.pts, i) * 180) / Math.PI; for (const t of [90, 270]) if (Math.abs(a - t) < 1) c.angle = t; });
    if (walkInfo) {
      for (const w of walkInfo.entered) { const j = edgeOf(w.a, w.b); if (j >= 0) r.edges[j].locked = w.L; }
      if (!walkInfo.closed) { // la pared de cierre y sus dos esquinas se calculan
        const j = edgeOf(pts[pts.length - 1], pts[0]);
        if (j >= 0) { r.edges[j].locked = null; r.corners[j].angle = null; r.corners[(j + 1) % n].angle = null; }
      }
    } else r.edges.forEach((e, i) => (e.locked = G.edgeLen(r.pts, i)));
  }
  if (!fresh) {
    const b = M.projectBBox(S.project), rb = G.bbox(r.pts);
    M.translateRoom(r, b.x1 + 1.2 - rb.x0, b.y0 - rb.y0);
    mutate(() => { S.project.rooms.push(r); }, { fit: true });
  } else { S.project.rooms.push(r); save(); openProject(S.project); }
  if (!lockAll) setTool('shape');
  else if (walkInfo?.closed) { const st = roomStatus(r); if (st.level === 'bad') toast(st.text, 5000); }
}

// ------------------------------------------------------------------ Ajustes / menú
function settingsSheet() {
  const s = S.settings;
  const theme = (() => { try { return localStorage.getItem('cotas.theme') || 'auto'; } catch { return 'auto'; } })();
  openSheet(`
    <h3>Ajustes</h3>
    <div class="row2">
      <label class="f">Unidad de las cotas<select id="s-unit"><option value="m">metros (3,42)</option><option value="cm">centímetros (342)</option><option value="mm">milímetros (3420)</option></select></label>
      <label class="f">Tema<select id="s-theme"><option value="auto">Automático</option><option value="dark">Oscuro</option><option value="light">Claro</option></select></label>
      <label class="f">Grosor de muro (cm)<input id="s-th" class="num" inputmode="decimal" value="${M.fmtNum(s.wallThickness * 100, 0)}"></label>
      <label class="f">Altura por defecto (m)<input id="s-h" class="num" inputmode="decimal" value="${M.fmtNum(s.defaultHeight, 2)}"></label>
      <label class="f">Escuadrar al escanear (± grados)<input id="s-sq" class="num" inputmode="decimal" value="${M.fmtNum(s.autoSquareDeg, 0)}"></label>
      <label class="f">Autor (para el cajetín)<input id="s-author" value="${esc(s.author)}" maxlength="60"></label>
    </div>
    <div class="acts"><button class="btn primary" data-s="ok">Guardar</button></div>`, {
    onMount: (sh) => {
      $('#s-unit', sh).value = s.unit; $('#s-theme', sh).value = theme;
      sh.onclick = (e) => {
        if (e.target.closest('[data-s]')?.dataset.s !== 'ok') return;
        const n = (id) => parseFloat($(id, sh).value.replace(',', '.'));
        s.unit = $('#s-unit', sh).value;
        if (n('#s-th') >= 0 && n('#s-th') <= 80) s.wallThickness = n('#s-th') / 100;
        if (n('#s-h') > 1 && n('#s-h') < 20) s.defaultHeight = n('#s-h');
        if (n('#s-sq') >= 0 && n('#s-sq') <= 15) s.autoSquareDeg = n('#s-sq');
        s.author = $('#s-author', sh).value.trim();
        M.saveSettings(s);
        const th = $('#s-theme', sh).value;
        try { if (th === 'auto') { localStorage.removeItem('cotas.theme'); delete document.documentElement.dataset.theme; } else { localStorage.setItem('cotas.theme', th); document.documentElement.dataset.theme = th; } } catch { document.documentElement.dataset.theme = th; }
        S.viewer?.setTheme(document.documentElement.dataset.theme === 'light' || (!document.documentElement.dataset.theme && matchMedia('(prefers-color-scheme: light)').matches));
        closeSheet();
        if (S.project) refresh(); else renderHome();
      };
    },
  });
}
function projectMenu() {
  openSheet(`
    <h3>${esc(S.project.name)}</h3>
    <div class="opt-list">
      <button class="opt" data-s="addscan">${icon('i-scan')}<span><b>Escanear otra habitación</b></span></button>
      <button class="opt" data-s="addman">${icon('i-ruler')}<span><b>Añadir habitación por medidas</b></span></button>
      <button class="opt" data-s="square">${icon('i-check')}<span><b>Escuadrar todas las habitaciones</b><small>Fija a 90° las esquinas que estén a menos de 6°</small></span></button>
      <button class="opt" data-s="dup">${icon('i-plan')}<span><b>Duplicar proyecto</b></span></button>
      <button class="opt" data-s="settings">${icon('i-settings')}<span><b>Ajustes</b></span></button>
      <button class="opt" data-s="del" style="color:var(--bad)">${icon('i-close')}<span><b>Eliminar proyecto</b></span></button>
    </div>`, {
    onMount: (sh) => {
      sh.onclick = (e) => {
        const a = e.target.closest('[data-s]')?.dataset.s; if (!a) return;
        if (a === 'addscan') { closeSheet(); newScanSheet(); }
        if (a === 'addman') { closeSheet(); manualSheet(); }
        if (a === 'square') { closeSheet(); let c = 0; mutate(() => { for (const r of S.project.rooms) c += M.autoSquare(r, 6); }); toast(`${c} esquinas escuadradas`); }
        if (a === 'dup') { const c = JSON.parse(JSON.stringify(S.project)); c.id = M.uid(); c.name += ' (copia)'; M.upsertProject(c); closeSheet(); openProject(c); toast('Proyecto duplicado'); }
        if (a === 'settings') { closeSheet(); settingsSheet(); }
        if (a === 'del' && confirm(`¿Eliminar el proyecto «${S.project.name}»? No se puede deshacer.`)) { M.deleteProject(S.project.id); goHome(); }
      };
    },
  });
}

function addRoomSheet() {
  openSheet(`<h3>Añadir habitación</h3>
    <div class="opt-list">
      <button class="opt" data-s="scan">${icon('i-scan')}<span><b>Escanear con cámara</b><small>Si la escaneas en la misma sesión que otra, quedan alineadas.</small></span></button>
      <button class="opt" data-s="man">${icon('i-ruler')}<span><b>Por medidas</b><small>Rectángulo, L, recorrido o dibujo libre</small></span></button>
    </div>`, { onMount: (sh) => { sh.onclick = (e) => { const a = e.target.closest('[data-s]')?.dataset.s; if (a === 'scan') { closeSheet(); newScanSheet(); } if (a === 'man') { closeSheet(); manualSheet(); } }; } });
}

// ------------------------------------------------------------------ eventos globales
document.addEventListener('click', (e) => {
  const t = e.target.closest('[data-act],[data-tab],[data-tool],[data-exp],[data-open],[data-v3d]');
  if (!t || t.closest('#sheet')) return;
  if (t.dataset.open) { const p = M.loadProjects().find((q) => q.id === t.dataset.open); if (p) { try { openProject(M.validateProject(p)); } catch (err) { toast(err.message); } } return; }
  if (t.dataset.tab) return setTab(t.dataset.tab);
  if (t.dataset.tool) return setTool(t.dataset.tool);
  if (t.dataset.exp) return doExport(t.dataset.exp);
  if (t.dataset.v3d) return v3dAction(t);
  switch (t.dataset.act) {
    case 'new-scan': S.project = null; return newScanSheet();
    case 'new-manual': S.project = null; return manualSheet();
    case 'import': return $('#file-in').click();
    case 'settings': return settingsSheet();
    case 'back': return goHome();
    case 'undo': return undo();
    case 'redo': return redo();
    case 'proj-menu': return projectMenu();
    case 'zoom-in': return S.editor.zoom(1.35);
    case 'zoom-out': return S.editor.zoom(1 / 1.35);
    case 'fit': return S.editor.fit();
    case 'add-room': return addRoomSheet();
    case 'goto-dims': return setTab('dims');
    case 'install': S.installPrompt?.prompt(); return;
  }
});
function v3dAction(b) {
  const v = S.viewer; if (!v) return;
  const k = b.dataset.v3d;
  if (k === 'persp' || k === 'top') v.view(k);
  if (k === 'low' || k === 'ceiling') { const on = b.getAttribute('aria-pressed') !== 'true'; b.setAttribute('aria-pressed', on); v.set(k === 'low' ? { lowWalls: on } : { ceiling: on }); }
  if (k === 'shot') fetch(v.screenshot()).then((r) => r.blob()).then((bl) => X.share(bl, X.slug(S.project.name) + '-3d.png', S.project.name));
}
$('#proj-name').addEventListener('change', (e) => { if (!S.project) return; mutate(() => { S.project.name = e.target.value.trim() || 'Proyecto sin nombre'; }); });
$('#file-in').addEventListener('change', async (e) => {
  const f = e.target.files[0]; e.target.value = ''; if (!f) return;
  try {
    const p = M.validateProject(JSON.parse(await f.text()));
    delete p.app; delete p.version;
    if (M.loadProjects().some((q) => q.id === p.id)) { p.id = M.uid(); p.name += ' (importado)'; }
    M.upsertProject(p); openProject(p); toast('Proyecto importado');
  } catch (err) { toast('No se pudo importar: ' + err.message, 4000); }
});
addEventListener('keydown', (e) => {
  if (!S.project || $('#v-project').hidden || /INPUT|SELECT|TEXTAREA/.test(document.activeElement?.tagName)) return;
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); }
  if (e.key === 'Escape') closeSheet();
});
addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); S.installPrompt = e; $('[data-act="install"]').hidden = false; });

// Aviso de AR en el inicio (sin bloquear)
import('./ar.js').then(async (A) => {
  S.arSupport = await A.arSupport();
  const box = $('#ar-status');
  if (!S.arSupport.ok) { box.hidden = false; box.innerHTML = `<b>Cámara AR no disponible en este navegador.</b> ${esc(S.arSupport.reason)}`; }
}).catch(() => {});

if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});

renderHome();
window.__cotas = { S, M, G, X, openProject, mutate, solveAll };
