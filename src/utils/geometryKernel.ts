import {
  CadArcEntity,
  CadCircleEntity,
  CadEntity,
  CadLineEntity,
  DiagnosticIssue,
  LineType,
  Point2D,
  ReconstructedSolution,
  SnapResult,
  SnapType,
  ViewType,
} from '../types/cad';
import {
  deriveFromCustomViews as kernelDeriveFromCustomViews,
  diagnoseThreeViews as kernelDiagnoseThreeViews,
  fixSingleDiagnosticIssue as kernelFixSingleDiagnosticIssue,
  getNormalizedBenchmarkPresets,
} from '../kernel';

export { getNormalizedBenchmarkPresets };

export interface Segment2D {
  p1: Point2D;
  p2: Point2D;
  entityId: string;
  lineType: LineType;
  view: ViewType;
  featureId?: string;
}

export interface GripHandle {
  id: string;
  entityId: string;
  point: Point2D;
  kind: 'endpoint' | 'corner' | 'center' | 'radius' | 'vertex';
}

// ============================================================================
// Interactive 2D CAD Drafting, Snapping (OSNAP), Grip Editing & Modify Tools
// ============================================================================

export function dist2D(a: Point2D, b: Point2D): number {
  return Math.hypot(a.u - b.u, a.v - b.v);
}

export function normalizeAngle(rad: number): number {
  const twoPi = Math.PI * 2;
  return ((rad % twoPi) + twoPi) % twoPi;
}

export function isAngleOnArc(
  a: number,
  start: number,
  end: number,
  tol = 0.001
): boolean {
  const na = normalizeAngle(a);
  const ns = normalizeAngle(start);
  const span = normalizeAngle(normalizeAngle(end) - ns);
  const rel = normalizeAngle(na - ns);
  return rel <= span + tol || rel >= Math.PI * 2 - tol;
}

export function getArcExactBounds(
  center: Point2D,
  radius: number,
  startAngle: number,
  endAngle: number
) {
  const pStart = {
    u: center.u + radius * Math.cos(startAngle),
    v: center.v + radius * Math.sin(startAngle),
  };
  const pEnd = {
    u: center.u + radius * Math.cos(endAngle),
    v: center.v + radius * Math.sin(endAngle),
  };
  let uMin = Math.min(pStart.u, pEnd.u);
  let uMax = Math.max(pStart.u, pEnd.u);
  let vMin = Math.min(pStart.v, pEnd.v);
  let vMax = Math.max(pStart.v, pEnd.v);
  const quadAngles = [0, Math.PI * 0.5, Math.PI, Math.PI * 1.5];
  for (const theta of quadAngles) {
    if (isAngleOnArc(theta, startAngle, endAngle, -1e-4)) {
      const qu = center.u + radius * Math.cos(theta);
      const qv = center.v + radius * Math.sin(theta);
      uMin = Math.min(uMin, qu);
      uMax = Math.max(uMax, qu);
      vMin = Math.min(vMin, qv);
      vMax = Math.max(vMax, qv);
    }
  }
  return { uMin, uMax, vMin, vMax };
}

export function intersectLineCircle(
  p1: Point2D,
  p2: Point2D,
  center: Point2D,
  radius: number,
  mode: 'segment' | 'ray' | 'infinite' = 'segment'
): { point: Point2D; t: number; angle: number }[] {
  const dx = p2.u - p1.u;
  const dy = p2.v - p1.v;
  const fx = p1.u - center.u;
  const fy = p1.v - center.v;
  const a = dx * dx + dy * dy;
  if (a < 1e-9) return [];
  const b = 2 * (fx * dx + fy * dy);
  const c = fx * fx + fy * fy - radius * radius;
  let disc = b * b - 4 * a * c;
  if (disc < -1e-5) return [];
  disc = Math.max(0, disc);
  const sqrtDisc = Math.sqrt(disc);
  const tCandidates = [(-b - sqrtDisc) / (2 * a), (-b + sqrtDisc) / (2 * a)];
  const results: { point: Point2D; t: number; angle: number }[] = [];

  for (const t of tCandidates) {
    if (
      mode === 'infinite' ||
      (mode === 'ray' && t >= -1e-4) ||
      (mode === 'segment' && t >= -1e-4 && t <= 1.0001)
    ) {
      const u = Number((p1.u + t * dx).toFixed(2));
      const v = Number((p1.v + t * dy).toFixed(2));
      const angle = normalizeAngle(Math.atan2(v - center.v, u - center.u));
      if (!results.some((r) => Math.hypot(r.point.u - u, r.point.v - v) < 0.05)) {
        results.push({ point: { u, v }, t, angle });
      }
    }
  }
  return results;
}

export function intersectCircleCircle(
  c1: Point2D,
  r1: number,
  c2: Point2D,
  r2: number
): Point2D[] {
  const d = dist2D(c1, c2);
  if (d > r1 + r2 + 1e-4 || d < Math.abs(r1 - r2) - 1e-4 || d < 1e-7) return [];
  const a = (r1 * r1 - r2 * r2 + d * d) / (2 * d);
  const h = Math.sqrt(Math.max(0, r1 * r1 - a * a));
  const x2 = c1.u + (a * (c2.u - c1.u)) / d;
  const y2 = c1.v + (a * (c2.v - c1.v)) / d;
  const rx = -(c2.v - c1.v) * (h / d);
  const ry = (c2.u - c1.u) * (h / d);
  const pA = { u: Number((x2 + rx).toFixed(2)), v: Number((y2 + ry).toFixed(2)) };
  const pB = { u: Number((x2 - rx).toFixed(2)), v: Number((y2 - ry).toFixed(2)) };
  if (dist2D(pA, pB) < 0.05) return [pA];
  return [pA, pB];
}

export function computeCircleTangentPoint(
  externalPt: Point2D,
  center: Point2D,
  radius: number,
  hintPt: Point2D
): Point2D {
  const dx = externalPt.u - center.u;
  const dy = externalPt.v - center.v;
  const d = Math.hypot(dx, dy);
  if (d <= radius + 0.001) {
    const ang = Math.atan2(hintPt.v - center.v, hintPt.u - center.u);
    return {
      u: Number((center.u + Math.cos(ang) * radius).toFixed(2)),
      v: Number((center.v + Math.sin(ang) * radius).toFixed(2)),
    };
  }
  const baseAngle = Math.atan2(dy, dx);
  const offsetAngle = Math.acos(Math.min(1, Math.max(-1, radius / d)));
  const a1 = baseAngle + offsetAngle;
  const a2 = baseAngle - offsetAngle;
  const t1 = {
    u: Number((center.u + Math.cos(a1) * radius).toFixed(2)),
    v: Number((center.v + Math.sin(a1) * radius).toFixed(2)),
  };
  const t2 = {
    u: Number((center.u + Math.cos(a2) * radius).toFixed(2)),
    v: Number((center.v + Math.sin(a2) * radius).toFixed(2)),
  };
  return dist2D(t1, hintPt) <= dist2D(t2, hintPt) ? t1 : t2;
}

export function expandEntityToSegments(
  ent: CadEntity,
  circleSegments = 32
): Segment2D[] {
  const res: Segment2D[] = [];
  if (ent.type === 'line') {
    res.push({
      p1: ent.p1,
      p2: ent.p2,
      entityId: ent.id,
      lineType: ent.lineType,
      view: ent.view,
      featureId: ent.featureId,
    });
  } else if (ent.type === 'rect') {
    const pts = [
      { u: ent.x, v: ent.y },
      { u: ent.x + ent.width, v: ent.y },
      { u: ent.x + ent.width, v: ent.y + ent.height },
      { u: ent.x, v: ent.y + ent.height },
    ];
    for (let i = 0; i < 4; i++) {
      res.push({
        p1: pts[i],
        p2: pts[(i + 1) % 4],
        entityId: ent.id,
        lineType: ent.lineType,
        view: ent.view,
        featureId: ent.featureId,
      });
    }
  } else if (ent.type === 'polygon') {
    const n = ent.points.length;
    for (let i = 0; i < (ent.closed ? n : n - 1); i++) {
      res.push({
        p1: ent.points[i],
        p2: ent.points[(i + 1) % n],
        entityId: ent.id,
        lineType: ent.lineType,
        view: ent.view,
        featureId: ent.featureId,
      });
    }
  } else if (ent.type === 'circle') {
    for (let i = 0; i < circleSegments; i++) {
      const a1 = (i / circleSegments) * Math.PI * 2;
      const a2 = ((i + 1) / circleSegments) * Math.PI * 2;
      res.push({
        p1: {
          u: ent.center.u + Math.cos(a1) * ent.radius,
          v: ent.center.v + Math.sin(a1) * ent.radius,
        },
        p2: {
          u: ent.center.u + Math.cos(a2) * ent.radius,
          v: ent.center.v + Math.sin(a2) * ent.radius,
        },
        entityId: ent.id,
        lineType: ent.lineType,
        view: ent.view,
        featureId: ent.featureId,
      });
    }
  } else if (ent.type === 'arc') {
    const span = normalizeAngle(ent.endAngle - ent.startAngle) || Math.PI * 2;
    const steps = Math.max(8, Math.round((span / (Math.PI * 2)) * circleSegments));
    for (let i = 0; i < steps; i++) {
      const a1 = ent.startAngle + (i / steps) * span;
      const a2 = ent.startAngle + ((i + 1) / steps) * span;
      res.push({
        p1: {
          u: ent.center.u + Math.cos(a1) * ent.radius,
          v: ent.center.v + Math.sin(a1) * ent.radius,
        },
        p2: {
          u: ent.center.u + Math.cos(a2) * ent.radius,
          v: ent.center.v + Math.sin(a2) * ent.radius,
        },
        entityId: ent.id,
        lineType: ent.lineType,
        view: ent.view,
        featureId: ent.featureId,
      });
    }
  }
  return res;
}

export function intersectSegments(
  a1: Point2D,
  a2: Point2D,
  b1: Point2D,
  b2: Point2D,
  infinite = false
): Point2D | null {
  const dax = a2.u - a1.u;
  const day = a2.v - a1.v;
  const dbx = b2.u - b1.u;
  const dby = b2.v - b1.v;
  const denom = dax * dby - day * dbx;
  if (Math.abs(denom) < 1e-7) return null;
  const t = ((b1.u - a1.u) * dby - (b1.v - a1.v) * dbx) / denom;
  const u = ((b1.u - a1.u) * day - (b1.v - a1.v) * dax) / denom;
  if (infinite || (t >= -1e-4 && t <= 1.0001 && u >= -1e-4 && u <= 1.0001)) {
    return {
      u: Number((a1.u + t * dax).toFixed(2)),
      v: Number((a1.v + t * day).toFixed(2)),
    };
  }
  return null;
}

export function pointToSegmentDist(p: Point2D, a: Point2D, b: Point2D) {
  const dx = b.u - a.u;
  const dy = b.v - a.v;
  const lenSq = dx * dx + dy * dy;
  if (lenSq < 1e-8) {
    return { dist: dist2D(p, a), proj: a, t: 0 };
  }
  const tRaw = ((p.u - a.u) * dx + (p.v - a.v) * dy) / lenSq;
  const t = Math.max(0, Math.min(1, tRaw));
  const proj = { u: a.u + t * dx, v: a.v + t * dy };
  return { dist: dist2D(p, proj), proj, t };
}

export function findIntersectionsWithEntity(
  targetEnt: CadEntity,
  otherEntities: CadEntity[],
  allowLineExtensionOnCurve = false
): Point2D[] {
  const pts: Point2D[] = [];
  const pushUnique = (pt: Point2D) => {
    if (!pts.some((p) => dist2D(p, pt) < 0.08)) pts.push(pt);
  };

  if (targetEnt.type === 'circle' || targetEnt.type === 'arc') {
    for (const other of otherEntities) {
      if (other.id === targetEnt.id || other.view !== targetEnt.view) continue;
      if (other.type === 'circle' || other.type === 'arc') {
        const cPts = intersectCircleCircle(
          targetEnt.center,
          targetEnt.radius,
          other.center,
          other.radius
        );
        for (const cp of cPts) {
          const ang1 = normalizeAngle(
            Math.atan2(cp.v - targetEnt.center.v, cp.u - targetEnt.center.u)
          );
          const ang2 = normalizeAngle(
            Math.atan2(cp.v - other.center.v, cp.u - other.center.u)
          );
          const ok1 =
            targetEnt.type === 'circle' ||
            isAngleOnArc(ang1, targetEnt.startAngle, targetEnt.endAngle, 0.01);
          const ok2 =
            other.type === 'circle' ||
            isAngleOnArc(ang2, other.startAngle, other.endAngle, 0.01);
          if (ok1 && ok2) pushUnique(cp);
        }
      } else {
        const segs = expandEntityToSegments(other);
        const mode =
          allowLineExtensionOnCurve && other.type === 'line' ? 'infinite' : 'segment';
        for (const s of segs) {
          const hits = intersectLineCircle(
            s.p1,
            s.p2,
            targetEnt.center,
            targetEnt.radius,
            mode
          );
          for (const h of hits) {
            if (
              targetEnt.type === 'circle' ||
              isAngleOnArc(h.angle, targetEnt.startAngle, targetEnt.endAngle, 0.01)
            ) {
              pushUnique(h.point);
            }
          }
        }
      }
    }
  } else {
    const targetSegs = expandEntityToSegments(targetEnt);
    const mode =
      allowLineExtensionOnCurve && targetEnt.type === 'line' ? 'infinite' : 'segment';
    for (const ts of targetSegs) {
      for (const other of otherEntities) {
        if (other.id === targetEnt.id || other.view !== targetEnt.view) continue;
        if (other.type === 'circle' || other.type === 'arc') {
          const hits = intersectLineCircle(
            ts.p1,
            ts.p2,
            other.center,
            other.radius,
            mode
          );
          for (const h of hits) {
            if (
              other.type === 'circle' ||
              isAngleOnArc(h.angle, other.startAngle, other.endAngle, 0.01)
            ) {
              pushUnique(h.point);
            }
          }
        } else {
          const otherSegs = expandEntityToSegments(other);
          for (const os of otherSegs) {
            const pt = intersectSegments(ts.p1, ts.p2, os.p1, os.p2, false);
            if (pt) pushUnique(pt);
          }
        }
      }
    }
  }
  return pts;
}

export function computeOSnap(
  rawPt: Point2D,
  view: ViewType,
  entities: CadEntity[],
  enabledSnaps: Record<SnapType, boolean>,
  gridStep = 4,
  snapRadius = 3.6,
  excludeEntityIds?: Set<string>,
  activeAnchorPt?: Point2D | null
): SnapResult {
  const viewEntities = entities.filter(
    (e) => e.view === view && (!excludeEntityIds || !excludeEntityIds.has(e.id))
  );
  const candidates: {
    point: Point2D;
    type: SnapType;
    label: string;
    dist: number;
    priority: number;
  }[] = [];

  const crossAlignTol = Math.min(snapRadius * 0.85, 2.8);
  const extractFeatureValues = (targetView: ViewType) => {
    const uVals: number[] = [];
    const vVals: number[] = [];
    for (const ent of entities) {
      if (
        ent.view !== targetView ||
        (excludeEntityIds && excludeEntityIds.has(ent.id))
      ) {
        continue;
      }
      if (ent.type === 'circle' || ent.type === 'arc') {
        uVals.push(ent.center.u, ent.center.u - ent.radius, ent.center.u + ent.radius);
        vVals.push(ent.center.v, ent.center.v - ent.radius, ent.center.v + ent.radius);
      } else {
        const segs = expandEntityToSegments(ent, 8);
        for (const s of segs) {
          uVals.push(s.p1.u, s.p2.u);
          vVals.push(s.p1.v, s.p2.v);
        }
      }
    }
    return { uVals, vVals };
  };

  let alignedU: number | null = null;
  let alignedV: number | null = null;
  let alignLabel = '';

  if (view === 'front') {
    const { uVals: topX } = extractFeatureValues('top');
    const { vVals: leftZ } = extractFeatureValues('left');
    for (const x of topX) {
      if (Math.abs(rawPt.u - x) <= crossAlignTol) {
        alignedU = x;
        alignLabel = 'X-ALIGN';
        break;
      }
    }
    for (const z of leftZ) {
      if (Math.abs(rawPt.v - z) <= crossAlignTol) {
        alignedV = z;
        alignLabel = alignLabel ? 'XZ-ALIGN' : 'Z-ALIGN';
        break;
      }
    }
  } else if (view === 'top') {
    const { uVals: frontX } = extractFeatureValues('front');
    const { uVals: leftY } = extractFeatureValues('left');
    for (const x of frontX) {
      if (Math.abs(rawPt.u - x) <= crossAlignTol) {
        alignedU = x;
        alignLabel = 'X-ALIGN';
        break;
      }
    }
    for (const y of leftY) {
      if (Math.abs(rawPt.v - y) <= crossAlignTol) {
        alignedV = y;
        alignLabel = alignLabel ? 'XY-ALIGN' : 'Y-ALIGN';
        break;
      }
    }
  } else if (view === 'left') {
    const { vVals: topY } = extractFeatureValues('top');
    const { vVals: frontZ } = extractFeatureValues('front');
    for (const y of topY) {
      if (Math.abs(rawPt.u - y) <= crossAlignTol) {
        alignedU = y;
        alignLabel = 'Y-ALIGN';
        break;
      }
    }
    for (const z of frontZ) {
      if (Math.abs(rawPt.v - z) <= crossAlignTol) {
        alignedV = z;
        alignLabel = alignLabel ? 'YZ-ALIGN' : 'Z-ALIGN';
        break;
      }
    }
  }

  const baseU = enabledSnaps.grid
    ? Math.round(rawPt.u / gridStep) * gridStep
    : Math.round(rawPt.u * 10) / 10;
  const baseV = enabledSnaps.grid
    ? Math.round(rawPt.v / gridStep) * gridStep
    : Math.round(rawPt.v * 10) / 10;

  for (const ent of viewEntities) {
    if (ent.type === 'circle' || ent.type === 'arc') {
      if (enabledSnaps.center) {
        const d = dist2D(rawPt, ent.center);
        if (d <= snapRadius) {
          candidates.push({
            point: ent.center,
            type: 'center',
            label: 'CEN',
            dist: d,
            priority: 1,
          });
        }
      }
      if (ent.type === 'arc' && enabledSnaps.endpoint) {
        const ep1 = {
          u: Number((ent.center.u + Math.cos(ent.startAngle) * ent.radius).toFixed(2)),
          v: Number((ent.center.v + Math.sin(ent.startAngle) * ent.radius).toFixed(2)),
        };
        const ep2 = {
          u: Number((ent.center.u + Math.cos(ent.endAngle) * ent.radius).toFixed(2)),
          v: Number((ent.center.v + Math.sin(ent.endAngle) * ent.radius).toFixed(2)),
        };
        for (const ep of [ep1, ep2]) {
          const d = dist2D(rawPt, ep);
          if (d <= snapRadius) {
            candidates.push({
              point: ep,
              type: 'endpoint',
              label: 'END',
              dist: d,
              priority: 1,
            });
          }
        }
      }
      if (enabledSnaps.quadrant) {
        const quadAngles = [0, Math.PI / 2, Math.PI, (Math.PI * 3) / 2];
        for (const qa of quadAngles) {
          if (ent.type === 'arc' && !isAngleOnArc(qa, ent.startAngle, ent.endAngle, 0.01)) {
            continue;
          }
          const q = {
            u: Number((ent.center.u + Math.cos(qa) * ent.radius).toFixed(2)),
            v: Number((ent.center.v + Math.sin(qa) * ent.radius).toFixed(2)),
          };
          const d = dist2D(rawPt, q);
          if (d <= snapRadius) {
            candidates.push({
              point: q,
              type: 'quadrant',
              label: 'QUA',
              dist: d,
              priority: 2,
            });
          }
        }
      }
    } else {
      const entSegs = expandEntityToSegments(ent, 16);
      for (const s of entSegs) {
        if (enabledSnaps.endpoint) {
          for (const ep of [s.p1, s.p2]) {
            const d = dist2D(rawPt, ep);
            if (d <= snapRadius) {
              candidates.push({
                point: ep,
                type: 'endpoint',
                label: 'END',
                dist: d,
                priority: 1,
              });
            }
          }
        }
        if (enabledSnaps.midpoint) {
          const mid = { u: (s.p1.u + s.p2.u) / 2, v: (s.p1.v + s.p2.v) / 2 };
          const d = dist2D(rawPt, mid);
          if (d <= snapRadius) {
            candidates.push({
              point: mid,
              type: 'midpoint',
              label: 'MID',
              dist: d,
              priority: 2,
            });
          }
        }
      }
    }
  }

  if (enabledSnaps.intersection) {
    if (viewEntities.length > 1) {
      for (let i = 0; i < viewEntities.length; i++) {
        const hits = findIntersectionsWithEntity(
          viewEntities[i],
          viewEntities.slice(i + 1),
          true
        );
        for (const pt of hits) {
          const d = dist2D(rawPt, pt);
          if (d <= snapRadius) {
            candidates.push({
              point: pt,
              type: 'intersection',
              label: 'INT',
              dist: d,
              priority: 1,
            });
          }
        }
      }
    }

    const testLines: {
      p1: Point2D;
      p2: Point2D;
      mode: 'ray' | 'infinite';
      priority: number;
    }[] = [];

    if (activeAnchorPt && dist2D(activeAnchorPt, rawPt) > 0.25) {
      testLines.push(
        { p1: activeAnchorPt, p2: rawPt, mode: 'ray', priority: 1 },
        {
          p1: activeAnchorPt,
          p2: { u: activeAnchorPt.u + 10, v: activeAnchorPt.v },
          mode: 'infinite',
          priority: 1,
        },
        {
          p1: activeAnchorPt,
          p2: { u: activeAnchorPt.u, v: activeAnchorPt.v + 10 },
          mode: 'infinite',
          priority: 1,
        },
        {
          p1: activeAnchorPt,
          p2: { u: activeAnchorPt.u + 10, v: activeAnchorPt.v + 10 },
          mode: 'infinite',
          priority: 1,
        },
        {
          p1: activeAnchorPt,
          p2: { u: activeAnchorPt.u + 10, v: activeAnchorPt.v - 10 },
          mode: 'infinite',
          priority: 1,
        }
      );
    }
    if (alignedU !== null) {
      testLines.push({
        p1: { u: alignedU, v: 0 },
        p2: { u: alignedU, v: 100 },
        mode: 'infinite',
        priority: 1,
      });
    }
    if (alignedV !== null) {
      testLines.push({
        p1: { u: 0, v: alignedV },
        p2: { u: 100, v: alignedV },
        mode: 'infinite',
        priority: 1,
      });
    }
    if (enabledSnaps.grid) {
      testLines.push(
        { p1: { u: baseU, v: 0 }, p2: { u: baseU, v: 100 }, mode: 'infinite', priority: 2 },
        { p1: { u: 0, v: baseV }, p2: { u: 100, v: baseV }, mode: 'infinite', priority: 2 }
      );
    }

    for (const ent of viewEntities) {
      if (ent.type === 'circle' || ent.type === 'arc') {
        for (const tl of testLines) {
          const hits = intersectLineCircle(tl.p1, tl.p2, ent.center, ent.radius, tl.mode);
          for (const h of hits) {
            if (
              !(
                ent.type === 'circle' ||
                isAngleOnArc(h.angle, ent.startAngle, ent.endAngle, 0.01)
              )
            ) {
              continue;
            }
            const d = dist2D(rawPt, h.point);
            if (d <= snapRadius) {
              candidates.push({
                point: h.point,
                type: 'intersection',
                label: 'INT',
                dist: d,
                priority: tl.priority,
              });
            }
          }
        }
        const dToRing = Math.abs(dist2D(rawPt, ent.center) - ent.radius);
        if (dToRing <= snapRadius * 0.85) {
          const ang = normalizeAngle(
            Math.atan2(rawPt.v - ent.center.v, rawPt.u - ent.center.u)
          );
          if (
            ent.type === 'circle' ||
            isAngleOnArc(ang, ent.startAngle, ent.endAngle, 0.01)
          ) {
            candidates.push({
              point: {
                u: Number((ent.center.u + Math.cos(ang) * ent.radius).toFixed(2)),
                v: Number((ent.center.v + Math.sin(ang) * ent.radius).toFixed(2)),
              },
              type: 'intersection',
              label: 'INT',
              dist: dToRing,
              priority: 3,
            });
          }
        }
      } else if (activeAnchorPt && dist2D(activeAnchorPt, rawPt) > 0.25) {
        const entSegs = expandEntityToSegments(ent, 16);
        for (const s of entSegs) {
          for (const orthoTarget of [
            { u: activeAnchorPt.u, v: rawPt.v },
            { u: rawPt.u, v: activeAnchorPt.v },
          ]) {
            if (dist2D(activeAnchorPt, orthoTarget) < 0.25) continue;
            const hit = intersectSegments(activeAnchorPt, orthoTarget, s.p1, s.p2, false);
            if (hit) {
              const d = dist2D(rawPt, hit);
              if (d <= snapRadius) {
                candidates.push({
                  point: hit,
                  type: 'intersection',
                  label: 'INT',
                  dist: d,
                  priority: 1,
                });
              }
            }
          }
        }
      }
    }
  }

  if (candidates.length > 0) {
    candidates.sort((a, b) => a.priority - b.priority || a.dist - b.dist);
    return {
      point: {
        u: Number(candidates[0].point.u.toFixed(2)),
        v: Number(candidates[0].point.v.toFixed(2)),
      },
      type: candidates[0].type,
      label: candidates[0].label,
    };
  }

  if (alignedU !== null || alignedV !== null) {
    return {
      point: {
        u: Number((alignedU !== null ? alignedU : baseU).toFixed(2)),
        v: Number((alignedV !== null ? alignedV : baseV).toFixed(2)),
      },
      type: 'grid',
      label: alignLabel,
    };
  }

  return {
    point: { u: baseU, v: baseV },
    type: 'grid',
    label: enabledSnaps.grid ? 'GRID' : '',
  };
}

export function findHoveredEntity(
  pt: Point2D,
  view: ViewType,
  entities: CadEntity[],
  tolerance = 3.5
): CadEntity | null {
  let best: { ent: CadEntity; d: number } | null = null;
  for (const ent of entities) {
    if (ent.view !== view) continue;
    if (ent.type === 'circle') {
      const dRing = Math.abs(dist2D(pt, ent.center) - ent.radius);
      const dCenter = dist2D(pt, ent.center);
      const d = Math.min(dRing, dCenter <= tolerance * 0.8 ? dCenter : dRing);
      if (d <= tolerance && (!best || d < best.d)) best = { ent, d };
    } else if (ent.type === 'arc') {
      const ang = normalizeAngle(
        Math.atan2(pt.v - ent.center.v, pt.u - ent.center.u)
      );
      if (isAngleOnArc(ang, ent.startAngle, ent.endAngle, 0.08)) {
        const d = Math.abs(dist2D(pt, ent.center) - ent.radius);
        if (d <= tolerance && (!best || d < best.d)) best = { ent, d };
      }
    } else {
      const segs = expandEntityToSegments(ent);
      for (const s of segs) {
        const { dist } = pointToSegmentDist(pt, s.p1, s.p2);
        if (dist <= tolerance && (!best || dist < best.d)) best = { ent, d: dist };
      }
    }
  }
  return best ? best.ent : null;
}

export function getEntityGrips(ent: CadEntity): GripHandle[] {
  if (ent.type === 'line') {
    return [
      { id: 'p1', entityId: ent.id, point: ent.p1, kind: 'endpoint' },
      { id: 'p2', entityId: ent.id, point: ent.p2, kind: 'endpoint' },
      {
        id: 'mid',
        entityId: ent.id,
        point: { u: (ent.p1.u + ent.p2.u) / 2, v: (ent.p1.v + ent.p2.v) / 2 },
        kind: 'center',
      },
    ];
  }
  if (ent.type === 'rect') {
    const x1 = ent.x;
    const y1 = ent.y;
    const x2 = ent.x + ent.width;
    const y2 = ent.y + ent.height;
    return [
      { id: 'sw', entityId: ent.id, point: { u: x1, v: y1 }, kind: 'corner' },
      { id: 'se', entityId: ent.id, point: { u: x2, v: y1 }, kind: 'corner' },
      { id: 'ne', entityId: ent.id, point: { u: x2, v: y2 }, kind: 'corner' },
      { id: 'nw', entityId: ent.id, point: { u: x1, v: y2 }, kind: 'corner' },
      {
        id: 'center',
        entityId: ent.id,
        point: { u: (x1 + x2) / 2, v: (y1 + y2) / 2 },
        kind: 'center',
      },
    ];
  }
  if (ent.type === 'circle') {
    return [
      { id: 'center', entityId: ent.id, point: ent.center, kind: 'center' },
      {
        id: 'q0',
        entityId: ent.id,
        point: { u: ent.center.u + ent.radius, v: ent.center.v },
        kind: 'radius',
      },
      {
        id: 'q90',
        entityId: ent.id,
        point: { u: ent.center.u, v: ent.center.v + ent.radius },
        kind: 'radius',
      },
      {
        id: 'q180',
        entityId: ent.id,
        point: { u: ent.center.u - ent.radius, v: ent.center.v },
        kind: 'radius',
      },
      {
        id: 'q270',
        entityId: ent.id,
        point: { u: ent.center.u, v: ent.center.v - ent.radius },
        kind: 'radius',
      },
    ];
  }
  if (ent.type === 'arc') {
    const span = normalizeAngle(ent.endAngle - ent.startAngle) || Math.PI;
    const midAng = ent.startAngle + span / 2;
    return [
      { id: 'center', entityId: ent.id, point: ent.center, kind: 'center' },
      {
        id: 'start',
        entityId: ent.id,
        point: {
          u: Number((ent.center.u + Math.cos(ent.startAngle) * ent.radius).toFixed(2)),
          v: Number((ent.center.v + Math.sin(ent.startAngle) * ent.radius).toFixed(2)),
        },
        kind: 'endpoint',
      },
      {
        id: 'end',
        entityId: ent.id,
        point: {
          u: Number((ent.center.u + Math.cos(ent.endAngle) * ent.radius).toFixed(2)),
          v: Number((ent.center.v + Math.sin(ent.endAngle) * ent.radius).toFixed(2)),
        },
        kind: 'endpoint',
      },
      {
        id: 'midRadius',
        entityId: ent.id,
        point: {
          u: Number((ent.center.u + Math.cos(midAng) * ent.radius).toFixed(2)),
          v: Number((ent.center.v + Math.sin(midAng) * ent.radius).toFixed(2)),
        },
        kind: 'radius',
      },
    ];
  }
  if (ent.type === 'polygon') {
    const n = ent.points.length || 1;
    const cu = ent.points.reduce((acc, p) => acc + p.u, 0) / n;
    const cv = ent.points.reduce((acc, p) => acc + p.v, 0) / n;
    return [
      { id: 'center', entityId: ent.id, point: { u: cu, v: cv }, kind: 'center' },
      ...ent.points.map((pt, idx) => ({
        id: `v_${idx}`,
        entityId: ent.id,
        point: pt,
        kind: 'vertex' as const,
      })),
    ];
  }
  return [];
}

export function translateEntity(ent: CadEntity, du: number, dv: number): CadEntity {
  const r = (n: number) => Number(n.toFixed(1));
  if (ent.type === 'line') {
    return {
      ...ent,
      p1: { u: r(ent.p1.u + du), v: r(ent.p1.v + dv) },
      p2: { u: r(ent.p2.u + du), v: r(ent.p2.v + dv) },
    };
  }
  if (ent.type === 'rect') {
    return { ...ent, x: r(ent.x + du), y: r(ent.y + dv) };
  }
  if (ent.type === 'circle' || ent.type === 'arc') {
    return {
      ...ent,
      center: { u: r(ent.center.u + du), v: r(ent.center.v + dv) },
    };
  }
  if (ent.type === 'polygon') {
    return {
      ...ent,
      points: ent.points.map((pt) => ({ u: r(pt.u + du), v: r(pt.v + dv) })),
    };
  }
  return ent;
}

export function applyGripDrag(
  ent: CadEntity,
  gripId: string,
  newPt: Point2D
): CadEntity {
  const r = (n: number) => Number(n.toFixed(2));
  if (ent.type === 'line') {
    if (gripId === 'p1') return { ...ent, p1: { u: r(newPt.u), v: r(newPt.v) } };
    if (gripId === 'p2') return { ...ent, p2: { u: r(newPt.u), v: r(newPt.v) } };
    if (gripId === 'mid') {
      const midU = (ent.p1.u + ent.p2.u) / 2;
      const midV = (ent.p1.v + ent.p2.v) / 2;
      return translateEntity(ent, newPt.u - midU, newPt.v - midV);
    }
  }
  if (ent.type === 'rect') {
    const x1 = ent.x;
    const y1 = ent.y;
    const x2 = ent.x + ent.width;
    const y2 = ent.y + ent.height;
    if (gripId === 'center') {
      return translateEntity(ent, newPt.u - (x1 + x2) / 2, newPt.v - (y1 + y2) / 2);
    }
    let nx1 = x1;
    let ny1 = y1;
    let nx2 = x2;
    let ny2 = y2;
    if (gripId === 'sw') {
      nx1 = newPt.u;
      ny1 = newPt.v;
    } else if (gripId === 'se') {
      nx2 = newPt.u;
      ny1 = newPt.v;
    } else if (gripId === 'ne') {
      nx2 = newPt.u;
      ny2 = newPt.v;
    } else if (gripId === 'nw') {
      nx1 = newPt.u;
      ny2 = newPt.v;
    }
    return {
      ...ent,
      x: r(Math.min(nx1, nx2)),
      y: r(Math.min(ny1, ny2)),
      width: r(Math.max(2, Math.abs(nx2 - nx1))),
      height: r(Math.max(2, Math.abs(ny2 - ny1))),
    };
  }
  if (ent.type === 'circle') {
    if (gripId === 'center') {
      return { ...ent, center: { u: r(newPt.u), v: r(newPt.v) } };
    }
    return { ...ent, radius: Math.max(1.5, r(dist2D(ent.center, newPt))) };
  }
  if (ent.type === 'arc') {
    if (gripId === 'center') {
      return { ...ent, center: { u: r(newPt.u), v: r(newPt.v) } };
    }
    if (gripId === 'start') {
      return {
        ...ent,
        startAngle: normalizeAngle(
          Math.atan2(newPt.v - ent.center.v, newPt.u - ent.center.u)
        ),
      };
    }
    if (gripId === 'end') {
      return {
        ...ent,
        endAngle: normalizeAngle(
          Math.atan2(newPt.v - ent.center.v, newPt.u - ent.center.u)
        ),
      };
    }
    if (gripId === 'midRadius') {
      return { ...ent, radius: Math.max(1.5, r(dist2D(ent.center, newPt))) };
    }
  }
  if (ent.type === 'polygon') {
    const n = ent.points.length || 1;
    const cu = ent.points.reduce((acc, p) => acc + p.u, 0) / n;
    const cv = ent.points.reduce((acc, p) => acc + p.v, 0) / n;
    if (gripId === 'center') return translateEntity(ent, newPt.u - cu, newPt.v - cv);
    if (gripId.startsWith('v_')) {
      const idx = Number(gripId.slice(2));
      const oldPt = ent.points[idx];
      if (!oldPt) return ent;
      const oldR = Math.hypot(oldPt.u - cu, oldPt.v - cv) || 1;
      const newR = Math.max(2, Math.hypot(newPt.u - cu, newPt.v - cv));
      const dAng =
        Math.atan2(newPt.v - cv, newPt.u - cu) -
        Math.atan2(oldPt.v - cv, oldPt.u - cu);
      const scale = newR / oldR;
      return {
        ...ent,
        points: ent.points.map((pt) => {
          const pr = Math.hypot(pt.u - cu, pt.v - cv) * scale;
          const pang = Math.atan2(pt.v - cv, pt.u - cu) + dAng;
          return {
            u: r(cu + Math.cos(pang) * pr),
            v: r(cv + Math.sin(pang) * pr),
          };
        }),
      };
    }
  }
  return ent;
}

export function getEntitiesInSelectionBox(
  pStart: Point2D,
  pEnd: Point2D,
  view: ViewType,
  entities: CadEntity[],
  isCrossing: boolean
): string[] {
  const uMin = Math.min(pStart.u, pEnd.u);
  const uMax = Math.max(pStart.u, pEnd.u);
  const vMin = Math.min(pStart.v, pEnd.v);
  const vMax = Math.max(pStart.v, pEnd.v);
  const inBox = (pt: Point2D) =>
    pt.u >= uMin - 0.001 &&
    pt.u <= uMax + 0.001 &&
    pt.v >= vMin - 0.001 &&
    pt.v <= vMax + 0.001;
  const boxEdges: [Point2D, Point2D][] = [
    [
      { u: uMin, v: vMin },
      { u: uMax, v: vMin },
    ],
    [
      { u: uMax, v: vMin },
      { u: uMax, v: vMax },
    ],
    [
      { u: uMax, v: vMax },
      { u: uMin, v: vMax },
    ],
    [
      { u: uMin, v: vMax },
      { u: uMin, v: vMin },
    ],
  ];

  const selectedIds: string[] = [];
  for (const ent of entities) {
    if (ent.view !== view) continue;
    const segs = expandEntityToSegments(ent, 32);
    if (segs.length === 0) continue;
    const allPointsInside = segs.every((s) => inBox(s.p1) && inBox(s.p2));
    if (!isCrossing) {
      if (allPointsInside) selectedIds.push(ent.id);
    } else {
      if (allPointsInside || segs.some((s) => inBox(s.p1) || inBox(s.p2))) {
        selectedIds.push(ent.id);
        continue;
      }
      let hitsEdge = false;
      for (const s of segs) {
        for (const [b1, b2] of boxEdges) {
          if (intersectSegments(s.p1, s.p2, b1, b2, false)) {
            hitsEdge = true;
            break;
          }
        }
        if (hitsEdge) break;
      }
      if (hitsEdge) selectedIds.push(ent.id);
    }
  }
  return selectedIds;
}

export function trimEntityAtPoint(
  clickPt: Point2D,
  view: ViewType,
  entities: CadEntity[]
): CadEntity[] {
  const target = findHoveredEntity(clickPt, view, entities, 4.2);
  if (!target) return entities;
  const otherEntities = entities.filter(
    (e) => e.id !== target.id && e.view === view
  );

  if (target.type === 'circle') {
    const hitPts = findIntersectionsWithEntity(target, otherEntities);
    if (hitPts.length < 2) return entities.filter((e) => e.id !== target.id);
    const angles = hitPts
      .map((p) =>
        normalizeAngle(Math.atan2(p.v - target.center.v, p.u - target.center.u))
      )
      .sort((a, b) => a - b);
    const clickAngle = normalizeAngle(
      Math.atan2(clickPt.v - target.center.v, clickPt.u - target.center.u)
    );
    const n = angles.length;
    let trimIdx = 0;
    for (let i = 0; i < n; i++) {
      if (isAngleOnArc(clickAngle, angles[i], angles[(i + 1) % n], 1e-4)) {
        trimIdx = i;
        break;
      }
    }
    const newArc: CadArcEntity = {
      id: `${target.id}-arc-${Date.now()}`,
      view: target.view,
      type: 'arc',
      lineType: target.lineType,
      center: target.center,
      radius: target.radius,
      startAngle: angles[(trimIdx + 1) % n],
      endAngle: angles[trimIdx],
      source: 'user',
      featureId: target.featureId,
      featureLabel: target.featureLabel,
    };
    return entities.map((e) => (e.id === target.id ? newArc : e));
  }

  if (target.type === 'arc') {
    const hitPts = findIntersectionsWithEntity(target, otherEntities);
    if (hitPts.length === 0) return entities.filter((e) => e.id !== target.id);
    const span = normalizeAngle(target.endAngle - target.startAngle);
    const relAngles = [0, span];
    for (const p of hitPts) {
      const ang = normalizeAngle(
        Math.atan2(p.v - target.center.v, p.u - target.center.u)
      );
      const rel = normalizeAngle(ang - target.startAngle);
      if (rel > 0.02 && rel < span - 0.02) relAngles.push(rel);
    }
    relAngles.sort((a, b) => a - b);
    const clickRel = normalizeAngle(
      normalizeAngle(
        Math.atan2(clickPt.v - target.center.v, clickPt.u - target.center.u)
      ) - target.startAngle
    );
    const keptArcs: CadArcEntity[] = [];
    for (let i = 0; i < relAngles.length - 1; i++) {
      const r0 = relAngles[i];
      const r1 = relAngles[i + 1];
      if (clickRel >= r0 - 0.001 && clickRel <= r1 + 0.001) continue;
      keptArcs.push({
        ...target,
        id: `${target.id}-sub-${i}-${Date.now()}`,
        startAngle: normalizeAngle(target.startAngle + r0),
        endAngle: normalizeAngle(target.startAngle + r1),
      });
    }
    return [...entities.filter((e) => e.id !== target.id), ...keptArcs];
  }

  const workingList: CadEntity[] = [];
  let targetLines: CadLineEntity[] = [];
  for (const e of entities) {
    if (
      e.id === target.id &&
      (e.type === 'line' || e.type === 'rect' || e.type === 'polygon')
    ) {
      targetLines = expandEntityToSegments(e).map((s, idx) => ({
        id: `${e.id}-seg-${idx}-${Date.now()}`,
        view: e.view,
        type: 'line',
        lineType: e.lineType,
        p1: s.p1,
        p2: s.p2,
        source: 'user',
        featureId: e.featureId,
        featureLabel: e.featureLabel,
      }));
    } else {
      workingList.push(e);
    }
  }
  if (targetLines.length === 0) return entities;

  let clickedSegIdx = 0;
  let minD = Infinity;
  let clickT = 0.5;
  targetLines.forEach((ln, idx) => {
    const { dist, t } = pointToSegmentDist(clickPt, ln.p1, ln.p2);
    if (dist < minD) {
      minD = dist;
      clickedSegIdx = idx;
      clickT = t;
    }
  });

  const segToTrim = targetLines[clickedSegIdx];
  const dx = segToTrim.p2.u - segToTrim.p1.u;
  const dy = segToTrim.p2.v - segToTrim.p1.v;
  const lenSq = dx * dx + dy * dy;
  const hitPts = findIntersectionsWithEntity(segToTrim, [
    ...workingList.filter((e) => e.view === view),
    ...targetLines.filter((_, idx) => idx !== clickedSegIdx),
  ]);
  const ts = [0, 1];
  for (const pt of hitPts) {
    if (lenSq > 1e-6) {
      const t =
        ((pt.u - segToTrim.p1.u) * dx + (pt.v - segToTrim.p1.v) * dy) / lenSq;
      if (t > 0.02 && t < 0.98) ts.push(t);
    }
  }
  ts.sort((a, b) => a - b);

  const keptLines: CadLineEntity[] = [];
  for (let i = 0; i < ts.length - 1; i++) {
    const t0 = ts[i];
    const t1 = ts[i + 1];
    if (clickT >= t0 - 1e-4 && clickT <= t1 + 1e-4 && ts.length > 2) continue;
    if (ts.length === 2) continue;
    keptLines.push({
      ...segToTrim,
      id: `${segToTrim.id}-p${i}`,
      p1: {
        u: Number((segToTrim.p1.u + t0 * dx).toFixed(2)),
        v: Number((segToTrim.p1.v + t0 * dy).toFixed(2)),
      },
      p2: {
        u: Number((segToTrim.p1.u + t1 * dx).toFixed(2)),
        v: Number((segToTrim.p1.v + t1 * dy).toFixed(2)),
      },
    });
  }

  return [
    ...workingList,
    ...targetLines.filter((_, idx) => idx !== clickedSegIdx),
    ...keptLines,
  ];
}

export function extendEntityAtPoint(
  clickPt: Point2D,
  view: ViewType,
  entities: CadEntity[]
): CadEntity[] {
  const target = findHoveredEntity(clickPt, view, entities, 4.5);
  if (!target) return entities;
  if (target.type === 'arc') {
    const closedCircle: CadCircleEntity = {
      id: `${target.id}-circle-${Date.now()}`,
      view: target.view,
      type: 'circle',
      lineType: target.lineType,
      center: target.center,
      radius: target.radius,
      source: 'user',
      featureId: target.featureId,
      featureLabel: target.featureLabel,
    };
    return entities.map((e) => (e.id === target.id ? closedCircle : e));
  }
  if (target.type !== 'line') return entities;

  const { t } = pointToSegmentDist(clickPt, target.p1, target.p2);
  const extendEnd2 = t >= 0.5;
  const startPt = extendEnd2 ? target.p1 : target.p2;
  const movingPt = extendEnd2 ? target.p2 : target.p1;
  const dirU = movingPt.u - startPt.u;
  const dirV = movingPt.v - startPt.v;
  const len = Math.hypot(dirU, dirV);
  if (len < 1e-5) return entities;
  const farPt = {
    u: movingPt.u + (dirU / len) * 240,
    v: movingPt.v + (dirV / len) * 240,
  };

  let bestNewPt: Point2D | null = null;
  let bestDist = Infinity;
  for (const e of entities) {
    if (e.view !== view || e.id === target.id) continue;
    if (e.type === 'circle' || e.type === 'arc') {
      const hits = intersectLineCircle(
        movingPt,
        farPt,
        e.center,
        e.radius,
        'segment'
      );
      for (const h of hits) {
        if (e.type === 'arc' && !isAngleOnArc(h.angle, e.startAngle, e.endAngle)) {
          continue;
        }
        const d = dist2D(movingPt, h.point);
        if (d > 0.5 && d < bestDist) {
          bestDist = d;
          bestNewPt = h.point;
        }
      }
    } else {
      const segs = expandEntityToSegments(e);
      for (const s of segs) {
        const hit = intersectSegments(movingPt, farPt, s.p1, s.p2, false);
        if (hit) {
          const d = dist2D(movingPt, hit);
          if (d > 0.5 && d < bestDist) {
            bestDist = d;
            bestNewPt = hit;
          }
        }
      }
    }
  }
  if (!bestNewPt) {
    bestNewPt = {
      u: Number((movingPt.u + (dirU / len) * 16).toFixed(1)),
      v: Number((movingPt.v + (dirV / len) * 16).toFixed(1)),
    };
  }
  return entities.map((e) => {
    if (e.id !== target.id || e.type !== 'line') return e;
    return extendEnd2 ? { ...e, p2: bestNewPt! } : { ...e, p1: bestNewPt! };
  });
}

export function offsetEntityAtPoint(
  clickPt: Point2D,
  view: ViewType,
  entities: CadEntity[],
  offsetDist = 8
): CadEntity[] {
  const target = findHoveredEntity(clickPt, view, entities, 5);
  if (!target) return entities;
  const newId = `offset-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  if (target.type === 'circle' || target.type === 'arc') {
    const sign = dist2D(clickPt, target.center) >= target.radius ? 1 : -1;
    const newR = Number(Math.max(2, target.radius + sign * offsetDist).toFixed(1));
    return [...entities, { ...target, id: newId, radius: newR, source: 'user' }];
  }
  if (target.type === 'rect') {
    const cx = target.x + target.width / 2;
    const cy = target.y + target.height / 2;
    const inside =
      clickPt.u > target.x &&
      clickPt.u < target.x + target.width &&
      clickPt.v > target.y &&
      clickPt.v < target.y + target.height;
    const delta = inside ? -offsetDist : offsetDist;
    const nw = Math.max(4, target.width + delta * 2);
    const nh = Math.max(4, target.height + delta * 2);
    return [
      ...entities,
      {
        ...target,
        id: newId,
        x: Number((cx - nw / 2).toFixed(1)),
        y: Number((cy - nh / 2).toFixed(1)),
        width: Number(nw.toFixed(1)),
        height: Number(nh.toFixed(1)),
        source: 'user',
      },
    ];
  }
  if (target.type === 'line') {
    const dx = target.p2.u - target.p1.u;
    const dy = target.p2.v - target.p1.v;
    const len = Math.hypot(dx, dy) || 1;
    const nx = -dy / len;
    const ny = dx / len;
    const side =
      (clickPt.u - target.p1.u) * nx + (clickPt.v - target.p1.v) * ny >= 0
        ? 1
        : -1;
    const ou = nx * offsetDist * side;
    const ov = ny * offsetDist * side;
    return [
      ...entities,
      {
        ...target,
        id: newId,
        p1: {
          u: Number((target.p1.u + ou).toFixed(1)),
          v: Number((target.p1.v + ov).toFixed(1)),
        },
        p2: {
          u: Number((target.p2.u + ou).toFixed(1)),
          v: Number((target.p2.v + ov).toFixed(1)),
        },
        source: 'user',
      },
    ];
  }
  if (target.type === 'polygon') {
    const n = target.points.length;
    if (n < 3) return entities;
    const cx = target.points.reduce((acc, p) => acc + p.u, 0) / n;
    const cy = target.points.reduce((acc, p) => acc + p.v, 0) / n;
    const avgR =
      target.points.reduce((acc, p) => acc + Math.hypot(p.u - cx, p.v - cy), 0) /
      n;
    const clickR = Math.hypot(clickPt.u - cx, clickPt.v - cy);
    const scale = Math.max(
      0.2,
      (avgR + (clickR >= avgR ? offsetDist : -offsetDist)) / (avgR || 1)
    );
    return [
      ...entities,
      {
        ...target,
        id: newId,
        points: target.points.map((p) => ({
          u: Number((cx + (p.u - cx) * scale).toFixed(1)),
          v: Number((cy + (p.v - cy) * scale).toFixed(1)),
        })),
        source: 'user',
      },
    ];
  }
  return entities;
}

// ============================================================================
// High-Level Kernel Facade API (6-Layer 2D-to-3D CSP + HLR + GB/T Diagnostics)
// ============================================================================

export function deriveFromCustomViews(
  entities: CadEntity[],
  knownViews: [ViewType, ViewType] = ['front', 'top'],
  targetView?: ViewType
): ReconstructedSolution[] {
  return kernelDeriveFromCustomViews(entities, knownViews, targetView);
}

export const deriveThirdView = deriveFromCustomViews;

export function diagnoseThreeViews(
  entities: CadEntity[],
  knownViews?: [ViewType, ViewType],
  lang: 'zh-CN' | 'zh-TW' | 'en' = 'zh-CN'
): DiagnosticIssue[] {
  return kernelDiagnoseThreeViews(entities, knownViews, lang);
}

export function fixSingleDiagnosticIssue(
  issue: DiagnosticIssue,
  entities: CadEntity[]
): CadEntity[] {
  return kernelFixSingleDiagnosticIssue(issue, entities);
}

export const applyDiagnosticFix = fixSingleDiagnosticIssue;
