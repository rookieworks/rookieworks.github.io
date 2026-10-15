// Exportaciones: DXF (AutoCAD R12), SVG/PDF a escala, PNG, JSON, CSV. Compartir en Android.
import * as G from './geom.js';
import { planSVG } from './plan2d.js';
import { fmtLen, fmtArea, fmtNum, wallName, roomStats } from './model.js';

// ---------------- DXF ----------------
export function toDXF(project, settings, { units = 'mm' } = {}) {
  const k = units === 'mm' ? 1000 : 1; // factor de escala
  const th = settings.wallThickness;
  const ents = [];
  const fx = (v) => (Math.round(v * 1e6) / 1e6).toString();
  const X = (p) => fx(p.x * k), Y = (p) => fx(-p.y * k);
  const line = (layer, a, b) => ents.push(`0\nLINE\n8\n${layer}\n10\n${X(a)}\n20\n${Y(a)}\n30\n0\n11\n${X(b)}\n21\n${Y(b)}\n31\n0`);
  const text = (layer, p, h, s, dir = { x: 1, y: 0 }) => {
    let ang = (Math.atan2(-dir.y, dir.x) * 180) / Math.PI;
    if (ang > 90.01) ang -= 180; else if (ang <= -90) ang += 180;
    const clean = String(s).replace(/[\r\n]/g, ' ').replace(/≈/g, '~').replace(/²/g, '2').replace(/–/g, '-');
    ents.push(`0\nTEXT\n8\n${layer}\n10\n${X(p)}\n20\n${Y(p)}\n30\n0\n40\n${fx(h * k)}\n1\n${clean}\n50\n${fx(ang)}\n72\n1\n73\n2\n11\n${X(p)}\n21\n${Y(p)}\n31\n0`);
  };
  const arc = (layer, c, r, a1, a2) => ents.push(`0\nARC\n8\n${layer}\n10\n${X(c)}\n20\n${Y(c)}\n30\n0\n40\n${fx(r * k)}\n50\n${fx(a1)}\n51\n${fx(a2)}`);
  const dxfAng = (v) => { let a = (Math.atan2(-v.y, v.x) * 180) / Math.PI; if (a < 0) a += 360; return a; };
  const TH = 0.12; // altura de texto (m)

  const dim = (a, b, nrm, off, label, layer = 'COTAS') => {
    const a2 = G.add(a, G.mul(nrm, off)), b2 = G.add(b, G.mul(nrm, off));
    line(layer, G.add(a, G.mul(nrm, 0.03)), G.add(a2, G.mul(nrm, 0.05)));
    line(layer, G.add(b, G.mul(nrm, 0.03)), G.add(b2, G.mul(nrm, 0.05)));
    line(layer, a2, b2);
    const u = G.norm(G.sub(b, a)), t = G.mul(G.norm(G.add(u, nrm)), 0.05);
    line(layer, G.sub(a2, t), G.add(a2, t)); line(layer, G.sub(b2, t), G.add(b2, t));
    text(layer + '_TXT', G.add(G.lerp(a2, b2, 0.5), G.mul(nrm, TH * 0.9)), TH, label, G.sub(b, a));
  };

  for (const room of project.rooms) {
    const pts = room.pts, n = pts.length, outer = G.offsetPolygon(pts, th);
    for (let i = 0; i < n; i++) {
      const a = pts[i], b = pts[(i + 1) % n], L = G.dist(a, b); if (L < 1e-6) continue;
      const u = G.norm(G.sub(b, a)), nout = G.mul(G.inwardNormal(pts, i), -1);
      const oa = outer[i], ob = outer[(i + 1) % n];
      const ops = room.openings.filter((o) => o.wall === i).map((o) => ({ ...o, s0: Math.max(0, o.offset), s1: Math.min(L, o.offset + o.width) })).filter((o) => o.s1 > o.s0).sort((p, q) => p.s0 - q.s0);
      const inP = (s) => G.add(a, G.mul(u, s));
      const outP = (s) => (s <= 1e-9 ? oa : s >= L - 1e-9 ? ob : G.add(inP(s), G.mul(nout, th)));
      let s = 0;
      for (const o of ops) {
        line('MUROS', inP(s), inP(o.s0)); line('MUROS', outP(s), outP(o.s0));
        line('MUROS', inP(o.s0), outP(o.s0)); line('MUROS', inP(o.s1), outP(o.s1));
        const w = o.s1 - o.s0;
        if (o.type === 'door') {
          const atStart = o.hinge !== 'end', out = o.swing === 'out';
          const hinge = out ? outP(atStart ? o.s0 : o.s1) : inP(atStart ? o.s0 : o.s1);
          const other = out ? outP(atStart ? o.s1 : o.s0) : inP(atStart ? o.s1 : o.s0);
          const leafEnd = G.add(hinge, G.mul(out ? nout : G.mul(nout, -1), w));
          line('PUERTAS', hinge, leafEnd);
          let a1 = dxfAng(G.sub(leafEnd, hinge)), a2 = dxfAng(G.sub(other, hinge));
          if ((a2 - a1 + 360) % 360 > 180) [a1, a2] = [a2, a1];
          arc('PUERTAS', hinge, w, a1, a2);
        } else if (o.type === 'window') {
          for (const f of [0, 0.5, 1]) line('VENTANAS', G.add(inP(o.s0), G.mul(nout, th * f)), G.add(inP(o.s1), G.mul(nout, th * f)));
        }
        dim(G.add(inP(o.s0), G.mul(nout, th)), G.add(inP(o.s1), G.mul(nout, th)), nout, 0.25, fmtLen(w, settings.unit, { suffix: false }), 'COTAS_HUECOS');
        s = o.s1;
      }
      line('MUROS', inP(s), inP(L)); line('MUROS', outP(s), outP(L));
      const nin = G.inwardNormal(pts, i);
      dim(a, b, nin, 0.35, fmtLen(L, settings.unit, { suffix: false }));
    }
    for (const d of room.diagonals) if (pts[d.a] && pts[d.b]) {
      line('DIAGONALES', pts[d.a], pts[d.b]);
      text('DIAGONALES', G.lerp(pts[d.a], pts[d.b], 0.5), TH * 0.9, fmtLen(G.dist(pts[d.a], pts[d.b]), settings.unit, { suffix: false }), G.sub(pts[d.b], pts[d.a]));
    }
    const lp = G.labelPoint(pts);
    text('TEXTOS', { x: lp.x, y: lp.y - 0.12 }, 0.16, room.name);
    text('TEXTOS', { x: lp.x, y: lp.y + 0.14 }, 0.11, `${fmtArea(G.area(pts))}  h=${fmtLen(room.height, settings.unit)}`);
    pts.forEach((p, i) => {
      const u1 = G.norm(G.sub(pts[(i - 1 + n) % n], p)), u2 = G.norm(G.sub(pts[(i + 1) % n], p));
      let bis = G.norm(G.add(u1, u2)); if (G.interiorAngle(pts, i) > Math.PI) bis = G.mul(bis, -1);
      text('ESQUINAS', G.add(p, G.mul(bis, -(th + 0.18))), 0.12, G.cornerName(i));
    });
  }

  const layers = [['MUROS', 7], ['PUERTAS', 30], ['VENTANAS', 4], ['COTAS', 1], ['COTAS_TXT', 1], ['COTAS_HUECOS', 3], ['COTAS_HUECOS_TXT', 3], ['DIAGONALES', 8], ['TEXTOS', 7], ['ESQUINAS', 8]];
  const hdr = ['0', 'SECTION', '2', 'HEADER', '9', '$ACADVER', '1', 'AC1009', '9', '$DWGCODEPAGE', '3', 'ANSI_1252', '9', '$INSUNITS', '70', units === 'mm' ? '4' : '6', '0', 'ENDSEC'].join('\n');
  const ltype = '0\nTABLE\n2\nLTYPE\n70\n1\n0\nLTYPE\n2\nCONTINUOUS\n70\n0\n3\nSolid line\n72\n65\n73\n0\n40\n0.0\n0\nENDTAB';
  const lay = `0\nTABLE\n2\nLAYER\n70\n${layers.length}\n` + layers.map(([nm, c]) => `0\nLAYER\n2\n${nm}\n70\n0\n62\n${c}\n6\nCONTINUOUS`).join('\n') + '\n0\nENDTAB';
  return `${hdr}\n0\nSECTION\n2\nTABLES\n${ltype}\n${lay}\n0\nENDSEC\n0\nSECTION\n2\nENTITIES\n${ents.join('\n')}\n0\nENDSEC\n0\nEOF\n`;
}

/** DXF R12 en bytes Windows‑1252 (acentos correctos en AutoCAD); lo que no cabe va como \\U+XXXX. */
export function dxfBlob(project, settings, opts) {
  const str = toDXF(project, settings, opts);
  const out = [];
  for (const ch of str) {
    const c = ch.codePointAt(0);
    if (c < 0x80 || (c >= 0xa0 && c <= 0xff)) out.push(c);
    else for (const b of `\\U+${c.toString(16).toUpperCase().padStart(4, '0')}`) out.push(b.charCodeAt(0));
  }
  return new Blob([new Uint8Array(out)], { type: 'application/dxf' });
}

// ---------------- Plano a escala (SVG en mm) ----------------
const SCALES = [20, 25, 50, 75, 100, 125, 150, 200, 250, 300, 500];
export const PAPER = { A4: [297, 210], A3: [420, 297] };

export function layoutForPaper(project, settings, paper = 'A4', forcedScale = null) {
  const [PW, PH] = PAPER[paper];
  const margin = 10, block = 34;
  const w = PW - margin * 2, h = PH - margin * 2 - block;
  const th = settings.wallThickness;
  const all = project.rooms.flatMap((r) => G.offsetPolygon(r.pts, th));
  const b = all.length ? G.bbox(all) : { x0: 0, y0: 0, x1: 1, y1: 1, w: 1, h: 1 };
  const padM = 9; // mm alrededor para cotas exteriores
  let denom = forcedScale;
  if (!denom) denom = SCALES.find((d) => (b.w * 1000) / d + padM * 2 <= w && (b.h * 1000) / d + padM * 2 <= h) || 1000;
  const S = 1000 / denom; // mm de papel por metro
  const ox = (w - b.w * S) / 2 - b.x0 * S, oy = (h - b.h * S) / 2 - b.y0 * S;
  return { PW, PH, margin, block, w, h, denom, S, ox, oy };
}

export function scaledSVG(project, settings, lay) {
  return planSVG(project, {
    scale: lay.S, ox: lay.ox, oy: lay.oy, width: lay.w, height: lay.h, units: 'mm',
    font: lay.denom <= 50 ? 2.4 : 2.0, sw: 0.25, unit: settings.unit, thickness: settings.wallThickness,
    interactive: false, embedStyle: true, overall: true, dimOffset: 5,
  });
}

/** SVG independiente (para abrir en Inkscape/Illustrator o imprimir) a la escala elegida. */
export function toSVGFile(project, settings, paper = 'A4') {
  const lay = layoutForPaper(project, settings, paper);
  return { svg: '<?xml version="1.0" encoding="UTF-8"?>\n' + scaledSVG(project, settings, lay), lay };
}

/** Rellena el contenedor de impresión (lámina con cajetín) y abre el diálogo de imprimir/guardar PDF. */
export function printSheet(project, settings, paper = 'A4') {
  const lay = layoutForPaper(project, settings, paper);
  const root = document.getElementById('print-root');
  const total = project.rooms.reduce((s, r) => s + G.area(r.pts), 0);
  const rows = project.rooms.map((r) => { const st = roomStats(r); return `<tr><td>${esc(r.name)}</td><td>${fmtArea(st.area)}</td><td>${fmtLen(st.perimeter, settings.unit)}</td><td>${fmtLen(r.height, settings.unit)}</td></tr>`; }).join('');
  const date = new Date().toLocaleDateString('es-ES', { day: '2-digit', month: 'long', year: 'numeric' });
  root.innerHTML = `
  <style>@page{size:${paper} landscape;margin:0}</style>
  <div class="psheet" style="width:${lay.PW}mm;height:${lay.PH - 0.6}mm;padding:${lay.margin}mm">
    <div class="psheet-draw" style="width:${lay.w}mm;height:${lay.h}mm">${scaledSVG(project, settings, lay)}</div>
    <div class="psheet-block" style="height:${lay.block}mm">
      <div class="tb-main"><div class="tb-title">${esc(project.name)}</div>
        <div class="tb-sub">Plano de planta · Cotas en ${settings.unit === 'm' ? 'metros' : settings.unit === 'cm' ? 'centímetros' : 'milímetros'} · Las cotas con ≈ son estimadas por escaneo</div>
        <div class="tb-sub">${date}${settings.author ? ' · ' + esc(settings.author) : ''}</div></div>
      <table class="tb-table"><thead><tr><th>Espacio</th><th>Superficie</th><th>Perímetro</th><th>Altura</th></tr></thead><tbody>${rows}<tr class="tb-total"><td>Total</td><td>${fmtArea(total)}</td><td></td><td></td></tr></tbody></table>
      <div class="tb-scale"><div class="tb-big">1:${lay.denom}</div><div class="tb-sub">${paper} apaisado</div>${scaleBar(lay)}</div>
    </div>
  </div>`;
  document.body.classList.add('printing');
  const done = () => { document.body.classList.remove('printing'); window.removeEventListener('afterprint', done); };
  window.addEventListener('afterprint', done);
  setTimeout(() => window.print(), 60);
  return lay;
}

function scaleBar(lay) {
  const S = lay.S; // mm por metro
  let m = 1; while (m * S < 15) m *= 2; while (m * S > 40) m /= 2;
  const w = m * S;
  return `<svg width="${w + 10}mm" height="7mm" viewBox="0 0 ${w + 10} 7"><rect x="0.5" y="1" width="${w / 2}" height="1.6" fill="#222"/><rect x="${0.5 + w / 2}" y="1" width="${w / 2}" height="1.6" fill="none" stroke="#222" stroke-width="0.25"/><text x="0.5" y="6" font-size="2.4" font-family="Inter,system-ui">0</text><text x="${0.5 + w}" y="6" font-size="2.4" text-anchor="middle" font-family="Inter,system-ui">${fmtNum(m, m < 1 ? 1 : 0)} m</text></svg>`;
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// ---------------- PNG ----------------
export async function toPNG(project, settings, { pxPerMm = 6, paper = 'A4' } = {}) {
  const { svg, lay } = toSVGFile(project, settings, paper);
  const W = Math.round(lay.w * pxPerMm), H = Math.round(lay.h * pxPerMm);
  const img = new Image();
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
  await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = url; });
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const ctx = c.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, W, H); ctx.drawImage(img, 0, 0, W, H);
  URL.revokeObjectURL(url);
  return await new Promise((res) => c.toBlob(res, 'image/png'));
}

// ---------------- CSV de medidas ----------------
export function toCSV(project, settings) {
  const rows = [['Espacio', 'Elemento', 'Medida (m)', 'Estado']];
  const q = (s) => `"${String(s).replace(/"/g, '""')}"`;
  for (const r of project.rooms) {
    r.pts.forEach((_, i) => rows.push([r.name, 'Pared ' + wallName(r, i), fmtNum(G.edgeLen(r.pts, i), 3), r.edges[i].locked != null ? 'medida' : 'estimada']));
    r.diagonals.forEach((d) => rows.push([r.name, `Diagonal ${G.cornerName(d.a)}–${G.cornerName(d.b)}`, fmtNum(G.dist(r.pts[d.a], r.pts[d.b]), 3), d.locked != null ? 'medida' : 'estimada']));
    r.pts.forEach((_, i) => rows.push([r.name, 'Ángulo ' + G.cornerName(i), fmtNum((G.interiorAngle(r.pts, i) * 180) / Math.PI, 2) + '°', r.corners[i].angle != null ? 'fijado' : 'estimado']));
    rows.push([r.name, 'Altura', fmtNum(r.height, 3), r.heightLocked ? 'medida' : 'estimada']);
    r.openings.forEach((o, k) => rows.push([r.name, `${o.type === 'door' ? 'Puerta' : o.type === 'window' ? 'Ventana' : 'Hueco'} ${k + 1} (pared ${wallName(r, o.wall)}) ancho×alto`, `${fmtNum(o.width, 3)} × ${fmtNum(o.height, 3)}`, '']));
    const st = roomStats(r);
    rows.push([r.name, 'Superficie (m²)', fmtNum(st.area, 2), '']);
    rows.push([r.name, 'Perímetro', fmtNum(st.perimeter, 3), '']);
  }
  return '﻿' + rows.map((r) => r.map(q).join(';')).join('\r\n');
}

// ---------------- Descargar / compartir ----------------
export function slug(s) { return (s || 'plano').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase() || 'plano'; }

export function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1500);
}

export async function share(blob, name, title) {
  const file = new File([blob], name, { type: blob.type || 'application/octet-stream' });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], title }); return true; } catch (e) { if (e.name === 'AbortError') return true; }
  }
  download(blob, name);
  return false;
}
