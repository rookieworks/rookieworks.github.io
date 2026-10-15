// Vista 3D (three.js): muros extruidos con huecos reales, suelo, techo opcional.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import * as G from './geom.js';

/** Construye un THREE.Group del proyecto. Ejes: x→x, planta y→z, altura→y. */
export function buildModel(project, { thickness = 0.15, ceiling = false, lowWalls = false } = {}) {
  const group = new THREE.Group();
  group.name = project.name || 'Cotas';
  const wallMat = new THREE.MeshStandardMaterial({ color: 0xece8e1, roughness: 0.9, side: THREE.DoubleSide });
  const capMat = new THREE.MeshStandardMaterial({ color: 0x3a3833, roughness: 1, side: THREE.DoubleSide });
  const floorMat = new THREE.MeshStandardMaterial({ color: 0xc9a77c, roughness: 0.8, side: THREE.DoubleSide });
  const ceilMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1, side: THREE.DoubleSide, transparent: true, opacity: 0.85 });
  const glassMat = new THREE.MeshStandardMaterial({ color: 0x9ec9e6, roughness: 0.1, metalness: 0, transparent: true, opacity: 0.35, side: THREE.DoubleSide });
  const doorMat = new THREE.MeshStandardMaterial({ color: 0x8a6239, roughness: 0.7, side: THREE.DoubleSide });

  for (const room of project.rooms) {
    const rg = new THREE.Group(); rg.name = room.name;
    const pts = room.pts, n = pts.length;
    const H = lowWalls ? Math.min(1.1, room.height) : room.height;
    const outer = G.offsetPolygon(pts, thickness);

    // Suelo
    const shape = new THREE.Shape(pts.map((p) => new THREE.Vector2(p.x, p.y)));
    const fg = new THREE.ShapeGeometry(shape); fg.rotateX(Math.PI / 2);
    const floor = new THREE.Mesh(fg, floorMat); floor.name = 'Suelo ' + room.name; floor.receiveShadow = true; rg.add(floor);
    if (ceiling && !lowWalls) {
      const cg = new THREE.ShapeGeometry(shape); cg.rotateX(Math.PI / 2);
      const c = new THREE.Mesh(cg, ceilMat); c.position.y = room.height; c.name = 'Techo ' + room.name; rg.add(c);
    }

    // Muros: cada pared se trocea según sus aberturas
    for (let i = 0; i < n; i++) {
      const a = pts[i], b = pts[(i + 1) % n], L = G.dist(a, b);
      if (L < 1e-4) continue;
      const u = G.norm(G.sub(b, a)), nout = G.mul(G.inwardNormal(pts, i), -1);
      const oa = outer[i], ob = outer[(i + 1) % n];
      const ops = room.openings.filter((o) => o.wall === i).map((o) => ({ ...o, s0: Math.max(0, o.offset), s1: Math.min(L, o.offset + o.width) })).filter((o) => o.s1 > o.s0).sort((p, q) => p.s0 - q.s0);
      const at = (s, side) => {
        if (side === 'in') return G.add(a, G.mul(u, s));
        if (s <= 1e-6) return oa; if (s >= L - 1e-6) return ob;
        return G.add(G.add(a, G.mul(u, s)), G.mul(nout, thickness));
      };
      const piece = (s0, s1, y0, y1, mat = wallMat) => {
        if (s1 - s0 < 1e-4 || y1 - y0 < 1e-4) return;
        rg.add(prism([at(s0, 'in'), at(s1, 'in'), at(s1, 'out'), at(s0, 'out')], y0, y1, mat));
      };
      let s = 0;
      for (const o of ops) {
        piece(s, o.s0, 0, H);
        const top = o.sill + o.height;
        piece(o.s0, o.s1, 0, Math.min(o.sill, H));
        if (top < H) piece(o.s0, o.s1, top, H);
        if (!lowWalls || o.sill < H) {
          if (o.type === 'window') {
            const g0 = G.add(G.add(a, G.mul(u, o.s0)), G.mul(nout, thickness / 2)), g1 = G.add(G.add(a, G.mul(u, o.s1)), G.mul(nout, thickness / 2));
            const yTop = Math.min(top, H);
            if (yTop > o.sill) rg.add(prism([g0, g1, G.add(g1, G.mul(nout, 0.01)), G.add(g0, G.mul(nout, 0.01))], o.sill, yTop, glassMat));
          } else if (o.type === 'door' && !lowWalls) {
            // hoja entreabierta a 30°
            const hingeAtStart = o.hinge !== 'end';
            const hp = G.add(a, G.mul(u, hingeAtStart ? o.s0 : o.s1));
            const dirIn = G.mul(nout, o.swing === 'out' ? 1 : -1);
            const along = G.mul(u, hingeAtStart ? 1 : -1);
            const ang = Math.PI / 6;
            const leafDir = G.add(G.mul(along, Math.cos(ang)), G.mul(dirIn, Math.sin(ang)));
            const w = o.s1 - o.s0, tk = 0.04;
            const p0 = hp, p1 = G.add(hp, G.mul(leafDir, w));
            const nn = G.mul(G.norm(G.perpL(leafDir)), tk);
            rg.add(prism([p0, p1, G.add(p1, nn), G.add(p0, nn)], 0, Math.min(top, H) - 0.01, doorMat));
          }
        }
        s = o.s1;
      }
      piece(s, L, 0, H);
    }
    // Remate superior oscuro (canto del muro) para leer el grosor desde arriba
    const capShape = new THREE.Shape(outer.map((p) => new THREE.Vector2(p.x, p.y)));
    capShape.holes.push(new THREE.Path(pts.map((p) => new THREE.Vector2(p.x, p.y))));
    const capG = new THREE.ShapeGeometry(capShape); capG.rotateX(Math.PI / 2);
    const cap = new THREE.Mesh(capG, capMat); cap.position.y = H + 0.002; cap.name = 'Canto muros'; rg.add(cap);
    group.add(rg);
  }
  return group;
}

/** Prisma vertical con base cuadrilátera (en planta) entre y0 e y1. */
function prism(q, y0, y1, mat) {
  const v = [];
  const P = (p, y) => [p.x, y, p.y];
  const quad = (a, b, c, d) => v.push(...a, ...b, ...c, ...a, ...c, ...d);
  const B = q.map((p) => P(p, y0)), T = q.map((p) => P(p, y1));
  for (let i = 0; i < 4; i++) { const j = (i + 1) % 4; quad(B[i], B[j], T[j], T[i]); }
  quad(T[0], T[1], T[2], T[3]); quad(B[3], B[2], B[1], B[0]);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(v, 3));
  g.computeVertexNormals();
  const m = new THREE.Mesh(g, mat); m.castShadow = true; m.receiveShadow = true;
  return m;
}

export class Viewer3D {
  constructor(host) {
    this.host = host;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    this.renderer.shadowMap.enabled = true;
    host.appendChild(this.renderer.domElement);
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(50, 1, 0.05, 500);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true; this.controls.maxPolarAngle = Math.PI * 0.495;
    const hemi = new THREE.HemisphereLight(0xffffff, 0x8c7a66, 1.6); this.scene.add(hemi);
    const sun = new THREE.DirectionalLight(0xffffff, 1.8); sun.position.set(6, 12, 4); sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048); sun.shadow.bias = -0.0004; sun.shadow.normalBias = 0.03; this.sun = sun; this.scene.add(sun, sun.target);
    this.model = null; this.opts = { ceiling: false, lowWalls: false };
    this._loop = () => { this.controls.update(); this.renderer.render(this.scene, this.camera); };
    this.renderer.setAnimationLoop(this._loop);
    new ResizeObserver(() => this.resize()).observe(host);
    this.setTheme(document.documentElement.dataset.theme === 'light' || matchMedia('(prefers-color-scheme: light)').matches && document.documentElement.dataset.theme !== 'dark');
  }
  setTheme(light) { this.scene.background = new THREE.Color(light ? 0xf1eee8 : 0x17160f); }
  resize() {
    const r = this.host.getBoundingClientRect(); if (!r.width) return;
    this.renderer.setSize(r.width, r.height, false);
    this.renderer.domElement.style.width = '100%'; this.renderer.domElement.style.height = '100%';
    this.camera.aspect = r.width / r.height; this.camera.updateProjectionMatrix();
  }
  load(project, settings, refit = true) {
    if (this.model) { this.scene.remove(this.model); this.model.traverse((o) => o.geometry?.dispose()); }
    this.project = project; this.settings = settings;
    this.model = buildModel(project, { thickness: settings.wallThickness, ...this.opts });
    this.scene.add(this.model);
    if (refit) this.fit();
  }
  set(opt) { Object.assign(this.opts, opt); if (this.project) this.load(this.project, this.settings, false); }
  /** Distancia para que la esfera envolvente quepa en pantalla (también en vertical). */
  _dist(R) {
    const v = THREE.MathUtils.degToRad(this.camera.fov), h = 2 * Math.atan(Math.tan(v / 2) * this.camera.aspect);
    return (R / Math.sin(Math.min(v, h) / 2)) * 1.02;
  }
  fit() {
    const box = new THREE.Box3().setFromObject(this.model);
    if (box.isEmpty()) return;
    const c = box.getCenter(new THREE.Vector3()), s = box.getSize(new THREE.Vector3());
    const r = Math.max(s.x, s.z, 2);
    this.controls.target.copy(c);
    const dir = new THREE.Vector3(0.45, 0.85, 0.75).normalize();
    this.camera.position.copy(c).addScaledVector(dir, this._dist(s.length() / 2));
    this.sun.position.set(c.x + r, c.y + r * 2, c.z + r * 0.5); this.sun.target.position.copy(c);
    const sc = this.sun.shadow.camera; sc.left = sc.bottom = -r; sc.right = sc.top = r; sc.far = r * 6; sc.updateProjectionMatrix();
    this.camera.updateProjectionMatrix();
  }
  view(kind) {
    const box = new THREE.Box3().setFromObject(this.model); if (box.isEmpty()) return;
    const c = box.getCenter(new THREE.Vector3()), s = box.getSize(new THREE.Vector3()), r = Math.max(s.x, s.z, 2);
    this.controls.target.copy(c);
    const d = this._dist(s.length() / 2);
    if (kind === 'top') this.camera.position.set(c.x, c.y + this._dist(Math.hypot(s.x, s.z) / 2), c.z + 0.001);
    else this.camera.position.copy(c).addScaledVector(new THREE.Vector3(0.45, 0.85, 0.75).normalize(), d);
    void r;
  }
  screenshot() { this.renderer.render(this.scene, this.camera); return this.renderer.domElement.toDataURL('image/png'); }
  dispose() { this.renderer.setAnimationLoop(null); this.renderer.dispose(); this.host.innerHTML = ''; }
}

export async function exportGLB(project, settings) {
  const { GLTFExporter } = await import('three/addons/exporters/GLTFExporter.js');
  const model = buildModel(project, { thickness: settings.wallThickness, ceiling: false });
  const ab = await new GLTFExporter().parseAsync(model, { binary: true });
  return new Blob([ab], { type: 'model/gltf-binary' });
}
export async function exportOBJ(project, settings) {
  const { OBJExporter } = await import('three/addons/exporters/OBJExporter.js');
  const model = buildModel(project, { thickness: settings.wallThickness, ceiling: false });
  model.updateMatrixWorld(true);
  return new Blob([new OBJExporter().parse(model)], { type: 'text/plain' });
}
