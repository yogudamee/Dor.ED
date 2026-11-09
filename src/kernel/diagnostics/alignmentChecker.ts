import { CadEntity, ViewType, DiagnosticIssue } from '../../types/cad';
import { subdivideAndSnapCurves } from '../arrangement/curveIntersector';

export interface SpanBounds2D {
  uMin: number;
  uMax: number;
  vMin: number;
  vMax: number;
  hasContent: boolean;
}

/**
 * Computes the overall bounding box (uMin, uMax, vMin, vMax) for structural curves
 * (thick_solid and thin_dashed) in a given view.
 */
export function computeViewSpanBounds(
  entities: CadEntity[],
  view: ViewType
): SpanBounds2D {
  const relevant = entities.filter(
    (e) =>
      e.view === view &&
      (e.lineType === 'thick_solid' || e.lineType === 'thin_dashed')
  );
  if (relevant.length === 0) {
    return { uMin: 0, uMax: 0, vMin: 0, vMax: 0, hasContent: false };
  }

  let uMin = Infinity;
  let uMax = -Infinity;
  let vMin = Infinity;
  let vMax = -Infinity;

  for (const e of relevant) {
    if (e.type === 'line') {
      uMin = Math.min(uMin, e.p1.u, e.p2.u);
      uMax = Math.max(uMax, e.p1.u, e.p2.u);
      vMin = Math.min(vMin, e.p1.v, e.p2.v);
      vMax = Math.max(vMax, e.p1.v, e.p2.v);
    } else if (e.type === 'rect') {
      uMin = Math.min(uMin, e.x, e.x + e.width);
      uMax = Math.max(uMax, e.x, e.x + e.width);
      vMin = Math.min(vMin, e.y, e.y + e.height);
      vMax = Math.max(vMax, e.y, e.y + e.height);
    } else if (e.type === 'circle') {
      uMin = Math.min(uMin, e.center.u - e.radius);
      uMax = Math.max(uMax, e.center.u + e.radius);
      vMin = Math.min(vMin, e.center.v - e.radius);
      vMax = Math.max(vMax, e.center.v + e.radius);
    } else if (e.type === 'arc') {
      for (let i = 0; i <= 24; i++) {
        const t = i / 24;
        const ang = e.startAngle + t * (e.endAngle - e.startAngle);
        const u = e.center.u + e.radius * Math.cos(ang);
        const v = e.center.v + e.radius * Math.sin(ang);
        uMin = Math.min(uMin, u);
        uMax = Math.max(uMax, u);
        vMin = Math.min(vMin, v);
        vMax = Math.max(vMax, v);
      }
    } else if (e.type === 'polygon') {
      for (const p of e.points) {
        uMin = Math.min(uMin, p.u);
        uMax = Math.max(uMax, p.u);
        vMin = Math.min(vMin, p.v);
        vMax = Math.max(vMax, p.v);
      }
    }
  }

  if (!Number.isFinite(uMin)) {
    return { uMin: 0, uMax: 0, vMin: 0, vMax: 0, hasContent: false };
  }
  return { uMin, uMax, vMin, vMax, hasContent: true };
}

/**
 * GB/T 4458.1 Three-Equal Alignment Checker ("长对正、高平齐、宽相等"):
 * - Front u (X) <-> Top u (X): 长对正
 * - Front v (Z) <-> Left v (Z): 高平齐
 * - Top v (Y) <-> Left u (Y): 宽相等
 */
export function checkThreeEqualAlignment(
  entities: CadEntity[],
  tolerance: number = 2.0
): DiagnosticIssue[] {
  const issues: DiagnosticIssue[] = [];
  const front = computeViewSpanBounds(entities, 'front');
  const top = computeViewSpanBounds(entities, 'top');
  const left = computeViewSpanBounds(entities, 'left');

  // 1. 长对正 (Front X vs Top X)
  if (front.hasContent && top.hasContent) {
    const dMin = Math.abs(front.uMin - top.uMin);
    const dMax = Math.abs(front.uMax - top.uMax);
    if (dMin > tolerance || dMax > tolerance) {
      issues.push({
        id: 'align-x-front-top',
        severity: 'error',
        category: 'violation_length',
        title: '违反“长对正”原则（主视图与俯视图 X 轴跨度不对齐）',
        description: `主视图 X 范围 [${front.uMin.toFixed(1)}, ${front.uMax.toFixed(1)}] 与俯视图 X 范围 [${top.uMin.toFixed(1)}, ${top.uMax.toFixed(1)}] 偏差超过 ${tolerance.toFixed(1)}mm（Δmin=${dMin.toFixed(1)}mm, Δmax=${dMax.toFixed(1)}mm）。`,
        views: ['front', 'top'],
        suggestion: '请使用竖直构造对齐线将主视图与俯视图的左右边界对齐。',
      });
    }
  }

  // 2. 高平齐 (Front Z vs Left Z)
  if (front.hasContent && left.hasContent) {
    const dMin = Math.abs(front.vMin - left.vMin);
    const dMax = Math.abs(front.vMax - left.vMax);
    if (dMin > tolerance || dMax > tolerance) {
      issues.push({
        id: 'align-z-front-left',
        severity: 'error',
        category: 'violation_height',
        title: '违反“高平齐”原则（主视图与左视图 Z 轴高度不对齐）',
        description: `主视图 Z 范围 [${front.vMin.toFixed(1)}, ${front.vMax.toFixed(1)}] 与左视图 Z 范围 [${left.vMin.toFixed(1)}, ${left.vMax.toFixed(1)}] 偏差超过 ${tolerance.toFixed(1)}mm（Δmin=${dMin.toFixed(1)}mm, Δmax=${dMax.toFixed(1)}mm）。`,
        views: ['front', 'left'],
        suggestion: '请使用水平构造对齐线将主视图与左视图的上下顶底面高度对齐。',
      });
    }
  }

  // 3. 宽相等 (Top Y vs Left Y)
  if (top.hasContent && left.hasContent) {
    const topWidth = top.vMax - top.vMin;
    const leftWidth = left.uMax - left.uMin;
    const dMin = Math.abs(top.vMin - left.uMin);
    const dMax = Math.abs(top.vMax - left.uMax);
    const dSpan = Math.abs(topWidth - leftWidth);
    if (dSpan > tolerance && (dMin > tolerance || dMax > tolerance)) {
      issues.push({
        id: 'align-y-top-left',
        severity: 'error',
        category: 'violation_width',
        title: '违反“宽相等”原则（俯视图与左视图 Y 轴前后宽度不一致）',
        description: `俯视图前后宽度 ΔY=${topWidth.toFixed(1)}mm [${top.vMin.toFixed(1)}, ${top.vMax.toFixed(1)}] 与左视图前后宽度 ΔY=${leftWidth.toFixed(1)}mm [${left.uMin.toFixed(1)}, ${left.uMax.toFixed(1)}] 偏差 ${dSpan.toFixed(1)}mm。`,
        views: ['top', 'left'],
        suggestion: '请通过右下象限 45° 宽相等折线对齐俯视图与左视图的前后宽度。',
      });
    }
  }

  return issues;
}

/**
 * Checks for dangling (degree-1) vertices in the `thick_solid` arrangement graph
 * that indicate unclosed outer profiles or hanging segments.
 */
export function checkTopologicalClosure(
  entities: CadEntity[],
  views: ViewType[] = ['front', 'top', 'left']
): DiagnosticIssue[] {
  const issues: DiagnosticIssue[] = [];

  for (const view of views) {
    const viewSolids = entities.filter(
      (e) => e.view === view && e.lineType === 'thick_solid'
    );
    if (viewSolids.length === 0) continue;

    const segments = subdivideAndSnapCurves(entities, view, 'thick_solid');
    if (segments.length === 0) continue;

    const degreeMap = new Map<string, { u: number; v: number; count: number }>();
    const snap = (u: number, v: number) => {
      for (const [k, entry] of degreeMap.entries()) {
        if (Math.hypot(entry.u - u, entry.v - v) <= 1.8) {
          return k;
        }
      }
      const key = `${u.toFixed(1)},${v.toFixed(1)}`;
      degreeMap.set(key, { u, v, count: 0 });
      return key;
    };

    for (const seg of segments) {
      const k1 = snap(seg.p1.u, seg.p1.v);
      const k2 = snap(seg.p2.u, seg.p2.v);
      if (k1 !== k2) {
        degreeMap.get(k1)!.count += 1;
        degreeMap.get(k2)!.count += 1;
      }
    }

    const danglingPoints: { u: number; v: number }[] = [];
    for (const entry of degreeMap.values()) {
      if (entry.count === 1) {
        danglingPoints.push({ u: entry.u, v: entry.v });
      }
    }

    if (danglingPoints.length > 0) {
      const viewLabel =
        view === 'front' ? '主视图' : view === 'top' ? '俯视图' : '左视图';
      const coords = danglingPoints
        .slice(0, 3)
        .map((p) => `(${p.u.toFixed(1)}, ${p.v.toFixed(1)})`)
        .join(', ');
      issues.push({
        id: `topology-dangling-${view}`,
        severity: 'warning',
        category: 'unclosed_loop',
        title: `${viewLabel}存在未闭合的悬空实线端点`,
        description: `在${viewLabel}中检测到 ${danglingPoints.length} 个度数为 1 的悬空实线端点：${coords}，可能导致闭合环无法参与三维拉伸。`,
        views: [view],
        suggestion: '请使用端点捕捉（OSNAP）闭合外轮廓或删除多余的悬空线段。',
      });
    }
  }

  return issues;
}
