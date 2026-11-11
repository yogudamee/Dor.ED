import { CadEntity, LineType, ViewType } from '../../types/cad';
import { BBox2D, SplitCurveSegment2D, Vec2 } from '../types';

const TWO_PI = Math.PI * 2;
const MAX_SPLIT_SEGMENTS = 1200;

export function dist2(a: Vec2, b: Vec2): number {
  return Math.hypot(a.u - b.u, a.v - b.v);
}

export function normAngle(rad: number): number {
  return ((rad % TWO_PI) + TWO_PI) % TWO_PI;
}

export function arcSweepCCW(startAngle: number, endAngle: number): number {
  const s = normAngle(endAngle - startAngle);
  return s < 1e-6 ? TWO_PI : s;
}

export function isAngleInArc(angle: number, startAngle: number, endAngle: number, tol = 1e-3): boolean {
  const s = arcSweepCCW(startAngle, endAngle);
  if (s >= TWO_PI - 1e-4) return true;
  const rel = normAngle(angle - normAngle(startAngle));
  return rel <= s + tol || rel >= TWO_PI - tol;
}

export function computeArcBBox(center: Vec2, radius: number, startAngle: number, endAngle: number): BBox2D {
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
  const cardinals = [0, Math.PI * 0.5, Math.PI, Math.PI * 1.5];
  for (const q of cardinals) {
    if (isAngleInArc(q, startAngle, endAngle, -1e-4)) {
      const qu = center.u + radius * Math.cos(q);
      const qv = center.v + radius * Math.sin(q);
      if (qu < uMin) uMin = qu;
      if (qu > uMax) uMax = qu;
      if (qv < vMin) vMin = qv;
      if (qv > vMax) vMax = qv;
    }
  }
  return { uMin, uMax, vMin, vMax };
}

export function pointToLineSegDist(p: Vec2, a: Vec2, b: Vec2): { dist: number; t: number; foot: Vec2 } {
  const du = b.u - a.u;
  const dv = b.v - a.v;
  const lenSq = du * du + dv * dv;
  if (lenSq < 1e-9) {
    return { dist: dist2(p, a), t: 0, foot: { u: a.u, v: a.v } };
  }
  const tRaw = ((p.u - a.u) * du + (p.v - a.v) * dv) / lenSq;
  const t = Math.max(0, Math.min(1, tRaw));
  const foot = { u: a.u + t * du, v: a.v + t * dv };
  return { dist: dist2(p, foot), t, foot };
}

export function intersectLineLineAnalytical(
  a1: Vec2,
  a2: Vec2,
  b1: Vec2,
  b2: Vec2
): { pt: Vec2; tA: number; tB: number } | null {
  const dau = a2.u - a1.u;
  const dav = a2.v - a1.v;
  const dbu = b2.u - b1.u;
  const dbv = b2.v - b1.v;
  const denom = dau * dbv - dav * dbu;
  if (Math.abs(denom) < 1e-8) return null;
  const tA = ((b1.u - a1.u) * dbv - (b1.v - a1.v) * dbu) / denom;
  const tB = ((b1.u - a1.u) * dav - (b1.v - a1.v) * dau) / denom;
  if (tA >= -1e-4 && tA <= 1 + 1e-4 && tB >= -1e-4 && tB <= 1 + 1e-4) {
    const tcA = Math.max(0, Math.min(1, tA));
    return {
      pt: { u: a1.u + tcA * dau, v: a1.v + tcA * dav },
      tA: tcA,
      tB: Math.max(0, Math.min(1, tB)),
    };
  }
  return null;
}

export function intersectLineCircleAnalytical(
  p1: Vec2,
  p2: Vec2,
  center: Vec2,
  radius: number
): { pt: Vec2; t: number; angle: number }[] {
  const du = p2.u - p1.u;
  const dv = p2.v - p1.v;
  const fu = p1.u - center.u;
  const fv = p1.v - center.v;
  const A = du * du + dv * dv;
  if (A < 1e-9) return [];
  const B = 2 * (fu * du + fv * dv);
  const C = fu * fu + fv * fv - radius * radius;
  let disc = B * B - 4 * A * C;
  // Allow slight grazing tangency tolerance up to ~0.35mm
  const tangentTol = 4 * A * Math.max(0.12, 0.008 * radius * radius);
  if (disc < -tangentTol) return [];
  disc = Math.max(0, disc);
  const sq = Math.sqrt(disc);
  const roots = disc < 1e-6 ? [-B / (2 * A)] : [(-B - sq) / (2 * A), (-B + sq) / (2 * A)];
  const hits: { pt: Vec2; t: number; angle: number }[] = [];
  for (const tRaw of roots) {
    if (tRaw >= -0.015 && tRaw <= 1.015) {
      const t = Math.max(0, Math.min(1, tRaw));
      const rawPt = { u: p1.u + t * du, v: p1.v + t * dv };
      const angle = normAngle(Math.atan2(rawPt.v - center.v, rawPt.u - center.u));
      const exactPt = {
        u: center.u + radius * Math.cos(angle),
        v: center.v + radius * Math.sin(angle),
      };
      if (dist2(rawPt, exactPt) <= 1.2) {
        if (!hits.some((h) => dist2(h.pt, exactPt) < 0.05)) {
          hits.push({ pt: exactPt, t, angle });
        }
      }
    }
  }
  return hits;
}

export function intersectCircleCircleAnalytical(
  c1: Vec2,
  r1: number,
  c2: Vec2,
  r2: number
): Vec2[] {
  const d = dist2(c1, c2);
  if (d < 1e-6) return [];
  if (d > r1 + r2 + 0.6 || d < Math.abs(r1 - r2) - 0.6) return [];
  const dClamped = Math.min(r1 + r2, Math.max(Math.abs(r1 - r2), d));
  const a = (r1 * r1 - r2 * r2 + dClamped * dClamped) / (2 * dClamped);
  const h = Math.sqrt(Math.max(0, r1 * r1 - a * a));
  const ux = (c2.u - c1.u) / d;
  const uv = (c2.v - c1.v) / d;
  const midU = c1.u + a * ux;
  const midV = c1.v + a * uv;
  const pA = { u: midU - h * uv, v: midV + h * ux };
  const pB = { u: midU + h * uv, v: midV - h * ux };
  if (dist2(pA, pB) < 0.06) return [pA];
  return [pA, pB];
}

interface RawPrim2D {
  sourceEntityId: string;
  lineType: LineType;
  kind: 'line' | 'circle' | 'arc';
  p1?: Vec2;
  p2?: Vec2;
  center?: Vec2;
  radius?: number;
  startAngle?: number;
  endAngle?: number;
}

/**
 * Converts user CAD entities in a view into snapped, intersection-split, T-junction-split,
 * gap-bridged analytical curve segments (`SplitCurveSegment2D[]`).
 */
export function snapAndSplitViewEntities(
  entities: CadEntity[],
  view: ViewType,
  allowedLineTypes: LineType[] = ['thick_solid', 'thin_dashed']
): SplitCurveSegment2D[] {
  const rawPrims: RawPrim2D[] = [];
  const filtered = entities.filter(
    (e) => e.view === view && e.source !== 'derived' && allowedLineTypes.includes(e.lineType)
  );

  for (const ent of filtered) {
    if (ent.type === 'line') {
      if (dist2(ent.p1, ent.p2) >= 0.25) {
        rawPrims.push({
          sourceEntityId: ent.id,
          lineType: ent.lineType,
          kind: 'line',
          p1: { ...ent.p1 },
          p2: { ...ent.p2 },
        });
      }
    } else if (ent.type === 'rect') {
      if (ent.width >= 0.4 && ent.height >= 0.4) {
        const c0 = { u: ent.x, v: ent.y };
        const c1 = { u: ent.x + ent.width, v: ent.y };
        const c2 = { u: ent.x + ent.width, v: ent.y + ent.height };
        const c3 = { u: ent.x, v: ent.y + ent.height };
        const edges: [Vec2, Vec2][] = [
          [c0, c1],
          [c1, c2],
          [c2, c3],
          [c3, c0],
        ];
        for (const [a, b] of edges) {
          rawPrims.push({
            sourceEntityId: ent.id,
            lineType: ent.lineType,
            kind: 'line',
            p1: a,
            p2: b,
          });
        }
      }
    } else if (ent.type === 'polygon' && ent.points.length >= 2) {
      const n = ent.points.length;
      const count = ent.closed !== false ? n : n - 1;
      for (let i = 0; i < count; i++) {
        const a = ent.points[i];
        const b = ent.points[(i + 1) % n];
        if (dist2(a, b) >= 0.25) {
          rawPrims.push({
            sourceEntityId: ent.id,
            lineType: ent.lineType,
            kind: 'line',
            p1: { ...a },
            p2: { ...b },
          });
        }
      }
    } else if (ent.type === 'circle' && ent.radius >= 0.4) {
      rawPrims.push({
        sourceEntityId: ent.id,
        lineType: ent.lineType,
        kind: 'circle',
        center: { ...ent.center },
        radius: ent.radius,
      });
    } else if (ent.type === 'arc' && ent.radius >= 0.4) {
      const sweep = arcSweepCCW(ent.startAngle, ent.endAngle);
      if (sweep >= TWO_PI - 0.02) {
        rawPrims.push({
          sourceEntityId: ent.id,
          lineType: ent.lineType,
          kind: 'circle',
          center: { ...ent.center },
          radius: ent.radius,
        });
      } else {
        const sA = normAngle(ent.startAngle);
        const eA = normAngle(ent.endAngle);
        rawPrims.push({
          sourceEntityId: ent.id,
          lineType: ent.lineType,
          kind: 'arc',
          center: { ...ent.center },
          radius: ent.radius,
          startAngle: sA,
          endAngle: eA,
          p1: { u: ent.center.u + ent.radius * Math.cos(sA), v: ent.center.v + ent.radius * Math.sin(sA) },
          p2: { u: ent.center.u + ent.radius * Math.cos(eA), v: ent.center.v + ent.radius * Math.sin(eA) },
        });
      }
    }
  }

  // Step 1: Calibrate near-orthogonal lines (angle deviation <= 1.2°)
  const orthoSinTol = Math.sin((1.2 * Math.PI) / 180);
  for (const p of rawPrims) {
    if (p.kind === 'line' && p.p1 && p.p2) {
      const du = p.p2.u - p.p1.u;
      const dv = p.p2.v - p.p1.v;
      const len = Math.hypot(du, dv);
      if (len >= 1.5) {
        if (Math.abs(dv) / len <= orthoSinTol && Math.abs(dv) <= 0.6) {
          const avgV = Number((0.5 * (p.p1.v + p.p2.v)).toFixed(2));
          p.p1.v = avgV;
          p.p2.v = avgV;
        } else if (Math.abs(du) / len <= orthoSinTol && Math.abs(du) <= 0.6) {
          const avgU = Number((0.5 * (p.p1.u + p.p2.u)).toFixed(2));
          p.p1.u = avgU;
          p.p2.u = avgU;
        }
      }
    }
  }

  // Step 2: Micro-gap endpoint bridging (<= 2.5mm) & T-junction snapping onto lines/circles
  const anchorPts: Vec2[] = [];
  const registerAnchor = (pt: Vec2): Vec2 => {
    for (const a of anchorPts) {
      if (dist2(a, pt) <= 0.85) return a;
    }
    const clean = { u: Number(pt.u.toFixed(3)), v: Number(pt.v.toFixed(3)) };
    anchorPts.push(clean);
    return clean;
  };

  for (const p of rawPrims) {
    if ((p.kind === 'line' || p.kind === 'arc') && p.p1 && p.p2) {
      // First check if endpoint is within 2.2mm of another curve's endpoint
      for (const other of rawPrims) {
        if (other === p) continue;
        if ((other.kind === 'line' || other.kind === 'arc') && other.p1 && other.p2) {
          if (dist2(p.p1, other.p1) <= 2.2 && dist2(p.p1, other.p1) > 1e-4) p.p1 = { ...other.p1 };
          else if (dist2(p.p1, other.p2) <= 2.2 && dist2(p.p1, other.p2) > 1e-4) p.p1 = { ...other.p2 };
          if (dist2(p.p2, other.p1) <= 2.2 && dist2(p.p2, other.p1) > 1e-4) p.p2 = { ...other.p1 };
          else if (dist2(p.p2, other.p2) <= 2.2 && dist2(p.p2, other.p2) > 1e-4) p.p2 = { ...other.p2 };
        }
      }
      // If p is a line whose endpoint nearly touches another line or circle/arc (<= 1.8mm), snap onto it
      if (p.kind === 'line') {
        for (const endKey of ['p1', 'p2'] as const) {
          const ep = p[endKey]!;
          let snapped = false;
          for (const other of rawPrims) {
            if (other === p) continue;
            if (other.kind === 'line' && other.p1 && other.p2) {
              const proj = pointToLineSegDist(ep, other.p1, other.p2);
              if (proj.dist <= 1.6 && proj.t > 0.01 && proj.t < 0.99) {
                p[endKey] = proj.foot;
                snapped = true;
                break;
              }
            } else if ((other.kind === 'circle' || other.kind === 'arc') && other.center && other.radius) {
              const dRing = Math.abs(dist2(ep, other.center) - other.radius);
              if (dRing <= 2.0) {
                const ang = normAngle(Math.atan2(ep.v - other.center.v, ep.u - other.center.u));
                if (
                  other.kind === 'circle' ||
                  isAngleInArc(ang, other.startAngle!, other.endAngle!, 0.06)
                ) {
                  p[endKey] = {
                    u: other.center.u + other.radius * Math.cos(ang),
                    v: other.center.v + other.radius * Math.sin(ang),
                  };
                  snapped = true;
                  break;
                }
              }
            }
          }
          if (snapped && dist2(p.p1, p.p2) < 0.25) {
            // Avoid collapsing degenerate micro-segments
          }
        }
      }
      p.p1 = registerAnchor(p.p1);
      p.p2 = registerAnchor(p.p2);
      if (p.kind === 'arc' && p.center && p.radius) {
        p.startAngle = normAngle(Math.atan2(p.p1.v - p.center.v, p.p1.u - p.center.u));
        p.endAngle = normAngle(Math.atan2(p.p2.v - p.center.v, p.p2.u - p.center.u));
      }
    }
  }

  // Step 3: Merge overlapping collinear straight lines of the SAME lineType before splitting
  // (e.g., if user drew two touching collinear solid chords, unify them; if solid overlaps dashed, solid wins)
  const lineSplitParams: number[][] = rawPrims.map((p) => (p.kind === 'line' ? [0, 1] : []));
  const circleSplitAngles: number[][] = rawPrims.map((p) =>
    p.kind === 'circle'
      ? []
      : p.kind === 'arc'
      ? [0, arcSweepCCW(p.startAngle!, p.endAngle!)]
      : []
  );

  const addLineParam = (idx: number, t: number) => {
    if (t <= 1e-3 || t >= 1 - 1e-3) return;
    const arr = lineSplitParams[idx];
    if (!arr.some((v) => Math.abs(v - t) <= 1e-3)) arr.push(t);
  };

  const addCircleAngle = (idx: number, absAngle: number) => {
    const p = rawPrims[idx];
    if (p.kind === 'circle') {
      const a = normAngle(absAngle);
      const arr = circleSplitAngles[idx];
      if (!arr.some((v) => Math.abs(v - a) <= 1e-3 || Math.abs(Math.abs(v - a) - TWO_PI) <= 1e-3)) {
        arr.push(a);
      }
    } else if (p.kind === 'arc') {
      const sweep = arcSweepCCW(p.startAngle!, p.endAngle!);
      const rel = normAngle(normAngle(absAngle) - p.startAngle!);
      if (rel > 1e-3 && rel < sweep - 1e-3) {
        const arr = circleSplitAngles[idx];
        if (!arr.some((v) => Math.abs(v - rel) <= 1e-3)) arr.push(rel);
      }
    }
  };

  // Step 4: Exact Pairwise Curve-Curve Intersections + T-Junctions
  const n = rawPrims.length;
  for (let i = 0; i < n; i++) {
    const A = rawPrims[i];
    for (let j = i + 1; j < n; j++) {
      const B = rawPrims[j];
      if (A.kind === 'line' && B.kind === 'line' && A.p1 && A.p2 && B.p1 && B.p2) {
        const hit = intersectLineLineAnalytical(A.p1, A.p2, B.p1, B.p2);
        if (hit) {
          addLineParam(i, hit.tA);
          addLineParam(j, hit.tB);
        } else {
          // Check collinear overlap or T-junction within 1.5mm
          for (const ep of [B.p1, B.p2]) {
            const pr = pointToLineSegDist(ep, A.p1, A.p2);
            if (pr.dist <= 1.5 && pr.t > 0.01 && pr.t < 0.99) addLineParam(i, pr.t);
          }
          for (const ep of [A.p1, A.p2]) {
            const pr = pointToLineSegDist(ep, B.p1, B.p2);
            if (pr.dist <= 1.5 && pr.t > 0.01 && pr.t < 0.99) addLineParam(j, pr.t);
          }
        }
      } else if (A.kind === 'line' && (B.kind === 'circle' || B.kind === 'arc')) {
        const hits = intersectLineCircleAnalytical(A.p1!, A.p2!, B.center!, B.radius!);
        for (const h of hits) {
          if (B.kind === 'circle' || isAngleInArc(h.angle, B.startAngle!, B.endAngle!, 0.02)) {
            addLineParam(i, h.t);
            addCircleAngle(j, h.angle);
          }
        }
        // Arc endpoints falling inside line segment A (shared-chord semicircles!)
        if (B.kind === 'arc' && B.p1 && B.p2) {
          for (const ep of [B.p1, B.p2]) {
            const pr = pointToLineSegDist(ep, A.p1!, A.p2!);
            if (pr.dist <= 1.5 && pr.t > 0.01 && pr.t < 0.99) addLineParam(i, pr.t);
          }
        }
      } else if ((A.kind === 'circle' || A.kind === 'arc') && B.kind === 'line') {
        const hits = intersectLineCircleAnalytical(B.p1!, B.p2!, A.center!, A.radius!);
        for (const h of hits) {
          if (A.kind === 'circle' || isAngleInArc(h.angle, A.startAngle!, A.endAngle!, 0.02)) {
            addCircleAngle(i, h.angle);
            addLineParam(j, h.t);
          }
        }
        if (A.kind === 'arc' && A.p1 && A.p2) {
          for (const ep of [A.p1, A.p2]) {
            const pr = pointToLineSegDist(ep, B.p1!, B.p2!);
            if (pr.dist <= 1.5 && pr.t > 0.01 && pr.t < 0.99) addLineParam(j, pr.t);
          }
        }
      } else if (
        (A.kind === 'circle' || A.kind === 'arc') &&
        (B.kind === 'circle' || B.kind === 'arc')
      ) {
        const pts = intersectCircleCircleAnalytical(A.center!, A.radius!, B.center!, B.radius!);
        for (const pt of pts) {
          const angA = normAngle(Math.atan2(pt.v - A.center!.v, pt.u - A.center!.u));
          const angB = normAngle(Math.atan2(pt.v - B.center!.v, pt.u - B.center!.u));
          const okA = A.kind === 'circle' || isAngleInArc(angA, A.startAngle!, A.endAngle!, 0.02);
          const okB = B.kind === 'circle' || isAngleInArc(angB, B.startAngle!, B.endAngle!, 0.02);
          if (okA && okB) {
            addCircleAngle(i, angA);
            addCircleAngle(j, angB);
          }
        }
        // Concentric / stitched arcs sharing endpoints
        if (dist2(A.center!, B.center!) <= 1.2 && Math.abs(A.radius! - B.radius!) <= 1.2) {
          if (B.kind === 'arc') {
            addCircleAngle(i, B.startAngle!);
            addCircleAngle(i, B.endAngle!);
          }
          if (A.kind === 'arc') {
            addCircleAngle(j, A.startAngle!);
            addCircleAngle(j, A.endAngle!);
          }
        }
      }
    }
  }

  // Step 5: Emit atomic SplitCurveSegment2D list and deduplicate overlapping identical sub-segments
  // (GB/T 4458.1 priority: thick_solid > thin_dashed)
  const rawSplitSegs: SplitCurveSegment2D[] = [];
  let segCounter = 0;

  for (let i = 0; i < n; i++) {
    if (rawSplitSegs.length >= MAX_SPLIT_SEGMENTS) break;
    const p = rawPrims[i];
    if (p.kind === 'line' && p.p1 && p.p2) {
      const ts = lineSplitParams[i].sort((a, b) => a - b);
      const du = p.p2.u - p.p1.u;
      const dv = p.p2.v - p.p1.v;
      for (let k = 0; k < ts.length - 1; k++) {
        const t0 = ts[k];
        const t1 = ts[k + 1];
        const q1 = registerAnchor({ u: p.p1.u + t0 * du, v: p.p1.v + t0 * dv });
        const q2 = registerAnchor({ u: p.p1.u + t1 * du, v: p.p1.v + t1 * dv });
        if (dist2(q1, q2) < 0.2) continue;
        rawSplitSegs.push({
          id: `sp-${view}-ln-${segCounter++}`,
          sourceEntityId: p.sourceEntityId,
          view,
          lineType: p.lineType,
          kind: 'line',
          p1: q1,
          p2: q2,
          bbox: {
            uMin: Math.min(q1.u, q2.u),
            uMax: Math.max(q1.u, q2.u),
            vMin: Math.min(q1.v, q2.v),
            vMax: Math.max(q1.v, q2.v),
          },
        });
      }
    } else if (p.kind === 'circle' && p.center && p.radius) {
      const angs = circleSplitAngles[i].sort((a, b) => a - b);
      // Even an isolated circle is split into 2 semicircular arcs (0 -> π, π -> 2π) for clean DCEL loopless graph!
      const effectiveAngs = angs.length >= 2 ? angs : angs.length === 1 ? [angs[0], normAngle(angs[0] + Math.PI)].sort((a, b) => a - b) : [0, Math.PI];
      const m = effectiveAngs.length;
      for (let k = 0; k < m; k++) {
        const a0 = effectiveAngs[k];
        const a1 = effectiveAngs[(k + 1) % m];
        const sweep = arcSweepCCW(a0, a1);
        if (sweep < 1e-3) continue;
        const q1 = registerAnchor({
          u: p.center.u + p.radius * Math.cos(a0),
          v: p.center.v + p.radius * Math.sin(a0),
        });
        const q2 = registerAnchor({
          u: p.center.u + p.radius * Math.cos(a1),
          v: p.center.v + p.radius * Math.sin(a1),
        });
        rawSplitSegs.push({
          id: `sp-${view}-arc-${segCounter++}`,
          sourceEntityId: p.sourceEntityId,
          view,
          lineType: p.lineType,
          kind: 'arc',
          p1: q1,
          p2: q2,
          center: { ...p.center },
          radius: p.radius,
          startAngle: a0,
          endAngle: a1,
          bbox: computeArcBBox(p.center, p.radius, a0, a1),
        });
      }
    } else if (p.kind === 'arc' && p.center && p.radius) {
      const rels = circleSplitAngles[i].sort((a, b) => a - b);
      for (let k = 0; k < rels.length - 1; k++) {
        const r0 = rels[k];
        const r1 = rels[k + 1];
        if (r1 - r0 < 1e-3) continue;
        const a0 = normAngle(p.startAngle! + r0);
        const a1 = normAngle(p.startAngle! + r1);
        const q1 = registerAnchor({
          u: p.center.u + p.radius * Math.cos(a0),
          v: p.center.v + p.radius * Math.sin(a0),
        });
        const q2 = registerAnchor({
          u: p.center.u + p.radius * Math.cos(a1),
          v: p.center.v + p.radius * Math.sin(a1),
        });
        rawSplitSegs.push({
          id: `sp-${view}-arc-${segCounter++}`,
          sourceEntityId: p.sourceEntityId,
          view,
          lineType: p.lineType,
          kind: 'arc',
          p1: q1,
          p2: q2,
          center: { ...p.center },
          radius: p.radius,
          startAngle: a0,
          endAngle: a1,
          bbox: computeArcBBox(p.center, p.radius, a0, a1),
        });
      }
    }
  }

  // Deduplicate identical segments (solid beats dashed)
  const deduped: SplitCurveSegment2D[] = [];
  for (const seg of rawSplitSegs) {
    const matchIdx = deduped.findIndex((existing) => {
      if (existing.kind !== seg.kind) return false;
      if (seg.kind === 'line') {
        const sameDir = dist2(existing.p1, seg.p1) <= 0.6 && dist2(existing.p2, seg.p2) <= 0.6;
        const oppDir = dist2(existing.p1, seg.p2) <= 0.6 && dist2(existing.p2, seg.p1) <= 0.6;
        return sameDir || oppDir;
      }
      // arc
      if (!existing.center || !seg.center || !existing.radius || !seg.radius) return false;
      if (dist2(existing.center, seg.center) > 0.9 || Math.abs(existing.radius - seg.radius) > 0.9) return false;
      const midExisting = normAngle(
        existing.startAngle! + 0.5 * arcSweepCCW(existing.startAngle!, existing.endAngle!)
      );
      const midSeg = normAngle(seg.startAngle! + 0.5 * arcSweepCCW(seg.startAngle!, seg.endAngle!));
      const dMid = Math.min(
        Math.abs(midExisting - midSeg),
        TWO_PI - Math.abs(midExisting - midSeg)
      );
      return (
        dMid <= 0.05 &&
        dist2(existing.p1, seg.p1) <= 0.8 &&
        dist2(existing.p2, seg.p2) <= 0.8
      );
    });

    if (matchIdx === -1) {
      deduped.push(seg);
    } else if (seg.lineType === 'thick_solid' && deduped[matchIdx].lineType !== 'thick_solid') {
      deduped[matchIdx] = seg;
    }
  }

  return deduped;
}
