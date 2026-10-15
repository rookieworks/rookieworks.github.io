// Ejecutar: node cotas/tests/core.test.mjs
import assert from 'node:assert/strict';
import * as G from '../js/geom.js';
import * as M from '../js/model.js';
import { solveRoom, suggestMeasurements } from '../js/solver.js';

let pass = 0;
const t = (name, fn) => { try { fn(); pass++; console.log('  ok', name); } catch (e) { console.error('FAIL', name, '\n', e); process.exitCode = 1; } };
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg ?? ''} esperado ${b}, obtenido ${a}`);

console.log('geom');
t('área y orientación', () => {
  const sq = [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 3 }, { x: 0, y: 3 }];
  near(G.signedArea(sq), 12, 1e-12);
  const o = G.orientCCW([...sq].reverse());
  assert.equal(o.reversed, true); near(G.signedArea(o.pts), 12, 1e-12);
  // la pared vieja i debe tener la misma longitud que la nueva wallMap[i]
  const rev = [...sq].reverse();
  rev.forEach((_, i) => near(G.edgeLen(rev, i), G.edgeLen(o.pts, o.wallMap[i]), 1e-12));
});
t('ángulo interior y reflejo', () => {
  const L = [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 2 }, { x: 2, y: 2 }, { x: 2, y: 4 }, { x: 0, y: 4 }];
  const deg = L.map((_, i) => (G.interiorAngle(L, i) * 180) / Math.PI);
  assert.deepEqual(deg.map(Math.round), [90, 90, 90, 270, 90, 90]);
});
t('ajuste de recta e intersección', () => {
  const l1 = G.fitLine([{ x: 0.3, y: 0.001 }, { x: 1.2, y: -0.001 }, { x: 2.0, y: 0 }]);
  const l2 = G.fitLine([{ x: 4, y: 0.5 }, { x: 4.001, y: 2 }]);
  const c = G.intersectLines(l1.p, l1.d, l2.p, l2.d);
  near(c.x, 4, 0.002); near(c.y, 0, 0.002);
});
t('offset exterior', () => {
  const sq = [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 3 }, { x: 0, y: 3 }];
  const o = G.offsetPolygon(sq, 0.15);
  near(G.area(o), 4.3 * 3.3, 1e-9);
});

console.log('model');
t('parseLen', () => {
  near(M.parseLen('3,42'), 3.42, 1e-12);
  near(M.parseLen('3.42'), 3.42, 1e-12);
  near(M.parseLen('342'), 3.42, 1e-12);       // >30 en metros ⇒ cm
  near(M.parseLen('342 cm'), 3.42, 1e-12);
  near(M.parseLen('3420mm'), 3.42, 1e-12);
  near(M.parseLen('3 m 42'), 3.42, 1e-12);
  near(M.parseLen('85', 'cm'), 0.85, 1e-12);
  near(M.parseLen('2.5'), 2.5, 1e-12);
  assert.equal(M.parseLen('abc'), null);
  assert.equal(M.parseLen('-2'), null);
});
t('fmtLen', () => {
  assert.equal(M.fmtLen(3.4155), '3,42 m');
  assert.equal(M.fmtLen(3.4155, 'cm'), '341,6 cm');
  assert.equal(M.fmtLen(3.4, 'cm'), '340 cm');
  assert.equal(M.fmtLen(3.4155, 'mm'), '3416 mm');
});
t('newRoom con polígono horario conserva aberturas', () => {
  const cw = [{ x: 0, y: 0 }, { x: 0, y: 3 }, { x: 4, y: 3 }, { x: 4, y: 0 }]; // área < 0
  const r = M.newRoom(cw, { openings: [{ type: 'door', wall: 1, offset: 0.5, width: 0.8, height: 2.1, sill: 0 }] });
  assert.ok(G.signedArea(r.pts) > 0);
  const op = r.openings[0];
  // pared vieja 1 = (0,3)->(4,3); centro de la puerta en x = 0.9
  const a = r.pts[op.wall], b = r.pts[(op.wall + 1) % 4];
  const mid = G.lerp(a, b, (op.offset + op.width / 2) / G.dist(a, b));
  near(mid.x, 0.9, 1e-9); near(mid.y, 3, 1e-9);
});
t('split y remove corner son inversos', () => {
  const r = M.newRoom([{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 3 }, { x: 0, y: 3 }]);
  r.openings.push({ id: 'd', type: 'door', wall: 2, offset: 1, width: 0.8, height: 2.1, sill: 0 });
  M.splitWall(r, 0); assert.equal(r.pts.length, 5); assert.equal(r.openings[0].wall, 3);
  M.removeCorner(r, 1); assert.equal(r.pts.length, 4); assert.equal(r.openings[0].wall, 2);
  assert.equal(r.edges.length, 4); assert.equal(r.corners.length, 4);
});
t('removeCorner en vértice 0 reubica abertura', () => {
  const r = M.newRoom([{ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 3 }, { x: 0, y: 3 }]);
  r.openings.push({ id: 'w', type: 'window', wall: 1, offset: 0.5, width: 1, height: 1, sill: 1 });
  M.removeCorner(r, 1);
  assert.equal(r.openings[0].wall, 0); near(r.openings[0].offset, 2.5, 1e-9);
});

console.log('solver');
const rect = (w, h, noise = 0) => [{ x: 0, y: 0 }, { x: w + noise, y: 0.02 * noise }, { x: w - noise, y: h + noise }, { x: -noise, y: h - noise }];
t('rectángulo escaneado + 2 cotas + escuadra ⇒ exacto', () => {
  const r = M.newRoom(rect(4.05, 2.96, 0.03));
  M.autoSquare(r, 4);
  r.edges[0].locked = 4.0; r.edges[1].locked = 3.0;
  const { pts, report } = solveRoom(r);
  near(G.edgeLen(pts, 0), 4.0, 0.0005); near(G.edgeLen(pts, 1), 3.0, 0.0005);
  near(G.edgeLen(pts, 2), 4.0, 0.0005); near(G.edgeLen(pts, 3), 3.0, 0.0005);
  near(G.area(pts), 12, 0.003);
  assert.equal(report.freeDof, 0, 'dof');
  assert.ok(report.maxLenError < 0.0005);
});
t('cuatro lados sin ángulos ⇒ falta 1 medida', () => {
  const r = M.newRoom(rect(4, 3));
  r.edges.forEach((e, i) => (e.locked = i % 2 ? 3 : 4));
  const { report } = solveRoom(r);
  assert.equal(report.freeDof, 1);
  assert.ok(suggestMeasurements(r, report).some((s) => s.type === 'diag'));
});
t('diagonal define el cuadrilátero', () => {
  const r = M.newRoom(rect(4.03, 2.97, 0.02));
  r.edges.forEach((e, i) => (e.locked = i % 2 ? 3 : 4));
  r.diagonals.push({ id: 'd1', a: 0, b: 2, locked: 5 });
  const { pts, report } = solveRoom(r);
  assert.equal(report.freeDof, 0);
  near((G.interiorAngle(pts, 1) * 180) / Math.PI, 90, 0.02);
});
t('medidas incompatibles ⇒ error de cierre visible', () => {
  const r = M.newRoom(rect(4, 3));
  r.corners.forEach((c) => (c.angle = 90));
  r.edges[0].locked = 4.0; r.edges[2].locked = 4.03; r.edges[1].locked = 3;
  const { report } = solveRoom(r);
  assert.ok(report.redundant >= 1);
  assert.ok(report.maxLenError > 0.005 || report.maxAngError > 0.1, 'debe reportar incoherencia');
});
t('forma L medida por completo', () => {
  const base = [{ x: 0, y: 0 }, { x: 5.1, y: 0 }, { x: 5.08, y: 2.02 }, { x: 2.03, y: 1.98 }, { x: 2.0, y: 4.1 }, { x: 0.02, y: 4.0 }];
  const r = M.newRoom(base);
  M.autoSquare(r, 5);
  assert.equal(r.corners.filter((c) => c.angle != null).length, 6);
  [5, 2, 3, 2, 2, 4].forEach((L, i) => (r.edges[i].locked = L));
  const { pts, report } = solveRoom(r);
  near(G.area(pts), 5 * 2 + 2 * 2, 0.002);
  assert.ok(report.maxLenError < 0.001, 'cierre ' + report.maxLenError);
});
t('rendimiento: 24 vértices < 1,5 s', () => {
  const pts = []; for (let i = 0; i < 24; i++) { const a = (i / 24) * Math.PI * 2; pts.push({ x: 5 * Math.cos(a), y: 5 * Math.sin(a) }); }
  const r = M.newRoom(pts); r.edges[0].locked = 1.4;
  const t0 = Date.now(); solveRoom(r); const ms = Date.now() - t0;
  assert.ok(ms < 1500, ms + ' ms');
});
console.log(`\n${pass} pruebas correctas`);
