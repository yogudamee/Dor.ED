import {
  GeneralizedLoftPayload,
  HemisphereCapSpec,
  Point2D,
  Primitive3D,
  ViewType,
} from '../../types/cad';
import {
  composeFromAxis,
  dist2,
  getSharedAxisBetweenViews,
  getViewAxisSpec,
  unprojectViewPointTo3D,
} from '../core/coordSystem';
import {
  Axis3D,
  BoundingBox2D,
  BoundingBox3D,
  CandidateSolidVolume,
  CompositeRegion2D,
  ViewArrangementResult,
  VirtualCircleCarrier2D,
} from '../core/types';
import { evalCSGSolidSDF, evalPrimitive3DSDF } from './analyticSurfaces';

function makeBoxBoundsFromAxisSpan(
  axis: Axis3D,
  uMin: number,
  uMax: number,
  vMin: number,
  vMax: number,
  wMin: number,
  wMax: number
): BoundingBox3D {
  if (axis === 'Z') {
    return { xMin: uMin, xMax: uMax, yMin: vMin, yMax: vMax, zMin: wMin, zMax: wMax };
  }
  if (axis === 'Y') {
    return { xMin: uMin, xMax: uMax, yMin: wMin, yMax: wMax, zMin: vMin, zMax: vMax };
  }
  return { xMin: wMin, xMax: wMax, yMin: uMin, yMax: uMax, zMin: vMin, zMax: vMax };
}

function getSpanOnCoord(b: BoundingBox2D, coord: 'u' | 'v'): [number, number] {
  return coord === 'u' ? [b.uMin, b.uMax] : [b.vMin, b.vMax];
}

function spansMatch(
  a0: number,
  a1: number,
  b0: number,
  b1: number,
  tol = 1.2
): boolean {
  return Math.abs(a0 - b0) <= tol && Math.abs(a1 - b1) <= tol;
}

function spanContains(
  outer0: number,
  outer1: number,
  inner0: number,
  inner1: number,
  tol = 1.2
): boolean {
  return inner0 >= outer0 - tol && inner1 <= outer1 + tol;
}

function generateWitnessPointsForPrimitive(prim: Primitive3D): {
  x: number;
  y: number;
  z: number;
}[] {
  const cx = 0.5 * (prim.xMin + prim.xMax);
  const cy = 0.5 * (prim.yMin + prim.yMax);
  const cz = 0.5 * (prim.zMin + prim.zMax);
  const pts: { x: number; y: number; z: number }[] = [];
  for (const fx of [0.25, 0.5, 0.75]) {
    for (const fy of [0.25, 0.5, 0.75]) {
      for (const fz of [0.25, 0.5, 0.75]) {
        const p = {
          x: prim.xMin + (prim.xMax - prim.xMin) * fx,
          y: prim.yMin + (prim.yMax - prim.yMin) * fy,
          z: prim.zMin + (prim.zMax - prim.zMin) * fz,
        };
        if (evalPrimitive3DSDF(p, prim) < -0.25) {
          pts.push(p);
        }
      }
    }
  }
  if (pts.length === 0) pts.push({ x: cx, y: cy, z: cz });
  return pts;
}

function estimateSurfaceArea(b: BoundingBox3D, shape: Primitive3D['shape']): number {
  const dx = Math.max(1, b.xMax - b.xMin);
  const dy = Math.max(1, b.yMax - b.yMin);
  const dz = Math.max(1, b.zMax - b.zMin);
  const boxA = 2 * (dx * dy + dy * dz + dz * dx);
  if (shape === 'sphere') return Math.PI * dx * dy;
  if (shape === 'hemisphere') return 0.75 * Math.PI * dx * dy;
  if (shape.startsWith('cylinder')) return 0.78 * boxA;
  if (shape.startsWith('cone') || shape === 'generalized_loft') return 0.65 * boxA;
  return boxA;
}

function hasRevolutionCenterline(
  arr: ViewArrangementResult,
  axisDir: 'u' | 'v',
  coord: number
): boolean {
  for (const cl of arr.centerlineEntities) {
    if (cl.type !== 'line') continue;
    // axisDir === 'v' means vertical revolution axis at u = coord
    if (axisDir === 'v' && Math.abs(cl.p1.u - cl.p2.u) < 0.6) {
      if (Math.abs(cl.p1.u - coord) <= 1.5) return true;
    }
    // axisDir === 'u' means horizontal revolution axis at v = coord
    if (axisDir === 'u' && Math.abs(cl.p1.v - cl.p2.v) < 0.6) {
      if (Math.abs(cl.p1.v - coord) <= 1.5) return true;
    }
  }
  return false;
}

/**
 * Check if an inner circle/loop in `circleArr` is actually an inner void hole (evidenced by matching
 * `thin_dashed` bands in `sideArr`) rather than a protruding coaxial boss cylinder!
 */
function isInnerCirclePureHoleWithoutBossStep(
  circ: VirtualCircleCarrier2D,
  circSharedCoord: 'u' | 'v',
  sideArr: ViewArrangementResult,
  sideSharedCoord: 'u' | 'v'
): boolean {
  const cShared = circSharedCoord === 'u' ? circ.center.u : circ.center.v;
  const r = circ.radius;
  const span0 = cShared - r;
  const span1 = cShared + r;

  // Does sideArr have a SOLID region whose shared-axis span matches [cShared - r, cShared + r]?
  const hasMatchingSolidBossInSide = sideArr.regions.some((sr) => {
    const [s0, s1] = getSpanOnCoord(sr.bounds, sideSharedCoord);
    return spansMatch(s0, s1, span0, span1, 1.2);
  });
  if (hasMatchingSolidBossInSide) return false;

  // Does sideArr have a parallel dashed band matching [cShared - r, cShared + r]?
  const expectedBandAxis = sideSharedCoord;
  const hasMatchingDashedHole = sideArr.parallelDashedBands.some(
    (b) =>
      b.axis === expectedBandAxis &&
      Math.abs(b.c1 - span0) <= 1.2 &&
      Math.abs(b.c2 - span1) <= 1.2
  );
  if (hasMatchingDashedHole) return true;

  // If inner circle has nestingDepth >= 1 and NO solid step tier matches its diameter in sideArr,
  // it is a hole opening, NOT a solid boss!
  return circ.nestingDepth >= 1;
}

/**
 * Symmetrically lift 2D atomic & composite regions across two orthogonal views `(arr1, arr2)`
 * into exact 3D positive solid volumes (`CandidateSolidVolume[]`), completely eliminating AABB slab
 * slicing and automatically stripping Steinmetz residual wedges around quadric/lofted revolution bodies!
 */
export function buildCandidateSolidVolumes(
  arr1: ViewArrangementResult,
  arr2: ViewArrangementResult
): CandidateSolidVolume[] {
  const candidates: CandidateSolidVolume[] = [];
  const mapping = getSharedAxisBetweenViews(arr1.view, arr2.view);
  let seq = 0;

  const pushCandidate = (
    prims: Primitive3D[],
    sourceRegions: { view: ViewType; regionId: string }[],
    description: string,
    priorityBoost = 0,
    isEssentialOuter = false
  ) => {
    if (prims.length === 0) return;
    let xMin = Infinity;
    let xMax = -Infinity;
    let yMin = Infinity;
    let yMax = -Infinity;
    let zMin = Infinity;
    let zMax = -Infinity;
    for (const p of prims) {
      if (p.xMin < xMin) xMin = p.xMin;
      if (p.xMax > xMax) xMax = p.xMax;
      if (p.yMin < yMin) yMin = p.yMin;
      if (p.yMax > yMax) yMax = p.yMax;
      if (p.zMin < zMin) zMin = p.zMin;
      if (p.zMax > zMax) zMax = p.zMax;
    }
    if (xMax - xMin < 0.2 || yMax - yMin < 0.2 || zMax - zMin < 0.2) return;
    const bounds = { xMin, xMax, yMin, yMax, zMin, zMax };

    // Deduplicate identical primitive volumes
    const isDup = candidates.some((ex) => {
      if (ex.primitives.length !== prims.length) return false;
      const p0 = ex.primitives[0];
      const q0 = prims[0];
      return (
        p0.shape === q0.shape &&
        Math.abs(ex.bounds.xMin - bounds.xMin) < 0.4 &&
        Math.abs(ex.bounds.xMax - bounds.xMax) < 0.4 &&
        Math.abs(ex.bounds.yMin - bounds.yMin) < 0.4 &&
        Math.abs(ex.bounds.yMax - bounds.yMax) < 0.4 &&
        Math.abs(ex.bounds.zMin - bounds.zMin) < 0.4 &&
        Math.abs(ex.bounds.zMax - bounds.zMax) < 0.4 &&
        Math.abs((p0.rMin ?? -1) - (q0.rMin ?? -1)) < 0.4 &&
        Math.abs((p0.rMax ?? -1) - (q0.rMax ?? -1)) < 0.4
      );
    });
    if (isDup) return;

    const witnessPts =
      prims.length === 1
        ? generateWitnessPointsForPrimitive(prims[0])
        : generateWitnessPointsForIntersectGroup(prims, bounds);
    if (witnessPts.length === 0) return;

    if (prims.some((p) => p.shape !== 'box' || p.loftSpec !== undefined)) {
      for (const sr of sourceRegions) {
        claimedAnalyticRegionIds.add(`${sr.view}:${sr.regionId}`);
      }
    }

    candidates.push({
      id: `cand_solid_${seq++}`,
      primitives: prims,
      bounds,
      witnessPoints: witnessPts,
      surfaceAreaEstimate: estimateSurfaceArea(bounds, prims[0].shape),
      priorityBoost,
      isEssentialOuter,
      sourceRegions,
      description,
    });
  };

  // Track 2D side/end regions already lifted into exact analytic cylinders/cones/spheres/prisms
  // so Section 4 never wraps a protruding cylinder/cone tower inside a rectangular AABB box!
  const claimedAnalyticRegionIds = new Set<string>();

  // Track envelopes claimed by exact quadric / GeneralizedLoft / polygonal prism lifts
  // so we strip out Steinmetz / AABB box-intersection wedges over the exact same 3D box!
  const claimedQuadricEnvelopes: BoundingBox3D[] = [];
  const markQuadricEnvelope = (b: BoundingBox3D) => {
    claimedQuadricEnvelopes.push({ ...b });
  };
  const isInsideClaimedQuadricEnvelope = (b: BoundingBox3D): boolean => {
    return claimedQuadricEnvelopes.some(
      (qb) =>
        Math.abs(qb.xMin - b.xMin) <= 1.2 &&
        Math.abs(qb.xMax - b.xMax) <= 1.2 &&
        Math.abs(qb.yMin - b.yMin) <= 1.2 &&
        Math.abs(qb.yMax - b.yMax) <= 1.2 &&
        Math.abs(qb.zMin - b.zMin) <= 1.2 &&
        Math.abs(qb.zMax - b.zMax) <= 1.2
    );
  };

  // ==========================================================================
  // 1. SPHERES: VirtualCircle(R) in arr1 + VirtualCircle(R) in arr2 with matching shared center!
  //    (Handles intact spheres AND slotted spheres whose trimmed major arcs stitch into VirtualCircles!)
  // ==========================================================================
  for (const vc1 of arr1.circleCarriers) {
    if (vc1.dominantLineType !== 'thick_solid' || vc1.nestingDepth > 0) continue;
    const s1 = mapping.v1Coord === 'u' ? vc1.center.u : vc1.center.v;
    const f1 = mapping.v1FreeCoord === 'u' ? vc1.center.u : vc1.center.v;

    for (const vc2 of arr2.circleCarriers) {
      if (vc2.dominantLineType !== 'thick_solid' || vc2.nestingDepth > 0) continue;
      const s2 = mapping.v2Coord === 'u' ? vc2.center.u : vc2.center.v;
      const f2 = mapping.v2FreeCoord === 'u' ? vc2.center.u : vc2.center.v;

      if (Math.abs(vc1.radius - vc2.radius) <= 0.8 && Math.abs(s1 - s2) <= 0.8) {
        const R = 0.5 * (vc1.radius + vc2.radius);
        const sCenter = 0.5 * (s1 + s2);
        const center3 = assemble3DPoint(
          mapping.sharedAxis,
          sCenter,
          mapping.v1FreeAxis,
          f1,
          mapping.v2FreeAxis,
          f2
        );
        const spherePrim: Primitive3D = {
          id: `prim_sphere_${seq}`,
          featureId: `feat_sphere_${seq}`,
          label: `球体 R${R.toFixed(1)}`,
          operation: 'add',
          shape: 'sphere',
          xMin: center3.x - R,
          xMax: center3.x + R,
          yMin: center3.y - R,
          yMax: center3.y + R,
          zMin: center3.z - R,
          zMax: center3.z + R,
          centerX: center3.x,
          centerY: center3.y,
          centerZ: center3.z,
          radius: R,
        };
        const env = {
          xMin: spherePrim.xMin,
          xMax: spherePrim.xMax,
          yMin: spherePrim.yMin,
          yMax: spherePrim.yMax,
          zMin: spherePrim.zMin,
          zMax: spherePrim.zMax,
        };
        markQuadricEnvelope(env);
        pushCandidate([spherePrim], [], '解析球体 (Sphere)', 50, true);
      }
    }
  }

  // ==========================================================================
  // 2. SYMMETRIC DIRECTIONAL LIFTING: Pair (circArr, sideArr) in BOTH orders
  //    Covers: Hemispheres, Cones, Eccentric Frustums, Semi-Cones/Frustums,
  //    Stepped/Straddling Cylinders, Hexagonal/Polygonal Prisms, Pyramids & Frustums!
  // ==========================================================================
  const liftDirectionalPair = (
    endArr: ViewArrangementResult,
    sideArr: ViewArrangementResult,
    endSharedCoord: 'u' | 'v',
    endFreeCoord: 'u' | 'v',
    endFreeAxis: Axis3D,
    sideSharedCoord: 'u' | 'v',
    sideSweepCoord: 'u' | 'v',
    loftAxis: Axis3D // Note: loftAxis === sideSweepAxis === normal axis of endArr!
  ) => {
    const endAxisSpec = getViewAxisSpec(endArr.view);
    void endAxisSpec;

    // 2A. Circle(s) in `endArr` paired with Semicircle / Triangle / Trapezoid / Rectangle in `sideArr`
    const solidCircles = endArr.circleCarriers.filter(
      (vc) => vc.dominantLineType === 'thick_solid'
    );

    for (const vc of solidCircles) {
      if (
        isInnerCirclePureHoleWithoutBossStep(
          vc,
          endSharedCoord,
          sideArr,
          sideSharedCoord
        )
      ) {
        continue;
      }

      const cShared = endSharedCoord === 'u' ? vc.center.u : vc.center.v;
      const cEndFree = endFreeCoord === 'u' ? vc.center.u : vc.center.v;
      const R = vc.radius;
      const cSpan0 = cShared - R;
      const cSpan1 = cShared + R;

      for (const sReg of sideArr.regions) {
        const [sShared0, sShared1] = getSpanOnCoord(sReg.bounds, sideSharedCoord);
        const [wMin, wMax] = getSpanOnCoord(sReg.bounds, sideSweepCoord);

        // (i) HEMISPHERE: Circle(R) in endArr + Semicircle(R) in sideArr!
        if (
          sReg.profileKind === 'semicircle' &&
          sReg.profileMeta?.radius !== undefined &&
          Math.abs(sReg.profileMeta.radius - R) <= 1.0 &&
          spansMatch(sShared0, sShared1, cSpan0, cSpan1, 1.2) &&
          sReg.profileMeta.chordAxis === sideSweepCoord &&
          sReg.profileMeta.chordCoord !== undefined
        ) {
          const flatCoord = sReg.profileMeta.chordCoord;
          const keepPos = sReg.profileMeta.keepGreater ?? true;
          const center3 = assemble3DPoint(
            mapping.sharedAxis,
            cShared,
            endFreeAxis,
            cEndFree,
            loftAxis,
            flatCoord
          );
          const hemiSpec: HemisphereCapSpec = {
            flatAxis: loftAxis,
            flatCoord,
            keepPositiveSide: keepPos,
          };
          const b = makeBoxBoundsFromAxisSpan(
            loftAxis,
            vc.center.u - R,
            vc.center.u + R,
            vc.center.v - R,
            vc.center.v + R,
            keepPos ? flatCoord : flatCoord - R,
            keepPos ? flatCoord + R : flatCoord
          );
          const hemiPrim: Primitive3D = {
            id: `prim_hemi_${seq}`,
            featureId: `feat_hemi_${seq}`,
            label: `平底半球 R${R.toFixed(1)}`,
            operation: 'add',
            shape: 'hemisphere',
            ...b,
            centerX: center3.x,
            centerY: center3.y,
            centerZ: center3.z,
            radius: R,
            hemisphereSpec: hemiSpec,
          };
          markQuadricEnvelope(b);
          pushCandidate(
            [hemiPrim],
            [{ view: sideArr.view, regionId: sReg.id }],
            '平底半球体 (Hemisphere)',
            45,
            vc.nestingDepth === 0
          );
          continue;
        }

        // (ii) RIGHT / INVERTED / ECCENTRIC CONE OR FRUSTUM:
        //      Circle(R) in endArr + Triangle / Trapezoid in sideArr!
        const isTaperAlongSweep =
          (sideSweepCoord === 'v' &&
            (sReg.profileKind === 'triangle_v' ||
              sReg.profileKind === 'trapezoid_v')) ||
          (sideSweepCoord === 'u' &&
            (sReg.profileKind === 'triangle_h' ||
              sReg.profileKind === 'trapezoid_h'));

        if (isTaperAlongSweep && sReg.profileMeta) {
          const rAtMin = sReg.profileMeta.rAtMin ?? 0;
          const rAtMax = sReg.profileMeta.rAtMax ?? 0;
          const cAtMin = sReg.profileMeta.cAtMin ?? cShared;
          const cAtMax = sReg.profileMeta.cAtMax ?? cShared;
          const rLarger = Math.max(rAtMin, rAtMax);
          const rSmaller = Math.min(rAtMin, rAtMax);
          const cLarger = rAtMin >= rAtMax ? cAtMin : cAtMax;

          if (
            Math.abs(rLarger - R) <= 1.2 &&
            Math.abs(cLarger - cShared) <= 1.2
          ) {
            // If frustum (rSmaller > 0.5), find matching top circle in endArr (supports eccentric oblique frustums!)
            let endU0 = vc.center.u;
            let endV0 = vc.center.v;
            let endU1 = vc.center.u;
            let endV1 = vc.center.v;

            if (rSmaller > 0.5) {
              const cSmallerExpected = rAtMin < rAtMax ? cAtMin : cAtMax;
              const topCirc = solidCircles.find(
                (oc) =>
                  oc.id !== vc.id &&
                  Math.abs(oc.radius - rSmaller) <= 1.2 &&
                  Math.abs(
                    (endSharedCoord === 'u' ? oc.center.u : oc.center.v) -
                      cSmallerExpected
                  ) <= 1.2
              );
              if (topCirc) {
                if (rAtMin >= rAtMax) {
                  endU1 = topCirc.center.u;
                  endV1 = topCirc.center.v;
                } else {
                  endU0 = topCirc.center.u;
                  endV0 = topCirc.center.v;
                }
              } else {
                // Eccentric shift along shared axis from side trapezoid even if top circle was drawn dashed or coincided
                if (rAtMin >= rAtMax) {
                  if (endSharedCoord === 'u') endU1 = cAtMax;
                  else endV1 = cAtMax;
                } else {
                  if (endSharedCoord === 'u') endU0 = cAtMin;
                  else endV0 = cAtMin;
                }
              }
            } else {
              // Cone apex shift if oblique cone!
              if (rAtMin >= rAtMax) {
                if (endSharedCoord === 'u') endU1 = cAtMax;
                else endV1 = cAtMax;
              } else {
                if (endSharedCoord === 'u') endU0 = cAtMin;
                else endV0 = cAtMin;
              }
            }

            const loftSpec: GeneralizedLoftPayload = {
              axis: loftAxis,
              w0: wMin,
              w1: wMax,
              section0: {
                kind: rAtMin <= 0.2 ? 'point' : 'circle',
                centerU: endU0,
                centerV: endV0,
                radiusU: rAtMin,
              },
              section1: {
                kind: rAtMax <= 0.2 ? 'point' : 'circle',
                centerU: endU1,
                centerV: endV1,
                radiusU: rAtMax,
              },
            };

            const uLo = Math.min(endU0 - rAtMin, endU1 - rAtMax);
            const uHi = Math.max(endU0 + rAtMin, endU1 + rAtMax);
            const vLo = Math.min(endV0 - rAtMin, endV1 - rAtMax);
            const vHi = Math.max(endV0 + rAtMin, endV1 + rAtMax);
            const b = makeBoxBoundsFromAxisSpan(
              loftAxis,
              uLo,
              uHi,
              vLo,
              vHi,
              wMin,
              wMax
            );
            const isEccentric =
              Math.hypot(endU1 - endU0, endV1 - endV0) > 0.5;
            const coneShape: Primitive3D['shape'] = isEccentric
              ? 'generalized_loft'
              : loftAxis === 'Z'
              ? 'cone_z'
              : loftAxis === 'Y'
              ? 'cone_y'
              : 'cone_x';

            const conePrim: Primitive3D = {
              id: `prim_cone_${seq}`,
              featureId: `feat_cone_${seq}`,
              label: isEccentric
                ? `偏心斜圆台 (R${rAtMin.toFixed(0)}→R${rAtMax.toFixed(0)})`
                : rSmaller <= 0.2
                ? `正圆锥 R${rLarger.toFixed(0)}`
                : `正圆台 R${rAtMin.toFixed(0)}→R${rAtMax.toFixed(0)}`,
              operation: 'add',
              shape: coneShape,
              ...b,
              rMin: rAtMin,
              rMax: rAtMax,
              uCenterMin: endU0,
              vCenterMin: endV0,
              uCenterMax: endU1,
              vCenterMax: endV1,
              loftSpec,
            };
            markQuadricEnvelope(b);
            pushCandidate(
              [conePrim],
              [{ view: sideArr.view, regionId: sReg.id }],
              conePrim.label,
              45,
              true
            );
            continue;
          }
        }

        // (iii) CYLINDER / STEPPED CYLINDER / CONE-SLOTTED-SIDE-PROFILE:
        // Also check if sideArr has a notched/slotted triangle (like Case 7: Cone with lateral slot cut out of triangle)
        if (
          (sReg.profileKind === 'general_polygon' ||
            sReg.profileKind === 'curved_loop') &&
          !sReg.isSubDecomposed &&
          spansMatch(sShared0, sShared1, cSpan0, cSpan1, 1.2)
        ) {
          // Check if outer boundary of sReg has two symmetric slanted cone generators meeting at apex or base!
          const coneFromSlotted = detectSlottedConeSideRegion(
            sReg,
            sideSharedCoord,
            sideSweepCoord,
            cShared,
            R
          );
          if (coneFromSlotted) {
            const { r0, r1, w0, w1 } = coneFromSlotted;
            const loftSpec: GeneralizedLoftPayload = {
              axis: loftAxis,
              w0,
              w1,
              section0: {
                kind: r0 <= 0.2 ? 'point' : 'circle',
                centerU: vc.center.u,
                centerV: vc.center.v,
                radiusU: r0,
              },
              section1: {
                kind: r1 <= 0.2 ? 'point' : 'circle',
                centerU: vc.center.u,
                centerV: vc.center.v,
                radiusU: r1,
              },
            };
            const b = makeBoxBoundsFromAxisSpan(
              loftAxis,
              vc.center.u - R,
              vc.center.u + R,
              vc.center.v - R,
              vc.center.v + R,
              w0,
              w1
            );
            const conePrim: Primitive3D = {
              id: `prim_slotted_cone_${seq}`,
              featureId: `feat_cone_${seq}`,
              label: `正圆锥基体 R${R.toFixed(0)}`,
              operation: 'add',
              shape:
                loftAxis === 'Z'
                  ? 'cone_z'
                  : loftAxis === 'Y'
                  ? 'cone_y'
                  : 'cone_x',
              ...b,
              rMin: r0,
              rMax: r1,
              loftSpec,
            };
            markQuadricEnvelope(b);
            pushCandidate(
              [conePrim],
              [{ view: sideArr.view, regionId: sReg.id }],
              '开槽圆锥主基体',
              46,
              true
            );
            continue;
          }
        }

        // Standard Cylinder / Stepped Cylinder / Straddling Half-Embedded Cylinder!
        if (spansMatch(sShared0, sShared1, cSpan0, cSpan1, 1.2)) {
          // Determine cylinder axial span [cylWMin, cylWMax]:
          // For straddling half-exposed/half-embedded cylinder (Case 4), if `sReg` is an upper/exposed cylinder
          // whose bottom touches an underlying base step while in `endArr` the full circle straddles across the step,
          // also generate a full-depth cylinder extending down to sideArr.bounds.min so it fuses into the base without floating!
          const cylShape: Primitive3D['shape'] =
            loftAxis === 'Z'
              ? 'cylinder_z'
              : loftAxis === 'Y'
              ? 'cylinder_y'
              : 'cylinder_x';

          const buildCyl = (wA: number, wB: number, boost: number, tag: string) => {
            const b = makeBoxBoundsFromAxisSpan(
              loftAxis,
              vc.center.u - R,
              vc.center.u + R,
              vc.center.v - R,
              vc.center.v + R,
              wA,
              wB
            );
            const c3 = composeFromAxis(
              loftAxis,
              vc.center.u,
              vc.center.v,
              0.5 * (wA + wB)
            );
            const cylPrim: Primitive3D = {
              id: `prim_cyl_${seq}`,
              featureId: `feat_cyl_${seq}`,
              label: `${tag} Ø${(2 * R).toFixed(0)}`,
              operation: 'add',
              shape: cylShape,
              ...b,
              centerX: c3.x,
              centerY: c3.y,
              centerZ: c3.z,
              radius: R,
            };
            markQuadricEnvelope(b);
            pushCandidate(
              [cylPrim],
              [{ view: sideArr.view, regionId: sReg.id }],
              cylPrim.label,
              boost,
              vc.nestingDepth === 0
            );
          };

          const bboxArea = Math.max(
            1e-3,
            (sShared1 - sShared0) * (wMax - wMin)
          );
          const fillsRect = Math.abs(sReg.area - bboxArea) / bboxArea <= 0.045;

          // Also recognize outer cylinder silhouettes notched by an open central U-slot
          // (where full-height straight axial generator walls >= 85% of `axialSpan` remain on BOTH `cSpan0` and `cSpan1`,
          // preventing coaxial stepped cylinder flanges like bench_01 from swallowing narrower upper tiers)!
          const hasFullHeightStraightWallOn = (targetCoord: number): boolean => {
            let wallLen = 0;
            for (const seg of sReg.boundarySegments) {
              if (seg.kind !== 'line') continue;
              const cA = sideSharedCoord === 'u' ? seg.p1.u : seg.p1.v;
              const cB = sideSharedCoord === 'u' ? seg.p2.u : seg.p2.v;
              const wA = sideSweepCoord === 'u' ? seg.p1.u : seg.p1.v;
              const wB = sideSweepCoord === 'u' ? seg.p2.u : seg.p2.v;
              if (
                Math.abs(cA - targetCoord) <= 0.6 &&
                Math.abs(cB - targetCoord) <= 0.6
              ) {
                wallLen += Math.abs(wB - wA);
              }
            }
            return wallLen >= (wMax - wMin) * 0.85;
          };
          const isNotchedOrBeveledCylinderSide =
            vc.nestingDepth === 0 &&
            !sReg.isSubDecomposed &&
            sReg.profileKind !== 'semicircle' &&
            !isTaperAlongSweep &&
            hasFullHeightStraightWallOn(cSpan0) &&
            hasFullHeightStraightWallOn(cSpan1);

          if (
            sReg.profileKind === 'rectangle' ||
            fillsRect ||
            isNotchedOrBeveledCylinderSide
          ) {
            // Check if a wider concentric solid circle contains `vc` (coaxial stepped shaft!)
            const hasWiderConcentricCircle = solidCircles.some(
              (oc) =>
                oc.id !== vc.id &&
                oc.radius > R + 0.6 &&
                dist2(oc.center, vc.center) <= 0.8
            );

            // If stacked coaxial shaft tier, tuck 0.6mm into adjacent wider tier so CSG ADDITION has zero coplanar cap degeneracy while keeping exact step shoulder!
            let tierWMin = wMin;
            let tierWMax = wMax;
            if (hasWiderConcentricCircle) {
              const widerBelow = sideArr.regions.some((or) => {
                const [os0, os1] = getSpanOnCoord(or.bounds, sideSharedCoord);
                const [, owMax] = getSpanOnCoord(or.bounds, sideSweepCoord);
                return (
                  or.bounds &&
                  os1 - os0 > sShared1 - sShared0 + 1.0 &&
                  Math.abs(owMax - wMin) <= 0.5
                );
              });
              const widerAbove = sideArr.regions.some((or) => {
                const [os0, os1] = getSpanOnCoord(or.bounds, sideSharedCoord);
                const [owMin] = getSpanOnCoord(or.bounds, sideSweepCoord);
                return (
                  or.bounds &&
                  os1 - os0 > sShared1 - sShared0 + 1.0 &&
                  Math.abs(owMin - wMax) <= 0.5
                );
              });
              if (widerBelow) tierWMin = wMin - 0.6;
              if (widerAbove) tierWMax = wMax + 0.6;
            }

            buildCyl(tierWMin, tierWMax, 40, '回转圆柱体');

            // Check straddling half-exposed/half-embedded cylinder extension into stepped rectangular base (Case 4!):
            if (!hasWiderConcentricCircle && sideArr.bounds) {
              const globalWMin =
                sideSweepCoord === 'v'
                  ? sideArr.bounds.vMin
                  : sideArr.bounds.uMin;
              const sideAllSolid = sideArr.regions.find((r) => r.isFullEnvelope);
              if (wMin > globalWMin + 1.0 && sideAllSolid) {
                const testW = globalWMin + 1.0;
                const ptL =
                  sideSweepCoord === 'v'
                    ? { u: cSpan0 + 1.0, v: testW }
                    : { u: testW, v: cSpan0 + 1.0 };
                const ptR =
                  sideSweepCoord === 'v'
                    ? { u: cSpan1 - 1.0, v: testW }
                    : { u: testW, v: cSpan1 - 1.0 };
                const inBaseL = sideArr.regions.some((r) =>
                  pointInRectangleOrPoly(ptL, r)
                );
                const inBaseR = sideArr.regions.some((r) =>
                  pointInRectangleOrPoly(ptR, r)
                );
                if (inBaseL && inBaseR) {
                  // Offset embedded bottom slightly inside the solid base (`+0.8mm`) so `three-bvh-csg` ADDITION avoids 72 coplanar triangles on `globalWMin` while keeping the outer base plane 100% flat!
                  const embedWMin = Math.min(wMin - 0.5, globalWMin + 0.8);
                  buildCyl(embedWMin, wMax, 44, '跨台阶融合实心圆柱');
                }
              }
            }
          }
        }
      }
    }

    // 2B. Semicircle / Regular Polygon / Arch / Curved-Loop in `endArr` paired with `sideArr`
    for (const eReg of endArr.regions) {
      if (eReg.profileKind === 'circle') continue;
      // Skip inner void loops unless they match a solid protruding tier in sideArr!
      const [eShared0, eShared1] = getSpanOnCoord(eReg.bounds, endSharedCoord);

      if (eReg.nestingDepth >= 1) {
        const hasProtrudingTierInSide = sideArr.regions.some((sr) => {
          const [s0, s1] = getSpanOnCoord(sr.bounds, sideSharedCoord);
          return (
            !sr.isFullEnvelope &&
            spansMatch(s0, s1, eShared0, eShared1, 1.2)
          );
        });
        if (!hasProtrudingTierInSide) continue;
      }

      for (const sReg of sideArr.regions) {
        const [sShared0, sShared1] = getSpanOnCoord(sReg.bounds, sideSharedCoord);
        const [wMin, wMax] = getSpanOnCoord(sReg.bounds, sideSweepCoord);
        if (!spansMatch(eShared0, eShared1, sShared0, sShared1, 1.2)) continue;

        // (i) COAXIAL HEMISPHERE from two orthogonal Semicircles (e.g. Case 12 Cone + Rear Hemisphere in front & top!)
        if (
          eReg.profileKind === 'semicircle' &&
          sReg.profileKind === 'semicircle' &&
          eReg.profileMeta?.radius !== undefined &&
          sReg.profileMeta?.radius !== undefined &&
          Math.abs(eReg.profileMeta.radius - sReg.profileMeta.radius) <= 1.2 &&
          eReg.profileMeta.chordAxis === endSharedCoord &&
          sReg.profileMeta.chordAxis === sideSharedCoord &&
          eReg.profileMeta.chordCoord !== undefined &&
          sReg.profileMeta.chordCoord !== undefined &&
          Math.abs(eReg.profileMeta.chordCoord - sReg.profileMeta.chordCoord) <= 1.2
        ) {
          const R = 0.5 * (eReg.profileMeta.radius + sReg.profileMeta.radius);
          const flatCoord = 0.5 * (eReg.profileMeta.chordCoord + sReg.profileMeta.chordCoord);
          const keepPos = eReg.profileMeta.keepGreater ?? true;
          const eCenterFree =
            endFreeCoord === 'u'
              ? eReg.profileMeta.center!.u
              : eReg.profileMeta.center!.v;
          const sCenterFree =
            sideSweepCoord === 'u'
              ? sReg.profileMeta.center!.u
              : sReg.profileMeta.center!.v;
          const center3 = assemble3DPoint(
            mapping.sharedAxis,
            flatCoord,
            endFreeAxis,
            eCenterFree,
            loftAxis,
            sCenterFree
          );
          const b: BoundingBox3D = {
            xMin: center3.x - R,
            xMax: center3.x + R,
            yMin: center3.y - R,
            yMax: center3.y + R,
            zMin: center3.z - R,
            zMax: center3.z + R,
          };
          if (mapping.sharedAxis === 'X') {
            if (keepPos) b.xMin = flatCoord;
            else b.xMax = flatCoord;
          } else if (mapping.sharedAxis === 'Y') {
            if (keepPos) b.yMin = flatCoord;
            else b.yMax = flatCoord;
          } else {
            if (keepPos) b.zMin = flatCoord;
            else b.zMax = flatCoord;
          }

          const hemiPrim: Primitive3D = {
            id: `prim_coax_hemi_${seq}`,
            featureId: `feat_hemi_${seq}`,
            label: `同轴半球体 R${R.toFixed(1)}`,
            operation: 'add',
            shape: 'hemisphere',
            ...b,
            centerX: center3.x,
            centerY: center3.y,
            centerZ: center3.z,
            radius: R,
            hemisphereSpec: {
              flatAxis: mapping.sharedAxis,
              flatCoord,
              keepPositiveSide: keepPos,
            },
          };
          markQuadricEnvelope(b);
          pushCandidate(
            [hemiPrim],
            [
              { view: endArr.view, regionId: eReg.id },
              { view: sideArr.view, regionId: sReg.id },
            ],
            '同轴半球复合部 (Hemisphere)',
            48,
            true
          );
          continue;
        }

        // (ii) SEMI-CONE & SEMI-FRUSTUM (Case 10!):
        //      Semicircle in `endArr` + Triangle / Trapezoid in `sideArr`!
        const isSideTaper =
          (sideSweepCoord === 'v' &&
            (sReg.profileKind === 'triangle_v' ||
              sReg.profileKind === 'trapezoid_v')) ||
          (sideSweepCoord === 'u' &&
            (sReg.profileKind === 'triangle_h' ||
              sReg.profileKind === 'trapezoid_h'));

        if (
          eReg.profileKind === 'semicircle' &&
          eReg.profileMeta?.center &&
          eReg.profileMeta.radius !== undefined &&
          isSideTaper &&
          sReg.profileMeta
        ) {
          const R = eReg.profileMeta.radius;
          const rAtMin = sReg.profileMeta.rAtMin ?? 0;
          const rAtMax = sReg.profileMeta.rAtMax ?? 0;
          const rLarger = Math.max(rAtMin, rAtMax);
          if (Math.abs(rLarger - R) <= 1.2) {
            const c0 = eReg.profileMeta.center;
            const arcStart = eReg.profileMeta.arcStart ?? 0;
            const arcEnd = eReg.profileMeta.arcEnd ?? Math.PI;
            const loftSpec: GeneralizedLoftPayload = {
              axis: loftAxis,
              w0: wMin,
              w1: wMax,
              section0: {
                kind: rAtMin <= 0.2 ? 'point' : 'semicircle',
                centerU: c0.u,
                centerV: c0.v,
                radiusU: rAtMin,
                arcStart,
                arcEnd,
                flatChordAxis: eReg.profileMeta.chordAxis,
                flatChordVal: eReg.profileMeta.chordCoord,
                keepGreater: eReg.profileMeta.keepGreater,
              },
              section1: {
                kind: rAtMax <= 0.2 ? 'point' : 'semicircle',
                centerU: c0.u,
                centerV: c0.v,
                radiusU: rAtMax,
                arcStart,
                arcEnd,
                flatChordAxis: eReg.profileMeta.chordAxis,
                flatChordVal: eReg.profileMeta.chordCoord,
                keepGreater: eReg.profileMeta.keepGreater,
              },
            };
            const b = makeBoxBoundsFromAxisSpan(
              loftAxis,
              eReg.bounds.uMin,
              eReg.bounds.uMax,
              eReg.bounds.vMin,
              eReg.bounds.vMax,
              wMin,
              wMax
            );
            const semiLoftPrim: Primitive3D = {
              id: `prim_semicone_${seq}`,
              featureId: `feat_semicone_${seq}`,
              label:
                Math.min(rAtMin, rAtMax) <= 0.2
                  ? `半圆锥 R${R.toFixed(0)}`
                  : `半圆台 R${rAtMin.toFixed(0)}→R${rAtMax.toFixed(0)}`,
              operation: 'add',
              shape: 'generalized_loft',
              ...b,
              rMin: rAtMin,
              rMax: rAtMax,
              loftSpec,
            };
            markQuadricEnvelope(b);
            pushCandidate(
              [semiLoftPrim],
              [
                { view: endArr.view, regionId: eReg.id },
                { view: sideArr.view, regionId: sReg.id },
              ],
              semiLoftPrim.label,
              46,
              true
            );
            continue;
          }
        }

        // (iii) POLYGONAL PYRAMID & POLYGONAL FRUSTUM:
        //       Regular / general polygon in `endArr` + Triangle / Trapezoid in `sideArr`!
        if (
          (eReg.profileKind === 'regular_polygon' ||
            (eReg.profileKind === 'general_polygon' &&
              (eReg.profileMeta?.sides ?? 0) >= 5)) &&
          isSideTaper &&
          sReg.profileMeta
        ) {
          const rAtMin = sReg.profileMeta.rAtMin ?? 0;
          const rAtMax = sReg.profileMeta.rAtMax ?? 0;
          const halfSpan = 0.5 * (eShared1 - eShared0);
          const rLarger = Math.max(rAtMin, rAtMax);
          if (Math.abs(rLarger - halfSpan) <= 1.5 && halfSpan > 1) {
            const cu = 0.5 * (eReg.bounds.uMin + eReg.bounds.uMax);
            const cv = 0.5 * (eReg.bounds.vMin + eReg.bounds.vMax);
            const baseVerts = extractCleanPolygonVertices(eReg);
            const scale0 = rAtMin / halfSpan;
            const scale1 = rAtMax / halfSpan;
            const poly0 = baseVerts.map((q) => ({
              u: cu + (q.u - cu) * scale0,
              v: cv + (q.v - cv) * scale0,
            }));
            const poly1 = baseVerts.map((q) => ({
              u: cu + (q.u - cu) * scale1,
              v: cv + (q.v - cv) * scale1,
            }));
            const loftSpec: GeneralizedLoftPayload = {
              axis: loftAxis,
              w0: wMin,
              w1: wMax,
              section0: {
                kind: scale0 <= 0.02 ? 'point' : 'polygon',
                centerU: cu,
                centerV: cv,
                radiusU: rAtMin,
                polygon: scale0 <= 0.02 ? undefined : poly0,
              },
              section1: {
                kind: scale1 <= 0.02 ? 'point' : 'polygon',
                centerU: cu,
                centerV: cv,
                radiusU: rAtMax,
                polygon: scale1 <= 0.02 ? undefined : poly1,
              },
            };
            const b = makeBoxBoundsFromAxisSpan(
              loftAxis,
              eReg.bounds.uMin,
              eReg.bounds.uMax,
              eReg.bounds.vMin,
              eReg.bounds.vMax,
              wMin,
              wMax
            );
            const pyrPrim: Primitive3D = {
              id: `prim_poly_loft_${seq}`,
              featureId: `feat_poly_loft_${seq}`,
              label:
                Math.min(scale0, scale1) <= 0.02 ? '正多棱锥' : '正多棱台',
              operation: 'add',
              shape: 'generalized_loft',
              ...b,
              loftSpec,
            };
            markQuadricEnvelope(b);
            pushCandidate(
              [pyrPrim],
              [
                { view: endArr.view, regionId: eReg.id },
                { view: sideArr.view, regionId: sReg.id },
              ],
              pyrPrim.label,
              44,
              true
            );
            continue;
          }
        }

        // (iv) EXACT POLYGONAL / CURVED PRISM (Regular Hexagon, Arch, Semicircle Cylinder, Atomic L-Block, Slanted Wedge):
        //      Non-rectangular profile `eReg` in `endArr` + true rectangular side silhouette `sReg` in `sideArr`!
        const sBboxArea = Math.max(
          1e-3,
          (sShared1 - sShared0) * (wMax - wMin)
        );
        const sFillsRect =
          sReg.profileKind === 'rectangle' ||
          (Boolean(sReg.isFullEnvelope) &&
            Math.abs(sReg.area - sBboxArea) / sBboxArea <= 0.045);

        // Skip artificial rectilinear shared-chord unions (their constituent atomic rectangles lift cleanly in Section 4 with exact per-tier depths!)
        const isArtificialRectilinearUnion =
          eReg.isSharedChordUnion &&
          eReg.boundarySegments.every(
            (seg) =>
              seg.kind === 'line' &&
              (Math.abs(seg.p1.u - seg.p2.u) < 0.05 ||
                Math.abs(seg.p1.v - seg.p2.v) < 0.05)
          );

        // Skip leftover concave `curved_loop` panels created when a foreground solid cylinder boss splits a rectangular base!
        const isCylinderBiteLeftover =
          eReg.profileKind === 'curved_loop' &&
          eReg.boundarySegments.some(
            (seg) =>
              seg.kind === 'arc' &&
              seg.center &&
              seg.radius !== undefined &&
              solidCircles.some(
                (vc) =>
                  dist2(vc.center, seg.center!) <= 0.8 &&
                  Math.abs(vc.radius - seg.radius!) <= 0.8
              )
          );

        if (
          eReg.profileKind !== 'rectangle' &&
          !eReg.isSubDecomposed &&
          !isArtificialRectilinearUnion &&
          !isCylinderBiteLeftover &&
          sFillsRect
        ) {
          // If `sideArr` has interior nested regions (e.g. narrow inner boss depth), do not extrude a rectilinear profile uniformly across the outer frame!
          const isRectilinearAtomic =
            eReg.profileKind === 'general_polygon' &&
            eReg.boundarySegments.every(
              (seg) =>
                seg.kind === 'line' &&
                (Math.abs(seg.p1.u - seg.p2.u) < 0.05 ||
                  Math.abs(seg.p1.v - seg.p2.v) < 0.05)
            );
          if (isRectilinearAtomic && sideArr.innerRegions.length > 0) {
            continue;
          }

          const b = makeBoxBoundsFromAxisSpan(
            loftAxis,
            eReg.bounds.uMin,
            eReg.bounds.uMax,
            eReg.bounds.vMin,
            eReg.bounds.vMax,
            wMin,
            wMax
          );
          if (isInsideClaimedQuadricEnvelope(b)) continue;

          const cleanVerts =
            eReg.profileKind === 'arch' ||
            eReg.profileKind === 'semicircle' ||
            eReg.profileKind === 'curved_loop'
              ? eReg.polygon
              : extractCleanPolygonVertices(eReg);

          const prismPrim: Primitive3D = {
            id: `prim_prism_${seq}`,
            featureId: `feat_prism_${seq}`,
            label:
              eReg.profileKind === 'regular_polygon'
                ? `正${eReg.profileMeta?.sides ?? 6}棱柱`
                : eReg.profileKind === 'arch'
                ? '拱形柱体'
                : '精确截面柱体',
            operation: 'add',
            shape: 'prism',
            ...b,
            prismAxis: loftAxis,
            prismPolygon: cleanVerts,
            prismSegments: eReg.boundarySegments,
          };
          if (
            eReg.profileKind === 'regular_polygon' ||
            eReg.profileKind === 'arch' ||
            eReg.profileKind === 'semicircle'
          ) {
            markQuadricEnvelope(b);
          }
          pushCandidate(
            [prismPrim],
            [
              { view: endArr.view, regionId: eReg.id },
              { view: sideArr.view, regionId: sReg.id },
            ],
            prismPrim.label,
            eReg.profileKind === 'regular_polygon' ||
              eReg.profileKind === 'arch' ||
              eReg.profileKind === 'semicircle'
              ? 42
              : 32,
            eReg.nestingDepth === 0
          );
        }
      }
    }
  };

  // Run directional lifting symmetrically in BOTH view orders:
  // Order 1: arr1 = end-on view, arr2 = side view -> loftAxis = arr1's normal axis (which equals arr2's free axis!)
  liftDirectionalPair(
    arr1,
    arr2,
    mapping.v1Coord,
    mapping.v1FreeCoord,
    mapping.v1FreeAxis,
    mapping.v2Coord,
    mapping.v2FreeCoord,
    mapping.v2FreeAxis
  );

  // Order 2: arr2 = end-on view, arr1 = side view -> loftAxis = arr2's normal axis (which equals arr1's free axis!)
  liftDirectionalPair(
    arr2,
    arr1,
    mapping.v2Coord,
    mapping.v2FreeCoord,
    mapping.v2FreeAxis,
    mapping.v1Coord,
    mapping.v1FreeCoord,
    mapping.v1FreeAxis
  );

  // ==========================================================================
  // 3. TWO SIDE VIEWS OF A REVOLUTION BODY (Cone / Frustum / Cylinder along the sharedAxis!)
  //    Example: Known views = ('front', 'top'), Cone axis = X!
  //    Both 'front' (X,Z) and 'top' (X,Y) show identical-taper triangles/trapezoids along X,
  //    or known views = ('front', 'left'), Cone axis = Z! Both show triangles/trapezoids along Z!
  // ==========================================================================
  for (const r1 of arr1.regions) {
    const isTaper1 =
      (mapping.v1Coord === 'v' &&
        (r1.profileKind === 'triangle_v' || r1.profileKind === 'trapezoid_v')) ||
      (mapping.v1Coord === 'u' &&
        (r1.profileKind === 'triangle_h' || r1.profileKind === 'trapezoid_h'));
    if (!isTaper1 || !r1.profileMeta) continue;

    const [w1Min, w1Max] = getSpanOnCoord(r1.bounds, mapping.v1Coord);
    const r1AtMin = r1.profileMeta.rAtMin ?? 0;
    const r1AtMax = r1.profileMeta.rAtMax ?? 0;
    const c1AtMin = r1.profileMeta.cAtMin ?? 0;
    const c1AtMax = r1.profileMeta.cAtMax ?? 0;

    for (const r2 of arr2.regions) {
      const isTaper2 =
        (mapping.v2Coord === 'v' &&
          (r2.profileKind === 'triangle_v' || r2.profileKind === 'trapezoid_v')) ||
        (mapping.v2Coord === 'u' &&
          (r2.profileKind === 'triangle_h' || r2.profileKind === 'trapezoid_h'));
      if (!isTaper2 || !r2.profileMeta) continue;

      const [w2Min, w2Max] = getSpanOnCoord(r2.bounds, mapping.v2Coord);
      if (!spansMatch(w1Min, w1Max, w2Min, w2Max, 1.2)) continue;

      const r2AtMin = r2.profileMeta.rAtMin ?? 0;
      const r2AtMax = r2.profileMeta.rAtMax ?? 0;
      const c2AtMin = r2.profileMeta.cAtMin ?? 0;
      const c2AtMax = r2.profileMeta.cAtMax ?? 0;

      if (
        Math.abs(r1AtMin - r2AtMin) <= 1.2 &&
        Math.abs(r1AtMax - r2AtMax) <= 1.2
      ) {
        const revAxis = mapping.sharedAxis;
        // Assemble 2D cross-section centers (u_perp, v_perp) in revAxis's perpendicular plane
        const cMin3 = assemble3DPoint(
          revAxis,
          w1Min,
          mapping.v1FreeAxis,
          c1AtMin,
          mapping.v2FreeAxis,
          c2AtMin
        );
        const cMax3 = assemble3DPoint(
          revAxis,
          w1Max,
          mapping.v1FreeAxis,
          c1AtMax,
          mapping.v2FreeAxis,
          c2AtMax
        );
        const u0 = revAxis === 'X' ? cMin3.y : cMin3.x;
        const v0 = revAxis === 'Z' ? cMin3.y : cMin3.z;
        const u1 = revAxis === 'X' ? cMax3.y : cMax3.x;
        const v1 = revAxis === 'Z' ? cMax3.y : cMax3.z;
        const rad0 = 0.5 * (r1AtMin + r2AtMin);
        const rad1 = 0.5 * (r1AtMax + r2AtMax);

        const loftSpec: GeneralizedLoftPayload = {
          axis: revAxis,
          w0: w1Min,
          w1: w1Max,
          section0: {
            kind: rad0 <= 0.2 ? 'point' : 'circle',
            centerU: u0,
            centerV: v0,
            radiusU: rad0,
          },
          section1: {
            kind: rad1 <= 0.2 ? 'point' : 'circle',
            centerU: u1,
            centerV: v1,
            radiusU: rad1,
          },
        };
        const b: BoundingBox3D = {
          xMin: Math.min(cMin3.x - (revAxis === 'X' ? 0 : rad0), cMax3.x - (revAxis === 'X' ? 0 : rad1)),
          xMax: Math.max(cMin3.x + (revAxis === 'X' ? 0 : rad0), cMax3.x + (revAxis === 'X' ? 0 : rad1)),
          yMin: Math.min(cMin3.y - (revAxis === 'Y' ? 0 : rad0), cMax3.y - (revAxis === 'Y' ? 0 : rad1)),
          yMax: Math.max(cMin3.y + (revAxis === 'Y' ? 0 : rad0), cMax3.y + (revAxis === 'Y' ? 0 : rad1)),
          zMin: Math.min(cMin3.z - (revAxis === 'Z' ? 0 : rad0), cMax3.z - (revAxis === 'Z' ? 0 : rad1)),
          zMax: Math.max(cMin3.z + (revAxis === 'Z' ? 0 : rad0), cMax3.z + (revAxis === 'Z' ? 0 : rad1)),
        };

        const hasCL =
          hasRevolutionCenterline(arr1, mapping.v1Coord, 0.5 * (c1AtMin + c1AtMax)) ||
          hasRevolutionCenterline(arr2, mapping.v2Coord, 0.5 * (c2AtMin + c2AtMax));

        const conePrim: Primitive3D = {
          id: `prim_dual_cone_${seq}`,
          featureId: `feat_cone_${seq}`,
          label:
            Math.min(rad0, rad1) <= 0.2
              ? `${revAxis}轴圆锥`
              : `${revAxis}轴圆台`,
          operation: 'add',
          shape: 'generalized_loft',
          ...b,
          rMin: rad0,
          rMax: rad1,
          loftSpec,
        };
        if (hasCL) markQuadricEnvelope(b);
        pushCandidate(
          [conePrim],
          [
            { view: arr1.view, regionId: r1.id },
            { view: arr2.view, regionId: r2.id },
          ],
          conePrim.label,
          hasCL ? 48 : 38,
          hasCL
        );
      }
    }
  }

  // Also check Semi-Cone / Semi-Frustum from symmetric triangle/trapezoid in one view + right-angled triangle/trapezoid in other view!
  for (const [aSym, cSym, fSymAxis, aRight, cRight, fRightCoord, fRightAxis] of [
    [
      arr1,
      mapping.v1Coord,
      mapping.v1FreeAxis,
      arr2,
      mapping.v2Coord,
      mapping.v2FreeCoord,
      mapping.v2FreeAxis,
    ] as const,
    [
      arr2,
      mapping.v2Coord,
      mapping.v2FreeAxis,
      arr1,
      mapping.v1Coord,
      mapping.v1FreeCoord,
      mapping.v1FreeAxis,
    ] as const,
  ]) {
    for (const rSym of aSym.regions) {
      const isSymTaper =
        (cSym === 'v' &&
          (rSym.profileKind === 'triangle_v' ||
            rSym.profileKind === 'trapezoid_v')) ||
        (cSym === 'u' &&
          (rSym.profileKind === 'triangle_h' ||
            rSym.profileKind === 'trapezoid_h'));
      if (!isSymTaper || !rSym.profileMeta) continue;
      const [wMin, wMax] = getSpanOnCoord(rSym.bounds, cSym);
      const r0 = rSym.profileMeta.rAtMin ?? 0;
      const r1 = rSym.profileMeta.rAtMax ?? 0;
      const rMaxVal = Math.max(r0, r1);
      const symCenter = 0.5 * ((rSym.profileMeta.cAtMin ?? 0) + (rSym.profileMeta.cAtMax ?? 0));

      for (const rRt of aRight.regions) {
        const isRtTaper =
          (cRight === 'v' &&
            (rRt.profileKind === 'triangle_v' ||
              rRt.profileKind === 'trapezoid_v')) ||
          (cRight === 'u' &&
            (rRt.profileKind === 'triangle_h' ||
              rRt.profileKind === 'trapezoid_h'));
        if (!isRtTaper) continue;
        const [rwMin, rwMax] = getSpanOnCoord(rRt.bounds, cRight);
        if (!spansMatch(wMin, wMax, rwMin, rwMax, 1.2)) continue;
        const [fMin, fMax] = getSpanOnCoord(rRt.bounds, fRightCoord);
        // Right-angled semi-cone/semi-frustum has width = R (half of 2*R)!
        if (Math.abs(fMax - fMin - rMaxVal) <= 1.2) {
          // Check which side (fMin or fMax) is the vertical/straight chord wall!
          const verts = extractCleanPolygonVertices(rRt);
          const countAtMin = verts.filter(
            (p) => Math.abs((fRightCoord === 'u' ? p.u : p.v) - fMin) <= 0.6
          ).length;
          const countAtMax = verts.filter(
            (p) => Math.abs((fRightCoord === 'u' ? p.u : p.v) - fMax) <= 0.6
          ).length;
          if (countAtMin >= 2 || countAtMax >= 2) {
            const flatVal = countAtMin >= 2 ? fMin : fMax;
            const keepPos = countAtMin >= 2;
            const revAxis = mapping.sharedAxis;
            const c3 = assemble3DPoint(
              revAxis,
              wMin,
              fSymAxis,
              symCenter,
              fRightAxis,
              flatVal
            );
            const cu = revAxis === 'X' ? c3.y : c3.x;
            const cv = revAxis === 'Z' ? c3.y : c3.z;
            // Determine arcStart, arcEnd in (u_perp, v_perp) of revAxis
            const fRightIsVInPerp =
              (revAxis === 'Z' && fRightAxis === 'Y') ||
              (revAxis === 'Y' && fRightAxis === 'Z') ||
              (revAxis === 'X' && fRightAxis === 'Z');
            const arcStart = fRightIsVInPerp
              ? keepPos
                ? 0
                : Math.PI
              : keepPos
              ? -Math.PI / 2
              : Math.PI / 2;
            const arcEnd = arcStart + Math.PI;

            const loftSpec: GeneralizedLoftPayload = {
              axis: revAxis,
              w0: wMin,
              w1: wMax,
              section0: {
                kind: r0 <= 0.2 ? 'point' : 'semicircle',
                centerU: cu,
                centerV: cv,
                radiusU: r0,
                arcStart,
                arcEnd,
                flatChordAxis: fRightIsVInPerp ? 'v' : 'u',
                flatChordVal: flatVal,
                keepGreater: keepPos,
              },
              section1: {
                kind: r1 <= 0.2 ? 'point' : 'semicircle',
                centerU: cu,
                centerV: cv,
                radiusU: r1,
                arcStart,
                arcEnd,
                flatChordAxis: fRightIsVInPerp ? 'v' : 'u',
                flatChordVal: flatVal,
                keepGreater: keepPos,
              },
            };
            const b = assemble3DBoxFromViews(
              mapping,
              wMin,
              wMax,
              symCenter - rMaxVal,
              symCenter + rMaxVal,
              fMin,
              fMax,
              aSym.view === arr1.view
            );
            const prim: Primitive3D = {
              id: `prim_dual_semicone_${seq}`,
              featureId: `feat_semicone_${seq}`,
              label: Math.min(r0, r1) <= 0.2 ? '半圆锥' : '半圆台',
              operation: 'add',
              shape: 'generalized_loft',
              ...b,
              rMin: r0,
              rMax: r1,
              loftSpec,
            };
            markQuadricEnvelope(b);
            pushCandidate(
              [prim],
              [
                { view: aSym.view, regionId: rSym.id },
                { view: aRight.view, regionId: rRt.id },
              ],
              prim.label,
              46,
              true
            );
          }
        }
      }
    }
  }

  // ==========================================================================
  // 4. EXACT PROFILE-PRODUCT ATOMIC & STEPPED CELLS (Boxes & Clipped Prisms)
  //    Pairs atomic & stepped sub-regions (r1, r2) whose shared-axis intervals overlap!
  //    CRITICAL: Skips any cell whose 3D bounding box matches an already-claimed quadric /
  //    GeneralizedLoft / hexagonal prism envelope (automatically stripping Steinmetz ears!).
  // ==========================================================================
  // Helper: check if a region is a rectangle whose only curved/indent boundary is a bite from an already-lifted solid cylinder boss!
  // By Boolean algebra: `(Rect \ Cylinder) ∪ Cylinder === Rect ∪ Cylinder`, so restoring `Rect` (`box`) eliminates 64-gon co-cylindrical CSG degeneracies!
  const isRectMinusSolidBossCircle = (
    reg: CompositeRegion2D,
    arr: ViewArrangementResult
  ): boolean => {
    if (reg.profileKind === 'rectangle') return true;
    if (reg.profileKind !== 'curved_loop') return false;
    const arcs = reg.boundarySegments.filter((s) => s.kind === 'arc');
    const lines = reg.boundarySegments.filter((s) => s.kind === 'line');
    if (arcs.length === 0) return false;
    const allLinesAxisAligned = lines.every(
      (l) =>
        Math.abs(l.p1.u - l.p2.u) < 0.06 ||
        Math.abs(l.p1.v - l.p2.v) < 0.06
    );
    if (!allLinesAxisAligned) return false;
    return arcs.every(
      (a) =>
        a.center !== undefined &&
        a.radius !== undefined &&
        arr.circleCarriers.some(
          (vc) =>
            vc.dominantLineType === 'thick_solid' &&
            vc.isFullCircleEntity &&
            dist2(vc.center, a.center!) <= 0.8 &&
            Math.abs(vc.radius - a.radius!) <= 0.8
        )
    );
  };

  const isArtificialRectUnion = (reg: CompositeRegion2D): boolean =>
    reg.isSharedChordUnion &&
    reg.boundarySegments.every(
      (s) =>
        s.kind === 'line' &&
        (Math.abs(s.p1.u - s.p2.u) < 0.06 ||
          Math.abs(s.p1.v - s.p2.v) < 0.06)
    );

  // Synthesize continuous step carrier regions when two co-height rectangular sub-regions `[sA0..sA1]` and `[sB0..sB1]`
  // share the exact same free-axis height `[fMin..fMax]` and are interrupted only by a taller foreground feature spanning `[sA1..sB0]`!
  const supersededStepPartIds = new Set<string>();
  const withBridgedStepCarriers = (
    regs: CompositeRegion2D[],
    arr: ViewArrangementResult,
    sharedCoord: 'u' | 'v',
    freeCoord: 'u' | 'v'
  ): CompositeRegion2D[] => {
    const out = [...regs];
    const rects = regs.filter(
      (r) => !r.isSharedChordUnion && isRectMinusSolidBossCircle(r, arr)
    );
    for (let i = 0; i < rects.length; i++) {
      for (let j = i + 1; j < rects.length; j++) {
        const a = rects[i];
        const b = rects[j];
        const [fa0, fa1] = getSpanOnCoord(a.bounds, freeCoord);
        const [fb0, fb1] = getSpanOnCoord(b.bounds, freeCoord);
        if (Math.abs(fa0 - fb0) > 0.6 || Math.abs(fa1 - fb1) > 0.6) continue;

        const [sa0, sa1] = getSpanOnCoord(a.bounds, sharedCoord);
        const [sb0, sb1] = getSpanOnCoord(b.bounds, sharedCoord);
        const leftEnd = Math.min(sa1, sb1);
        const rightStart = Math.max(sa0, sb0);
        if (rightStart - leftEnd < 2.0) continue;

        // Check if an interrupting taller solid feature occupies `[leftEnd, rightStart]` and rises above `fa1`
        const hasTallerInterruptor = regs.some((mid) => {
          const [sm0, sm1] = getSpanOnCoord(mid.bounds, sharedCoord);
          const [fm0, fm1] = getSpanOnCoord(mid.bounds, freeCoord);
          return (
            Math.abs(sm0 - leftEnd) <= 1.0 &&
            Math.abs(sm1 - rightStart) <= 1.0 &&
            fm0 <= fa0 + 1.0 &&
            fm1 > fa1 + 1.0
          );
        });
        if (!hasTallerInterruptor) continue;

        supersededStepPartIds.add(`${arr.view}:${a.id}`);
        supersededStepPartIds.add(`${arr.view}:${b.id}`);

        const uMin = Math.min(a.bounds.uMin, b.bounds.uMin);
        const uMax = Math.max(a.bounds.uMax, b.bounds.uMax);
        const vMin = Math.min(a.bounds.vMin, b.bounds.vMin);
        const vMax = Math.max(a.bounds.vMax, b.bounds.vMax);
        const poly: Point2D[] = [
          { u: uMin, v: vMin },
          { u: uMax, v: vMin },
          { u: uMax, v: vMax },
          { u: uMin, v: vMax },
        ];
        out.push({
          id: `reg_${arr.view}_bridged_${i}_${j}`,
          view: arr.view,
          lineType: 'thick_solid',
          atomicFaceIds: [...a.atomicFaceIds, ...b.atomicFaceIds],
          boundarySegments: [
            { id: 'bs0', kind: 'line', p1: poly[0], p2: poly[1], lineType: 'thick_solid', sourceEntityId: a.id },
            { id: 'bs1', kind: 'line', p1: poly[1], p2: poly[2], lineType: 'thick_solid', sourceEntityId: a.id },
            { id: 'bs2', kind: 'line', p1: poly[2], p2: poly[3], lineType: 'thick_solid', sourceEntityId: a.id },
            { id: 'bs3', kind: 'line', p1: poly[3], p2: poly[0], lineType: 'thick_solid', sourceEntityId: a.id },
          ],
          polygon: poly,
          area: (uMax - uMin) * (vMax - vMin),
          bounds: { uMin, uMax, vMin, vMax },
          interiorPoint: { u: 0.5 * (uMin + uMax), v: 0.5 * (vMin + vMax) },
          nestingDepth: 0,
          parentRegionId: null,
          childRegionIds: [],
          isSharedChordUnion: false,
          profileKind: 'rectangle',
          profileMeta: {},
        });
      }
    }
    return out;
  };

  const atomicOrStep1 = withBridgedStepCarriers(
    arr1.regions.filter(
      (r) => !r.isSubDecomposed && r.profileKind !== 'circle'
    ),
    arr1,
    mapping.v1Coord,
    mapping.v1FreeCoord
  );
  const atomicOrStep2 = withBridgedStepCarriers(
    arr2.regions.filter(
      (r) => !r.isSubDecomposed && r.profileKind !== 'circle'
    ),
    arr2,
    mapping.v2Coord,
    mapping.v2FreeCoord
  );

  for (const r1 of atomicOrStep1) {
    if (
      !r1.isFullEnvelope &&
      (claimedAnalyticRegionIds.has(`${arr1.view}:${r1.id}`) ||
        supersededStepPartIds.has(`${arr1.view}:${r1.id}`))
    ) {
      continue;
    }

    // Do not lift inner holes (`nestingDepth >= 1`) as standalone boxes unless they match a solid boss in arr2!
    const [s1Min, s1Max] = getSpanOnCoord(r1.bounds, mapping.v1Coord);
    const [f1Min, f1Max] = getSpanOnCoord(r1.bounds, mapping.v1FreeCoord);

    if (r1.nestingDepth >= 1) {
      const matchesBoss2 = atomicOrStep2.some((r2) => {
        const [s2Min, s2Max] = getSpanOnCoord(r2.bounds, mapping.v2Coord);
        return !r2.isFullEnvelope && spansMatch(s1Min, s1Max, s2Min, s2Max, 1.2);
      });
      if (!matchesBoss2) continue;
    }

    const r1ActsAsRect = isRectMinusSolidBossCircle(r1, arr1);
    // Do not extrude artificial multi-panel non-rectangular unions (e.g. T-shaped union of separate step & boss faces) in Section 4;
    // genuine multi-panel analytic profiles (regular_polygon, semicircle) are already lifted in Sections 2 & 3!
    if (!r1ActsAsRect && r1.isSharedChordUnion) continue;

    // If `r1` is a sub-span feature that ALREADY has an exact shared-axis partner in `atomicOrStep2`,
    // do not loosely expand `r1` across wider outer base envelopes via `r1InR2`!
    const r1HasExactPartner = atomicOrStep2.some((cand2) => {
      if (r1ActsAsRect && isArtificialRectUnion(cand2)) return false;
      const [c2Min, c2Max] = getSpanOnCoord(cand2.bounds, mapping.v2Coord);
      return !cand2.isFullEnvelope && spansMatch(s1Min, s1Max, c2Min, c2Max, 1.2);
    });

    for (const r2 of atomicOrStep2) {
      if (
        !r2.isFullEnvelope &&
        (claimedAnalyticRegionIds.has(`${arr2.view}:${r2.id}`) ||
          supersededStepPartIds.has(`${arr2.view}:${r2.id}`))
      ) {
        continue;
      }
      const [s2Min, s2Max] = getSpanOnCoord(r2.bounds, mapping.v2Coord);
      const [f2Min, f2Max] = getSpanOnCoord(r2.bounds, mapping.v2FreeCoord);

      const r2ActsAsRect = isRectMinusSolidBossCircle(r2, arr2);
      if (!r2ActsAsRect && r2.isSharedChordUnion) continue;

      // Skip artificial multi-panel rectangular unions ONLY when both regions act as pure rectangles
      // (When one side is an atomic L-block / arch / sloped polygon, pairing it with the full rectangular envelope in the other view yields the exact 1-piece prism!)
      if (
        r1ActsAsRect &&
        r2ActsAsRect &&
        (isArtificialRectUnion(r1) || isArtificialRectUnion(r2))
      ) {
        continue;
      }

      if (r2.nestingDepth >= 1) {
        if (r1.isFullEnvelope || !spansMatch(s1Min, s1Max, s2Min, s2Max, 1.2)) {
          continue;
        }
      }

      // Avoid pairing two artificial multi-panel full-envelope unions unless one is a non-rect polygon
      if (
        r1.isSharedChordUnion &&
        r2.isSharedChordUnion &&
        r1ActsAsRect &&
        r2ActsAsRect
      ) {
        continue;
      }

      const r2HasExactPartner = atomicOrStep1.some((cand1) => {
        if (r2ActsAsRect && isArtificialRectUnion(cand1)) return false;
        const [c1Min, c1Max] = getSpanOnCoord(cand1.bounds, mapping.v1Coord);
        return !cand1.isFullEnvelope && spansMatch(s2Min, s2Max, c1Min, c1Max, 1.2);
      });

      // Require exact span match OR clean containment when no exact partner exists (stepped sub-region inside continuous base!)
      const exactMatch = spansMatch(s1Min, s1Max, s2Min, s2Max, 1.2);
      const r1InR2 =
        !r1HasExactPartner &&
        !r1.isSharedChordUnion &&
        spanContains(s2Min, s2Max, s1Min, s1Max, 1.2) &&
        r2ActsAsRect;
      const r2InR1 =
        !r2HasExactPartner &&
        !r2.isSharedChordUnion &&
        spanContains(s1Min, s1Max, s2Min, s2Max, 1.2) &&
        r1ActsAsRect;

      if (!exactMatch && !r1InR2 && !r2InR1) continue;

      const ovMin = Math.max(s1Min, s2Min);
      const ovMax = Math.min(s1Max, s2Max);
      if (ovMax - ovMin < 1.5) continue;

      const box3 = assemble3DBoxFromViews(
        mapping,
        ovMin,
        ovMax,
        f1Min,
        f1Max,
        f2Min,
        f2Max,
        true
      );

      // Strip Steinmetz / AABB box over an already-claimed quadric / GeneralizedLoft / polygonal prism!
      if (isInsideClaimedQuadricEnvelope(box3)) continue;
      // Also skip sub-strip boxes that are slices of a claimed regular polygon / cone / sphere!
      const midTest = {
        x: 0.5 * (box3.xMin + box3.xMax),
        y: 0.5 * (box3.yMin + box3.yMax),
        z: 0.5 * (box3.zMin + box3.zMax),
      };
      const isSliceOfClaimedQuadric = claimedQuadricEnvelopes.some(
        (qb) =>
          midTest.x >= qb.xMin + 0.1 &&
          midTest.x <= qb.xMax - 0.1 &&
          midTest.y >= qb.yMin + 0.1 &&
          midTest.y <= qb.yMax - 0.1 &&
          midTest.z >= qb.zMin + 0.1 &&
          midTest.z <= qb.zMax - 0.1 &&
          box3.xMin >= qb.xMin - 0.8 &&
          box3.xMax <= qb.xMax + 0.8 &&
          box3.yMin >= qb.yMin - 0.8 &&
          box3.yMax <= qb.yMax + 0.8 &&
          box3.zMin >= qb.zMin - 0.8 &&
          box3.zMax <= qb.zMax + 0.8
      );
      if (isSliceOfClaimedQuadric) continue;

      if (r1ActsAsRect && r2ActsAsRect) {
        const boxPrim: Primitive3D = {
          id: `prim_box_${seq}`,
          featureId: `feat_box_${seq}`,
          label: `正交体元 (${(box3.xMax - box3.xMin).toFixed(0)}×${(
            box3.yMax - box3.yMin
          ).toFixed(0)}×${(box3.zMax - box3.zMin).toFixed(0)})`,
          operation: 'add',
          shape: 'box',
          ...box3,
        };
        pushCandidate(
          [boxPrim],
          [
            { view: arr1.view, regionId: r1.id },
            { view: arr2.view, regionId: r2.id },
          ],
          boxPrim.label,
          exactMatch ? 20 : 12,
          false
        );
      } else if (!r1ActsAsRect && r2ActsAsRect) {
        const axis1 = getViewAxisSpec(arr1.view).wAxis;
        const pPrim: Primitive3D = {
          id: `prim_p1_${seq}`,
          featureId: `feat_prism_${seq}`,
          label: '截面拉伸体元',
          operation: 'add',
          shape: 'prism',
          ...box3,
          prismAxis: axis1,
          prismPolygon: extractCleanPolygonVertices(r1),
          prismSegments: r1.boundarySegments,
        };
        pushCandidate(
          [pPrim],
          [
            { view: arr1.view, regionId: r1.id },
            { view: arr2.view, regionId: r2.id },
          ],
          pPrim.label,
          24,
          false
        );
      } else if (r1ActsAsRect && !r2ActsAsRect) {
        const axis2 = getViewAxisSpec(arr2.view).wAxis;
        const pPrim: Primitive3D = {
          id: `prim_p2_${seq}`,
          featureId: `feat_prism_${seq}`,
          label: '截面拉伸体元',
          operation: 'add',
          shape: 'prism',
          ...box3,
          prismAxis: axis2,
          prismPolygon: extractCleanPolygonVertices(r2),
          prismSegments: r2.boundarySegments,
        };
        pushCandidate(
          [pPrim],
          [
            { view: arr1.view, regionId: r1.id },
            { view: arr2.view, regionId: r2.id },
          ],
          pPrim.label,
          24,
          false
        );
      } else if (exactMatch) {
        // BOTH r1 and r2 are non-rectangular profiles -> Exact boolean intersection of two prisms!
        const wg = `wg_int_${seq}`;
        const axis1 = getViewAxisSpec(arr1.view).wAxis;
        const axis2 = getViewAxisSpec(arr2.view).wAxis;
        const pA: Primitive3D = {
          id: `prim_intA_${seq}`,
          featureId: `feat_int_${seq}`,
          label: '双向精确斜切交集体A',
          operation: 'add',
          weldGroup: wg,
          shape: 'prism',
          ...box3,
          prismAxis: axis1,
          prismPolygon: extractCleanPolygonVertices(r1),
          prismSegments: r1.boundarySegments,
        };
        const pB: Primitive3D = {
          id: `prim_intB_${seq}`,
          featureId: `feat_int_${seq}`,
          label: '双向精确斜切交集体B',
          operation: 'intersect',
          weldGroup: wg,
          shape: 'prism',
          ...box3,
          prismAxis: axis2,
          prismPolygon: extractCleanPolygonVertices(r2),
          prismSegments: r2.boundarySegments,
        };
        pushCandidate(
          [pA, pB],
          [
            { view: arr1.view, regionId: r1.id },
            { view: arr2.view, regionId: r2.id },
          ],
          '双向截面精确半空间交集体',
          26,
          false
        );
      }
    }
  }

  return candidates;
}

// ============================================================================
// Internal Geometric Helpers
// ============================================================================

function assemble3DPoint(
  a1: Axis3D,
  v1: number,
  a2: Axis3D,
  v2: number,
  a3: Axis3D,
  v3: number
): { x: number; y: number; z: number } {
  const out = { x: 0, y: 0, z: 0 };
  const put = (ax: Axis3D, val: number) => {
    if (ax === 'X') out.x = val;
    else if (ax === 'Y') out.y = val;
    else out.z = val;
  };
  put(a1, v1);
  put(a2, v2);
  put(a3, v3);
  return out;
}

function assemble3DBoxFromViews(
  mapping: ReturnType<typeof getSharedAxisBetweenViews>,
  sMin: number,
  sMax: number,
  f1Min: number,
  f1Max: number,
  f2Min: number,
  f2Max: number,
  firstIsV1: boolean
): BoundingBox3D {
  const pLo = assemble3DPoint(
    mapping.sharedAxis,
    sMin,
    firstIsV1 ? mapping.v1FreeAxis : mapping.v2FreeAxis,
    f1Min,
    firstIsV1 ? mapping.v2FreeAxis : mapping.v1FreeAxis,
    f2Min
  );
  const pHi = assemble3DPoint(
    mapping.sharedAxis,
    sMax,
    firstIsV1 ? mapping.v1FreeAxis : mapping.v2FreeAxis,
    f1Max,
    firstIsV1 ? mapping.v2FreeAxis : mapping.v1FreeAxis,
    f2Max
  );
  return {
    xMin: Math.min(pLo.x, pHi.x),
    xMax: Math.max(pLo.x, pHi.x),
    yMin: Math.min(pLo.y, pHi.y),
    yMax: Math.max(pLo.y, pHi.y),
    zMin: Math.min(pLo.z, pHi.z),
    zMax: Math.max(pLo.z, pHi.z),
  };
}

function extractCleanPolygonVertices(reg: CompositeRegion2D): Point2D[] {
  if (reg.boundarySegments.some((s) => s.kind === 'arc')) {
    return reg.polygon;
  }
  const verts = reg.boundarySegments.map((s) => ({ u: s.p1.u, v: s.p1.v }));
  return verts.length >= 3 ? verts : reg.polygon;
}

function pointInRectangleOrPoly(pt: Point2D, reg: CompositeRegion2D): boolean {
  if (
    pt.u < reg.bounds.uMin - 0.1 ||
    pt.u > reg.bounds.uMax + 0.1 ||
    pt.v < reg.bounds.vMin - 0.1 ||
    pt.v > reg.bounds.vMax + 0.1
  ) {
    return false;
  }
  if (reg.profileKind === 'rectangle') return true;
  // Ray cast on polygon
  const poly = reg.polygon;
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].u;
    const yi = poly[i].v;
    const xj = poly[j].u;
    const yj = poly[j].v;
    if (
      yi > pt.v !== yj > pt.v &&
      pt.u < ((xj - xi) * (pt.v - yi)) / (yj - yi + 1e-12) + xi
    ) {
      inside = !inside;
    }
  }
  return inside;
}

function detectSlottedConeSideRegion(
  reg: CompositeRegion2D,
  sharedCoord: 'u' | 'v',
  sweepCoord: 'u' | 'v',
  cShared: number,
  R: number
): { r0: number; r1: number; w0: number; w1: number } | null {
  const [w0, w1] = getSpanOnCoord(reg.bounds, sweepCoord);
  if (w1 - w0 < 5) return null;
  // Look for slanted line segments that lie on the symmetric cone flank lines from (cShared ± R, wBase) to (cShared, wApex)!
  const lines = reg.boundarySegments.filter((s) => s.kind === 'line');
  // Test normal upright cone (r0 = R at w0, r1 = 0 at w1) and inverted cone (r0 = 0 at w0, r1 = R at w1)
  for (const [r0Test, r1Test] of [
    [R, 0],
    [0, R],
  ] as const) {
    let flankHits = 0;
    for (const ln of lines) {
      const sA = sharedCoord === 'u' ? ln.p1.u : ln.p1.v;
      const wA = sweepCoord === 'u' ? ln.p1.u : ln.p1.v;
      const sB = sharedCoord === 'u' ? ln.p2.u : ln.p2.v;
      const wB = sweepCoord === 'u' ? ln.p2.u : ln.p2.v;
      if (Math.abs(wB - wA) < 3.0 || Math.abs(sB - sA) < 1.5) continue;
      const tA = (wA - w0) / (w1 - w0);
      const tB = (wB - w0) / (w1 - w0);
      const rExpA = (1 - tA) * r0Test + tA * r1Test;
      const rExpB = (1 - tB) * r0Test + tB * r1Test;
      if (
        Math.abs(Math.abs(sA - cShared) - rExpA) <= 1.0 &&
        Math.abs(Math.abs(sB - cShared) - rExpB) <= 1.0
      ) {
        flankHits++;
      }
    }
    if (flankHits >= 2) {
      return { r0: r0Test, r1: r1Test, w0, w1 };
    }
  }
  return null;
}

function generateWitnessPointsForIntersectGroup(
  prims: Primitive3D[],
  bounds: BoundingBox3D
): { x: number; y: number; z: number }[] {
  const pts: { x: number; y: number; z: number }[] = [];
  for (const fx of [0.25, 0.5, 0.75]) {
    for (const fy of [0.25, 0.5, 0.75]) {
      for (const fz of [0.25, 0.5, 0.75]) {
        const p = {
          x: bounds.xMin + (bounds.xMax - bounds.xMin) * fx,
          y: bounds.yMin + (bounds.yMax - bounds.yMin) * fy,
          z: bounds.zMin + (bounds.zMax - bounds.zMin) * fz,
        };
        if (evalCSGSolidSDF(p, prims) < -0.25) pts.push(p);
      }
    }
  }
  return pts;
}

export { unprojectViewPointTo3D, dist2 };
