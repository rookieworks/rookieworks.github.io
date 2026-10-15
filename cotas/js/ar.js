// Escaneo con cámara: WebXR (immersive-ar sobre ARCore, Chrome Android) o simulador de escritorio.
import * as THREE from 'three';
import { ScanCore } from './scan-core.js';
import { fmtLen } from './model.js';
import { rotatePts, bbox } from './geom.js';

export async function arSupport() {
  if (!window.isSecureContext) return { ok: false, reason: 'La cámara AR necesita HTTPS.' };
  if (!navigator.xr) return { ok: false, reason: 'Este navegador no soporta WebXR. En el S24 Ultra abre la app con Google Chrome (no con Samsung Internet).' };
  try {
    const ok = await navigator.xr.isSessionSupported('immersive-ar');
    return ok ? { ok: true } : { ok: false, reason: 'AR no disponible. Instala o actualiza «Servicios de Google Play para RA» (ARCore) desde Play Store y usa Chrome.' };
  } catch (e) { return { ok: false, reason: 'No se pudo comprobar AR: ' + e.message }; }
}

const COL = { ok: 0x3ddc84, warn: 0xffb020, bad: 0xff4d4f, wall: 0xffffff, guide: 0x9aa0a6, accent: 0xe8833a, opening: 0x4fc3f7, top: 0xe8833a };

function makeLabel(text, color = '#fff', bg = 'rgba(14,14,12,.78)') {
  const c = document.createElement('canvas'); c.width = 256; c.height = 80;
  const g = c.getContext('2d');
  g.font = '600 40px system-ui, sans-serif';
  const w = Math.min(248, g.measureText(text).width + 36);
  g.fillStyle = bg; const x = (256 - w) / 2;
  g.beginPath(); g.roundRect(x, 10, w, 60, 30); g.fill();
  g.fillStyle = color; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(text, 128, 41);
  const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace;
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, sizeAttenuation: false, transparent: true }));
  s.scale.set(0.16, 0.05, 1); s.renderOrder = 10;
  return s;
}

function bar(a, b, color, r = 0.006) {
  const A = new THREE.Vector3(...a), B = new THREE.Vector3(...b);
  const L = A.distanceTo(B); if (L < 1e-4) return new THREE.Object3D();
  const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, L, 8, 1, true), new THREE.MeshBasicMaterial({ color, depthTest: false, transparent: true, opacity: 0.95 }));
  m.position.copy(A).add(B).multiplyScalar(0.5);
  m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), B.clone().sub(A).normalize());
  m.renderOrder = 5;
  return m;
}
function dot3(p, color, r = 0.025) {
  const m = new THREE.Mesh(new THREE.SphereGeometry(r, 16, 10), new THREE.MeshBasicMaterial({ color, depthTest: false }));
  m.position.set(...p); m.renderOrder = 6; return m;
}

export class ScanController {
  constructor({ overlay, settings, onRoom, onExit, sim = false, existingBBox = null }) {
    this.ov = overlay; this.settings = settings; this.onRoom = onRoom; this.onExit = onExit; this.sim = sim;
    this.existingBBox = existingBBox;
    this.roomCount = 0;
    this.align = null; // transformación de sesión → planta
    this.$ = (sel) => overlay.querySelector(sel);
  }

  async start(mode = 'corners') {
    this.core = new ScanCore({ mode, defaultHeight: this.settings.defaultHeight });
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(65, innerWidth / innerHeight, 0.02, 60);
    this.visual = new THREE.Group(); this.scene.add(this.visual);
    this._buildReticle();
    this.liveGroup = new THREE.Group(); this.scene.add(this.liveGroup);
    this._bindUI();
    this.ov.hidden = false;
    document.body.classList.add('scanning');
    try { this.wake = await navigator.wakeLock?.request('screen'); } catch { /* opcional */ }
    if (this.sim) await this._startSim(); else await this._startXR();
    this._renderHud(true);
  }

  // ---------------- WebXR ----------------
  async _startXR() {
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.setSize(innerWidth, innerHeight);
    renderer.xr.enabled = true;
    renderer.xr.setReferenceSpaceType('local');
    this.renderer = renderer;
    const session = await navigator.xr.requestSession('immersive-ar', {
      requiredFeatures: ['hit-test'],
      optionalFeatures: ['dom-overlay', 'anchors'],
      domOverlay: { root: this.ov },
    });
    this.session = session;
    session.addEventListener('end', () => this._cleanup());
    await renderer.xr.setSession(session);
    const viewer = await session.requestReferenceSpace('viewer');
    this.hitSource = await session.requestHitTestSource({ space: viewer });
    if (!session.domOverlayState) this._toast('Tu navegador no muestra controles sobre la cámara. Actualiza Chrome.');
    const q = new THREE.Quaternion(), up = new THREE.Vector3();
    renderer.setAnimationLoop((t, frame) => {
      if (!frame) return;
      const ref = renderer.xr.getReferenceSpace();
      const pose = frame.getViewerPose(ref);
      if (pose) {
        const m = pose.transform.matrix;
        const origin = [m[12], m[13], m[14]];
        const dir = [-m[8], -m[9], -m[10]];
        let hit = null;
        const res = frame.getHitTestResults(this.hitSource);
        if (res.length) {
          const hp = res[0].getPose(ref);
          if (hp) {
            const o = hp.transform.orientation;
            q.set(o.x, o.y, o.z, o.w); up.set(0, 1, 0).applyQuaternion(q);
            const p = hp.transform.position;
            hit = { p: [p.x, p.y, p.z], n: [up.x, up.y, up.z] };
          }
        }
        this._frame({ origin, dir, hit }, origin);
        this.tracking = true;
      } else this.tracking = false;
      renderer.render(this.scene, this.camera);
    });
  }

  // ---------------- Simulador (escritorio / pruebas) ----------------
  async _startSim() {
    const host = document.createElement('div'); host.className = 'sim-host'; document.body.appendChild(host); this.simHost = host;
    const renderer = new THREE.WebGLRenderer({ antialias: true }); renderer.setPixelRatio(Math.min(2, devicePixelRatio));
    renderer.setSize(innerWidth, innerHeight); host.appendChild(renderer.domElement); this.renderer = renderer;
    this.scene.background = new THREE.Color(0x30302c);
    const world = new THREE.Group(); this.scene.add(world); this.simWorld = world;
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x665544, 2.2));
    const ROOM = [[0, 0], [5, 0], [5, 2], [3, 2], [3, 4], [0, 4]], H = 2.6;
    const shape = new THREE.Shape(ROOM.map(([x, z]) => new THREE.Vector2(x, z)));
    const fg = new THREE.ShapeGeometry(shape); fg.rotateX(Math.PI / 2);
    world.add(new THREE.Mesh(fg, new THREE.MeshStandardMaterial({ color: 0xb08d63, side: THREE.DoubleSide })));
    ROOM.forEach(([x0, z0], i) => {
      const [x1, z1] = ROOM[(i + 1) % ROOM.length];
      const L = Math.hypot(x1 - x0, z1 - z0);
      const w = new THREE.Mesh(new THREE.PlaneGeometry(L, H), new THREE.MeshStandardMaterial({ color: i % 2 ? 0xe9e4da : 0xdcd6ca, side: THREE.DoubleSide }));
      w.position.set((x0 + x1) / 2, H / 2, (z0 + z1) / 2); w.rotation.y = -Math.atan2(z1 - z0, x1 - x0); world.add(w);
    });
    const box = (x0, x1, z0, z1, h, c) => { const m = new THREE.Mesh(new THREE.BoxGeometry(x1 - x0, h, z1 - z0), new THREE.MeshStandardMaterial({ color: c })); m.position.set((x0 + x1) / 2, h / 2, (z0 + z1) / 2); world.add(m); };
    box(4.2, 5, 0, 0.6, 2.0, 0x6b4f35); // armario en la esquina
    box(0.5, 2.5, 3.1, 4, 0.8, 0x4a5a6a); // sofá
    box(1.6, 2.6, 1.2, 2.0, 0.75, 0x7a5a3a); // mesa
    this.sim = { yaw: -2.3, pitch: -0.5, pos: new THREE.Vector3(2.0, 1.45, 2.6) };
    const ray = new THREE.Raycaster();
    const keys = new Set();
    addEventListener('keydown', this._kd = (e) => keys.add(e.key.toLowerCase()));
    addEventListener('keyup', this._ku = (e) => keys.delete(e.key.toLowerCase()));
    let drag = null;
    renderer.domElement.addEventListener('pointerdown', (e) => (drag = { x: e.clientX, y: e.clientY }));
    addEventListener('pointerup', this._pu = () => (drag = null));
    addEventListener('pointermove', this._pm = (e) => { if (!drag) return; this.sim.yaw -= (e.clientX - drag.x) * 0.004; this.sim.pitch = Math.max(-1.5, Math.min(1.5, this.sim.pitch - (e.clientY - drag.y) * 0.004)); drag = { x: e.clientX, y: e.clientY }; });
    window.__cotasSim = {
      aimAt: (x, y, z) => { const d = new THREE.Vector3(x, y, z).sub(this.sim.pos); this.sim.yaw = Math.atan2(-d.x, -d.z); this.sim.pitch = Math.atan2(d.y, Math.hypot(d.x, d.z)); },
      moveTo: (x, z) => { this.sim.pos.set(x, 1.45, z); },
      core: () => this.core,
    };
    const loop = () => {
      const s = this.sim;
      const fwd = new THREE.Vector3(-Math.sin(s.yaw), 0, -Math.cos(s.yaw)), right = new THREE.Vector3(-fwd.z, 0, fwd.x);
      if (keys.has('w')) s.pos.addScaledVector(fwd, 0.03); if (keys.has('s')) s.pos.addScaledVector(fwd, -0.03);
      if (keys.has('d')) s.pos.addScaledVector(right, 0.03); if (keys.has('a')) s.pos.addScaledVector(right, -0.03);
      this.camera.position.copy(s.pos);
      this.camera.rotation.set(s.pitch, s.yaw, 0, 'YXZ');
      this.camera.updateMatrixWorld();
      const dir = new THREE.Vector3(0, 0, -1).applyQuaternion(this.camera.quaternion);
      ray.set(s.pos, dir);
      const hits = ray.intersectObjects(world.children, false);
      let hit = null;
      if (hits.length) {
        const h = hits[0]; const n = h.face.normal.clone().transformDirection(h.object.matrixWorld);
        if (n.dot(dir) > 0) n.negate();
        hit = { p: h.point.toArray(), n: n.toArray() };
      }
      this._frame({ origin: s.pos.toArray(), dir: dir.toArray(), hit }, s.pos.toArray());
      renderer.render(this.scene, this.camera);
    };
    renderer.setAnimationLoop(loop);
    this._simResize = () => { renderer.setSize(innerWidth, innerHeight); this.camera.aspect = innerWidth / innerHeight; this.camera.updateProjectionMatrix(); };
    addEventListener('resize', this._simResize);
  }

  // ---------------- Común ----------------
  _frame(input, camPos) {
    const r = this.core.update(input);
    this.camPos = camPos;
    if (this.core.version !== this._ver) { this._ver = this.core.version; this._rebuild(); this._renderHud(true); }
    this._updateReticle(r);
    this._renderHud(false);
  }

  _buildReticle() {
    const g = new THREE.Group();
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.035, 0.05, 32), new THREE.MeshBasicMaterial({ color: COL.ok, depthTest: false, side: THREE.DoubleSide, transparent: true }));
    const dotM = new THREE.Mesh(new THREE.CircleGeometry(0.008, 16), ring.material);
    ring.renderOrder = dotM.renderOrder = 8;
    g.add(ring, dotM);
    this.reticle = g; this.reticleMat = ring.material; this.scene.add(g);
  }

  _updateReticle(r) {
    const R = this.reticle;
    this.liveGroup.clear();
    if (!r || r.kind === 'none' || !r.p) { R.visible = false; return; }
    R.visible = true;
    R.position.set(r.p.x, r.p.y + 0.002, r.p.z);
    if (r.kind === 'floor') R.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 1, 0));
    else if (this.camPos) R.lookAt(new THREE.Vector3(...this.camPos));
    this.reticleMat.color.setHex(!r.ok ? COL.bad : r.warn ? COL.warn : COL.ok);
    const c = this.core;
    if (c.state === 'walls' && c.mode === 'corners' && c.points.length) {
      const a = c.points[c.points.length - 1];
      const A = [a.x, c.floorY, a.y], B = [r.p.x, c.floorY, r.p.z];
      this.liveGroup.add(bar(A, B, COL.accent, 0.004));
      const lab = this._label(fmtLen(r.live, this.settings.unit)); lab.position.set((A[0] + B[0]) / 2, c.floorY + 0.03, (A[2] + B[2]) / 2); this.liveGroup.add(lab);
    }
    if (c.state === 'room' && r.kind === 'wallplane' && c.pending) {
      const lab = this._label((c.pending.type === 'height' || c.pending.step >= 2) ? 'h ' + fmtLen(r.h, this.settings.unit) : fmtLen(r.s, this.settings.unit));
      lab.position.set(r.p.x, r.p.y + 0.08, r.p.z); this.liveGroup.add(lab);
    }
  }

  _label(text) {
    this._labels ||= new Map();
    let s = this._labels.get(text);
    if (!s) { s = makeLabel(text); this._labels.set(text, s); if (this._labels.size > 200) { const k = this._labels.keys().next().value; this._labels.get(k).material.map.dispose(); this._labels.delete(k); } }
    return s.clone();
  }

  _rebuild() {
    this.visual.clear();
    const v = this.core.visual();
    for (const s of v.segments) this.visual.add(bar(s.a, s.b, COL[s.kind] ?? COL.wall, s.kind === 'guide' ? 0.003 : 0.006));
    for (const p of v.points) this.visual.add(dot3(p.p, p.first ? COL.accent : p.corner ? COL.accent : COL.wall, p.corner ? 0.03 : 0.022));
    for (const l of v.labels) { const s = this._label(fmtLen(+l.text, this.settings.unit)); s.position.set(l.at[0], l.at[1] + 0.04, l.at[2]); this.visual.add(s); }
  }

  // ---------------- HUD (DOM overlay) ----------------
  _bindUI() {
    const ov = this.ov;
    const stop = (e) => e.preventDefault();
    ov.querySelectorAll('.ar-top, .ar-bottom, .ar-dialog').forEach((el) => el.addEventListener('beforexrselect', stop));
    ov.onclick = (e) => {
      const b = e.target.closest('[data-ar]'); if (!b || b.disabled) return;
      this._action(b.dataset.ar);
    };
  }

  _action(a) {
    const c = this.core;
    const buzz = (ms = 15) => navigator.vibrate?.(ms);
    switch (a) {
      case 'add': { const ev = c.tap(); if (ev) buzz(ev === 'closed' || ev === 'opening' ? [20, 40, 20] : 15); else buzz(60); break; }
      case 'undo': c.undo(); buzz(); break;
      case 'next': if (!c.nextWall()) this._toast('Marca al menos 2 puntos separados en esta pared'); else buzz(); break;
      case 'close': if (!c.close()) this._toast(c.warnings[0] || 'Faltan paredes para cerrar'); else { buzz([20, 40, 20]); if (c.warnings.length) this._toast(c.warnings[0]); } break;
      case 'mode-corners': case 'mode-lines': {
        const m = a === 'mode-corners' ? 'corners' : 'lines';
        if (c.mode !== m) {
          const hasData = c.points.length || c.walls.some((w) => w.length);
          if (!hasData) { c.mode = m; c.version++; } else this._toast('Deshaz los puntos para cambiar de modo');
        }
        break;
      }
      case 'height': case 'door': case 'window': c.begin(a); break;
      case 'done-pending': c.cancelPending(); break;
      case 'finish': this._finishRoom(); break;
      case 'another': this._hideDialog(); this.core = new ScanCore({ mode: c.mode, floorY: c.floorY, defaultHeight: this.settings.defaultHeight }); this._ver = -1; break;
      case 'exit': this.exit(); break;
    }
    this._renderHud(true);
  }

  _finishRoom() {
    const res = this.core.result(); if (!res) return;
    if (!this.align) {
      // Alinear la primera pared con el eje X y llevar la sala a la derecha de lo ya existente.
      const p0 = res.pts[0], p1 = res.pts[1];
      const ang = -Math.atan2(p1.y - p0.y, p1.x - p0.x);
      const rot = rotatePts(res.pts, ang);
      const b = bbox(rot);
      const ex = this.existingBBox;
      const dx = (ex ? ex.x1 + 1.5 : 0) - b.x0, dy = (ex ? ex.y0 : 0) - b.y0;
      this.align = { ang, dx, dy };
    }
    const { ang, dx, dy } = this.align;
    const pts = rotatePts(res.pts, ang).map((p) => ({ x: p.x + dx, y: p.y + dy }));
    this.roomCount++;
    const saved = this.onRoom({ ...res, pts });
    this.core.saved = true;
    this._showDialog(`<b>Habitación guardada</b><br>${saved?.summary || ''}<br><small>Puedes escanear otra habitación: quedará alineada con esta.</small>`,
      [['another', 'Escanear otra'], ['exit', 'Ver plano y cotas']]);
  }

  _showDialog(html, btns) {
    const d = this.$('.ar-dialog');
    d.innerHTML = `<div class="ar-dialog-body">${html}</div><div class="ar-dialog-btns">${btns.map(([k, t], i) => `<button data-ar="${k}" class="${i ? 'primary' : ''}">${t}</button>`).join('')}</div>`;
    d.hidden = false;
  }
  _hideDialog() { this.$('.ar-dialog').hidden = true; }

  _toast(msg) {
    const t = this.$('.ar-toast'); t.textContent = msg; t.hidden = false;
    clearTimeout(this._tt); this._tt = setTimeout(() => (t.hidden = true), 3500);
  }

  _renderHud(structural) {
    const c = this.core, r = c.reticle;
    const u = this.settings.unit;
    // mensaje y lectura en vivo (cada fotograma, solo si cambia)
    let msg = !this.sim && this.tracking === false ? 'Buscando… mueve el móvil despacio' : (r?.msg || '');
    let live = '';
    if (r && r.ok) {
      if (c.state === 'walls' && r.live != null) live = fmtLen(r.live, u);
      if (c.state === 'room' && c.pending) live = c.pending.type === 'height' || c.pending.step >= 2 ? 'h ' + fmtLen(r.h, u) : fmtLen(r.s, u);
    }
    if (msg !== this._lastMsg) { this.$('.ar-msg').textContent = msg; this._lastMsg = msg; }
    if (live !== this._lastLive) { this.$('.ar-live').textContent = live; this._lastLive = live; }
    this.$('.ar-cross').dataset.state = !r || !r.ok ? 'bad' : r.warn ? 'warn' : 'ok';
    const add = this.$('[data-ar="add"]');
    add.disabled = !r || !r.ok || (c.state === 'room' && !c.pending);
    if (!structural) return;

    const steps = { floor: '1 · Suelo', walls: c.mode === 'corners' ? '2 · Esquinas' : '2 · Paredes', room: '3 · Detalles' };
    this.$('.ar-step').textContent = steps[c.state] || '';
    this.$('.ar-modes').hidden = c.state !== 'walls' && c.state !== 'floor';
    this.$('[data-ar="mode-corners"]').classList.toggle('on', c.mode === 'corners');
    this.$('[data-ar="mode-lines"]').classList.toggle('on', c.mode === 'lines');
    add.textContent = c.state === 'floor' ? 'Fijar suelo' : '＋';
    add.classList.toggle('wide', c.state === 'floor');
    const row = this.$('.ar-actions');
    const B = (k, t, en = true, cls = '') => `<button data-ar="${k}" ${en ? '' : 'disabled'} class="${cls}">${t}</button>`;
    let html = '';
    if (c.state === 'walls') {
      if (c.mode === 'lines') html += B('next', 'Siguiente pared', c._curWall().length >= 2);
      html += B('close', 'Cerrar sala', c.canClose(), 'primary');
    } else if (c.state === 'room') {
      if (c.pending) {
        const done = c.pending.type === 'height' ? `Listo (${c.heightSamples.length} med.)` : 'Cancelar';
        html += B('done-pending', done);
      } else {
        html += B('height', c.heightSamples.length ? `Altura ${fmtLen(c.height, u)}` : 'Medir altura');
        html += B('door', 'Puerta') + B('window', 'Ventana');
        html += B('finish', 'Terminar', true, 'primary');
      }
    }
    row.innerHTML = html;
    const counts = c.state === 'walls' ? (c.mode === 'corners' ? `${c.points.length} esquinas` : `Pared ${c.walls.length} · ${c._curWall().length} pts`) :
      c.state === 'room' ? `${c.poly.length} paredes · ${c.openings.length} huecos` : '';
    this.$('.ar-count').textContent = counts;
  }

  async exit() {
    if (this.core?.state === 'room' && !this.core.saved) this._finishRoom();
    if (this.session) { try { await this.session.end(); } catch { this._cleanup(); } } else this._cleanup();
  }

  _cleanup() {
    if (this._cleaned) return; this._cleaned = true;
    this.renderer?.setAnimationLoop(null);
    this.renderer?.dispose();
    this.hitSource?.cancel?.();
    try { this.wake?.release(); } catch { /* */ }
    if (this.simHost) { this.simHost.remove(); removeEventListener('keydown', this._kd); removeEventListener('keyup', this._ku); removeEventListener('pointerup', this._pu); removeEventListener('pointermove', this._pm); removeEventListener('resize', this._simResize); delete window.__cotasSim; }
    this.ov.hidden = true; this._hideDialog();
    document.body.classList.remove('scanning');
    this.onExit?.(this.roomCount);
  }
}
