// Simula ARCore: una sala en L con muebles; apuntamos la cámara a puntos concretos.
import assert from 'node:assert/strict';
import { ScanCore } from '../js/scan-core.js';
import * as G from '../js/geom.js';

let pass = 0;
const t = (name, fn) => { try { fn(); pass++; console.log('  ok', name); } catch (e) { console.error('FAIL', name, '\n', e); process.exitCode = 1; } };
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg ?? ''} esperado ${b}, obtenido ${a}`);

// Sala real (planta x,z), L de 5x4 con muesca 2x2; techo 2,60
const ROOM = [{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 5, y: 2 }, { x: 3, y: 2 }, { x: 3, y: 4 }, { x: 0, y: 4 }];
const H = 2.6, FLOOR = -0.003; // ARCore estima el suelo con ~3 mm de error
// Armario que tapa la esquina (5,0): caja x 4.2..5, z 0..0.6, alto 2.0
const BOXES = [{ x0: 4.2, x1: 5, z0: 0, z1: 0.6, y1: 2.0 }, { x0: 0.5, x1: 2.5, z0: 3.1, z1: 4, y1: 0.8 }];

function raycast(o, d) {
  let best = null;
  const take = (tt, p, n) => { if (tt > 1e-6 && (!best || tt < best.t)) best = { t: tt, p, n }; };
  if (d[1] < 0) { const tt = (0 - o[1]) / d[1]; take(tt, [o[0] + d[0] * tt, 0, o[2] + d[2] * tt], [0, 1, 0]); }
  for (let i = 0; i < ROOM.length; i++) { // paredes como planos verticales
    const a = ROOM[i], b = ROOM[(i + 1) % ROOM.length];
    const e = { x: b.x - a.x, y: b.y - a.y }, den = d[0] * e.y - d[2] * e.x;
    if (Math.abs(den) < 1e-9) continue;
    const w = { x: a.x - o[0], y: a.y - o[2] };
    const tt = (w.x * e.y - w.y * e.x) / den, u = (w.x * d[2] - w.y * d[0]) / den;
    const y = o[1] + d[1] * tt;
    if (u >= 0 && u <= 1 && y >= 0 && y <= H) take(tt, [o[0] + d[0] * tt, y, o[2] + d[2] * tt], [-e.y, 0, e.x]);
  }
  for (const B of BOXES) { // caras superior y laterales (aprox.)
    if (d[1] < 0) { const tt = (B.y1 - o[1]) / d[1]; const x = o[0] + d[0] * tt, z = o[2] + d[2] * tt; if (x >= B.x0 && x <= B.x1 && z >= B.z0 && z <= B.z1) take(tt, [x, B.y1, z], [0, 1, 0]); }
    for (const [ax, val] of [['x', B.x0], ['x', B.x1], ['z', B.z0], ['z', B.z1]]) {
      const k = ax === 'x' ? 0 : 2; if (Math.abs(d[k]) < 1e-9) continue;
      const tt = (val - o[k]) / d[k]; const p = [o[0] + d[0] * tt, o[1] + d[1] * tt, o[2] + d[2] * tt];
      const ok = ax === 'x' ? p[2] >= B.z0 && p[2] <= B.z1 : p[0] >= B.x0 && p[0] <= B.x1;
      if (ok && p[1] >= 0 && p[1] <= B.y1) take(tt, p, ax === 'x' ? [Math.sign(-d[0]), 0, 0] : [0, 0, Math.sign(-d[2])]);
    }
  }
  return best ? { p: [best.p[0], best.p[1] + FLOOR, best.p[2]], n: best.n } : null;
}
// La cámara (a 1,45 m) apunta al punto objetivo; el hit se simula con el raycast real.
function aim(core, cam, target) {
  const d = [target[0] - cam[0], target[1] - cam[1], target[2] - cam[2]];
  const L = Math.hypot(...d); d.forEach((_, i) => (d[i] /= L));
  return core.update({ origin: [cam[0], cam[1] + FLOOR, cam[2]], dir: d, hit: raycast(cam, d) });
}
const CAM = [1.5, 1.45, 1.5];

t('modo esquinas: sala en L sin armario', () => {
  const c = new ScanCore({ mode: 'corners' });
  const r0 = aim(c, CAM, [1.0, 0, 1.0]); assert.equal(r0.kind, 'floor'); c.tap();
  assert.equal(c.state, 'walls');
  for (const p of ROOM) { aim(c, CAM, [p.x, 0, p.y]); assert.equal(c.tap(), 'point'); }
  const r = aim(c, CAM, [0.05, 0, 0.05]); assert.ok(r.snapClose, 'debe ofrecer cerrar'); assert.equal(c.tap(), 'closed');
  const res = c.result();
  near(G.area(res.pts), 16, 0.01);
  assert.ok(G.signedArea(res.pts) > 0);
});

t('punto sobre mueble ⇒ aviso', () => {
  const c = new ScanCore({ mode: 'corners', floorY: FLOOR });
  const r = aim(c, CAM, [4.6, 0, 0.3]); // detrás del armario
  assert.ok(r.warn && /mueble/.test(r.warn), JSON.stringify(r));
});

t('modo paredes: esquina tapada por el armario se reconstruye', () => {
  const c = new ScanCore({ mode: 'lines', floorY: FLOOR });
  // Pared z=0 (de (0,0) a (5,0)): dos puntos visibles del rodapié antes del armario
  const walls = [
    [[0.8, 0, 0], [3.5, 0, 0]],
    [[5, 2.3, 0.2], [5, 0, 1.6]],    // x=5: un punto alto (encima del armario) y otro a ras de suelo
    [[4.6, 0, 2], [3.4, 0, 2]],
    [[3, 0, 2.5], [3, 0, 3.6]],
    [[2.0, 1.2, 4], [0.3, 1.2, 4]],    // mueble bajo delante: dos puntos en la pared por encima
    [[0, 0, 3.5], [0, 0, 0.6]],
  ];
  walls.forEach((w, i) => {
    for (const p of w) { const r = aim(c, CAM, p); assert.ok(r.ok, 'retícula ok ' + JSON.stringify(r)); c.tap(); }
    if (i < walls.length - 1) assert.ok(c.nextWall());
  });
  assert.ok(c.close());
  const res = c.result();
  const truth = ROOM;
  // cada esquina debe estar a < 2 mm de la real
  for (const q of truth) assert.ok(res.pts.some((p) => G.dist(p, q) < 0.002), 'esquina ' + JSON.stringify(q) + ' ' + JSON.stringify(res.pts));
  near(G.area(res.pts), 16, 0.01);
});

t('altura, puerta y ventana sobre planos de pared', () => {
  const c = new ScanCore({ mode: 'corners', floorY: FLOOR });
  for (const p of ROOM) { aim(c, CAM, [p.x, 0, p.y]); c.tap(); }
  assert.ok(c.close());
  c.begin('height');
  aim(c, CAM, [0, 2.6, 2]); c.tap(); aim(c, CAM, [2, 2.6, 0]); c.tap();
  near(c.height, 2.6, 0.005);
  c.cancelPending();
  // puerta en la pared x=0 (de z=4 a z=0 en el polígono orientado), hueco z 1.0..1.9, alto 2.05
  c.begin('door');
  aim(c, CAM, [0, 1.0, 1.0]); c.tap(); aim(c, CAM, [0, 0.4, 1.9]); c.tap(); aim(c, CAM, [0, 2.05, 1.45]); assert.equal(c.tap(), 'opening');
  const d = c.result().openings[0];
  near(d.width, 0.9, 0.005); near(d.height, 2.05, 0.006); near(d.sill, 0, 1e-9);
  // ventana en z=0, x 1.2..2.4, alféizar 0.9, superior 2.1
  c.begin('window');
  aim(c, CAM, [1.2, 1.5, 0]); c.tap(); aim(c, CAM, [2.4, 1.5, 0]); c.tap(); aim(c, CAM, [1.8, 0.9, 0]); c.tap(); aim(c, CAM, [1.8, 2.1, 0]); c.tap();
  const w = c.result().openings[1];
  near(w.width, 1.2, 0.005); near(w.sill, 0.9, 0.006); near(w.height, 1.2, 0.006);
  // centro de la ventana a 1,8 m de x=0 sobre z=0
  const P = c.result().pts, a = P[w.wall], b = P[(w.wall + 1) % P.length];
  const mid = G.lerp(a, b, (w.offset + w.width / 2) / G.dist(a, b));
  near(mid.x, 1.8, 0.005); near(mid.y, 0, 0.005);
});

t('deshacer recorre todos los estados', () => {
  const c = new ScanCore({ mode: 'corners' });
  aim(c, CAM, [1, 0, 1]); c.tap();
  aim(c, CAM, [0, 0, 0]); c.tap(); aim(c, CAM, [5, 0, 0]); c.tap();
  c.undo(); c.undo(); assert.equal(c.points.length, 0); c.undo(); assert.equal(c.state, 'floor');
});
console.log(`\n${pass} pruebas correctas`);
