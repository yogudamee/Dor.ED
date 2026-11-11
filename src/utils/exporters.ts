import { CadEntity, Primitive3D } from '../types/cad';
import { exportPrimitivesToWatertightSTL } from '../kernel';
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
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}px" height="${height}px" style="background:#0B0F17;font-family:'JetBrains Mono',monospace;">`,
    `<!-- Outer Frame & GB Title Block -->`,
    `<rect x="16" y="16" width="${width - 32}" height="${height - 32}" fill="none" stroke="#475569" stroke-width="2"/>`,
    `<line x1="460" y1="16" x2="460" y2="${height - 16}" stroke="#1E293B" stroke-width="1" stroke-dasharray="4,4"/>`,
    `<line x1="16" y1="340" x2="${width - 16}" y2="340" stroke="#1E293B" stroke-width="1" stroke-dasharray="4,4"/>`,
    `<text x="32" y="42" fill="#94A3B8" font-size="13" font-weight="bold">主视图 (Front V)</text>`,
    `<text x="480" y="42" fill="#94A3B8" font-size="13" font-weight="bold">左视图 (Left W)</text>`,
    `<text x="32" y="366" fill="#94A3B8" font-size="13" font-weight="bold">俯视图 (Top H)</text>`,
    `<rect x="520" y="560" width="368" height="88" fill="#111827" stroke="#475569" stroke-width="1.5"/>`,
    `<text x="536" y="592" fill="#F8FAFC" font-size="15" font-weight="bold">Dor.ED 工程制图标准图纸</text>`,
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
 * Powered by the unified sharp-edge watertight manifold CSG mesher (including subtracted holes,
 * slots, GeneralizedLofts, hemispheres, and saddle intersections).
 */
export function exportToSTL(primitives: Primitive3D[], name = 'DorED_3D_Solid'): string {
  return exportPrimitivesToWatertightSTL(primitives, name);
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

