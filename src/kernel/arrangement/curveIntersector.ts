import {
  CadArcEntity,
  CadEntity,
  CadLineEntity,
  LineType,
  LoopCurveSegment2D,
  Point2D,
  ViewType,
} from '../../types/cad';
import { BoundingBox2D, CurveSegment2D } from '../../types/kernel';

export function dist2D(a: Point2D, b: Point2D): number {
  return Math.hypot(a.u - b.u, a.v - b.v);
}

export function normalizeAngle(angle: number): number {
  const twoPi = Math.PI * 2;
  return ((angle % twoPi) + twoPi) % twoPi;
}

export function ccwSweepAngle(startAngle: number, endAngle: number): number {
  let sweep = normalizeAngle(endAngle - startAngle);
  if (sweep < 1e-4) sweep = Math.PI * 2;
  return sweep;
}

export function isAngleOnArc(
  testAngle: number,
  startAngle: number,
  endAngle: number,
  tol = 1e-3
): boolean {
  const sweep = ccwSweepAngle(startAngle, endAngle);
  const rel = normalizeAngle(testAngle - startAngle);
  return rel <= sweep + tol || Math.abs(rel - Math.PI * 2) <= tol;
}

export function pointToSegmentDist(
  p: Point2D,
  a: Point2D,
  b: Point2D
): { dist: number; proj: Point2D; t: number } {
  const dx = b.u - a.u;
  const dy = b.v - a.v;
  const lenSq = dx * dx + dy * dy;
  if (lenSq < 1e-10) {
    return { dist: dist2D(p, a), proj: { ...a }, t: 0 };
  }
  const rawT = ((p.u - a.u) * dx + (p.v - a.v) * dy) / lenSq;
  const t = Math.max(0, Math.min(1, rawT));
  const proj = { u: a.u + t * dx, v: a.v + t * dy };
  return { dist: dist2D(p, proj), proj, t: rawT };
}

/**
 * 100% isomorphic arc sampler shared across 2D Canvas/SVG, HLR, SDF, and 3D Viewport
 */
export function sampleArcPoints(
  arc: {
    center: Point2D;
    radius: number;
    startAngle: number;
    endAngle: number;
    ccw?: boolean;
  },
  numSegments = 32,
  includeEndpoints = true
): Point2D[] {
  const sweep = ccwSweepAngle(arc.startAngle, arc.endAngle);
  const steps = Math.max(8, Math.round((sweep / Math.PI) * numSegments));
  const pts: Point2D[] = [];
  const iStart = includeEndpoints ? 0 : 1;
  const iEnd = includeEndpoints ? steps : steps - 1;
  const isCcw = arc.ccw !== false;
  for (let i = iStart; i <= iEnd; i++) {
    const t = isCcw ? i / steps : 1 - i / steps;
    const ang = arc.startAngle + sweep * t;
    pts.push({
      u: arc.center.u + arc.radius * Math.cos(ang),
      v: arc.center.v + arc.radius * Math.sin(ang),
    });
  }
  return pts;
}

export function getArcExactBounds(
  center: Point2D,
  radius: number,
  startAngle: number,
  endAngle: number
): BoundingBox2D {
  const p1 = {
    u: center.u + radius * Math.cos(startAngle),
    v: center.v + radius * Math.sin(startAngle),
  };
  const p2 = {
    u: center.u + radius * Math.cos(endAngle),
    v: center.v + radius * Math.sin(endAngle),
  };
  let uMin = Math.min(p1.u, p2.u);
  let uMax = Math.max(p1.u, p2.u);
  let vMin = Math.min(p1.v, p2.v);
  let vMax = Math.max(p1.v, p2.v);
  if (isAngleOnArc(0, startAngle, endAngle)) uMax = Math.max(uMax, center.u + radius);
  if (isAngleOnArc(Math.PI * 0.5, startAngle, endAngle)) vMax = Math.max(vMax, center.v + radius);
  if (isAngleOnArc(Math.PI, startAngle, endAngle)) uMin = Math.min(uMin, center.u - radius);
  if (isAngleOnArc(Math.PI * 1.5, startAngle, endAngle)) vMin = Math.min(vMin, center.v - radius);
  return { uMin, uMax, vMin, vMax };
}

export function getSegmentsExactBounds(segments: LoopCurveSegment2D[]): BoundingBox2D {
  let uMin = Infinity;
  let uMax = -Infinity;
  let vMin = Infinity;
  let vMax = -Infinity;
  for (const s of segments) {
    if (
      s.kind === 'arc' &&
      s.center &&
      s.radius !== undefined &&
      s.startAngle !== undefined &&
      s.endAngle !== undefined
    ) {
      const b = getArcExactBounds(s.center, s.radius, s.startAngle, s.endAngle);
      uMin = Math.min(uMin, b.uMin);
      uMax = Math.max(uMax, b.uMax);
      vMin = Math.min(vMin, b.vMin);
      vMax = Math.max(vMax, b.vMax);
    } else {
      uMin = Math.min(uMin, s.p1.u, s.p2.u);
      uMax = Math.max(uMax, s.p1.u, s.p2.u);
      vMin = Math.min(vMin, s.p1.v, s.p2.v);
      vMax = Math.max(vMax, s.p1.v, s.p2.v);
    }
  }
  return { uMin, uMax, vMin, vMax };
}

export function polygonSignedArea2D(pts: Point2D[]): number {
  if (pts.length < 3) return 0;
  let s = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    s += a.u * b.v - b.u * a.v;
  }
  return 0.5 * s;
}

export function polygonArea2D(pts: Point2D[]): number {
  return Math.abs(polygonSignedArea2D(pts));
}

export function buildDensePolygonFromSegments(segments: LoopCurveSegment2D[]): Point2D[] {
  const pts: Point2D[] = [];
  const pushUnique = (pt: Point2D) => {
    if (pts.length === 0 || dist2D(pts[pts.length - 1], pt) > 0.05) {
      pts.push({ u: pt.u, v: pt.v });
    }
  };
  for (const seg of segments) {
    pushUnique(seg.p1);
    if (
      seg.kind === 'arc' &&
      seg.center &&
      seg.radius !== undefined &&
      seg.startAngle !== undefined &&
      seg.endAngle !== undefined
    ) {
      const arcPts = sampleArcPoints(
        {
          center: seg.center,
          radius: seg.radius,
          startAngle: seg.startAngle,
          endAngle: seg.endAngle,
          ccw: seg.ccw !== false,
        },
        32,
        false
      );
      for (const ap of arcPts) pushUnique(ap);
    }
  }
  if (pts.length > 2 && dist2D(pts[0], pts[pts.length - 1]) <= 0.1) {
    pts.pop();
  }
  return pts;
}

/**
 * Exact Line-Line intersection parameter solver
 */
export function intersectLineLineParams(
  p1: Point2D,
  p2: Point2D,
  q1: Point2D,
  q2: Point2D
): { pt: Point2D; t: number; u: number } | null {
  const rU = p2.u - p1.u;
  const rV = p2.v - p1.v;
  const sU = q2.u - q1.u;
  const sV = q2.v - q1.v;
  const cross = rU * sV - rV * sU;
  if (Math.abs(cross) < 1e-6) return null;
  const qpU = q1.u - p1.u;
  const qpV = q1.v - p1.v;
  const t = (qpU * sV - qpV * sU) / cross;
  const u = (qpU * rV - qpV * rU) / cross;
  if (t >= -1e-3 && t <= 1 + 1e-3 && u >= -1e-3 && u <= 1 + 1e-3) {
    return {
      pt: { u: p1.u + t * rU, v: p1.v + t * rV },
      t: Math.max(0, Math.min(1, t)),
      u: Math.max(0, Math.min(1, u)),
    };
  }
  return null;
}

/**
 * Exact Line-Arc intersection parameter solver
 */
export function intersectLineArcParams(
  p1: Point2D,
  p2: Point2D,
  arc: { center: Point2D; radius: number; startAngle: number; endAngle: number }
): { pt: Point2D; tLine: number; angleArc: number }[] {
  const dx = p2.u - p1.u;
  const dy = p2.v - p1.v;
  const fx = p1.u - arc.center.u;
  const fy = p1.v - arc.center.v;
  const a = dx * dx + dy * dy;
  if (a < 1e-8) return [];
  const b = 2 * (fx * dx + fy * dy);
  const c = fx * fx + fy * fy - arc.radius * arc.radius;
  let disc = b * b - 4 * a * c;
  if (disc < -1e-3) return [];
  disc = Math.max(0, disc);
  const sqrtDisc = Math.sqrt(disc);
  const tCandidates = disc < 1e-6 ? [-b / (2 * a)] : [(-b - sqrtDisc) / (2 * a), (-b + sqrtDisc) / (2 * a)];
  const results: { pt: Point2D; tLine: number; angleArc: number }[] = [];
  for (const t of tCandidates) {
    if (t >= -0.02 && t <= 1.02) {
      const tClamped = Math.max(0, Math.min(1, t));
      const pt = { u: p1.u + tClamped * dx, v: p1.v + tClamped * dy };
      const ang = normalizeAngle(Math.atan2(pt.v - arc.center.v, pt.u - arc.center.u));
      if (isAngleOnArc(ang, arc.startAngle, arc.endAngle, 0.03)) {
        results.push({ pt, tLine: tClamped, angleArc: ang });
      }
    }
  }
  return results;
}

/**
 * Subdivides all lines and arcs in a view at X-intersections and T-junctions,
 * merges colinear overlapping chords, and calibrates near-orthogonal semicircular chords.
 */
export function subdivideAndSnapCurves(
  entities: CadEntity[],
  view: ViewType,
  lineType: LineType = 'thick_solid',
  tJunctionTol = 1.8
): CurveSegment2D[] {
  const viewEnts = entities.filter((e) => e.view === view && e.source !== 'derived' && e.lineType === lineType);
  const rawLines: { id: string; p1: Point2D; p2: Point2D }[] = [];
  const rawArcs: CadArcEntity[] = [];

  for (const e of viewEnts) {
    if (e.type === 'line') {
      if (dist2D(e.p1, e.p2) >= 0.3) {
        rawLines.push({ id: e.id, p1: { ...e.p1 }, p2: { ...e.p2 } });
      }
    } else if (e.type === 'rect') {
      const pts: Point2D[] = [
        { u: e.x, v: e.y },
        { u: e.x + e.width, v: e.y },
        { u: e.x + e.width, v: e.y + e.height },
        { u: e.x, v: e.y + e.height },
      ];
      for (let i = 0; i < 4; i++) {
        rawLines.push({ id: `${e.id}_edge_${i}`, p1: pts[i], p2: pts[(i + 1) % 4] });
      }
    } else if (e.type === 'polygon' && e.points.length >= 2) {
      const cnt = e.closed ? e.points.length : e.points.length - 1;
      for (let i = 0; i < cnt; i++) {
        const p1 = e.points[i];
        const p2 = e.points[(i + 1) % e.points.length];
        if (dist2D(p1, p2) >= 0.3) {
          rawLines.push({ id: `${e.id}_seg_${i}`, p1: { ...p1 }, p2: { ...p2 } });
        }
      }
    } else if (e.type === 'arc') {
      rawArcs.push(e);
    }
  }

  // Ortho-calibrate horizontal/vertical lines that close semicircular arcs
  for (const arc of rawArcs) {
    const pS = {
      u: arc.center.u + arc.radius * Math.cos(arc.startAngle),
      v: arc.center.v + arc.radius * Math.sin(arc.startAngle),
    };
    const pE = {
      u: arc.center.u + arc.radius * Math.cos(arc.endAngle),
      v: arc.center.v + arc.radius * Math.sin(arc.endAngle),
    };
    for (const ln of rawLines) {
      const dS = pointToSegmentDist(pS, ln.p1, ln.p2).dist;
      const dE = pointToSegmentDist(pE, ln.p1, ln.p2).dist;
      if (dS <= 2.5 && dE <= 2.5) {
        if (
          Math.abs(ln.p1.v - ln.p2.v) <= 3.0 &&
          Math.abs(0.5 * (ln.p1.v + ln.p2.v) - arc.center.v) <= 3.5
        ) {
          ln.p1.v = arc.center.v;
          ln.p2.v = arc.center.v;
        } else if (
          Math.abs(ln.p1.u - ln.p2.u) <= 3.0 &&
          Math.abs(0.5 * (ln.p1.u + ln.p2.u) - arc.center.u) <= 3.5
        ) {
          ln.p1.u = arc.center.u;
          ln.p2.u = arc.center.u;
        }
      }
    }
  }

  // Collect all key endpoints (line endpoints + arc endpoints) for T-junction splitting
  const allEndpoints: Point2D[] = [];
  for (const ln of rawLines) {
    allEndpoints.push(ln.p1, ln.p2);
  }
  for (const arc of rawArcs) {
    allEndpoints.push(
      {
        u: arc.center.u + arc.radius * Math.cos(arc.startAngle),
        v: arc.center.v + arc.radius * Math.sin(arc.startAngle),
      },
      {
        u: arc.center.u + arc.radius * Math.cos(arc.endAngle),
        v: arc.center.v + arc.radius * Math.sin(arc.endAngle),
      }
    );
  }

  // Split straight lines at all X-intersections and interior T-junction endpoints
  const subdividedSegments: CurveSegment2D[] = [];
  for (let i = 0; i < rawLines.length; i++) {
    const ln = rawLines[i];
    const len = dist2D(ln.p1, ln.p2);
    if (len < 0.3) continue;
    const ux = (ln.p2.u - ln.p1.u) / len;
    const uy = (ln.p2.v - ln.p1.v) / len;
    const splitTs: number[] = [0, 1];
    const addSplitT = (t: number) => {
      if (t > 0.02 && t < 0.98 && !splitTs.some((st) => Math.abs(st - t) <= 0.015)) {
        splitTs.push(t);
      }
    };

    // T-junctions from any endpoint
    for (const pt of allEndpoints) {
      const d = pointToSegmentDist(pt, ln.p1, ln.p2);
      if (d.dist <= tJunctionTol) {
        const t = ((pt.u - ln.p1.u) * ux + (pt.v - ln.p1.v) * uy) / len;
        addSplitT(t);
      }
    }

    // Line-Line X-intersections
    for (let j = 0; j < rawLines.length; j++) {
      if (i === j) continue;
      const ix = intersectLineLineParams(ln.p1, ln.p2, rawLines[j].p1, rawLines[j].p2);
      if (ix) addSplitT(ix.t);
    }

    // Line-Arc intersections
    for (const arc of rawArcs) {
      const ixs = intersectLineArcParams(ln.p1, ln.p2, arc);
      for (const ix of ixs) addSplitT(ix.tLine);
    }

    splitTs.sort((a, b) => a - b);
    for (let k = 0; k < splitTs.length - 1; k++) {
      const tA = splitTs[k];
      const tB = splitTs[k + 1];
      const subP1 = {
        u: ln.p1.u + tA * (ln.p2.u - ln.p1.u),
        v: ln.p1.v + tA * (ln.p2.v - ln.p1.v),
      };
      const subP2 = {
        u: ln.p1.u + tB * (ln.p2.u - ln.p1.u),
        v: ln.p1.v + tB * (ln.p2.v - ln.p1.v),
      };
      if (dist2D(subP1, subP2) >= 0.3) {
        subdividedSegments.push({
          id: `${ln.id}_sub_${k}`,
          kind: 'line',
          p1: subP1,
          p2: subP2,
          lineType,
          sourceEntityId: ln.id,
        });
      }
    }
  }

  // Add arc segments with exact endpoints snapped to ortho-calibrated chords when applicable
  for (const arc of rawArcs) {
    let pS = {
      u: arc.center.u + arc.radius * Math.cos(arc.startAngle),
      v: arc.center.v + arc.radius * Math.sin(arc.startAngle),
    };
    let pE = {
      u: arc.center.u + arc.radius * Math.cos(arc.endAngle),
      v: arc.center.v + arc.radius * Math.sin(arc.endAngle),
    };
    if (Math.abs(pS.v - arc.center.v) <= 2.5 && Math.abs(pE.v - arc.center.v) <= 2.5) {
      pS = { u: pS.u, v: arc.center.v };
      pE = { u: pE.u, v: arc.center.v };
    } else if (Math.abs(pS.u - arc.center.u) <= 2.5 && Math.abs(pE.u - arc.center.u) <= 2.5) {
      pS = { u: arc.center.u, v: pS.v };
      pE = { u: arc.center.u, v: pE.v };
    }
    if (dist2D(pS, pE) >= 0.3) {
      subdividedSegments.push({
        id: arc.id,
        kind: 'arc',
        p1: pS,
        p2: pE,
        center: { ...arc.center },
        radius: arc.radius,
        startAngle: arc.startAngle,
        endAngle: arc.endAngle,
        ccw: true,
        lineType,
        sourceEntityId: arc.id,
      });
    }
  }

  return subdividedSegments;
}
