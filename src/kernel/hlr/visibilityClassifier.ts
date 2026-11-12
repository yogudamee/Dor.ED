import { Point2D, Primitive3D, ViewType } from '../../types/cad';
import {
  intersectCircleCircleExact,
  intersectLineCircleExact,
  intersectLineLineExact,
} from '../arrangement2d/preprocessAndSplit';
import {
  add3,
  arcSweepCCW,
  computeEyeDistance,
  dist2,
  dot3,
  getViewAxisSpec,
  isAngleInSweep,
  makeViewingRay,
  normAngle,
  projectPoint3DToView,
  scale3,
  TWO_PI,
} from '../core/coordSystem';
import {
  ClassifiedSegment2D,
  ExtractedEdges3D,
  Vec3,
} from '../core/types';
import { evalCSGSolidSDF } from '../lifting3d/analyticSurfaces';
import { hasSolidIn26Neighborhood } from './edgeExtractor3D';

interface ProjectedCandidateCurve {
  kind: 'line' | 'arc';
  p1_2d: Point2D;
  p2_2d: Point2D;
  p1_3d: Vec3;
  p2_3d: Vec3;
  // For exact 3D circle/arc perpendicular to rayDir:
  center2d?: Point2D;
  center3d?: Vec3;
  radius?: number;
  startAngle?: number;
  endAngle?: number;
  uAxis3d?: Vec3;
  vAxis3d?: Vec3;
  ccwIn2d?: boolean;
  forceHidden?: boolean;
  isKnifeEdgeProtected?: boolean;
  featureId?: string;
  featureLabel?: string;
}

function evalCurve3DAtParam(c: ProjectedCandidateCurve, t: number): Vec3 {
  if (
    c.kind === 'arc' &&
    c.center3d &&
    c.radius !== undefined &&
    c.startAngle !== undefined &&
    c.endAngle !== undefined &&
    c.uAxis3d &&
    c.vAxis3d
  ) {
    const sweep = arcSweepCCW(c.startAngle, c.endAngle);
    const ang = c.ccwIn2d !== false
      ? c.startAngle + t * sweep
      : c.endAngle - t * sweep;
    // Wait: startAngle & endAngle on ProjectedCandidateCurve are ALREADY converted to 2D (u, v) +dθ angles!
    const q2 = {
      u: c.center2d!.u + c.radius * Math.cos(c.startAngle + t * sweep),
      v: c.center2d!.v + c.radius * Math.sin(c.startAngle + t * sweep),
    };
    void ang;
    // Reconstruct exact 3D point on the plane parallel to view (`w = center3d.w`)
    if (c.uAxis3d.x === 0 && c.uAxis3d.y === 0 && c.uAxis3d.z === 0) {
      return c.center3d;
    }
    return {
      x: c.uAxis3d.x !== 0 ? q2.u : c.vAxis3d.x !== 0 ? q2.v : c.center3d.x,
      y: c.uAxis3d.y !== 0 ? q2.u : c.vAxis3d.y !== 0 ? q2.v : c.center3d.y,
      z: c.uAxis3d.z !== 0 ? q2.u : c.vAxis3d.z !== 0 ? q2.v : c.center3d.z,
    };
  }
  return {
    x: c.p1_3d.x + (c.p2_3d.x - c.p1_3d.x) * t,
    y: c.p1_3d.y + (c.p2_3d.y - c.p1_3d.y) * t,
    z: c.p1_3d.z + (c.p2_3d.z - c.p1_3d.z) * t,
  };
}

function evalCurve2DAtParam(c: ProjectedCandidateCurve, t: number): Point2D {
  if (
    c.kind === 'arc' &&
    c.center2d &&
    c.radius !== undefined &&
    c.startAngle !== undefined &&
    c.endAngle !== undefined
  ) {
    const sweep = arcSweepCCW(c.startAngle, c.endAngle);
    const ang = c.startAngle + t * sweep;
    return {
      u: c.center2d.u + c.radius * Math.cos(ang),
      v: c.center2d.v + c.radius * Math.sin(ang),
    };
  }
  return {
    u: c.p1_2d.u + (c.p2_2d.u - c.p1_2d.u) * t,
    v: c.p1_2d.v + (c.p2_2d.v - c.p1_2d.v) * t,
  };
}

/**
 * Evaluate exact physical visibility of a 3D point `p3` in `view` against the composite CSG solid:
 * - `'culled'`: `p3` is NOT on the true boundary of the CSG boolean solid (either buried inside a unioned solid `SDF < -0.11`,
 *               or floating in empty air / carved away by a subtract void `SDF > 0.11`), OR lies on an internal coplanar
 *               face whose local surface normal has no depth jump!
 * - `'hidden'`: `p3` is on the true CSG boundary, AND either `forceHidden` is set (internal bore silhouette) OR the viewing ray
 *               from the observer eye hits foreground solid material (`SDF < -0.035`) strictly in front of `p3`!
 * - `'visible'`: `p3` is on the true CSG boundary AND the viewing ray from the eye to `p3` is 100% unobstructed!
 */
export function classifyPoint3DVisibility(
  p3: Vec3,
  view: ViewType,
  primitives: Primitive3D[],
  forceHidden = false,
  isKnifeEdgeProtected = false
): 'visible' | 'hidden' | 'culled' {
  const sdfAtP = evalCSGSolidSDF(p3, primitives);

  if (Math.abs(sdfAtP) > 0.12) {
    return 'culled';
  }

  // Knife-edge & zero-thickness protection: verify solid actually exists in 26-neighborhood!
  if (!isKnifeEdgeProtected && !hasSolidIn26Neighborhood(p3, primitives, 0.16)) {
    return 'culled';
  }

  if (forceHidden) {
    return 'hidden';
  }

  const p2 = projectPoint3DToView(p3, view);
  const { origin, dir } = makeViewingRay(view, p2.u, p2.v);
  const targetS = computeEyeDistance(p3, view);

  // Compute global entry sMin along ray to avoid marching through empty space outside [0, 120]^3
  let minPossibleS = Math.max(0, targetS - 115);
  const maxCheckS = targetS - 0.24;
  if (maxCheckS <= minPossibleS) return 'visible';

  // Adaptive ray-depth marching (step = 0.85mm, plus fine check near surface!)
  const step = 0.85;
  for (let s = minPossibleS; s <= maxCheckS; s += step) {
    const q = {
      x: origin.x + dir.x * s,
      y: origin.y + dir.y * s,
      z: origin.z + dir.z * s,
    };
    const d = evalCSGSolidSDF(q, primitives);
    if (d < -0.035) {
      return 'hidden';
    }
    // Safe sphere-tracing acceleration when far from solid!
    if (d > 1.2) {
      s += d - 0.8;
    }
  }

  // Also check right in front of p3 (`targetS - 0.35`)
  const qNear = {
    x: origin.x + dir.x * (targetS - 0.32),
    y: origin.y + dir.y * (targetS - 0.32),
    z: origin.z + dir.z * (targetS - 0.32),
  };
  if (evalCSGSolidSDF(qNear, primitives) < -0.035) {
    return 'hidden';
  }

  return 'visible';
}

/**
 * Project all 3D edges/arcs/SSI chains into `view`, split at all 2D apparent intersections and
 * visibility jump points (6-step binary refinement), and classify every interval into
 * `thick_solid` (`visible`), `thin_dashed` (`hidden`), or `culled`!
 */
export function classifyEdgesForViewHLR(
  extracted: ExtractedEdges3D,
  primitives: Primitive3D[],
  view: ViewType
): ClassifiedSegment2D[] {
  const { rayDir, uAxis, vAxis } = getViewAxisSpec(view);
  const projCurves: ProjectedCandidateCurve[] = [];

  const unitAxisVec = (ax: 'X' | 'Y' | 'Z'): Vec3 =>
    ax === 'X'
      ? { x: 1, y: 0, z: 0 }
      : ax === 'Y'
      ? { x: 0, y: 1, z: 0 }
      : { x: 0, y: 0, z: 1 };

  const viewUVec = unitAxisVec(uAxis);
  const viewVVec = unitAxisVec(vAxis);

  // 1. Project 3D straight segments
  for (const seg of extracted.segments) {
    const q1 = projectPoint3DToView(seg.p1, view);
    const q2 = projectPoint3DToView(seg.p2, view);
    if (dist2(q1, q2) < 0.05) continue; // Degenerate end-on line
    projCurves.push({
      kind: 'line',
      p1_2d: q1,
      p2_2d: q2,
      p1_3d: seg.p1,
      p2_3d: seg.p2,
      forceHidden: seg.forceHidden,
      isKnifeEdgeProtected: seg.isKnifeEdgeProtected,
      featureId: seg.featureId,
      featureLabel: seg.featureLabel,
    });
  }

  // 2. Project 3D analytic circles & arcs
  for (const arc of extracted.arcs) {
    const align = Math.abs(dot3(arc.normal, rayDir));
    if (align > 0.998) {
      // Face-on circle/arc! Projects as a true 2D circle / circular arc in (u, v)!
      const c2 = projectPoint3DToView(arc.center, view);
      if (arc.isFullCircle) {
        // Split full circle at 0 and π so intersection splitting works uniformly
        const pR = { u: c2.u + arc.radius, v: c2.v };
        const pL = { u: c2.u - arc.radius, v: c2.v };
        const pR3 = add3(arc.center, scale3(viewUVec, arc.radius));
        const pL3 = add3(arc.center, scale3(viewUVec, -arc.radius));
        projCurves.push(
          {
            kind: 'arc',
            p1_2d: pR,
            p2_2d: pL,
            p1_3d: pR3,
            p2_3d: pL3,
            center2d: c2,
            center3d: arc.center,
            radius: arc.radius,
            startAngle: 0,
            endAngle: Math.PI,
            uAxis3d: viewUVec,
            vAxis3d: viewVVec,
            ccwIn2d: true,
            forceHidden: arc.forceHidden,
            isKnifeEdgeProtected: arc.isKnifeEdgeProtected,
            featureId: arc.featureId,
            featureLabel: arc.featureLabel,
          },
          {
            kind: 'arc',
            p1_2d: pL,
            p2_2d: pR,
            p1_3d: pL3,
            p2_3d: pR3,
            center2d: c2,
            center3d: arc.center,
            radius: arc.radius,
            startAngle: Math.PI,
            endAngle: 0,
            uAxis3d: viewUVec,
            vAxis3d: viewVVec,
            ccwIn2d: true,
            forceHidden: arc.forceHidden,
            isKnifeEdgeProtected: arc.isKnifeEdgeProtected,
            featureId: arc.featureId,
            featureLabel: arc.featureLabel,
          }
        );
      } else {
        // Map arc startAngle & endAngle to 2D (u, v) +dθ!
        const pStart3 = add3(
          arc.center,
          add3(
            scale3(arc.uAxis, arc.radius * Math.cos(arc.startAngle)),
            scale3(arc.vAxis, arc.radius * Math.sin(arc.startAngle))
          )
        );
        const midAng3 =
          arc.startAngle + 0.5 * arcSweepCCW(arc.startAngle, arc.endAngle);
        const pMid3 = add3(
          arc.center,
          add3(
            scale3(arc.uAxis, arc.radius * Math.cos(midAng3)),
            scale3(arc.vAxis, arc.radius * Math.sin(midAng3))
          )
        );
        const pEnd3 = add3(
          arc.center,
          add3(
            scale3(arc.uAxis, arc.radius * Math.cos(arc.endAngle)),
            scale3(arc.vAxis, arc.radius * Math.sin(arc.endAngle))
          )
        );

        const qS = projectPoint3DToView(pStart3, view);
        const qM = projectPoint3DToView(pMid3, view);
        const qE = projectPoint3DToView(pEnd3, view);
        const aS = normAngle(Math.atan2(qS.v - c2.v, qS.u - c2.u));
        const aM = normAngle(Math.atan2(qM.v - c2.v, qM.u - c2.u));
        const aE = normAngle(Math.atan2(qE.v - c2.v, qE.u - c2.u));

        const goesCCW = isAngleInSweep(aM, aS, aE, 1e-3);
        const finalStart = goesCCW ? aS : aE;
        const finalEnd = goesCCW ? aE : aS;

        projCurves.push({
          kind: 'arc',
          p1_2d: goesCCW ? qS : qE,
          p2_2d: goesCCW ? qE : qS,
          p1_3d: goesCCW ? pStart3 : pEnd3,
          p2_3d: goesCCW ? pEnd3 : pStart3,
          center2d: c2,
          center3d: arc.center,
          radius: arc.radius,
          startAngle: finalStart,
          endAngle: finalEnd,
          uAxis3d: viewUVec,
          vAxis3d: viewVVec,
          ccwIn2d: true,
          forceHidden: arc.forceHidden,
          isKnifeEdgeProtected: arc.isKnifeEdgeProtected,
          featureId: arc.featureId,
          featureLabel: arc.featureLabel,
        });
      }
    } else if (align < 0.01) {
      // Edge-on circle/arc! Projects as a straight line segment (e.g. annular shoulder step or cylinder end-cap)!
      // Sample front-facing half vs back-facing half, OR sample at 24 segments?
      // WAIT: Think carefully! For an edge-on circle (like a cylinder cap or annular shoulder at `Z = z0`),
      // the FRONT half of the circle (facing the observer!) is closer to the eye than the BACK half!
      // If we just drew one single chord through the center, its 3D depth would be `center` (inside the upper cylinder!) instead of the front rim (`center + R * (-rayDir)`)!
      // Sampling the FRONT rim (`-rayDir` side, 16 segments — or exact front chord shifted to the front-facing semicircular rim!) ensures the ray-depth check tests the ACTUAL closest point of the circle at each `(u, v)`!
      const N_EDGE = arc.isFullCircle ? 24 : 16;
      const sweep = arc.isFullCircle
        ? TWO_PI
        : arcSweepCCW(arc.startAngle, arc.endAngle);
      const s0 = arc.isFullCircle ? 0 : arc.startAngle;
      for (let k = 0; k < N_EDGE; k++) {
        const a1 = s0 + (k / N_EDGE) * sweep;
        const a2 = s0 + ((k + 1) / N_EDGE) * sweep;
        const pt1 = add3(
          arc.center,
          add3(
            scale3(arc.uAxis, arc.radius * Math.cos(a1)),
            scale3(arc.vAxis, arc.radius * Math.sin(a1))
          )
        );
        const pt2 = add3(
          arc.center,
          add3(
            scale3(arc.uAxis, arc.radius * Math.cos(a2)),
            scale3(arc.vAxis, arc.radius * Math.sin(a2))
          )
        );
        const q1 = projectPoint3DToView(pt1, view);
        const q2 = projectPoint3DToView(pt2, view);
        if (dist2(q1, q2) > 0.04) {
          projCurves.push({
            kind: 'line',
            p1_2d: q1,
            p2_2d: q2,
            p1_3d: pt1,
            p2_3d: pt2,
            forceHidden: arc.forceHidden,
            isKnifeEdgeProtected: arc.isKnifeEdgeProtected,
            featureId: arc.featureId,
            featureLabel: arc.featureLabel,
          });
        }
      }
    } else {
      // Oblique circle/arc -> dense 36-segment polyline
      const N_OBL = 36;
      const sweep = arc.isFullCircle
        ? TWO_PI
        : arcSweepCCW(arc.startAngle, arc.endAngle);
      const s0 = arc.isFullCircle ? 0 : arc.startAngle;
      for (let k = 0; k < N_OBL; k++) {
        const a1 = s0 + (k / N_OBL) * sweep;
        const a2 = s0 + ((k + 1) / N_OBL) * sweep;
        const pt1 = add3(
          arc.center,
          add3(
            scale3(arc.uAxis, arc.radius * Math.cos(a1)),
            scale3(arc.vAxis, arc.radius * Math.sin(a1))
          )
        );
        const pt2 = add3(
          arc.center,
          add3(
            scale3(arc.uAxis, arc.radius * Math.cos(a2)),
            scale3(arc.vAxis, arc.radius * Math.sin(a2))
          )
        );
        const q1 = projectPoint3DToView(pt1, view);
        const q2 = projectPoint3DToView(pt2, view);
        if (dist2(q1, q2) > 0.04) {
          projCurves.push({
            kind: 'line',
            p1_2d: q1,
            p2_2d: q2,
            p1_3d: pt1,
            p2_3d: pt2,
            forceHidden: arc.forceHidden,
            isKnifeEdgeProtected: arc.isKnifeEdgeProtected,
            featureId: arc.featureId,
            featureLabel: arc.featureLabel,
          });
        }
      }
    }
  }

  // 3. Project 3D SSI intersection chains
  for (const chain of extracted.ssiChains) {
    for (let k = 0; k < chain.points.length - 1; k++) {
      const p1 = chain.points[k];
      const p2 = chain.points[k + 1];
      const q1 = projectPoint3DToView(p1, view);
      const q2 = projectPoint3DToView(p2, view);
      if (dist2(q1, q2) > 0.04) {
        projCurves.push({
          kind: 'line',
          p1_2d: q1,
          p2_2d: q2,
          p1_3d: p1,
          p2_3d: p2,
          forceHidden: chain.forceHidden,
          featureId: chain.featureId,
          featureLabel: chain.featureLabel,
        });
      }
    }
  }

  // 4. Split all projected 2D curves at ALL apparent 2D intersections!
  const splitParams: number[][] = projCurves.map(() => [0, 1]);
  const addParam = (idx: number, t: number) => {
    if (t <= 1e-3 || t >= 1 - 1e-3) return;
    const arr = splitParams[idx];
    if (!arr.some((x) => Math.abs(x - t) < 2e-3)) arr.push(t);
  };

  const pointToCurveParam = (c: ProjectedCandidateCurve, pt: Point2D): number | null => {
    if (c.kind === 'line') {
      const du = c.p2_2d.u - c.p1_2d.u;
      const dv = c.p2_2d.v - c.p1_2d.v;
      const lenSq = du * du + dv * dv;
      if (lenSq < 1e-8) return null;
      return ((pt.u - c.p1_2d.u) * du + (pt.v - c.p1_2d.v) * dv) / lenSq;
    }
    if (
      c.center2d &&
      c.radius !== undefined &&
      c.startAngle !== undefined &&
      c.endAngle !== undefined
    ) {
      const ang = normAngle(Math.atan2(pt.v - c.center2d.v, pt.u - c.center2d.u));
      const sweep = arcSweepCCW(c.startAngle, c.endAngle);
      const rel = normAngle(ang - c.startAngle);
      if (rel <= sweep + 1e-3) return rel / sweep;
    }
    return null;
  };

  for (let i = 0; i < projCurves.length; i++) {
    const ci = projCurves[i];
    for (let j = i + 1; j < projCurves.length; j++) {
      const cj = projCurves[j];
      let hits: Point2D[] = [];
      if (ci.kind === 'line' && cj.kind === 'line') {
        hits = intersectLineLineExact(ci.p1_2d, ci.p2_2d, cj.p1_2d, cj.p2_2d, 1e-4);
      } else if (ci.kind === 'line' && cj.kind === 'arc') {
        hits = intersectLineCircleExact(
          ci.p1_2d,
          ci.p2_2d,
          cj.center2d!,
          cj.radius!,
          1e-4
        );
      } else if (ci.kind === 'arc' && cj.kind === 'line') {
        hits = intersectLineCircleExact(
          cj.p1_2d,
          cj.p2_2d,
          ci.center2d!,
          ci.radius!,
          1e-4
        );
      } else if (ci.kind === 'arc' && cj.kind === 'arc') {
        hits = intersectCircleCircleExact(
          ci.center2d!,
          ci.radius!,
          cj.center2d!,
          cj.radius!
        );
      }

      for (const h of hits) {
        const ti = pointToCurveParam(ci, h);
        const tj = pointToCurveParam(cj, h);
        if (
          ti !== null &&
          ti >= -0.002 &&
          ti <= 1.002 &&
          tj !== null &&
          tj >= -0.002 &&
          tj <= 1.002
        ) {
          if (ti > 0.002 && ti < 0.998) addParam(i, ti);
          if (tj > 0.002 && tj < 0.998) addParam(j, tj);
        }
      }
    }
  }

  // 5. Classify each atomic interval with multi-point adaptive bisection when visibility jumps!
  const results: ClassifiedSegment2D[] = [];

  const classifySubInterval = (
    c: ProjectedCandidateCurve,
    t0: number,
    t1: number,
    depth: number
  ) => {
    const span2d =
      c.kind === 'arc' && c.radius
        ? (t1 - t0) * arcSweepCCW(c.startAngle!, c.endAngle!) * c.radius
        : (t1 - t0) * dist2(c.p1_2d, c.p2_2d);
    if (span2d < 0.08) return;

    const tA = t0 + (t1 - t0) * 0.2;
    const tM = t0 + (t1 - t0) * 0.5;
    const tB = t0 + (t1 - t0) * 0.8;

    const vA = classifyPoint3DVisibility(
      evalCurve3DAtParam(c, tA),
      view,
      primitives,
      c.forceHidden,
      c.isKnifeEdgeProtected
    );
    const vM = classifyPoint3DVisibility(
      evalCurve3DAtParam(c, tM),
      view,
      primitives,
      c.forceHidden,
      c.isKnifeEdgeProtected
    );
    const vB = classifyPoint3DVisibility(
      evalCurve3DAtParam(c, tB),
      view,
      primitives,
      c.forceHidden,
      c.isKnifeEdgeProtected
    );

    if ((vA !== vM || vM !== vB) && depth < 6 && span2d > 0.25) {
      const tHalf = 0.5 * (t0 + t1);
      classifySubInterval(c, t0, tHalf, depth + 1);
      classifySubInterval(c, tHalf, t1, depth + 1);
      return;
    }

    // Majority / midpoint decision
    const vis = vA === vB ? vA : vM;
    if (vis === 'culled') return;

    const q1 = evalCurve2DAtParam(c, t0);
    const q2 = evalCurve2DAtParam(c, t1);
    const lt = vis === 'visible' ? 'thick_solid' : 'thin_dashed';

    if (
      c.kind === 'arc' &&
      c.center2d &&
      c.radius !== undefined &&
      c.startAngle !== undefined &&
      c.endAngle !== undefined
    ) {
      const sw = arcSweepCCW(c.startAngle, c.endAngle);
      const sA = normAngle(c.startAngle + t0 * sw);
      const eA = normAngle(c.startAngle + t1 * sw);
      results.push({
        kind: 'arc',
        p1: q1,
        p2: q2,
        center: c.center2d,
        radius: c.radius,
        startAngle: sA,
        endAngle: eA,
        visibility: vis,
        lineType: lt,
        featureId: c.featureId,
        featureLabel: c.featureLabel,
      });
    } else {
      results.push({
        kind: 'line',
        p1: q1,
        p2: q2,
        visibility: vis,
        lineType: lt,
        featureId: c.featureId,
        featureLabel: c.featureLabel,
      });
    }
  };

  for (let i = 0; i < projCurves.length; i++) {
    const c = projCurves[i];
    const ts = splitParams[i].sort((a, b) => a - b);
    for (let k = 0; k < ts.length - 1; k++) {
      classifySubInterval(c, ts[k], ts[k + 1], 0);
    }
  }

  return results;
}
