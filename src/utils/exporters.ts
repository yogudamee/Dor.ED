import { CadEntity, Primitive3D } from '../types/cad';
import { expandEntityToSegments } from './geometryKernel';

/**
 * Export 2D CAD entities to AutoCAD DXF (AC1009 / R12 standard format)
 */
export function exportToDXF(entities: CadEntity[]): string {
  const lines: string[] = [
    '0', 'SECTION',
    '2', 'HEADER',
    '9', '$ACADVER',
    '1', 'AC1009',
    '0', 'ENDSEC',
    '0', 'SECTION',
    '2', 'TABLES',
    '0', 'TABLE',
    '2', 'LTYPE',
    '70', '3',
    '0', 'LTYPE', '2', 'CONTINUOUS', '70', '0', '3', 'Solid line', '72', '65', '73', '0', '40', '0.0',
    '0', 'LTYPE', '2', 'DASHED', '70', '0', '3', 'Dashed __ __ __', '72', '65', '73', '2', '40', '6.0', '49', '4.0', '49', '-2.0',
    '0', 'LTYPE', '2', 'CENTER', '70', '0', '3', 'Center ____ _ ____', '72', '65', '73', '4', '40', '12.0', '49', '8.0', '49', '-1.5', '49', '1.0', '49', '-1.5',
    '0', 'ENDTAB',
    '0', 'ENDSEC',
    '0', 'SECTION',
    '2', 'ENTITIES',
  ];

  const getOffset = (view: CadEntity['view']): { dx: number; dy: number } => {
    switch (view) {
      case 'front':
        return { dx: 0, dy: 150 };
      case 'top':
        return { dx: 0, dy: 0 };
      case 'left':
        return { dx: 150, dy: 150 };
    }
  };

  const getLType = (lt: CadEntity['lineType']) => {
    if (lt === 'thin_dashed') return 'DASHED';
    if (lt === 'center_dot_dash') return 'CENTER';
    return 'CONTINUOUS';
  };

  for (const ent of entities) {
    const { dx, dy } = getOffset(ent.view);
    const ltype = getLType(ent.lineType);
    const layer = `${ent.view.toUpperCase()}_${ent.lineType.toUpperCase()}`;

    if (ent.type === 'circle') {
      lines.push(
        '0', 'CIRCLE',
        '8', layer,
        '6', ltype,
        '10', (ent.center.u + dx).toFixed(4),
        '20', (ent.center.v + dy).toFixed(4),
        '30', '0.0',
        '40', ent.radius.toFixed(4)
      );
    } else if (ent.type === 'arc') {
      lines.push(
        '0', 'ARC',
        '8', layer,
        '6', ltype,
        '10', (ent.center.u + dx).toFixed(4),
        '20', (ent.center.v + dy).toFixed(4),
        '30', '0.0',
        '40', ent.radius.toFixed(4),
        '50', ((ent.startAngle * 180) / Math.PI).toFixed(4),
        '51', ((ent.endAngle * 180) / Math.PI).toFixed(4)
      );
    } else {
      const segs = expandEntityToSegments(ent);
      for (const seg of segs) {
        lines.push(
          '0', 'LINE',
          '8', layer,
          '6', ltype,
          '10', (seg.p1.u + dx).toFixed(4),
          '20', (seg.p1.v + dy).toFixed(4),
          '30', '0.0',
          '11', (seg.p2.u + dx).toFixed(4),
          '21', (seg.p2.v + dy).toFixed(4),
          '31', '0.0'
        );
      }
    }
  }

  lines.push('0', 'ENDSEC', '0', 'EOF');
  return lines.join('\n');
}

/**
 * Export 2D Three-View Engineering Drawing to standard SVG Blueprint
 */
export function exportToSVG(entities: CadEntity[], projectTitle: string): string {
  const width = 920;
  const height = 680;
  const svgParts: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" style="background:#0B0F17;font-family:'JetBrains Mono',monospace;">`,
    `<!-- Outer Frame & GB Title Block -->`,
    `<rect x="16" y="16" width="${width - 32}" height="${height - 32}" fill="none" stroke="#475569" stroke-width="2"/>`,
    `<line x1="460" y1="16" x2="460" y2="${height - 16}" stroke="#1E293B" stroke-width="1" stroke-dasharray="4,4"/>`,
    `<line x1="16" y1="340" x2="${width - 16}" y2="340" stroke="#1E293B" stroke-width="1" stroke-dasharray="4,4"/>`,
    `<text x="32" y="42" fill="#94A3B8" font-size="13" font-weight="bold">主视图 (Front V)</text>`,
    `<text x="480" y="42" fill="#94A3B8" font-size="13" font-weight="bold">左视图 (Left W)</text>`,
    `<text x="32" y="366" fill="#94A3B8" font-size="13" font-weight="bold">俯视图 (Top H)</text>`,
    `<rect x="520" y="560" width="368" height="88" fill="#111827" stroke="#475569" stroke-width="1.5"/>`,
    `<text x="536" y="592" fill="#F8FAFC" font-size="15" font-weight="bold">EngiDraft 3D 工程制图标准图纸</text>`,
    `<text x="536" y="618" fill="#38BDF8" font-size="12">课题：${projectTitle}</text>`,
    `<text x="536" y="638" fill="#94A3B8" font-size="11">投影法：GB/T 4458.1 第一角画法  |  比例 1:1  |  单位 mm</text>`,
  ];

  // 45-degree miter line in Q4
  svgParts.push(
    `<line x1="460" y1="340" x2="740" y2="620" stroke="#10B981" stroke-width="1.2" stroke-dasharray="5,3"/>`,
    `<text x="640" y="510" fill="#10B981" font-size="11">45° 宽相等辅助线</text>`
  );

  const mapPt = (view: CadEntity['view'], u: number, v: number): { x: number; y: number } => {
    const scale = 2.6;
    if (view === 'front') {
      return { x: 60 + u * scale, y: 310 - v * scale };
    }
    if (view === 'top') {
      return { x: 60 + u * scale, y: 360 + v * scale };
    }
    // left
    return { x: 480 + u * scale, y: 310 - v * scale };
  };

  for (const ent of entities) {
    let stroke = '#F8FAFC';
    let strokeWidth = '2.4';
    let dash = '';
    if (ent.lineType === 'thin_dashed') {
      stroke = '#F59E0B';
      strokeWidth = '1.4';
      dash = 'stroke-dasharray="7,4"';
    } else if (ent.lineType === 'center_dot_dash') {
      stroke = '#06B6D4';
      strokeWidth = '1.2';
      dash = 'stroke-dasharray="12,3,2,3"';
    } else if (ent.lineType === 'construction') {
      stroke = '#10B981';
      strokeWidth = '1.0';
      dash = 'stroke-dasharray="3,3"';
    }

    if (ent.type === 'circle') {
      const c = mapPt(ent.view, ent.center.u, ent.center.v);
      const r = ent.radius * 2.6;
      svgParts.push(
        `<circle cx="${c.x.toFixed(1)}" cy="${c.y.toFixed(1)}" r="${r.toFixed(1)}" fill="none" stroke="${stroke}" stroke-width="${strokeWidth}" ${dash}/>`
      );
    } else {
      const segs = expandEntityToSegments(ent);
      for (const seg of segs) {
        const p1 = mapPt(ent.view, seg.p1.u, seg.p1.v);
        const p2 = mapPt(ent.view, seg.p2.u, seg.p2.v);
        svgParts.push(
          `<line x1="${p1.x.toFixed(1)}" y1="${p1.y.toFixed(1)}" x2="${p2.x.toFixed(1)}" y2="${p2.y.toFixed(1)}" stroke="${stroke}" stroke-width="${strokeWidth}" stroke-linecap="round" ${dash}/>`
        );
      }
    }
  }

  svgParts.push('</svg>');
  return svgParts.join('\n');
}

/**
 * Export 3D Reconstructed Model to ASCII STL format (SolidWorks / Fusion 360 compatible)
 */
export function exportToSTL(primitives: Primitive3D[], name = 'EngiDraft_3D_Solid'): string {
  const lines: string[] = [`solid ${name.replace(/\s+/g, '_')}`];

  const pushTri = (
    p1: [number, number, number],
    p2: [number, number, number],
    p3: [number, number, number]
  ) => {
    const ux = p2[0] - p1[0];
    const uy = p2[1] - p1[1];
    const uz = p2[2] - p1[2];
    const vx = p3[0] - p1[0];
    const vy = p3[1] - p1[1];
    const vz = p3[2] - p1[2];
    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz) || 1;
    nx /= len;
    ny /= len;
    nz /= len;
    lines.push(`  facet normal ${nx.toFixed(5)} ${ny.toFixed(5)} ${nz.toFixed(5)}`);
    lines.push('    outer loop');
    lines.push(`      vertex ${p1[0].toFixed(4)} ${p1[1].toFixed(4)} ${p1[2].toFixed(4)}`);
    lines.push(`      vertex ${p2[0].toFixed(4)} ${p2[1].toFixed(4)} ${p2[2].toFixed(4)}`);
    lines.push(`      vertex ${p3[0].toFixed(4)} ${p3[1].toFixed(4)} ${p3[2].toFixed(4)}`);
    lines.push('    endloop');
    lines.push('  endfacet');
  };

  const addBox = (x0: number, x1: number, y0: number, y1: number, z0: number, z1: number) => {
    const v: [number, number, number][] = [
      [x0, y0, z0],
      [x1, y0, z0],
      [x1, y1, z0],
      [x0, y1, z0],
      [x0, y0, z1],
      [x1, y0, z1],
      [x1, y1, z1],
      [x0, y1, z1],
    ];
    const faces = [
      [0, 2, 1], [0, 3, 2], // bottom
      [4, 5, 6], [4, 6, 7], // top
      [0, 1, 5], [0, 5, 4], // front
      [2, 3, 7], [2, 7, 6], // back
      [0, 4, 7], [0, 7, 3], // left
      [1, 2, 6], [1, 6, 5], // right
    ];
    for (const [a, b, c] of faces) {
      pushTri(v[a], v[b], v[c]);
    }
  };

  const addCylinderZ = (cx: number, cy: number, z0: number, z1: number, rBot: number, rTop: number, segs = 32) => {
    for (let i = 0; i < segs; i++) {
      const a0 = (i / segs) * Math.PI * 2;
      const a1 = ((i + 1) / segs) * Math.PI * 2;
      const c0 = Math.cos(a0), s0 = Math.sin(a0);
      const c1 = Math.cos(a1), s1 = Math.sin(a1);
      const b0: [number, number, number] = [cx + rBot * c0, cy + rBot * s0, z0];
      const b1: [number, number, number] = [cx + rBot * c1, cy + rBot * s1, z0];
      const t0: [number, number, number] = [cx + rTop * c0, cy + rTop * s0, z1];
      const t1: [number, number, number] = [cx + rTop * c1, cy + rTop * s1, z1];
      if (rBot > 1e-3) pushTri([cx, cy, z0], b1, b0);
      if (rTop > 1e-3) pushTri([cx, cy, z1], t0, t1);
      if (rBot > 1e-3) pushTri(b0, b1, t1);
      if (rTop > 1e-3) pushTri(b0, t1, t0);
    }
  };

  const addSphere = (cx: number, cy: number, cz: number, r: number, hemi: boolean, wSegs = 28, hSegs = 16) => {
    const maxLat = hemi ? hSegs / 2 : hSegs;
    for (let i = 0; i < maxLat; i++) {
      const p0 = (i / hSegs) * Math.PI;
      const p1 = ((i + 1) / hSegs) * Math.PI;
      for (let j = 0; j < wSegs; j++) {
        const t0 = (j / wSegs) * Math.PI * 2;
        const t1 = ((j + 1) / wSegs) * Math.PI * 2;
        const pt = (phi: number, theta: number): [number, number, number] => [
          cx + r * Math.sin(phi) * Math.cos(theta),
          cy + r * Math.sin(phi) * Math.sin(theta),
          cz + r * Math.cos(phi),
        ];
        const v00 = pt(p0, t0), v10 = pt(p1, t0), v11 = pt(p1, t1), v01 = pt(p0, t1);
        if (i > 0) pushTri(v00, v10, v11);
        if (i < hSegs - 1) pushTri(v00, v11, v01);
      }
    }
  };

  for (const prim of primitives) {
    if (prim.operation === 'subtract') continue;
    const cx = prim.centerX ?? 0.5 * (prim.xMin + prim.xMax);
    const cy = prim.centerY ?? 0.5 * (prim.yMin + prim.yMax);
    const cz = prim.centerZ ?? 0.5 * (prim.zMin + prim.zMax);
    const r = prim.radius ?? 0.5 * (prim.xMax - prim.xMin);

    if (prim.shape === 'cylinder_z') {
      addCylinderZ(cx, cy, prim.zMin, prim.zMax, r, r);
    } else if (prim.shape === 'cone_z') {
      addCylinderZ(cx, cy, prim.zMin, prim.zMax, prim.rMin ?? r, prim.rMax ?? 0);
    } else if (prim.shape === 'sphere') {
      addSphere(cx, cy, cz, r, false);
    } else if (prim.shape === 'hemisphere') {
      addSphere(cx, cy, prim.zMin, r, true);
    } else if (prim.shape === 'pyramid' && prim.prismPolygon && prim.apex3D) {
      const pts = prim.prismPolygon;
      const apex = prim.apex3D;
      const zBase = Math.abs(apex[2] - prim.zMin) > Math.abs(apex[2] - prim.zMax) ? prim.zMin : prim.zMax;
      for (let i = 0; i < pts.length; i++) {
        const pA = pts[i], pB = pts[(i + 1) % pts.length];
        pushTri([pA.u, pA.v, zBase], [pB.u, pB.v, zBase], apex);
      }
    } else if (prim.shape === 'plane_sheet' && prim.vertices3D && prim.vertices3D.length >= 3) {
      const v3 = prim.vertices3D;
      for (let i = 1; i < v3.length - 1; i++) {
        pushTri(v3[0], v3[i], v3[i + 1]);
      }
    } else {
      addBox(prim.xMin, prim.xMax, prim.yMin, prim.yMax, prim.zMin, prim.zMax);
    }
  }

  lines.push(`endsolid ${name.replace(/\s+/g, '_')}`);
  return lines.join('\n');
}

/**
 * Trigger browser file download without window.open
 */
export function downloadTextFile(filename: string, content: string, mimeType = 'text/plain;charset=utf-8') {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/**
 * Export 2D Three-View Engineering Blueprint as High-Resolution PNG (1840x1360)
 */
export function exportToPNG(entities: CadEntity[], projectTitle: string) {
  const svgString = exportToSVG(entities, projectTitle);
  const svgBlob = new Blob([svgString], { type: 'image/svg+xml;charset=utf-8' });
  const url = URL.createObjectURL(svgBlob);
  const img = new Image();
  img.onload = () => {
    const canvas = document.createElement('canvas');
    canvas.width = 1840;
    canvas.height = 1360;
    const ctx = canvas.getContext('2d');
    if (ctx) {
      ctx.fillStyle = '#0B0F17';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      canvas.toBlob((pngBlob) => {
        if (pngBlob) {
          const pngUrl = URL.createObjectURL(pngBlob);
          const a = document.createElement('a');
          a.href = pngUrl;
          a.download = `${projectTitle}.png`;
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
          URL.revokeObjectURL(pngUrl);
        }
      }, 'image/png');
    }
    URL.revokeObjectURL(url);
  };
  img.src = url;
}

