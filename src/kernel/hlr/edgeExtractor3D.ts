import { GeneralizedLoftPayload, Point2D, Primitive3D, ViewType } from '../../types/cad';
import {
  add3,
  arcSweepCCW,
  composeFromAxis,
  cross3,
  dist3,
  getViewAxisSpec,
  normalize3,
  scale3,
  sub3,
  TWO_PI,
} from '../core/coordSystem';
import {
  AnalyticArc3D,
  Axis3D,
  BooleanOp,
  ExtractedEdges3D,
  Seg3D,
  Vec3,
} from '../core/types';
import {
  evalCSGSolidSDF,
  evalPositiveBaseOnlySDF,
  evalPrimitive3DSDF,
  evaluateLoftGeneratorLine3D,
  getPrimitiveLoftEquivalent,
  solveLoftSilhouetteAngles,
} from '../lifting3d/analyticSurfaces';
import { traceAllSSICurves3D } from '../ssi/ssiTracer';

function getAxisBasis3D(axis: Axis3D): { uVec: Vec3; vVec: Vec3; nVec: Vec3 } {
  if (axis === 'Z') {
    return {
      uVec: { x: 1, y: 0, z: 0 },
      vVec: { x: 0, y: 1, z: 0 },
      nVec: { x: 0, y: 0, z: 1 },
    };
  }
  if (axis === 'Y') {
    return {
      uVec: { x: 1, y: 0, z: 0 },
      vVec: { x: 0, y: 0, z: 1 },
      nVec: { x: 0, y: 1, z: 0 },
    };
  }
  return {
    uVec: { x: 0, y: 1, z: 0 },
    vVec: { x: 0, y: 0, z: 1 },
    nVec: { x: 1, y: 0, z: 0 },
  };
}

/**
 * Check 26-neighborhood solid presence around `p` so knife-edge rims (`r_hole ≈ R_min`)
 * where a hole meets a frustum top circle are protected as real solid features!
 */
export function hasSolidIn26Neighborhood(
  p: Vec3,
  primitives: Primitive3D[],
  delta = 0.18
): boolean {
  if (evalCSGSolidSDF(p, primitives) < -0.005) return true;
  for (const dx of [-delta, 0, delta]) {
    for (const dy of [-delta, 0, delta]) {
      for (const dz of [-delta, 0, delta]) {
        if (dx === 0 && dy === 0 && dz === 0) continue;
        if (
          evalCSGSolidSDF(
            { x: p.x + dx, y: p.y + dy, z: p.z + dz },
            primitives
          ) < -0.015
        ) {
          return true;
        }
      }
    }
  }
  return false;
}

/**
 * Clip a 3D straight segment `[p0, p1]` (such as a cone extreme generator or void bore generator)
 * so that:
 * - Positive solid generators pierced by cross-holes or lateral slots ONLY lose the hollow void interval,
 *   retaining both solid end segments intact!
 * - Subtract void bore generators are clipped strictly to the interior of the positive solid base
 *   (`SDF_posBase < -0.05`) and outside other voids, locked as `forceHidden = true`!
 */
function clipGeneratorSegmentToActiveIntervals(
  p0: Vec3,
  p1: Vec3,
  prim: Primitive3D,
  allPrimitives: Primitive3D[],
  isKnifeEdge = false,
  allowExteriorBreach = false
): Seg3D[] {
  const totalLen = dist3(p0, p1);
  if (totalLen < 0.1) return [];

  const subtracts = allPrimitives.filter((pr) => pr.operation === 'subtract');
  const positives = allPrimitives.filter((pr) => pr.operation !== 'subtract');

  const isPointActive = (t: number): boolean => {
    const pt = {
      x: p0.x + (p1.x - p0.x) * t,
      y: p0.y + (p1.y - p0.y) * t,
      z: p0.z + (p1.z - p0.z) * t,
    };
    if (prim.operation === 'subtract') {
      const baseD = evalPositiveBaseOnlySDF(pt, allPrimitives);
      if (allowExteriorBreach && Math.abs(baseD) <= 0.08) {
        if (!hasSolidIn26Neighborhood(pt, allPrimitives, 0.18)) return false;
      } else if (baseD > (isKnifeEdge ? -0.005 : -0.05)) {
        return false;
      }
      // And not swallowed inside another larger void channel!
      for (const ov of subtracts) {
        if (ov.id === prim.id) continue;
        if (evalPrimitive3DSDF(pt, ov) < -0.04) return false;
      }
      return true;
    } else {
      // Positive solid generator: must not be buried inside another positive solid AND must not be carved out by any subtract void!
      for (const op of positives) {
        if (op.id === prim.id) continue;
        if (op.weldGroup && op.weldGroup === prim.weldGroup) continue;
        if (evalPrimitive3DSDF(pt, op) < -0.05) return false;
      }
      for (const vp of subtracts) {
        if (evalPrimitive3DSDF(pt, vp) < -0.03) return false;
      }
      return true;
    }
  };

  const N = Math.max(24, Math.ceil(totalLen / 1.0));
  const out: Seg3D[] = [];
  let inInterval = false;
  let tStart = 0;

  const refineTransition = (tA: number, tB: number, targetActive: boolean): number => {
    let lo = tA;
    let hi = tB;
    for (let k = 0; k < 6; k++) {
      const mid = 0.5 * (lo + hi);
      if (isPointActive(mid) === targetActive) hi = mid;
      else lo = mid;
    }
    return 0.5 * (lo + hi);
  };

  for (let i = 0; i <= N; i++) {
    const t = i / N;
    const active = isPointActive(t);
    if (active && !inInterval) {
      tStart = i === 0 ? 0 : refineTransition((i - 1) / N, t, true);
      inInterval = true;
    } else if (!active && inInterval) {
      const tEnd = refineTransition((i - 1) / N, t, false);
      if ((tEnd - tStart) * totalLen > 0.25) {
        out.push(
          makeSubSeg(
            p0,
            p1,
            tStart,
            tEnd,
            prim,
            allPrimitives,
            isKnifeEdge,
            allowExteriorBreach
          )
        );
      }
      inInterval = false;
    }
  }
  if (inInterval && (1 - tStart) * totalLen > 0.25) {
    out.push(
      makeSubSeg(
        p0,
        p1,
        tStart,
        1,
        prim,
        allPrimitives,
        isKnifeEdge,
        allowExteriorBreach
      )
    );
  }

  return out;
}

function makeSubSeg(
  p0: Vec3,
  p1: Vec3,
  t0: number,
  t1: number,
  prim: Primitive3D,
  allPrimitives: Primitive3D[],
  isKnifeEdge: boolean,
  allowExteriorBreach = false
): Seg3D {
  const tMid = 0.5 * (t0 + t1);
  const midPt = {
    x: p0.x + (p1.x - p0.x) * tMid,
    y: p0.y + (p1.y - p0.y) * tMid,
    z: p0.z + (p1.z - p0.z) * tMid,
  };
  const onExteriorFace =
    allowExteriorBreach &&
    prim.operation === 'subtract' &&
    Math.abs(evalPositiveBaseOnlySDF(midPt, allPrimitives)) <= 0.08;

  return {
    p1: {
      x: p0.x + (p1.x - p0.x) * t0,
      y: p0.y + (p1.y - p0.y) * t0,
      z: p0.z + (p1.z - p0.z) * t0,
    },
    p2: {
      x: p0.x + (p1.x - p0.x) * t1,
      y: p0.y + (p1.y - p0.y) * t1,
      z: p0.z + (p1.z - p0.z) * t1,
    },
    ownerOp: prim.operation as BooleanOp,
    ownerId: prim.id,
    featureId: prim.featureId,
    featureLabel: prim.label,
    forceHidden: prim.operation === 'subtract' && !onExteriorFace,
    isKnifeEdgeProtected: isKnifeEdge,
    isSilhouette: true,
  };
}

/**
 * Extract all 3D sharp crease edges, annular step shoulder full contours, exact view-dependent
 * extreme silhouette generators, and 3D SSI intersection curves for a composite CSG solid!
 */
export function extractAll3DEdgesForView(
  primitives: Primitive3D[],
  view: ViewType,
  precomputedSSI?: ReturnType<typeof traceAllSSICurves3D>
): ExtractedEdges3D {
  const segments: Seg3D[] = [];
  const arcs: AnalyticArc3D[] = [];
  const ssiChains = precomputedSSI ?? traceAllSSICurves3D(primitives);
  const { rayDir } = getViewAxisSpec(view);

  const subtracts = primitives.filter((p) => p.operation === 'subtract');

  for (const prim of primitives) {
    const op = prim.operation as BooleanOp;

    // 1. Sphere & Hemisphere
    if (prim.shape === 'sphere' || prim.shape === 'hemisphere') {
      const cx = prim.centerX ?? 0.5 * (prim.xMin + prim.xMax);
      const cy = prim.centerY ?? 0.5 * (prim.yMin + prim.yMax);
      const cz = prim.centerZ ?? 0.5 * (prim.zMin + prim.zMax);
      const R =
        prim.radius ??
        0.5 *
          Math.max(
            prim.xMax - prim.xMin,
            prim.yMax - prim.yMin,
            prim.zMax - prim.zMin
          );
      const center = { x: cx, y: cy, z: cz };

      // Great-circle limb perpendicular to rayDir!
      const nVec = normalize3(rayDir);
      const ref =
        Math.abs(nVec.z) < 0.9 ? { x: 0, y: 0, z: 1 } : { x: 1, y: 0, z: 0 };
      const uVec = normalize3(cross3(ref, nVec));
      const vVec = normalize3(cross3(nVec, uVec));

      if (prim.shape === 'sphere') {
        arcs.push({
          center,
          radius: R,
          uAxis: uVec,
          vAxis: vVec,
          normal: nVec,
          startAngle: 0,
          endAngle: TWO_PI,
          isFullCircle: true,
          ownerOp: op,
          ownerId: prim.id,
          featureId: prim.featureId,
          featureLabel: prim.label,
        });
      } else {
        const hs = prim.hemisphereSpec ?? {
          flatAxis: 'Z' as const,
          flatCoord: prim.zMin,
          keepPositiveSide: true,
        };
        // (a) Flat circular cap at `hs.flatCoord` along `hs.flatAxis`!
        const capBasis = getAxisBasis3D(hs.flatAxis);
        const capCenter = { ...center };
        if (hs.flatAxis === 'X') capCenter.x = hs.flatCoord;
        else if (hs.flatAxis === 'Y') capCenter.y = hs.flatCoord;
        else capCenter.z = hs.flatCoord;
        arcs.push({
          center: capCenter,
          radius: R,
          uAxis: capBasis.uVec,
          vAxis: capBasis.vVec,
          normal: capBasis.nVec,
          startAngle: 0,
          endAngle: TWO_PI,
          isFullCircle: true,
          ownerOp: op,
          ownerId: prim.id,
          featureId: prim.featureId,
          featureLabel: prim.label,
          isAnnularShoulder: true,
        });

        // (b) Great-circle limb clipped to hemisphere half-space!
        // Sample 72 points or exact semicircle if limb plane is perpendicular to flat plane!
        const N_LIMB = 72;
        let prevPt: Vec3 | null = null;
        for (let k = 0; k <= N_LIMB; k++) {
          const ang = (k / N_LIMB) * TWO_PI;
          const pt = add3(
            center,
            add3(
              scale3(uVec, R * Math.cos(ang)),
              scale3(vVec, R * Math.sin(ang))
            )
          );
          const coord =
            hs.flatAxis === 'X' ? pt.x : hs.flatAxis === 'Y' ? pt.y : pt.z;
          const ok = hs.keepPositiveSide
            ? coord >= hs.flatCoord - 1e-3
            : coord <= hs.flatCoord + 1e-3;
          if (ok) {
            if (prevPt) {
              segments.push({
                p1: prevPt,
                p2: pt,
                ownerOp: op,
                ownerId: prim.id,
                featureId: prim.featureId,
                featureLabel: prim.label,
                isSilhouette: true,
              });
            }
            prevPt = pt;
          } else {
            prevPt = null;
          }
        }
      }
      continue;
    }

    // 2. GeneralizedLoft / Cylinders / Cones / Frustums / Semi-Cones / Polygonal Pyramids
    const loft = getPrimitiveLoftEquivalent(prim);
    if (loft) {
      extractLoftEdgesAndSilhouettes(
        prim,
        loft,
        view,
        primitives,
        subtracts,
        segments,
        arcs
      );
      continue;
    }

    // 3. Prisms (Regular Hexagons, Arches, Semicircular Cylinders, General Polygons)
    if (prim.shape === 'prism' || prim.shape === 'rib_xz') {
      extractPrismEdges3D(prim, view, primitives, segments, arcs);
      continue;
    }

    // 4. Wedges (`wedge_x`, `wedge_y`) & Rectangular Pyramids (`pyramid`)
    if (prim.shape === 'wedge_y' || prim.shape === 'wedge_x') {
      extractWedgeEdges3D(prim, segments);
      continue;
    }
    if (prim.shape === 'pyramid') {
      extractRectPyramidEdges3D(prim, segments);
      continue;
    }

    // 5. Orthogonal Box (`box`)
    extractBoxEdges3D(prim, primitives, segments);
  }

  return { segments, arcs, ssiChains };
}

function extractLoftEdgesAndSilhouettes(
  prim: Primitive3D,
  loft: GeneralizedLoftPayload,
  view: ViewType,
  allPrimitives: Primitive3D[],
  subtracts: Primitive3D[],
  segments: Seg3D[],
  arcs: AnalyticArc3D[]
): void {
  const op = prim.operation as BooleanOp;
  const basis = getAxisBasis3D(loft.axis);
  const s0 = loft.section0;
  const s1 = loft.section1;

  // Detect Knife-Edge condition (`r_hole ≈ R_min` within 0.25mm!)
  let isKnifeEdge = false;
  if (op === 'subtract') {
    const rHole = Math.max(s0.radiusU ?? 0, s1.radiusU ?? 0);
    for (const pos of allPrimitives) {
      if (pos.operation === 'subtract') continue;
      const pLoft = getPrimitiveLoftEquivalent(pos);
      if (pLoft && pLoft.axis === loft.axis) {
        const rMinPos = Math.min(
          pLoft.section0.kind === 'point' ? Infinity : pLoft.section0.radiusU,
          pLoft.section1.kind === 'point' ? Infinity : pLoft.section1.radiusU
        );
        if (Math.abs(rHole - rMinPos) <= 0.35) {
          isKnifeEdge = true;
          break;
        }
      }
    }
  } else {
    const rMinSelf = Math.min(
      s0.kind === 'point' ? Infinity : s0.radiusU,
      s1.kind === 'point' ? Infinity : s1.radiusU
    );
    for (const sub of subtracts) {
      const sLoft = getPrimitiveLoftEquivalent(sub);
      if (sLoft && sLoft.axis === loft.axis) {
        const rHole = Math.max(sLoft.section0.radiusU, sLoft.section1.radiusU);
        if (Math.abs(rHole - rMinSelf) <= 0.35) {
          isKnifeEdge = true;
          break;
        }
      }
    }
  }

  // Polygonal Pyramid / Polygonal Frustum
  if (s0.polygon && s0.polygon.length >= 3) {
    const poly0 = s0.polygon;
    const n = poly0.length;
    const poly1: Point2D[] =
      s1.polygon && s1.polygon.length === n
        ? s1.polygon
        : poly0.map(() => ({ u: s1.centerU, v: s1.centerV }));

    for (let i = 0; i < n; i++) {
      const a0 = composeFromAxis(loft.axis, poly0[i].u, poly0[i].v, loft.w0);
      const b0 = composeFromAxis(
        loft.axis,
        poly0[(i + 1) % n].u,
        poly0[(i + 1) % n].v,
        loft.w0
      );
      segments.push(...clipGeneratorSegmentToActiveIntervals(a0, b0, prim, allPrimitives));

      if (s1.kind !== 'point') {
        const a1 = composeFromAxis(loft.axis, poly1[i].u, poly1[i].v, loft.w1);
        const b1 = composeFromAxis(
          loft.axis,
          poly1[(i + 1) % n].u,
          poly1[(i + 1) % n].v,
          loft.w1
        );
        segments.push(...clipGeneratorSegmentToActiveIntervals(a1, b1, prim, allPrimitives));
      }

      const lat0 = composeFromAxis(loft.axis, poly0[i].u, poly0[i].v, loft.w0);
      const lat1 = composeFromAxis(loft.axis, poly1[i].u, poly1[i].v, loft.w1);
      segments.push(...clipGeneratorSegmentToActiveIntervals(lat0, lat1, prim, allPrimitives));
    }
    return;
  }

  // End-cap circles / semicircles at w0 and w1 (Preserving full annular step shoulder contour!)
  const emitCapSection = (
    sec: GeneralizedLoftPayload['section0'],
    wVal: number
  ) => {
    if (sec.kind === 'point' || sec.radiusU <= 0.1) return;
    const c3 = composeFromAxis(loft.axis, sec.centerU, sec.centerV, wVal);
    if (sec.kind === 'circle') {
      // Note: For a subtract bore cap at an open face `wVal`, the circular opening rim ON the solid face IS visible (`forceHidden: false`),
      // while if `wVal` is a blind/T-branch end strictly inside the solid, HLR ray-casting automatically classifies it as `thin_dashed`!
      arcs.push({
        center: c3,
        radius: sec.radiusU,
        uAxis: basis.uVec,
        vAxis: basis.vVec,
        normal: basis.nVec,
        startAngle: 0,
        endAngle: TWO_PI,
        isFullCircle: true,
        ownerOp: op,
        ownerId: prim.id,
        featureId: prim.featureId,
        featureLabel: prim.label,
        isKnifeEdgeProtected: isKnifeEdge,
        isAnnularShoulder: op !== 'subtract',
      });
    } else if (sec.kind === 'semicircle') {
      const sAng = sec.arcStart ?? 0;
      const eAng = sec.arcEnd ?? Math.PI;
      arcs.push({
        center: c3,
        radius: sec.radiusU,
        uAxis: basis.uVec,
        vAxis: basis.vVec,
        normal: basis.nVec,
        startAngle: sAng,
        endAngle: eAng,
        isFullCircle: false,
        ownerOp: op,
        ownerId: prim.id,
        featureId: prim.featureId,
        featureLabel: prim.label,
        isKnifeEdgeProtected: isKnifeEdge,
      });
      // Also emit straight flat chord of semicircle!
      const pStart = composeFromAxis(
        loft.axis,
        sec.centerU + sec.radiusU * Math.cos(sAng),
        sec.centerV + sec.radiusU * Math.sin(sAng),
        wVal
      );
      const pEnd = composeFromAxis(
        loft.axis,
        sec.centerU + sec.radiusU * Math.cos(eAng),
        sec.centerV + sec.radiusU * Math.sin(eAng),
        wVal
      );
      segments.push({
        p1: pStart,
        p2: pEnd,
        ownerOp: op,
        ownerId: prim.id,
        featureId: prim.featureId,
        featureLabel: prim.label,
      });
    }
  };

  emitCapSection(s0, loft.w0);
  emitCapSection(s1, loft.w1);

  // If Semi-Cone or Semi-Frustum: emit the TWO straight corner edges along the flat cut-face!
  if (s0.kind === 'semicircle' || s1.kind === 'semicircle') {
    const sAng = s0.arcStart ?? s1.arcStart ?? 0;
    const eAng = s0.arcEnd ?? s1.arcEnd ?? Math.PI;
    for (const cornerTheta of [sAng, eAng]) {
      const { p0, p1 } = evaluateLoftGeneratorLine3D(loft, cornerTheta);
      segments.push(
        ...clipGeneratorSegmentToActiveIntervals(
          p0,
          p1,
          prim,
          allPrimitives,
          isKnifeEdge,
          true
        )
      );
    }
  }

  // Exact View-Dependent Extreme Silhouette Generators (`A cos θ + B sin θ = C`)!
  const silAngles = solveLoftSilhouetteAngles(loft, view);
  for (const theta of silAngles) {
    const { p0, p1 } = evaluateLoftGeneratorLine3D(loft, theta);
    segments.push(
      ...clipGeneratorSegmentToActiveIntervals(
        p0,
        p1,
        prim,
        allPrimitives,
        isKnifeEdge
      )
    );
  }
}

function extractPrismEdges3D(
  prim: Primitive3D,
  view: ViewType,
  allPrimitives: Primitive3D[],
  segments: Seg3D[],
  arcs: AnalyticArc3D[]
): void {
  const op = prim.operation as BooleanOp;
  const axis: Axis3D =
    prim.prismAxis ??
    (prim.extrudeAxis ? (prim.extrudeAxis.toUpperCase() as Axis3D) : 'Z');
  const w0 = axis === 'Z' ? prim.zMin : axis === 'Y' ? prim.yMin : prim.xMin;
  const w1 = axis === 'Z' ? prim.zMax : axis === 'Y' ? prim.yMax : prim.xMax;
  const basis = getAxisBasis3D(axis);

  if (prim.prismSegments && prim.prismSegments.length > 0) {
    for (const seg of prim.prismSegments) {
      if (
        seg.kind === 'arc' &&
        seg.center &&
        seg.radius !== undefined &&
        seg.startAngle !== undefined &&
        seg.endAngle !== undefined
      ) {
        for (const wVal of [w0, w1]) {
          arcs.push({
            center: composeFromAxis(axis, seg.center.u, seg.center.v, wVal),
            radius: seg.radius,
            uAxis: basis.uVec,
            vAxis: basis.vVec,
            normal: basis.nVec,
            startAngle: seg.startAngle,
            endAngle: seg.endAngle,
            isFullCircle: arcSweepCCW(seg.startAngle, seg.endAngle) >= TWO_PI - 1e-3,
            ownerOp: op,
            ownerId: prim.id,
            featureId: prim.featureId,
            featureLabel: prim.label,
          });
        }
        // Check silhouette angles on this cylindrical arc face!
        const arcLoft: GeneralizedLoftPayload = {
          axis,
          w0,
          w1,
          section0: {
            kind: 'semicircle',
            centerU: seg.center.u,
            centerV: seg.center.v,
            radiusU: seg.radius,
            arcStart: seg.startAngle,
            arcEnd: seg.endAngle,
          },
          section1: {
            kind: 'semicircle',
            centerU: seg.center.u,
            centerV: seg.center.v,
            radiusU: seg.radius,
            arcStart: seg.startAngle,
            arcEnd: seg.endAngle,
          },
        };
        for (const th of solveLoftSilhouetteAngles(arcLoft, view)) {
          const { p0, p1 } = evaluateLoftGeneratorLine3D(arcLoft, th);
          segments.push(
            ...clipGeneratorSegmentToActiveIntervals(p0, p1, prim, allPrimitives)
          );
        }
      } else {
        for (const wVal of [w0, w1]) {
          const a = composeFromAxis(axis, seg.p1.u, seg.p1.v, wVal);
          const b = composeFromAxis(axis, seg.p2.u, seg.p2.v, wVal);
          segments.push(
            ...clipGeneratorSegmentToActiveIntervals(a, b, prim, allPrimitives)
          );
        }
      }

      // Lateral extrusion edge at vertex `seg.p1` (unless smooth tangent joint between line and arc!)
      const lat0 = composeFromAxis(axis, seg.p1.u, seg.p1.v, w0);
      const lat1 = composeFromAxis(axis, seg.p1.u, seg.p1.v, w1);
      // Check if seg.p1 is a smooth C1 tangent point between a line and an arc (like Arch shoulder!)
      const isSmoothArchTangent = checkSmoothTangentVertex(
        seg.p1,
        prim.prismSegments
      );
      if (!isSmoothArchTangent) {
        segments.push(
          ...clipGeneratorSegmentToActiveIntervals(lat0, lat1, prim, allPrimitives)
        );
      }
    }
    return;
  }

  const poly = prim.prismPolygon ?? prim.polygon2D ?? [];
  const n = poly.length;
  for (let i = 0; i < n; i++) {
    const pA = poly[i];
    const pB = poly[(i + 1) % n];
    for (const wVal of [w0, w1]) {
      segments.push(
        ...clipGeneratorSegmentToActiveIntervals(
          composeFromAxis(axis, pA.u, pA.v, wVal),
          composeFromAxis(axis, pB.u, pB.v, wVal),
          prim,
          allPrimitives
        )
      );
    }
    segments.push(
      ...clipGeneratorSegmentToActiveIntervals(
        composeFromAxis(axis, pA.u, pA.v, w0),
        composeFromAxis(axis, pA.u, pA.v, w1),
        prim,
        allPrimitives
      )
    );
  }
}

function checkSmoothTangentVertex(
  pt: Point2D,
  segs: NonNullable<Primitive3D['prismSegments']>
): boolean {
  const incident = segs.filter(
    (s) =>
      Math.hypot(s.p1.u - pt.u, s.p1.v - pt.v) < 0.08 ||
      Math.hypot(s.p2.u - pt.u, s.p2.v - pt.v) < 0.08
  );
  if (incident.length !== 2) return false;
  const arcSeg = incident.find((s) => s.kind === 'arc');
  const lineSeg = incident.find((s) => s.kind === 'line');
  if (!arcSeg || !lineSeg || !arcSeg.center) return false;
  // Radius vector from arc center to `pt` is perpendicular to smooth tangent line!
  const ru = pt.u - arcSeg.center.u;
  const rv = pt.v - arcSeg.center.v;
  const lu = lineSeg.p2.u - lineSeg.p1.u;
  const lv = lineSeg.p2.v - lineSeg.p1.v;
  const rLen = Math.hypot(ru, rv);
  const lLen = Math.hypot(lu, lv);
  if (rLen < 1e-4 || lLen < 1e-4) return false;
  const dot = Math.abs(ru * lu + rv * lv) / (rLen * lLen);
  return dot < 0.02; // perpendicular to radius => tangent!
}

function extractWedgeEdges3D(prim: Primitive3D, segments: Seg3D[]): void {
  const op = prim.operation as BooleanOp;
  const { xMin, xMax, yMin, yMax, zMin, zMax } = prim;
  const add = (p1: Vec3, p2: Vec3) =>
    segments.push({
      p1,
      p2,
      ownerOp: op,
      ownerId: prim.id,
      featureId: prim.featureId,
      featureLabel: prim.label,
    });

  if (prim.shape === 'wedge_y') {
    const v = [
      { x: xMin, y: yMin, z: zMin },
      { x: xMax, y: yMin, z: zMin },
      { x: xMax, y: yMax, z: zMin },
      { x: xMin, y: yMax, z: zMin },
      { x: xMin, y: yMax, z: zMax },
      { x: xMax, y: yMax, z: zMax },
    ];
    add(v[0], v[1]);
    add(v[1], v[2]);
    add(v[2], v[3]);
    add(v[3], v[0]);
    add(v[3], v[4]);
    add(v[2], v[5]);
    add(v[4], v[5]);
    add(v[0], v[4]);
    add(v[1], v[5]);
  } else {
    const v = [
      { x: xMin, y: yMin, z: zMin },
      { x: xMax, y: yMin, z: zMin },
      { x: xMax, y: yMax, z: zMin },
      { x: xMin, y: yMax, z: zMin },
      { x: xMax, y: yMin, z: zMax },
      { x: xMax, y: yMax, z: zMax },
    ];
    add(v[0], v[1]);
    add(v[1], v[2]);
    add(v[2], v[3]);
    add(v[3], v[0]);
    add(v[1], v[4]);
    add(v[2], v[5]);
    add(v[4], v[5]);
    add(v[0], v[4]);
    add(v[3], v[5]);
  }
}

function extractRectPyramidEdges3D(prim: Primitive3D, segments: Seg3D[]): void {
  const op = prim.operation as BooleanOp;
  const { xMin, xMax, yMin, yMax, zMin, zMax } = prim;
  const base = [
    { x: xMin, y: yMin, z: zMin },
    { x: xMax, y: yMin, z: zMin },
    { x: xMax, y: yMax, z: zMin },
    { x: xMin, y: yMax, z: zMin },
  ];
  const apex = prim.apex3D
    ? { x: prim.apex3D[0], y: prim.apex3D[1], z: prim.apex3D[2] }
    : { x: 0.5 * (xMin + xMax), y: 0.5 * (yMin + yMax), z: zMax };

  for (let i = 0; i < 4; i++) {
    segments.push(
      {
        p1: base[i],
        p2: base[(i + 1) % 4],
        ownerOp: op,
        ownerId: prim.id,
        featureId: prim.featureId,
        featureLabel: prim.label,
      },
      {
        p1: base[i],
        p2: apex,
        ownerOp: op,
        ownerId: prim.id,
        featureId: prim.featureId,
        featureLabel: prim.label,
      }
    );
  }
}

function extractBoxEdges3D(
  prim: Primitive3D,
  allPrimitives: Primitive3D[],
  segments: Seg3D[]
): void {
  const { xMin, xMax, yMin, yMax, zMin, zMax } = prim;
  const c: Vec3[] = [
    { x: xMin, y: yMin, z: zMin },
    { x: xMax, y: yMin, z: zMin },
    { x: xMax, y: yMax, z: zMin },
    { x: xMin, y: yMax, z: zMin },
    { x: xMin, y: yMin, z: zMax },
    { x: xMax, y: yMin, z: zMax },
    { x: xMax, y: yMax, z: zMax },
    { x: xMin, y: yMax, z: zMax },
  ];
  const pairs: [number, number][] = [
    [0, 1],
    [1, 2],
    [2, 3],
    [3, 0],
    [4, 5],
    [5, 6],
    [6, 7],
    [7, 4],
    [0, 4],
    [1, 5],
    [2, 6],
    [3, 7],
  ];
  for (const [i, j] of pairs) {
    if (prim.operation === 'subtract') {
      // For a subtract box (rectangular hole or open U-slot!), an edge can be EITHER:
      // - On an open slot surface (visible crease where slot cuts solid exterior -> forceHidden = false!), OR
      // - Strictly buried inside the solid body (internal square bore corner -> HLR ray-casting automatically classifies as hidden!).
      // So we do NOT lock subtract box edges to forceHidden; we simply clip them to intervals on the CSG boundary (`|SDF_csg| <= 0.12`)!
      segments.push({
        p1: c[i],
        p2: c[j],
        ownerOp: 'subtract',
        ownerId: prim.id,
        featureId: prim.featureId,
        featureLabel: prim.label,
        forceHidden: false,
      });
    } else {
      segments.push(
        ...clipGeneratorSegmentToActiveIntervals(c[i], c[j], prim, allPrimitives)
      );
    }
  }
}
