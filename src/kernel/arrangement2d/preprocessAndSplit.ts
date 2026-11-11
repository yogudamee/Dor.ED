import { CadEntity, LineType, Point2D, ViewType } from '../../types/cad';
import {
  arcSweepCCW,
  dist2,
  isAngleInSweep,
  normAngle,
  pointToLineSegDist,
  TWO_PI,
} from '../core/coordSystem';
import { CurveSegment2D } from '../core/types';

const LINE_PRIORITY: Record<LineType, number> = {
  thick_solid: 3,
  thin_dashed: 2,
  center_dot_dash: 1,
  construction: 0,
};

function roundCoord(v: number): number {
  return Math.round(v * 10000) / 10000;
}

function snapNearOrtho(p1: Point2D, p2: Point2D): [Point2D, Point2D] {
  const du = p2.u - p1.u;
  const dv = p2.v - p1.v;
  const len = Math.hypot(du, dv);
  if (len < 1e-5) return [p1, p2];
  // Calibrate <= 0.8 deg unintentional hand-drawn tilt when near grid/integer coords
  if (Math.abs(du) < 0.08 && Math.abs(du) / len < 0.014) {
    const uMid = Math.round(((p1.u + p2.u) / 2) * 10) / 10;
    if (Math.abs(p1.u - uMid) < 0.08 && Math.abs(p2.u - uMid) < 0.08) {
      return [
        { u: uMid, v: p1.v },
        { u: uMid, v: p2.v },
      ];
    }
  }
  if (Math.abs(dv) < 0.08 && Math.abs(dv) / len < 0.014) {
    const vMid = Math.round(((p1.v + p2.v) / 2) * 10) / 10;
    if (Math.abs(p1.v - vMid) < 0.08 && Math.abs(p2.v - vMid) < 0.08) {
      return [
        { u: p1.u, v: vMid },
        { u: p2.u, v: vMid },
      ];
    }
  }
  return [p1, p2];
}

export interface RawPrimitiveCurve {
  id: string;
  sourceEntityId: string;
  lineType: LineType;
  featureId?: string;
  featureLabel?: string;
  kind: 'line' | 'circle' | 'arc';
  p1?: Point2D;
  p2?: Point2D;
  center?: Point2D;
  radius?: number;
  startAngle?: number;
  endAngle?: number;
}

/**
 * Losslessly decompose `rect` and `polygon` into base `line` primitives while
 * STRICTLY isolating `center_dot_dash` and `construction` so they NEVER split solid/dashed faces!
 */
export function decomposeEntitiesForArrangement(
  entities: CadEntity[],
  view: ViewType
): {
  arrangementCurves: RawPrimitiveCurve[];
  centerlineEntities: CadEntity[];
} {
  const arrangementCurves: RawPrimitiveCurve[] = [];
  const centerlineEntities: CadEntity[] = [];

  for (const ent of entities) {
    if (ent.view !== view) continue;
    if (
      ent.lineType === 'center_dot_dash' ||
      ent.lineType === 'construction'
    ) {
      if (ent.lineType === 'center_dot_dash') {
        centerlineEntities.push(ent);
      }
      continue;
    }

    if (ent.type === 'line') {
      const [q1, q2] = snapNearOrtho(ent.p1, ent.p2);
      if (dist2(q1, q2) > 0.05) {
        arrangementCurves.push({
          id: ent.id,
          sourceEntityId: ent.id,
          lineType: ent.lineType,
          featureId: ent.featureId,
          featureLabel: ent.featureLabel,
          kind: 'line',
          p1: q1,
          p2: q2,
        });
      }
    } else if (ent.type === 'rect') {
      const x1 = ent.x;
      const y1 = ent.y;
      const x2 = ent.x + ent.width;
      const y2 = ent.y + ent.height;
      const corners: Point2D[] = [
        { u: x1, v: y1 },
        { u: x2, v: y1 },
        { u: x2, v: y2 },
        { u: x1, v: y2 },
      ];
      for (let i = 0; i < 4; i++) {
        const a = corners[i];
        const b = corners[(i + 1) % 4];
        if (dist2(a, b) > 0.05) {
          arrangementCurves.push({
            id: `${ent.id}_e${i}`,
            sourceEntityId: ent.id,
            lineType: ent.lineType,
            featureId: ent.featureId,
            featureLabel: ent.featureLabel,
            kind: 'line',
            p1: a,
            p2: b,
          });
        }
      }
    } else if (ent.type === 'polygon') {
      const pts = ent.points;
      const n = pts.length;
      const count = ent.closed ? n : Math.max(0, n - 1);
      for (let i = 0; i < count; i++) {
        const a = pts[i];
        const b = pts[(i + 1) % n];
        if (dist2(a, b) > 0.05) {
          arrangementCurves.push({
            id: `${ent.id}_p${i}`,
            sourceEntityId: ent.id,
            lineType: ent.lineType,
            featureId: ent.featureId,
            featureLabel: ent.featureLabel,
            kind: 'line',
            p1: a,
            p2: b,
          });
        }
      }
    } else if (ent.type === 'circle') {
      if (ent.radius > 0.1) {
        arrangementCurves.push({
          id: ent.id,
          sourceEntityId: ent.id,
          lineType: ent.lineType,
          featureId: ent.featureId,
          featureLabel: ent.featureLabel,
          kind: 'circle',
          center: { u: ent.center.u, v: ent.center.v },
          radius: ent.radius,
        });
      }
    } else if (ent.type === 'arc') {
      if (ent.radius > 0.1) {
        const sweep = arcSweepCCW(ent.startAngle, ent.endAngle);
        if (sweep >= TWO_PI - 1e-3) {
          arrangementCurves.push({
            id: ent.id,
            sourceEntityId: ent.id,
            lineType: ent.lineType,
            featureId: ent.featureId,
            featureLabel: ent.featureLabel,
            kind: 'circle',
            center: { u: ent.center.u, v: ent.center.v },
            radius: ent.radius,
          });
        } else if (sweep * ent.radius > 0.05) {
          arrangementCurves.push({
            id: ent.id,
            sourceEntityId: ent.id,
            lineType: ent.lineType,
            featureId: ent.featureId,
            featureLabel: ent.featureLabel,
            kind: 'arc',
            center: { u: ent.center.u, v: ent.center.v },
            radius: ent.radius,
            startAngle: normAngle(ent.startAngle),
            endAngle: normAngle(ent.endAngle),
          });
        }
      }
    }
  }

  return { arrangementCurves, centerlineEntities };
}

// ============================================================================
// Exact Pairwise Curve Intersections + T-Junction (<= 1.5mm) + Micro-Gap (<= 2.0mm)
// ============================================================================

export function intersectLineLineExact(
  a1: Point2D,
  a2: Point2D,
  b1: Point2D,
  b2: Point2D,
  tol = 1e-5
): Point2D[] {
  const dax = a2.u - a1.u;
  const day = a2.v - a1.v;
  const dbx = b2.u - b1.u;
  const dby = b2.v - b1.v;
  const denom = dax * dby - day * dbx;
  const lenA = Math.hypot(dax, day);
  const lenB = Math.hypot(dbx, dby);
  if (lenA < 1e-6 || lenB < 1e-6) return [];

  if (Math.abs(denom) / (lenA * lenB) < 1e-5) {
    // Collinear overlap: return mutual endpoints that lie on the other segment
    const pts: Point2D[] = [];
    for (const q of [b1, b2]) {
      const { dist } = pointToLineSegDist(q, a1, a2);
      if (dist <= 0.15) pts.push({ u: q.u, v: q.v });
    }
    for (const p of [a1, a2]) {
      const { dist } = pointToLineSegDist(p, b1, b2);
      if (dist <= 0.15) pts.push({ u: p.u, v: p.v });
    }
    return pts;
  }

  const t = ((b1.u - a1.u) * dby - (b1.v - a1.v) * dbx) / denom;
  const s = ((b1.u - a1.u) * day - (b1.v - a1.v) * dax) / denom;
  if (t >= -tol && t <= 1 + tol && s >= -tol && s <= 1 + tol) {
    const tc = Math.max(0, Math.min(1, t));
    return [{ u: a1.u + tc * dax, v: a1.v + tc * day }];
  }
  return [];
}

export function intersectLineCircleExact(
  p1: Point2D,
  p2: Point2D,
  center: Point2D,
  radius: number,
  segTol = 1e-4
): Point2D[] {
  const dx = p2.u - p1.u;
  const dy = p2.v - p1.v;
  const fx = p1.u - center.u;
  const fy = p1.v - center.v;
  const a = dx * dx + dy * dy;
  if (a < 1e-10) return [];
  const b = 2 * (fx * dx + fy * dy);
  const c = fx * fx + fy * fy - radius * radius;
  let disc = b * b - 4 * a * c;
  // Allow slight tangent graze tolerance up to 0.08mm
  const minDistToCenter = Math.abs(dx * fy - dy * fx) / Math.sqrt(a);
  if (disc < 0 && Math.abs(minDistToCenter - radius) <= 0.08) {
    disc = 0;
  }
  if (disc < 0) return [];
  const sqrtD = Math.sqrt(Math.max(0, disc));
  const ts = [(-b - sqrtD) / (2 * a), (-b + sqrtD) / (2 * a)];
  const out: Point2D[] = [];
  for (const t of ts) {
    if (t >= -segTol && t <= 1 + segTol) {
      const tc = Math.max(0, Math.min(1, t));
      const pt = { u: p1.u + tc * dx, v: p1.v + tc * dy };
      // Project onto exact circle radius to avoid drift
      const ang = Math.atan2(pt.v - center.v, pt.u - center.u);
      const exactPt = {
        u: center.u + radius * Math.cos(ang),
        v: center.v + radius * Math.sin(ang),
      };
      // If line is axis-aligned, preserve exact line coord when tangent/secant
      if (Math.abs(dx) < 1e-6) exactPt.u = p1.u;
      if (Math.abs(dy) < 1e-6) exactPt.v = p1.v;
      if (!out.some((q) => dist2(q, exactPt) < 1e-3)) {
        out.push(exactPt);
      }
    }
  }
  return out;
}

export function intersectCircleCircleExact(
  c1: Point2D,
  r1: number,
  c2: Point2D,
  r2: number
): Point2D[] {
  const d = dist2(c1, c2);
  if (d < 1e-6) return [];
  if (d > r1 + r2 + 0.08 || d < Math.abs(r1 - r2) - 0.08) return [];
  const a = (r1 * r1 - r2 * r2 + d * d) / (2 * d);
  const hSq = r1 * r1 - a * a;
  const h = Math.sqrt(Math.max(0, hSq));
  const u0 = c1.u + (a * (c2.u - c1.u)) / d;
  const v0 = c1.v + (a * (c2.v - c1.v)) / d;
  const ru = -(c2.v - c1.v) * (h / d);
  const rv = (c2.u - c1.u) * (h / d);
  const pA = { u: u0 + ru, v: v0 + rv };
  const pB = { u: u0 - ru, v: v0 - rv };
  if (dist2(pA, pB) < 1e-3) return [pA];
  return [pA, pB];
}

function getCurveEndpoints(c: RawPrimitiveCurve): Point2D[] {
  if (c.kind === 'line' && c.p1 && c.p2) return [c.p1, c.p2];
  if (
    c.kind === 'arc' &&
    c.center &&
    c.radius !== undefined &&
    c.startAngle !== undefined &&
    c.endAngle !== undefined
  ) {
    return [
      {
        u: c.center.u + c.radius * Math.cos(c.startAngle),
        v: c.center.v + c.radius * Math.sin(c.startAngle),
      },
      {
        u: c.center.u + c.radius * Math.cos(c.endAngle),
        v: c.center.v + c.radius * Math.sin(c.endAngle),
      },
    ];
  }
  return [];
}

/**
 * Heal micro-gaps (<= 2.0mm) between dangling degree-1 endpoints and snap T-junctions (<= 1.5mm).
 */
function healMicroGapsAndTJunctions(
  curves: RawPrimitiveCurve[],
  tJunctionTol = 1.5,
  microGapTol = 2.0
): RawPrimitiveCurve[] {
  const working = curves.map((c) => ({
    ...c,
    p1: c.p1 ? { ...c.p1 } : undefined,
    p2: c.p2 ? { ...c.p2 } : undefined,
    center: c.center ? { ...c.center } : undefined,
  }));

  // 1. Collect endpoint degrees (within 0.35mm clustering)
  interface EndRef {
    curveIdx: number;
    which: 'p1' | 'p2' | 'arcStart' | 'arcEnd';
    pt: Point2D;
  }
  const collectEnds = (): EndRef[] => {
    const refs: EndRef[] = [];
    working.forEach((c, idx) => {
      if (c.kind === 'line' && c.p1 && c.p2) {
        refs.push({ curveIdx: idx, which: 'p1', pt: c.p1 });
        refs.push({ curveIdx: idx, which: 'p2', pt: c.p2 });
      } else if (
        c.kind === 'arc' &&
        c.center &&
        c.radius !== undefined &&
        c.startAngle !== undefined &&
        c.endAngle !== undefined
      ) {
        refs.push({
          curveIdx: idx,
          which: 'arcStart',
          pt: {
            u: c.center.u + c.radius * Math.cos(c.startAngle),
            v: c.center.v + c.radius * Math.sin(c.startAngle),
          },
        });
        refs.push({
          curveIdx: idx,
          which: 'arcEnd',
          pt: {
            u: c.center.u + c.radius * Math.cos(c.endAngle),
            v: c.center.v + c.radius * Math.sin(c.endAngle),
          },
        });
      }
    });
    return refs;
  };

  const ends = collectEnds();
  const isConnectedEndpoint = (idx: number): boolean => {
    const e = ends[idx];
    for (let j = 0; j < ends.length; j++) {
      if (j === idx) continue;
      if (dist2(e.pt, ends[j].pt) <= 0.25) return true;
    }
    // Also check if already lying cleanly on another curve within 0.15mm
    for (let k = 0; k < working.length; k++) {
      if (k === e.curveIdx) continue;
      const other = working[k];
      if (other.kind === 'line' && other.p1 && other.p2) {
        if (pointToLineSegDist(e.pt, other.p1, other.p2).dist <= 0.15) {
          return true;
        }
      } else if ((other.kind === 'circle' || other.kind === 'arc') && other.center && other.radius !== undefined) {
        const dRing = Math.abs(dist2(e.pt, other.center) - other.radius);
        if (dRing <= 0.15) {
          if (other.kind === 'circle') return true;
          const ang = normAngle(Math.atan2(e.pt.v - other.center.v, e.pt.u - other.center.u));
          if (isAngleInSweep(ang, other.startAngle!, other.endAngle!, 0.02)) {
            return true;
          }
        }
      }
    }
    return false;
  };

  // 2. Micro-gap bridging (<= 2.0mm) between pairs of dangling degree-1 endpoints
  const consumedEnd = new Set<number>();
  const bridgeCurves: RawPrimitiveCurve[] = [];
  for (let i = 0; i < ends.length; i++) {
    if (consumedEnd.has(i) || isConnectedEndpoint(i)) continue;
    let bestJ = -1;
    let bestDist = microGapTol;
    for (let j = i + 1; j < ends.length; j++) {
      if (consumedEnd.has(j) || ends[j].curveIdx === ends[i].curveIdx) continue;
      if (isConnectedEndpoint(j)) continue;
      // Only bridge same lineType or solid-to-solid
      if (
        working[ends[i].curveIdx].lineType !==
        working[ends[j].curveIdx].lineType
      ) {
        continue;
      }
      const d = dist2(ends[i].pt, ends[j].pt);
      if (d > 1e-4 && d <= bestDist) {
        bestDist = d;
        bestJ = j;
      }
    }
    if (bestJ >= 0) {
      consumedEnd.add(i);
      consumedEnd.add(bestJ);
      const ci = working[ends[i].curveIdx];
      const cj = working[ends[bestJ].curveIdx];
      // If both are line endpoints and very close (< 0.8mm), snap directly to intersection/midpoint
      if (
        ci.kind === 'line' &&
        cj.kind === 'line' &&
        bestDist <= 0.8 &&
        ends[i].which.startsWith('p') &&
        ends[bestJ].which.startsWith('p')
      ) {
        const mid = {
          u: (ends[i].pt.u + ends[bestJ].pt.u) / 2,
          v: (ends[i].pt.v + ends[bestJ].pt.v) / 2,
        };
        if (ends[i].which === 'p1') ci.p1 = { ...mid };
        else ci.p2 = { ...mid };
        if (ends[bestJ].which === 'p1') cj.p1 = { ...mid };
        else cj.p2 = { ...mid };
      } else {
        bridgeCurves.push({
          id: `bridge_${ci.id}_${cj.id}`,
          sourceEntityId: ci.sourceEntityId,
          lineType: ci.lineType,
          kind: 'line',
          p1: { ...ends[i].pt },
          p2: { ...ends[bestJ].pt },
        });
      }
    }
  }

  // 3. T-junction snapping (<= 1.5mm): snap dangling line endpoints onto nearby host curve
  for (let i = 0; i < ends.length; i++) {
    if (consumedEnd.has(i) || isConnectedEndpoint(i)) continue;
    const e = ends[i];
    const hostCurve = working[e.curveIdx];
    if (hostCurve.kind !== 'line' || !hostCurve.p1 || !hostCurve.p2) continue;

    let bestSnap: Point2D | null = null;
    let bestDist = tJunctionTol;
    for (let k = 0; k < working.length; k++) {
      if (k === e.curveIdx) continue;
      const target = working[k];
      if (target.kind === 'line' && target.p1 && target.p2) {
        const { dist, proj } = pointToLineSegDist(e.pt, target.p1, target.p2);
        if (dist <= bestDist) {
          bestDist = dist;
          bestSnap = proj;
        }
      } else if (
        (target.kind === 'circle' || target.kind === 'arc') &&
        target.center &&
        target.radius !== undefined
      ) {
        const dRing = Math.abs(dist2(e.pt, target.center) - target.radius);
        if (dRing <= bestDist) {
          const ang = normAngle(
            Math.atan2(e.pt.v - target.center.v, e.pt.u - target.center.u)
          );
          if (
            target.kind === 'circle' ||
            isAngleInSweep(ang, target.startAngle!, target.endAngle!, 0.03)
          ) {
            bestDist = dRing;
            bestSnap = {
              u: target.center.u + target.radius * Math.cos(ang),
              v: target.center.v + target.radius * Math.sin(ang),
            };
          }
        }
      }
    }

    if (bestSnap) {
      if (e.which === 'p1') hostCurve.p1 = bestSnap;
      else if (e.which === 'p2') hostCurve.p2 = bestSnap;
    }
  }

  return [...working, ...bridgeCurves];
}

/**
 * Preprocess and split all 2D curves (`thick_solid` and `thin_dashed`) at all exact pairwise
 * intersections, T-junctions, and tangent points, deduplicating overlapping segments by
 * `thick_solid > thin_dashed` priority.
 */
export function preprocessAndSplitView(
  entities: CadEntity[],
  view: ViewType,
  filterSolidOnly = false
): {
  segments: CurveSegment2D[];
  centerlineEntities: CadEntity[];
  rawCurves: RawPrimitiveCurve[];
} {
  const { arrangementCurves, centerlineEntities } =
    decomposeEntitiesForArrangement(entities, view);

  const filteredRaw = filterSolidOnly
    ? arrangementCurves.filter((c) => c.lineType === 'thick_solid')
    : arrangementCurves;

  const curves = healMicroGapsAndTJunctions(filteredRaw, 1.5, 2.0);
  const splitPtsPerCurve: Point2D[][] = curves.map((c) => getCurveEndpoints(c));

  const addSplitPt = (idx: number, pt: Point2D) => {
    const arr = splitPtsPerCurve[idx];
    if (!arr.some((q) => dist2(q, pt) < 0.03)) {
      arr.push({ u: roundCoord(pt.u), v: roundCoord(pt.v) });
    }
  };

  // Exact pairwise intersection & endpoint projection pass
  for (let i = 0; i < curves.length; i++) {
    const ci = curves[i];
    for (let j = i + 1; j < curves.length; j++) {
      const cj = curves[j];
      if (ci.kind === 'line' && cj.kind === 'line') {
        const hits = intersectLineLineExact(ci.p1!, ci.p2!, cj.p1!, cj.p2!, 1e-3);
        for (const h of hits) {
          addSplitPt(i, h);
          addSplitPt(j, h);
        }
        // T-junction split check within 0.3mm
        for (const ep of [ci.p1!, ci.p2!]) {
          const { dist, proj } = pointToLineSegDist(ep, cj.p1!, cj.p2!);
          if (dist <= 0.3) addSplitPt(j, proj);
        }
        for (const ep of [cj.p1!, cj.p2!]) {
          const { dist, proj } = pointToLineSegDist(ep, ci.p1!, ci.p2!);
          if (dist <= 0.3) addSplitPt(i, proj);
        }
      } else if (
        ci.kind === 'line' &&
        (cj.kind === 'circle' || cj.kind === 'arc')
      ) {
        const hits = intersectLineCircleExact(
          ci.p1!,
          ci.p2!,
          cj.center!,
          cj.radius!,
          2e-3
        );
        for (const h of hits) {
          const ang = normAngle(
            Math.atan2(h.v - cj.center!.v, h.u - cj.center!.u)
          );
          if (
            cj.kind === 'circle' ||
            isAngleInSweep(ang, cj.startAngle!, cj.endAngle!, 0.015)
          ) {
            addSplitPt(i, h);
            addSplitPt(j, h);
          }
        }
      } else if (
        (ci.kind === 'circle' || ci.kind === 'arc') &&
        cj.kind === 'line'
      ) {
        const hits = intersectLineCircleExact(
          cj.p1!,
          cj.p2!,
          ci.center!,
          ci.radius!,
          2e-3
        );
        for (const h of hits) {
          const ang = normAngle(
            Math.atan2(h.v - ci.center!.v, h.u - ci.center!.u)
          );
          if (
            ci.kind === 'circle' ||
            isAngleInSweep(ang, ci.startAngle!, ci.endAngle!, 0.015)
          ) {
            addSplitPt(i, h);
            addSplitPt(j, h);
          }
        }
      } else if (
        (ci.kind === 'circle' || ci.kind === 'arc') &&
        (cj.kind === 'circle' || cj.kind === 'arc')
      ) {
        // Same circle overlap: split at arc endpoints
        if (
          dist2(ci.center!, cj.center!) < 0.25 &&
          Math.abs(ci.radius! - cj.radius!) < 0.25
        ) {
          for (const ep of getCurveEndpoints(ci)) addSplitPt(j, ep);
          for (const ep of getCurveEndpoints(cj)) addSplitPt(i, ep);
        } else {
          const hits = intersectCircleCircleExact(
            ci.center!,
            ci.radius!,
            cj.center!,
            cj.radius!
          );
          for (const h of hits) {
            const angI = normAngle(
              Math.atan2(h.v - ci.center!.v, h.u - ci.center!.u)
            );
            const angJ = normAngle(
              Math.atan2(h.v - cj.center!.v, h.u - cj.center!.u)
            );
            const okI =
              ci.kind === 'circle' ||
              isAngleInSweep(angI, ci.startAngle!, ci.endAngle!, 0.015);
            const okJ =
              cj.kind === 'circle' ||
              isAngleInSweep(angJ, cj.startAngle!, cj.endAngle!, 0.015);
            if (okI && okJ) {
              addSplitPt(i, h);
              addSplitPt(j, h);
            }
          }
        }
      }
    }
  }

  // Subdivide each curve into atomic CurveSegment2D pieces
  const rawSegments: CurveSegment2D[] = [];
  curves.forEach((c, idx) => {
    const pts = splitPtsPerCurve[idx];
    if (c.kind === 'line' && c.p1 && c.p2) {
      const du = c.p2.u - c.p1.u;
      const dv = c.p2.v - c.p1.v;
      const lenSq = du * du + dv * dv;
      if (lenSq < 1e-6) return;
      const paramPts = pts
        .map((p) => ({
          p,
          t: Math.max(
            0,
            Math.min(1, ((p.u - c.p1!.u) * du + (p.v - c.p1!.v) * dv) / lenSq)
          ),
        }))
        .sort((a, b) => a.t - b.t);

      // Deduplicate close parameters
      const unique: { p: Point2D; t: number }[] = [];
      for (const item of paramPts) {
        if (
          unique.length === 0 ||
          dist2(unique[unique.length - 1].p, item.p) > 0.03
        ) {
          unique.push(item);
        }
      }
      for (let k = 0; k < unique.length - 1; k++) {
        const a = unique[k].p;
        const b = unique[k + 1].p;
        if (dist2(a, b) > 0.04) {
          rawSegments.push({
            id: `${c.id}_s${k}`,
            kind: 'line',
            p1: a,
            p2: b,
            lineType: c.lineType,
            sourceEntityId: c.sourceEntityId,
            featureId: c.featureId,
            featureLabel: c.featureLabel,
          });
        }
      }
    } else if (c.kind === 'circle' && c.center && c.radius !== undefined) {
      if (pts.length < 2) {
        // Split isolated full circle into two exact semicircles [0, π] and [π, 0] so DCEL has finite half-edges without self-loops
        const pRight = { u: c.center.u + c.radius, v: c.center.v };
        const pLeft = { u: c.center.u - c.radius, v: c.center.v };
        rawSegments.push(
          {
            id: `${c.id}_semi0`,
            kind: 'arc',
            p1: pRight,
            p2: pLeft,
            center: c.center,
            radius: c.radius,
            startAngle: 0,
            endAngle: Math.PI,
            ccw: true,
            lineType: c.lineType,
            sourceEntityId: c.sourceEntityId,
            featureId: c.featureId,
            featureLabel: c.featureLabel,
          },
          {
            id: `${c.id}_semi1`,
            kind: 'arc',
            p1: pLeft,
            p2: pRight,
            center: c.center,
            radius: c.radius,
            startAngle: Math.PI,
            endAngle: 0,
            ccw: true,
            lineType: c.lineType,
            sourceEntityId: c.sourceEntityId,
            featureId: c.featureId,
            featureLabel: c.featureLabel,
          }
        );
      } else {
        const angPts = pts
          .map((p) => ({
            ang: normAngle(Math.atan2(p.v - c.center!.v, p.u - c.center!.u)),
            p,
          }))
          .sort((a, b) => a.ang - b.ang);
        const unique: { ang: number; p: Point2D }[] = [];
        for (const item of angPts) {
          if (
            unique.length === 0 ||
            Math.abs(item.ang - unique[unique.length - 1].ang) * c.radius! > 0.03
          ) {
            unique.push(item);
          }
        }
        if (
          unique.length > 1 &&
          (TWO_PI - unique[unique.length - 1].ang + unique[0].ang) * c.radius! <=
            0.03
        ) {
          unique.pop();
        }
        const m = unique.length;
        if (m === 1) {
          const a0 = unique[0].ang;
          const aMid = normAngle(a0 + Math.PI);
          const p0 = unique[0].p;
          const pMid = {
            u: roundCoord(c.center.u + c.radius * Math.cos(aMid)),
            v: roundCoord(c.center.v + c.radius * Math.sin(aMid)),
          };
          rawSegments.push(
            {
              id: `${c.id}_c0`,
              kind: 'arc',
              p1: p0,
              p2: pMid,
              center: c.center,
              radius: c.radius,
              startAngle: a0,
              endAngle: aMid,
              ccw: true,
              lineType: c.lineType,
              sourceEntityId: c.sourceEntityId,
              featureId: c.featureId,
              featureLabel: c.featureLabel,
            },
            {
              id: `${c.id}_c1`,
              kind: 'arc',
              p1: pMid,
              p2: p0,
              center: c.center,
              radius: c.radius,
              startAngle: aMid,
              endAngle: a0,
              ccw: true,
              lineType: c.lineType,
              sourceEntityId: c.sourceEntityId,
              featureId: c.featureId,
              featureLabel: c.featureLabel,
            }
          );
        } else {
          for (let k = 0; k < m; k++) {
            const u0 = unique[k];
            const u1 = unique[(k + 1) % m];
            rawSegments.push({
              id: `${c.id}_a${k}`,
              kind: 'arc',
              p1: u0.p,
              p2: u1.p,
              center: c.center,
              radius: c.radius,
              startAngle: u0.ang,
              endAngle: u1.ang,
              ccw: true,
              lineType: c.lineType,
              sourceEntityId: c.sourceEntityId,
              featureId: c.featureId,
              featureLabel: c.featureLabel,
            });
          }
        }
      }
    } else if (
      c.kind === 'arc' &&
      c.center &&
      c.radius !== undefined &&
      c.startAngle !== undefined &&
      c.endAngle !== undefined
    ) {
      const totalSweep = arcSweepCCW(c.startAngle, c.endAngle);
      const relPts = pts
        .map((p) => {
          const ang = normAngle(
            Math.atan2(p.v - c.center!.v, p.u - c.center!.u)
          );
          let rel = normAngle(ang - c.startAngle!);
          if (rel > totalSweep + 0.02 && TWO_PI - rel < 0.05) rel = 0;
          rel = Math.max(0, Math.min(totalSweep, rel));
          const exactAng = normAngle(c.startAngle! + rel);
          return {
            rel,
            ang: exactAng,
            p: {
              u: roundCoord(c.center!.u + c.radius! * Math.cos(exactAng)),
              v: roundCoord(c.center!.v + c.radius! * Math.sin(exactAng)),
            },
          };
        })
        .sort((a, b) => a.rel - b.rel);

      const unique: typeof relPts = [];
      for (const item of relPts) {
        if (
          unique.length === 0 ||
          Math.abs(item.rel - unique[unique.length - 1].rel) * c.radius! > 0.03
        ) {
          unique.push(item);
        }
      }
      for (let k = 0; k < unique.length - 1; k++) {
        const u0 = unique[k];
        const u1 = unique[k + 1];
        if ((u1.rel - u0.rel) * c.radius > 0.04) {
          rawSegments.push({
            id: `${c.id}_s${k}`,
            kind: 'arc',
            p1: u0.p,
            p2: u1.p,
            center: c.center,
            radius: c.radius,
            startAngle: u0.ang,
            endAngle: u1.ang,
            ccw: true,
            lineType: c.lineType,
            sourceEntityId: c.sourceEntityId,
            featureId: c.featureId,
            featureLabel: c.featureLabel,
          });
        }
      }
    }
  });

  // Deduplicate geometrically identical segments, keeping highest lineType priority
  const deduped: CurveSegment2D[] = [];
  for (const seg of rawSegments) {
    const existingIdx = deduped.findIndex((ex) => areSegmentsCoincident(ex, seg));
    if (existingIdx < 0) {
      deduped.push(seg);
    } else {
      const ex = deduped[existingIdx];
      if (LINE_PRIORITY[seg.lineType] > LINE_PRIORITY[ex.lineType]) {
        deduped[existingIdx] = seg;
      }
    }
  }

  return {
    segments: deduped,
    centerlineEntities,
    rawCurves: filteredRaw,
  };
}

function areSegmentsCoincident(a: CurveSegment2D, b: CurveSegment2D): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'line') {
    const sameDir = dist2(a.p1, b.p1) < 0.06 && dist2(a.p2, b.p2) < 0.06;
    const oppDir = dist2(a.p1, b.p2) < 0.06 && dist2(a.p2, b.p1) < 0.06;
    return sameDir || oppDir;
  }
  if (
    a.center &&
    b.center &&
    a.radius !== undefined &&
    b.radius !== undefined &&
    a.startAngle !== undefined &&
    a.endAngle !== undefined &&
    b.startAngle !== undefined &&
    b.endAngle !== undefined
  ) {
    if (dist2(a.center, b.center) > 0.15 || Math.abs(a.radius - b.radius) > 0.15) {
      return false;
    }
    const midA = a.startAngle + arcSweepCCW(a.startAngle, a.endAngle) * 0.5;
    const midB = b.startAngle + arcSweepCCW(b.startAngle, b.endAngle) * 0.5;
    const pMidA = {
      u: a.center.u + a.radius * Math.cos(midA),
      v: a.center.v + a.radius * Math.sin(midA),
    };
    const pMidB = {
      u: b.center.u + b.radius * Math.cos(midB),
      v: b.center.v + b.radius * Math.sin(midB),
    };
    return (
      dist2(pMidA, pMidB) < 0.08 &&
      ((dist2(a.p1, b.p1) < 0.08 && dist2(a.p2, b.p2) < 0.08) ||
        (dist2(a.p1, b.p2) < 0.08 && dist2(a.p2, b.p1) < 0.08))
    );
  }
  return false;
}
