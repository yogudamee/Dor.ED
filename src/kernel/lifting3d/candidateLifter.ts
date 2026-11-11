import {
  GeneralizedLoftPayload,
  HemisphereCapSpec,
  Primitive3D,
  ViewType,
} from '../../types/cad';
import {
  AnalyticalSurface3D,
  Axis3D,
  BBox3D,
  CandidateVolume3D,
  CarrierCircle2D,
  LiftedCandidatePool3D,
  ParallelDashedBand2D,
  PlanarArrangement2D,
  RegionProfile2D,
  TaperedDashedBand2D,
} from '../types';
import {
  buildCandidateVolumeFromPrimitive,
  createPlaneSurface3D,
  evalCurvedRegion2DSDF,
  getThirdTargetView,
} from './surfacePrimitives';
import { computeGeneralizedLoftBBox } from './generalizedLoft';

interface SharedAxisMapping {
  sharedAxis: Axis3D;
  keyInV1: 'u' | 'v';
  privKeyInV1: 'u' | 'v'; // corresponds to w2Axis
  w1Axis: Axis3D;         // extrusion depth axis of V1 (= privKeyInV2)
  keyInV2: 'u' | 'v';
  privKeyInV2: 'u' | 'v'; // corresponds to w1Axis
  w2Axis: Axis3D;         // extrusion depth axis of V2 (= privKeyInV1)
}

export function getSharedAxisMapping(v1: ViewType, v2: ViewType): SharedAxisMapping {
  if (v1 === 'front' && v2 === 'top') {
    return {
      sharedAxis: 'X',
      keyInV1: 'u',
      privKeyInV1: 'v',
      w1Axis: 'Y',
      keyInV2: 'u',
      privKeyInV2: 'v',
      w2Axis: 'Z',
    };
  }
  if (v1 === 'top' && v2 === 'front') {
    return {
      sharedAxis: 'X',
      keyInV1: 'u',
      privKeyInV1: 'v',
      w1Axis: 'Z',
      keyInV2: 'u',
      privKeyInV2: 'v',
      w2Axis: 'Y',
    };
  }
  if (v1 === 'front' && v2 === 'left') {
    return {
      sharedAxis: 'Z',
      keyInV1: 'v',
      privKeyInV1: 'u',
      w1Axis: 'Y',
      keyInV2: 'v',
      privKeyInV2: 'u',
      w2Axis: 'X',
    };
  }
  if (v1 === 'left' && v2 === 'front') {
    return {
      sharedAxis: 'Z',
      keyInV1: 'v',
      privKeyInV1: 'u',
      w1Axis: 'X',
      keyInV2: 'v',
      privKeyInV2: 'u',
      w2Axis: 'Y',
    };
  }
  if (v1 === 'top' && v2 === 'left') {
    return {
      sharedAxis: 'Y',
      keyInV1: 'v',
      privKeyInV1: 'u',
      w1Axis: 'Z',
      keyInV2: 'u',
      privKeyInV2: 'v',
      w2Axis: 'X',
    };
  }
  // v1 === 'left' && v2 === 'top'
  return {
    sharedAxis: 'Y',
    keyInV1: 'u',
    privKeyInV1: 'v',
    w1Axis: 'X',
    keyInV2: 'v',
    privKeyInV2: 'u',
    w2Axis: 'Z',
  };
}

function getBBoxSpan(
  bbox: { uMin: number; uMax: number; vMin: number; vMax: number },
  key: 'u' | 'v'
): [number, number] {
  return key === 'u' ? [bbox.uMin, bbox.uMax] : [bbox.vMin, bbox.vMax];
}

function spansMatch(a: [number, number], b: [number, number], tol = 1.6): boolean {
  return Math.abs(a[0] - b[0]) <= tol && Math.abs(a[1] - b[1]) <= tol;
}

function spansOverlap(a: [number, number], b: [number, number], minOverlap = 0.8): boolean {
  return Math.min(a[1], b[1]) - Math.max(a[0], b[0]) >= minOverlap;
}

function makeBBox3DFromAxes(
  aAxis: Axis3D,
  aRange: [number, number],
  bAxis: Axis3D,
  bRange: [number, number],
  cAxis: Axis3D,
  cRange: [number, number]
): BBox3D {
  const map: Record<Axis3D, [number, number]> = {
    X: [0, 0],
    Y: [0, 0],
    Z: [0, 0],
  };
  map[aAxis] = [Math.min(aRange[0], aRange[1]), Math.max(aRange[0], aRange[1])];
  map[bAxis] = [Math.min(bRange[0], bRange[1]), Math.max(bRange[0], bRange[1])];
  map[cAxis] = [Math.min(cRange[0], cRange[1]), Math.max(cRange[0], cRange[1])];
  return {
    xMin: map.X[0],
    xMax: map.X[1],
    yMin: map.Y[0],
    yMax: map.Y[1],
    zMin: map.Z[0],
    zMax: map.Z[1],
  };
}

function axisCylinderShape(axis: Axis3D): 'cylinder_x' | 'cylinder_y' | 'cylinder_z' {
  return axis === 'X' ? 'cylinder_x' : axis === 'Y' ? 'cylinder_y' : 'cylinder_z';
}

function makeCylinderPrimitive(
  id: string,
  label: string,
  operation: 'add' | 'subtract',
  viewOfCircle: ViewType,
  centerU: number,
  centerV: number,
  radius: number,
  wMin: number,
  wMax: number,
  isInternal = false
): Primitive3D {
  const wAxis: Axis3D = viewOfCircle === 'top' ? 'Z' : viewOfCircle === 'front' ? 'Y' : 'X';
  const lo = Math.min(wMin, wMax);
  const hi = Math.max(wMin, wMax);
  if (wAxis === 'Z') {
    return {
      id,
      featureId: id,
      label,
      operation,
      shape: 'cylinder_z',
      xMin: centerU - radius,
      xMax: centerU + radius,
      yMin: centerV - radius,
      yMax: centerV + radius,
      zMin: lo,
      zMax: hi,
      centerX: centerU,
      centerY: centerV,
      centerZ: 0.5 * (lo + hi),
      radius,
      isInternalFeature: isInternal,
    };
  }
  if (wAxis === 'Y') {
    return {
      id,
      featureId: id,
      label,
      operation,
      shape: 'cylinder_y',
      xMin: centerU - radius,
      xMax: centerU + radius,
      yMin: lo,
      yMax: hi,
      zMin: centerV - radius,
      zMax: centerV + radius,
      centerX: centerU,
      centerY: 0.5 * (lo + hi),
      centerZ: centerV,
      radius,
      isInternalFeature: isInternal,
    };
  }
  return {
    id,
    featureId: id,
    label,
    operation,
    shape: axisCylinderShape('X'),
    xMin: lo,
    xMax: hi,
    yMin: centerU - radius,
    yMax: centerU + radius,
    zMin: centerV - radius,
    zMax: centerV + radius,
    centerX: 0.5 * (lo + hi),
    centerY: centerU,
    centerZ: centerV,
    radius,
    isInternalFeature: isInternal,
  };
}

function makeRegionExtrusionPrimitive(
  id: string,
  label: string,
  operation: 'add' | 'subtract',
  region: RegionProfile2D,
  wMin: number,
  wMax: number,
  isInternal = false
): Primitive3D {
  const lo = Math.min(wMin, wMax);
  const hi = Math.max(wMin, wMax);
  const view = region.view;
  const wAxis: Axis3D = view === 'top' ? 'Z' : view === 'front' ? 'Y' : 'X';

  if (region.shapeKind === 'circle' && region.circleSpec) {
    return makeCylinderPrimitive(
      id,
      label,
      operation,
      view,
      region.circleSpec.center.u,
      region.circleSpec.center.v,
      region.circleSpec.radius,
      lo,
      hi,
      isInternal
    );
  }

  const bbox3D =
    wAxis === 'Z'
      ? {
          xMin: region.bbox.uMin,
          xMax: region.bbox.uMax,
          yMin: region.bbox.vMin,
          yMax: region.bbox.vMax,
          zMin: lo,
          zMax: hi,
        }
      : wAxis === 'Y'
        ? {
            xMin: region.bbox.uMin,
            xMax: region.bbox.uMax,
            yMin: lo,
            yMax: hi,
            zMin: region.bbox.vMin,
            zMax: region.bbox.vMax,
          }
        : {
            xMin: lo,
            xMax: hi,
            yMin: region.bbox.uMin,
            yMax: region.bbox.uMax,
            zMin: region.bbox.vMin,
            zMax: region.bbox.vMax,
          };

  if (region.shapeKind === 'rect') {
    return {
      id,
      featureId: id,
      label,
      operation,
      shape: 'box',
      ...bbox3D,
      isInternalFeature: isInternal,
    };
  }

  return {
    id,
    featureId: id,
    label,
    operation,
    shape: 'prism',
    ...bbox3D,
    prismAxis: wAxis,
    extrudeAxis: wAxis.toLowerCase() as 'x' | 'y' | 'z',
    prismPolygon: region.densePolygon.map((pt) => ({ u: pt.u, v: pt.v })),
    polygon2D: region.densePolygon.map((pt) => ({ u: pt.u, v: pt.v })),
    prismSegments: region.segments,
    isInternalFeature: isInternal,
  };
}

function sectionFromRegionOrCircle(
  region: RegionProfile2D | null,
  circle: CarrierCircle2D | null
): GeneralizedLoftPayload['section0'] | null {
  if (region && region.shapeKind === 'semicircle' && region.semicircleSpec) {
    const s = region.semicircleSpec;
    return {
      kind: 'semicircle',
      centerU: s.center.u,
      centerV: s.center.v,
      radiusU: s.radius,
      arcStart: s.arcStart,
      arcEnd: s.arcEnd,
      flatChordAxis: s.chordAxis,
      flatChordVal: s.chordCoord,
      keepGreater: s.keepGreater,
    };
  }
  if (circle && circle.isSemicircle && circle.sharedChord) {
    const ch = circle.sharedChord;
    return {
      kind: 'semicircle',
      centerU: circle.center.u,
      centerV: circle.center.v,
      radiusU: circle.radius,
      flatChordAxis: ch.axis,
      flatChordVal: ch.coord,
      keepGreater: ch.keepGreater,
    };
  }
  if (circle && circle.isFullCircle) {
    return {
      kind: 'circle',
      centerU: circle.center.u,
      centerV: circle.center.v,
      radiusU: circle.radius,
    };
  }
  if (region && region.shapeKind === 'circle' && region.circleSpec) {
    return {
      kind: 'circle',
      centerU: region.circleSpec.center.u,
      centerV: region.circleSpec.center.v,
      radiusU: region.circleSpec.radius,
    };
  }
  if (region) {
    return {
      kind: 'polygon',
      centerU: 0.5 * (region.bbox.uMin + region.bbox.uMax),
      centerV: 0.5 * (region.bbox.vMin + region.bbox.vMax),
      radiusU: 0.5 * Math.max(region.bbox.uMax - region.bbox.uMin, region.bbox.vMax - region.bbox.vMin),
      polygon: region.densePolygon.map((pt) => ({ u: pt.u, v: pt.v })),
    };
  }
  return null;
}

/**
 * Lifts 2D Planar Arrangements from two known orthographic views `(arr1, arr2)` into a unified
 * 3D Candidate Pool (`CandidateVolume3D[]` + `AnalyticalSurface3D[]`) for Cellular CSP solving.
 * Completely symmetric across all `(V1, V2)` pairs with zero view-hardcoded shape hacks.
 */
export function liftProjectiveCandidates3D(
  arr1: PlanarArrangement2D,
  arr2: PlanarArrangement2D
): LiftedCandidatePool3D {
  const v1 = arr1.view;
  const v2 = arr2.view;
  const targetView = getThirdTargetView(v1, v2);
  const map = getSharedAxisMapping(v1, v2);

  const b1 = arr1.solidBBox ?? arr1.overallBBox ?? { uMin: 20, uMax: 100, vMin: 20, vMax: 100 };
  const b2 = arr2.solidBBox ?? arr2.overallBBox ?? { uMin: 20, uMax: 100, vMin: 20, vMax: 100 };

  const sharedSpan1 = getBBoxSpan(b1, map.keyInV1);
  const sharedSpan2 = getBBoxSpan(b2, map.keyInV2);
  const sharedRange: [number, number] = [
    Math.min(sharedSpan1[0], sharedSpan2[0]),
    Math.max(sharedSpan1[1], sharedSpan2[1]),
  ];
  const w2Range = getBBoxSpan(b1, map.privKeyInV1); // depth range of V2
  const w1Range = getBBoxSpan(b2, map.privKeyInV2); // depth range of V1

  const visualHullBBox = makeBBox3DFromAxes(
    map.sharedAxis,
    sharedRange,
    map.w2Axis,
    w2Range,
    map.w1Axis,
    w1Range
  );

  const volumes: CandidateVolume3D[] = [];
  const dedupKeys = new Set<string>();
  let seq = 1;

  const registerVolume = (
    prim: Primitive3D,
    roleHint: CandidateVolume3D['roleHint'],
    priority: number,
    sourceViews: ViewType[],
    sigKey: string,
    opts?: { isGuaranteedVoid?: boolean; isGuaranteedSolid?: boolean }
  ) => {
    if (dedupKeys.has(sigKey)) return;
    const dx = prim.xMax - prim.xMin;
    const dy = prim.yMax - prim.yMin;
    const dz = prim.zMax - prim.zMin;
    if (dx < 0.25 || dy < 0.25 || dz < 0.25) return;
    dedupKeys.add(sigKey);
    volumes.push(buildCandidateVolumeFromPrimitive(prim, roleHint, priority, sourceViews, opts));
  };

  // GB/T 4458.1 Visible Opening Law helpers:
  // Checks whether a circle or closed region is strictly enclosed (`depth >= 1`) inside the outer
  // solid silhouette without touching any outer silhouette edge.
  const isStrictlyInnerCircle = (c: CarrierCircle2D, arr: PlanarArrangement2D): boolean => {
    if (arr.outerSilhouetteLoops.length === 0) return false;
    const cardinals = [
      { u: c.center.u - c.radius, v: c.center.v },
      { u: c.center.u + c.radius, v: c.center.v },
      { u: c.center.u, v: c.center.v - c.radius },
      { u: c.center.u, v: c.center.v + c.radius },
    ];
    return arr.outerSilhouetteLoops.some(
      (ol) =>
        ol.area > Math.PI * c.radius * c.radius * 1.15 &&
        cardinals.every((pt) => evalCurvedRegion2DSDF(pt, ol.segments, ol.densePolygon) < -0.55)
    );
  };

  const isStrictlyInnerRegion = (r: RegionProfile2D, arr: PlanarArrangement2D): boolean => {
    if (r.isOuterEnvelope || arr.outerSilhouetteLoops.length === 0) return false;
    const insideOuter = arr.outerSilhouetteLoops.some(
      (ol) =>
        ol.area > r.area * 1.12 &&
        evalCurvedRegion2DSDF(r.interiorSample, ol.segments, ol.densePolygon) < -0.5
    );
    if (!insideOuter) return false;
    const touchesOuterContour = r.segments.some((seg) => {
      const mid = { u: 0.5 * (seg.p1.u + seg.p2.u), v: 0.5 * (seg.p1.v + seg.p2.v) };
      return arr.outerSilhouetteLoops.some(
        (ol) => Math.abs(evalCurvedRegion2DSDF(mid, ol.segments, ol.densePolygon)) <= 0.55
      );
    });
    return !touchesOuterContour;
  };

  // Helper to run asymmetric cross-view lifting from (arrA -> arrB) in both directions:
  // pass 1: A = arr1, B = arr2; pass 2: A = arr2, B = arr1
  const liftOrderedPair = (arrA: PlanarArrangement2D, arrB: PlanarArrangement2D) => {
    const m = getSharedAxisMapping(arrA.view, arrB.view);
    const bB = arrB.solidBBox ?? arrB.overallBBox;
    if (!bB) return;
    const fullDepthOfA = getBBoxSpan(bB, m.privKeyInV2); // full [wA_min, wA_max]

    const solidRegionsA = arrA.regions.filter((r) => r.isSolidOnly);
    const solidRegionsB = arrB.regions.filter((r) => r.isSolidOnly);

    // ------------------------------------------------------------------------
    // 1. Quadric Sphere & Flat-Base / Composite Hemisphere Detection
    // ------------------------------------------------------------------------
    for (const cA of arrA.carrierCircles) {
      const spanA: [number, number] = [cA.center[m.keyInV1] - cA.radius, cA.center[m.keyInV1] + cA.radius];

      // 1a. Sphere: Full or trimmed-major circle in A + Full or trimmed-major circle in B with equal radius & matching shared span.
      //     VISIBLE OPENING LAW: Two inner `thick_solid` circles (`depth >= 1`) are orthogonal hole openings, NEVER a solid sphere!
      if ((cA.isFullCircle || cA.isMajorTrimmedArc) && arrA.view === v1) {
        const innerA = isStrictlyInnerCircle(cA, arrA);
        for (const cB of arrB.carrierCircles) {
          if (!cB.isFullCircle && !cB.isMajorTrimmedArc) continue;
          const innerB = isStrictlyInnerCircle(cB, arrB);
          const isCavity = cA.totalSolidSweep < 0.2 && cB.totalSolidSweep < 0.2;
          if (!isCavity && (innerA || innerB)) continue;

          const spanB: [number, number] = [cB.center[m.keyInV2] - cB.radius, cB.center[m.keyInV2] + cB.radius];
          if (Math.abs(cA.radius - cB.radius) <= 1.2 && spansMatch(spanA, spanB, 1.8)) {
            const r = 0.5 * (cA.radius + cB.radius);
            const sharedCenter = 0.5 * (cA.center[m.keyInV1] + cB.center[m.keyInV2]);
            const w2Center = cA.center[m.privKeyInV1];
            const w1Center = cB.center[m.privKeyInV2];
            const cBox = makeBBox3DFromAxes(
              m.sharedAxis,
              [sharedCenter - r, sharedCenter + r],
              m.w2Axis,
              [w2Center - r, w2Center + r],
              m.w1Axis,
              [w1Center - r, w1Center + r]
            );
            const id = `cand_sphere_${seq++}`;
            registerVolume(
              {
                id,
                featureId: id,
                label: isCavity ? '球形内腔' : '球体',
                operation: isCavity ? 'subtract' : 'add',
                shape: 'sphere',
                ...cBox,
                centerX: 0.5 * (cBox.xMin + cBox.xMax),
                centerY: 0.5 * (cBox.yMin + cBox.yMax),
                centerZ: 0.5 * (cBox.zMin + cBox.zMax),
                radius: r,
                isInternalFeature: isCavity,
              },
              isCavity ? 'cavity_Candidate' : 'solid_body',
              97,
              [arrA.view, arrB.view],
              `sphere_${Math.round(cBox.xMin)}_${Math.round(cBox.yMin)}_${Math.round(cBox.zMin)}_${Math.round(r)}`
            );
          }
        }
      }
    }

    // 1b. Hemisphere: Semicircle region in A (flat chord perpendicular to privKeyInV1 = w2Axis)
    //     paired with Full/Stitched/Trimmed-Major Circle in B
    for (const rA of solidRegionsA) {
      if (rA.shapeKind !== 'semicircle' || !rA.semicircleSpec) continue;
      if (isStrictlyInnerRegion(rA, arrA)) continue;
      const semi = rA.semicircleSpec;
      if (semi.chordAxis !== m.privKeyInV1) continue;
      const spanA = getBBoxSpan(rA.bbox, m.keyInV1);

      for (const cB of arrB.carrierCircles) {
        if (!cB.isFullCircle && !cB.isMajorTrimmedArc) continue;
        if (isStrictlyInnerCircle(cB, arrB)) continue;
        const spanB: [number, number] = [cB.center[m.keyInV2] - cB.radius, cB.center[m.keyInV2] + cB.radius];
        if (Math.abs(semi.radius - cB.radius) <= 1.5 && spansMatch(spanA, spanB, 1.8)) {
          const R = 0.5 * (semi.radius + cB.radius);
          const sharedC = 0.5 * (semi.center[m.keyInV1] + cB.center[m.keyInV2]);
          const w1C = cB.center[m.privKeyInV2];
          const flatCoord = semi.chordCoord;
          const w2Span: [number, number] = semi.keepGreater
            ? [flatCoord, flatCoord + R]
            : [flatCoord - R, flatCoord];
          const hBox = makeBBox3DFromAxes(
            m.sharedAxis,
            [sharedC - R, sharedC + R],
            m.w2Axis,
            w2Span,
            m.w1Axis,
            [w1C - R, w1C + R]
          );
          const center3DBox = makeBBox3DFromAxes(
            m.sharedAxis,
            [sharedC, sharedC],
            m.w2Axis,
            [flatCoord, flatCoord],
            m.w1Axis,
            [w1C, w1C]
          );
          const hemiSpec: HemisphereCapSpec = {
            flatAxis: m.w2Axis,
            flatCoord,
            keepPositiveSide: semi.keepGreater,
          };
          const id = `cand_hemisphere_${seq++}`;
          registerVolume(
            {
              id,
              featureId: id,
              label: '半球体',
              operation: 'add',
              shape: 'hemisphere',
              ...hBox,
              centerX: center3DBox.xMin,
              centerY: center3DBox.yMin,
              centerZ: center3DBox.zMin,
              radius: R,
              hemisphereSpec: hemiSpec,
            },
            'solid_body',
            96,
            [arrA.view, arrB.view],
            `hemi_${m.w2Axis}_${Math.round(flatCoord)}_${semi.keepGreater ? 'pos' : 'neg'}_${Math.round(R)}_${Math.round(sharedC)}`
          );
        }
      }
    }

    // ------------------------------------------------------------------------
    // 2. Generalized Loft (Solid Cone, Right/Eccentric/Oblique Frustum,
    //    Shared-Chord Half-Cone, Shared-Chord Half-Frustum, Pyramid)
    // ------------------------------------------------------------------------
    for (const rA of solidRegionsA) {
      if (
        (rA.shapeKind !== 'trapezoid' && rA.shapeKind !== 'triangle') ||
        !rA.trapezoidSpec
      ) {
        continue;
      }
      const trap = rA.trapezoidSpec;
      if (trap.taperAxis !== m.privKeyInV1) continue;

      // If `rA` is merely an internal-crease sub-panel (e.g. left/right half split by X=60)
      // of a larger outer trapezoid/triangle spanning the exact same `[w0, w1]` height, skip `rA`
      // so the unified outer envelope lifts a single clean pyramid/frustum/cone!
      if (!rA.isOuterEnvelope) {
        const coveredByUnifiedOuterTrap = solidRegionsA.some((outerR) => {
          if (
            !outerR.isOuterEnvelope ||
            (outerR.shapeKind !== 'trapezoid' && outerR.shapeKind !== 'triangle') ||
            !outerR.trapezoidSpec ||
            outerR.trapezoidSpec.taperAxis !== m.privKeyInV1
          ) {
            return false;
          }
          const oMinW = Math.min(outerR.trapezoidSpec.w0, outerR.trapezoidSpec.w1);
          const oMaxW = Math.max(outerR.trapezoidSpec.w0, outerR.trapezoidSpec.w1);
          const rMinW = Math.min(trap.w0, trap.w1);
          const rMaxW = Math.max(trap.w0, trap.w1);
          return (
            Math.abs(oMinW - rMinW) <= 0.8 &&
            Math.abs(oMaxW - rMaxW) <= 0.8 &&
            outerR.area > rA.area * 1.15
          );
        });
        if (coveredByUnifiedOuterTrap) continue;
      }

      const span0: [number, number] = [trap.span0Min, trap.span0Max];
      const span1: [number, number] = [trap.span1Min, trap.span1Max];
      const len0 = span0[1] - span0[0];
      const len1 = span1[1] - span1[0];

      // Find matching cross-section candidates in B for base 0 and base 1
      const findMatchingCrossSectionsInB = (
        targetSpan: [number, number]
      ): GeneralizedLoftPayload['section0'][] => {
        const len = targetSpan[1] - targetSpan[0];
        if (len <= 1.2) {
          // Point apex! Determine its coordinate along w1Axis (= privKeyInV2)
          return [];
        }
        const primaryMatches: GeneralizedLoftPayload['section0'][] = [];
        const fallbackUnionMatches: GeneralizedLoftPayload['section0'][] = [];
        // Check outer-envelope & atomic regions in B first; only fall back to partial 2-face unions
        // (such as shared-chord inner semicircles) when no outer/atomic region matches `targetSpan`!
        for (const rB of solidRegionsB) {
          const sb = getBBoxSpan(rB.bbox, m.keyInV2);
          if (spansMatch(targetSpan, sb, 1.8)) {
            const sec = sectionFromRegionOrCircle(rB, null);
            if (sec) {
              if (rB.isOuterEnvelope || rB.isAtomic) primaryMatches.push(sec);
              else fallbackUnionMatches.push(sec);
            }
          }
        }
        const matches: GeneralizedLoftPayload['section0'][] =
          primaryMatches.length > 0 ? [...primaryMatches] : [...fallbackUnionMatches];
        // Check carrier circles (including concentric inner/outer circles or semicircles) in B
        for (const cB of arrB.carrierCircles) {
          const sb: [number, number] = [
            cB.center[m.keyInV2] - cB.radius,
            cB.center[m.keyInV2] + cB.radius,
          ];
          if (spansMatch(targetSpan, sb, 1.8)) {
            const sec = sectionFromRegionOrCircle(null, cB);
            if (sec) matches.push(sec);
          }
        }
        return matches;
      };

      const secs0 = findMatchingCrossSectionsInB(span0);
      const secs1 = findMatchingCrossSectionsInB(span1);

      if (len0 > 1.2 && len1 <= 1.2 && secs0.length > 0) {
        // Pure Cone / Half-Cone / Pyramid with apex at w1!
        const apexShared = 0.5 * (span1[0] + span1[1]);
        for (const s0 of secs0) {
          // Lock apex coordinate along privKeyInV2:
          // If base is a semicircle whose chord lies on privKeyInV2, lock apex onto flatChordVal!
          let apexU = m.keyInV2 === 'u' ? apexShared : s0.centerU;
          let apexV = m.keyInV2 === 'v' ? apexShared : s0.centerV;
          if (s0.kind === 'semicircle' && s0.flatChordAxis && s0.flatChordVal !== undefined) {
            if (s0.flatChordAxis !== m.keyInV2) {
              if (s0.flatChordAxis === 'u') apexU = s0.flatChordVal;
              else apexV = s0.flatChordVal;
            }
          }
          // Check if B has an explicit interior apex vertex near apexShared (for oblique cones / radial-creased pyramids!)
          const apexVertsInB = arrB.vertices.filter((vt) => {
            if (Math.abs(vt.pt[m.keyInV2] - apexShared) > 1.2) return false;
            if (vt.outgoingHalfEdges.length >= 3) return true;
            if (s0.kind === 'polygon' && s0.polygon) {
              // Never hijack an outer boundary corner of the base polygon as the pyramid apex!
              const onBaseCorner = s0.polygon.some(
                (bp) => Math.hypot(bp.u - vt.pt.u, bp.v - vt.pt.v) <= 1.2
              );
              if (onBaseCorner) return false;
            }
            return (
              vt.outgoingHalfEdges.length >= 2 &&
              Math.hypot(vt.pt.u - s0.centerU, vt.pt.v - s0.centerV) < 0.85 * Math.max(2, Math.abs(s0.radiusU))
            );
          });
          if (apexVertsInB.length === 1 && s0.kind !== 'semicircle') {
            apexU = apexVertsInB[0].pt.u;
            apexV = apexVertsInB[0].pt.v;
          }

          const loftSpec: GeneralizedLoftPayload = {
            axis: m.w2Axis,
            w0: trap.w0,
            w1: trap.w1,
            section0: s0,
            section1: { kind: 'point', centerU: apexU, centerV: apexV, radiusU: 0 },
          };
          const lBox = computeGeneralizedLoftBBox(loftSpec);
          const id = `cand_loft_cone_${seq++}`;
          registerVolume(
            {
              id,
              featureId: id,
              label: s0.kind === 'semicircle' ? '半圆锥体' : s0.kind === 'circle' ? '圆锥体' : '棱锥体',
              operation: 'add',
              shape: 'generalized_loft',
              ...lBox,
              loftSpec,
            },
            'solid_body',
            94,
            [arrA.view, arrB.view],
            `loft_${m.w2Axis}_${Math.round(trap.w0)}_${Math.round(trap.w1)}_${s0.kind}_${Math.round(s0.radiusU)}_${Math.round(apexShared)}`
          );
        }
      } else if (len1 > 1.2 && len0 <= 1.2 && secs1.length > 0) {
        // Pure Cone / Half-Cone / Pyramid with apex at w0!
        const apexShared = 0.5 * (span0[0] + span0[1]);
        for (const s1 of secs1) {
          let apexU = m.keyInV2 === 'u' ? apexShared : s1.centerU;
          let apexV = m.keyInV2 === 'v' ? apexShared : s1.centerV;
          if (s1.kind === 'semicircle' && s1.flatChordAxis && s1.flatChordVal !== undefined) {
            if (s1.flatChordAxis !== m.keyInV2) {
              if (s1.flatChordAxis === 'u') apexU = s1.flatChordVal;
              else apexV = s1.flatChordVal;
            }
          }
          const loftSpec: GeneralizedLoftPayload = {
            axis: m.w2Axis,
            w0: trap.w1,
            w1: trap.w0,
            section0: s1,
            section1: { kind: 'point', centerU: apexU, centerV: apexV, radiusU: 0 },
          };
          const lBox = computeGeneralizedLoftBBox(loftSpec);
          const id = `cand_loft_cone_${seq++}`;
          registerVolume(
            {
              id,
              featureId: id,
              label: s1.kind === 'semicircle' ? '半圆锥体' : s1.kind === 'circle' ? '圆锥体' : '棱锥体',
              operation: 'add',
              shape: 'generalized_loft',
              ...lBox,
              loftSpec,
            },
            'solid_body',
            94,
            [arrA.view, arrB.view],
            `loft_${m.w2Axis}_${Math.round(trap.w1)}_${Math.round(trap.w0)}_${s1.kind}_${Math.round(s1.radiusU)}_${Math.round(apexShared)}`
          );
        }
      } else if (secs0.length > 0 && secs1.length > 0) {
        // Frustum / Eccentric Oblique Frustum / Half-Frustum / Tapered Prism
        for (const s0 of secs0) {
          for (const s1 of secs1) {
            if (s0.kind !== s1.kind) continue;
            // Avoid pairing identical radius as a frustum if there is also another distinct circle,
            // unless trapezoid actually has equal spans (which wouldn't be trapezoid).
            const loftSpec: GeneralizedLoftPayload = {
              axis: m.w2Axis,
              w0: trap.w0,
              w1: trap.w1,
              section0: s0,
              section1: s1,
            };
            const lBox = computeGeneralizedLoftBBox(loftSpec);
            const id = `cand_loft_frustum_${seq++}`;
            registerVolume(
              {
                id,
                featureId: id,
                label: s0.kind === 'semicircle' ? '半圆台体' : s0.kind === 'circle' ? '圆台体' : '棱台体',
                operation: 'add',
                shape: 'generalized_loft',
                ...lBox,
                loftSpec,
              },
              'solid_body',
              93,
              [arrA.view, arrB.view],
              `loft_${m.w2Axis}_${Math.round(trap.w0)}_${Math.round(trap.w1)}_${s0.kind}_${Math.round(s0.centerU)}_${Math.round(s0.radiusU)}_${Math.round(s1.centerU)}_${Math.round(s1.radiusU)}`
            );
          }
        }
      }
    }

    // ------------------------------------------------------------------------
    // 3. Multi-Step Bosses & Cross-Matched Extrusions (e.g. 3-Step Cylinder,
    //    Arch + Base Plate, Intersecting Tee Cylinders)
    // ------------------------------------------------------------------------
    // 3a. Match every CarrierCircle in A (solid sweep >= 0.4π) with every solid Region in B
    //     whose shared-axis span matches [center - R, center + R]
    for (const cA of arrA.carrierCircles) {
      if (!cA.isFullCircle || cA.totalSolidSweep < Math.PI * 0.35) continue;
      const cAIsInner = isStrictlyInnerCircle(cA, arrA);
      const cSpan: [number, number] = [
        cA.center[m.keyInV1] - cA.radius,
        cA.center[m.keyInV1] + cA.radius,
      ];

      const isMatchedSphereWithB =
        !cAIsInner &&
        arrB.carrierCircles.some(
          (cB) =>
            (cB.isFullCircle || cB.isMajorTrimmedArc) &&
            !isStrictlyInnerCircle(cB, arrB) &&
            Math.abs(cB.radius - cA.radius) <= 1.2 &&
            spansMatch(cSpan, [cB.center[m.keyInV2] - cB.radius, cB.center[m.keyInV2] + cB.radius], 1.8)
        );
      if (isMatchedSphereWithB) continue;

      let matchedSolidStepInB = false;
      for (const rB of solidRegionsB) {
        // Skip trapezoids/triangles/semicircles OR multi-face unions composed of cones/hemispheres!
        if (
          rB.shapeKind === 'trapezoid' ||
          rB.shapeKind === 'triangle' ||
          rB.shapeKind === 'semicircle' ||
          rB.shapeKind === 'circle'
        ) {
          continue;
        }
        // VISIBLE OPENING LAW: An inner circle in A cannot pair with a strictly-inner region in B into an `'add'` boss!
        if (cAIsInner && isStrictlyInnerRegion(rB, arrB)) continue;

        if (!rB.isAtomic && rB.faceIds.length > 1) {
          const subFacesB = solidRegionsB.filter(
            (sub) =>
              sub.isAtomic &&
              sub.faceIds.length === 1 &&
              rB.faceIds.includes(sub.faceIds[0])
          );
          const hasTaperedOrCurvedSubFace = subFacesB.some(
            (sub) =>
              sub.shapeKind === 'trapezoid' ||
              sub.shapeKind === 'triangle' ||
              sub.shapeKind === 'semicircle'
          );
          if (hasTaperedOrCurvedSubFace) continue;
          // A non-rectangular stepped union of unequal axis-aligned rectangles (e.g. 3-step pagoda / T-step)
          // does NOT maintain width `rB.bbox` across `depthSpan`; each atomic step rect is matched individually.
          if (
            rB.shapeKind !== 'rect' &&
            subFacesB.length >= 2 &&
            subFacesB.every((sub) => sub.shapeKind === 'rect')
          ) {
            continue;
          }
        }
        const sb = getBBoxSpan(rB.bbox, m.keyInV2);
        if (spansMatch(cSpan, sb, 1.6)) {
          const depthSpan = getBBoxSpan(rB.bbox, m.privKeyInV2);
          matchedSolidStepInB = true;
          const id = `cand_step_cyl_${seq++}`;
          const prim = makeCylinderPrimitive(
            id,
            '圆柱阶梯段',
            'add',
            arrA.view,
            cA.center.u,
            cA.center.v,
            cA.radius,
            depthSpan[0],
            depthSpan[1],
            false
          );
          registerVolume(
            prim,
            'step_boss',
            90,
            [arrA.view, arrB.view],
            `cyl_${arrA.view}_${Math.round(cA.center.u)}_${Math.round(cA.center.v)}_${Math.round(cA.radius)}_${Math.round(depthSpan[0])}_${Math.round(depthSpan[1])}`
          );
        }
      }

      // If no specific step region matched but cSpan matches full outer BBox of B (and cA is NOT an inner hole circle!),
      // lift full-depth cylinder candidate
      if (!cAIsInner && !matchedSolidStepInB && spansMatch(cSpan, getBBoxSpan(bB, m.keyInV2), 1.8)) {
        const hasOnlyConicOrSphereInB =
          solidRegionsB.length > 0 &&
          solidRegionsB.every(
            (r) =>
              r.shapeKind === 'trapezoid' ||
              r.shapeKind === 'triangle' ||
              r.shapeKind === 'semicircle' ||
              r.shapeKind === 'circle' ||
              (!r.isAtomic && r.faceIds.length > 1)
          );
        if (!hasOnlyConicOrSphereInB) {
          const id = `cand_full_cyl_${seq++}`;
          const prim = makeCylinderPrimitive(
            id,
            '主圆柱体',
            'add',
            arrA.view,
            cA.center.u,
            cA.center.v,
            cA.radius,
            fullDepthOfA[0],
            fullDepthOfA[1],
            false
          );
          registerVolume(
            prim,
            'solid_body',
            85,
            [arrA.view, arrB.view],
            `cyl_${arrA.view}_${Math.round(cA.center.u)}_${Math.round(cA.center.v)}_${Math.round(cA.radius)}_${Math.round(fullDepthOfA[0])}_${Math.round(fullDepthOfA[1])}`
          );
        }
      }
    }

    // 3b. Match solid Regions in A with solid Regions in B whose shared-axis spans match
    for (const rA of solidRegionsA) {
      if (
        rA.shapeKind === 'trapezoid' ||
        rA.shapeKind === 'triangle'
      ) {
        if (rA.trapezoidSpec?.taperAxis === m.privKeyInV1) continue;
      }
      const rAIsInner = isStrictlyInnerRegion(rA, arrA);
      // Skip if rA is an outer circle already matched as a sphere with B!
      if (
        rA.shapeKind === 'circle' &&
        rA.circleSpec &&
        !rAIsInner &&
        arrB.carrierCircles.some(
          (cB) =>
            (cB.isFullCircle || cB.isMajorTrimmedArc) &&
            !isStrictlyInnerCircle(cB, arrB) &&
            Math.abs(cB.radius - rA.circleSpec!.radius) <= 1.2
        )
      ) {
        continue;
      }
      if (
        !rA.isAtomic &&
        rA.faceIds.length > 1 &&
        rA.shapeKind !== 'rect' &&
        rA.shapeKind !== 'polygon'
      ) {
        const hasTaperedOrCurvedSubFaceA = solidRegionsA.some(
          (sub) =>
            sub.isAtomic &&
            sub.faceIds.length === 1 &&
            rA.faceIds.includes(sub.faceIds[0]) &&
            (sub.shapeKind === 'trapezoid' ||
              sub.shapeKind === 'triangle' ||
              sub.shapeKind === 'semicircle')
        );
        if (hasTaperedOrCurvedSubFaceA) continue;
      }
      const sA = getBBoxSpan(rA.bbox, m.keyInV1);

      for (const rB of solidRegionsB) {
        if (
          ((rB.shapeKind === 'trapezoid' || rB.shapeKind === 'triangle') &&
            rB.trapezoidSpec?.taperAxis === m.privKeyInV2) ||
          (rB.shapeKind === 'semicircle' && rB.semicircleSpec?.chordAxis === m.privKeyInV2) ||
          rB.shapeKind === 'circle'
        ) {
          continue;
        }
        // VISIBLE OPENING LAW: Never pair two strictly-inner closed loops into a trapped internal `'add'` block!
        if (rAIsInner && isStrictlyInnerRegion(rB, arrB)) {
          continue;
        }
        // CRITICAL OBLIQUE HALF-SPACE RULE:
        // Never extrude an axis-aligned `'rect'` in View A as an `'add'` cuboid (`box`) across a
        // `'polygon'` or `'arch_or_curved'` profile in View B! The symmetric pass `(arrB, arrA)`
        // lifts `rB`'s exact polygonal/curved `prism` over `rA`'s rectangular span; unioning a `box`
        // from `rA` would overwrite all oblique polygon cuts and degenerate the 3D solid into a Cuboid!
        if (
          rA.shapeKind === 'rect' &&
          (rB.shapeKind === 'polygon' ||
            rB.shapeKind === 'arch_or_curved' ||
            rB.shapeKind === 'semicircle' ||
            rB.shapeKind === 'triangle' ||
            rB.shapeKind === 'trapezoid')
        ) {
          continue;
        }
        if (!rB.isAtomic && rB.faceIds.length > 1 && rB.shapeKind !== 'rect') {
          const subFacesB = solidRegionsB.filter(
            (sub) =>
              sub.isAtomic &&
              sub.faceIds.length === 1 &&
              rB.faceIds.includes(sub.faceIds[0])
          );
          if (
            rB.shapeKind !== 'polygon' &&
            subFacesB.some(
              (sub) =>
                sub.shapeKind === 'trapezoid' ||
                sub.shapeKind === 'triangle' ||
                sub.shapeKind === 'semicircle'
            )
          ) {
            continue;
          }
          if (
            subFacesB.length >= 2 &&
            subFacesB.every((sub) => sub.shapeKind === 'rect')
          ) {
            continue;
          }
        }
        const sB = getBBoxSpan(rB.bbox, m.keyInV2);
        if (spansMatch(sA, sB, 1.6)) {
          const depthSpan = getBBoxSpan(rB.bbox, m.privKeyInV2);
          const id = `cand_matched_ext_${seq++}`;
          const prim = makeRegionExtrusionPrimitive(
            id,
            rA.shapeKind === 'polygon' ? '多边形棱柱体' : '匹配拉伸特征',
            'add',
            rA,
            depthSpan[0],
            depthSpan[1],
            false
          );
          // If BOTH rA and rB are non-rectangular profiles (e.g. bi-polygonal / polygon-arch intersection),
          // tag as `'ambiguous'` hull extrusions so coalescing intersects them (`ADD ∩ INTERSECT`)!
          const bothNonRect = rA.shapeKind !== 'rect' && rB.shapeKind !== 'rect';
          registerVolume(
            prim,
            bothNonRect ? 'ambiguous' : 'solid_body',
            bothNonRect ? 75 : 88,
            [arrA.view, arrB.view],
            `ext_${arrA.view}_${rA.shapeKind}_${Math.round(rA.bbox.uMin)}_${Math.round(rA.bbox.uMax)}_${Math.round(rA.bbox.vMin)}_${Math.round(rA.bbox.vMax)}_${Math.round(depthSpan[0])}_${Math.round(depthSpan[1])}`
          );
        }
      }
    }

    // ------------------------------------------------------------------------
    // 4. Tapered Dashed Bands (八字形斜細虛線對) -> Oblique Conical / Frustum /
    //    Shared-Chord Double-Semicircle Through-Hole Cavities!
    // ------------------------------------------------------------------------
    for (const tBand of arrA.taperedDashedBands) {
      if (tBand.taperAxis !== m.privKeyInV1) continue;
      const span0: [number, number] = [tBand.span0Min, tBand.span0Max];
      const span1: [number, number] = [tBand.span1Min, tBand.span1Max];

      const findHoleCrossSectionInB = (
        targetSpan: [number, number]
      ): GeneralizedLoftPayload['section0'][] => {
        const res: GeneralizedLoftPayload['section0'][] = [];
        // Check semicircle & inner regions in B (both solid and dashed-bounded)
        for (const rB of arrB.regions) {
          const sb = getBBoxSpan(rB.bbox, m.keyInV2);
          if (spansMatch(targetSpan, sb, 1.8)) {
            if (
              rB.shapeKind === 'semicircle' ||
              rB.shapeKind === 'circle' ||
              !rB.isOuterEnvelope
            ) {
              const sec = sectionFromRegionOrCircle(rB, null);
              if (sec) res.push(sec);
            }
          }
        }
        for (const cB of arrB.carrierCircles) {
          const sb: [number, number] = [
            cB.center[m.keyInV2] - cB.radius,
            cB.center[m.keyInV2] + cB.radius,
          ];
          if (spansMatch(targetSpan, sb, 1.8)) {
            const sec = sectionFromRegionOrCircle(null, cB);
            if (sec) res.push(sec);
          }
        }
        return res;
      };

      const hSecs0 = findHoleCrossSectionInB(span0);
      const hSecs1 = findHoleCrossSectionInB(span1);
      for (const s0 of hSecs0) {
        for (const s1 of hSecs1) {
          if (s0.kind !== s1.kind) continue;
          // Extend axial ends slightly (0.4mm) along ruling slope for clean open through-hole boolean cut
          const dw = tBand.w1 - tBand.w0;
          if (Math.abs(dw) < 1e-3) continue;
          const loftSpec: GeneralizedLoftPayload = {
            axis: m.w2Axis,
            w0: tBand.w0,
            w1: tBand.w1,
            section0: s0,
            section1: s1,
          };
          const lBox = computeGeneralizedLoftBBox(loftSpec);
          const id = `cand_taper_hole_${seq++}`;
          registerVolume(
            {
              id,
              featureId: id,
              label: s0.kind === 'semicircle' ? '共顶弦斜半圆台通孔' : '斜圆台/棱台通孔',
              operation: 'subtract',
              shape: 'generalized_loft',
              ...lBox,
              loftSpec,
              isInternalFeature: true,
            },
            'cavity_Candidate',
            98,
            [arrA.view, arrB.view],
            `taperhole_${m.w2Axis}_${Math.round(tBand.w0)}_${Math.round(tBand.w1)}_${s0.kind}_${Math.round(s0.radiusU)}_${Math.round(s1.radiusU)}`,
            { isGuaranteedVoid: true }
          );
        }
      }
    }

    // ------------------------------------------------------------------------
    // 5. Parallel Dashed Bands + Inner Loops / Circles -> Bounded Slots,
    //    Blind Holes, Orthogonal Intersecting Round & Square Cavities
    // ------------------------------------------------------------------------
    for (const pBand of arrA.parallelDashedBands) {
      // Determine which axis pBand's width [coordMin, coordMax] measures in A:
      // orientation === 'vertical' => width is along 'u', span is along 'v'
      // orientation === 'horizontal' => width is along 'v', span is along 'u'
      const bandWidthKey: 'u' | 'v' = pBand.orientation === 'vertical' ? 'u' : 'v';
      const bandSpanKey: 'u' | 'v' = pBand.orientation === 'vertical' ? 'v' : 'u';

      // Expand open-air mouths 2.0mm past outer boundary so boolean cuts never leave coplanar cap crusts!
      let spanLo = pBand.spanMin;
      let spanHi = pBand.spanMax;
      if (pBand.touchesMinBoundary) spanLo -= 2.0;
      if (pBand.touchesMaxBoundary) spanHi += 2.0;

      // T-JUNCTION SEAMLESS PENETRATION:
      // If an inner blind/half-hole end (`!touchesMinBoundary` or `!touchesMaxBoundary`) abuts or enters
      // an orthogonal inner hole opening in `arrA` (with R2 <= R1 + 1.5mm), advance the inner end to the
      // orthogonal hole's axis center `w_c` (plus 0.08mm micro-overlap) so zero crescent septum remains!
      if (!pBand.touchesMinBoundary || !pBand.touchesMaxBoundary) {
        const bandHalfW = 0.5 * (pBand.coordMax - pBand.coordMin);
        const orthoHolesInA: { sharedSpan: [number, number]; depthSpan: [number, number]; r1: number }[] = [];

        for (const cA of arrA.carrierCircles) {
          if (!isStrictlyInnerCircle(cA, arrA)) continue;
          const sh: [number, number] = [
            cA.center[bandWidthKey] - cA.radius,
            cA.center[bandWidthKey] + cA.radius,
          ];
          const dp: [number, number] = [
            cA.center[bandSpanKey] - cA.radius,
            cA.center[bandSpanKey] + cA.radius,
          ];
          orthoHolesInA.push({ sharedSpan: sh, depthSpan: dp, r1: cA.radius });
        }
        for (const rA of arrA.regions) {
          if (!rA.isSolidOnly || !isStrictlyInnerRegion(rA, arrA)) continue;
          const sh = getBBoxSpan(rA.bbox, bandWidthKey);
          const dp = getBBoxSpan(rA.bbox, bandSpanKey);
          orthoHolesInA.push({ sharedSpan: sh, depthSpan: dp, r1: 0.5 * (dp[1] - dp[0]) });
        }

        for (const oh of orthoHolesInA) {
          if (!spansOverlap([pBand.coordMin, pBand.coordMax], oh.sharedSpan, 1.0)) continue;
          if (bandHalfW > oh.r1 + 1.5) continue;
          const wc = 0.5 * (oh.depthSpan[0] + oh.depthSpan[1]);
          const microOverlap = bandHalfW <= oh.r1 + 0.2 ? 0.08 : 0;

          if (
            !pBand.touchesMinBoundary &&
            pBand.spanMax > oh.depthSpan[1] + 1.0 &&
            pBand.spanMin >= oh.depthSpan[0] - 1.5 &&
            pBand.spanMin <= oh.depthSpan[1] + 1.8
          ) {
            spanLo = Math.min(spanLo, Math.max(oh.depthSpan[0] + 0.5, wc - microOverlap));
          }
          if (
            !pBand.touchesMaxBoundary &&
            pBand.spanMin < oh.depthSpan[0] - 1.0 &&
            pBand.spanMax >= oh.depthSpan[0] - 1.8 &&
            pBand.spanMax <= oh.depthSpan[1] + 1.5
          ) {
            spanHi = Math.max(spanHi, Math.min(oh.depthSpan[1] - 0.5, wc + microOverlap));
          }
        }
      }

      if (bandWidthKey === m.keyInV1 && bandSpanKey === m.privKeyInV1) {
        // pBand's width [coordMin, coordMax] is along `sharedAxis`, and its length [spanLo, spanHi]
        // runs along `w2Axis`!
        const bandSharedSpan: [number, number] = [pBand.coordMin, pBand.coordMax];
        let pairedWithBoundedProfileInB = false;
        let pairedWithCircleInB = false;

        // 5a. Pair with matching CarrierCircle in B (cylindrical hole along w2Axis!)
        for (const cB of arrB.carrierCircles) {
          const cbSpan: [number, number] = [
            cB.center[m.keyInV2] - cB.radius,
            cB.center[m.keyInV2] + cB.radius,
          ];
          if (spansMatch(bandSharedSpan, cbSpan, 1.8)) {
            pairedWithBoundedProfileInB = true;
            pairedWithCircleInB = true;
            const cBIsInner = isStrictlyInnerCircle(cB, arrB) && cB.totalSolidSweep >= Math.PI * 0.5;
            const matchedAsStepBossInA = solidRegionsA.some(
              (rA) =>
                rA.shapeKind === 'rect' &&
                !isStrictlyInnerRegion(rA, arrA) &&
                spansMatch(cbSpan, getBBoxSpan(rA.bbox, m.keyInV1), 1.4) &&
                !spansMatch(getBBoxSpan(rA.bbox, m.privKeyInV1), getBBoxSpan(arrA.solidBBox ?? rA.bbox, m.privKeyInV1), 1.0)
            );
            const id = `cand_hole_cyl_${seq++}`;
            const prim = makeCylinderPrimitive(
              id,
              '圆柱孔腔',
              'subtract',
              arrB.view,
              cB.center.u,
              cB.center.v,
              cB.radius,
              spanLo,
              spanHi,
              true
            );
            registerVolume(
              prim,
              'cavity_Candidate',
              98,
              [arrA.view, arrB.view],
              `holecyl_${arrB.view}_${Math.round(cB.center.u)}_${Math.round(cB.center.v)}_${Math.round(cB.radius)}_${Math.round(spanLo)}_${Math.round(spanHi)}`,
              cBIsInner && !matchedAsStepBossInA ? { isGuaranteedVoid: true } : undefined
            );
          }
        }

        // 5b. Pair with matching non-outer solid RegionProfile2D in B (e.g. internal solid square/rect/semicircle/polygon框!)
        for (const rB of arrB.regions) {
          if (rB.isOuterEnvelope || !rB.isSolidOnly || rB.hasDashedBoundary) continue;
          if (pairedWithCircleInB && rB.shapeKind === 'circle') continue;
          const rbSpan = getBBoxSpan(rB.bbox, m.keyInV2);
          if (spansMatch(bandSharedSpan, rbSpan, 1.8)) {
            pairedWithBoundedProfileInB = true;
            const rBIsInner = isStrictlyInnerRegion(rB, arrB);
            const matchedAsStepBossInA = solidRegionsA.some(
              (rA) =>
                rA.shapeKind === 'rect' &&
                !isStrictlyInnerRegion(rA, arrA) &&
                spansMatch(rbSpan, getBBoxSpan(rA.bbox, m.keyInV1), 1.4) &&
                !spansMatch(getBBoxSpan(rA.bbox, m.privKeyInV1), getBBoxSpan(arrA.solidBBox ?? rA.bbox, m.privKeyInV1), 1.0)
            );
            const id = `cand_hole_bounded_${seq++}`;
            const prim = makeRegionExtrusionPrimitive(
              id,
              '有界内孔/内槽',
              'subtract',
              rB,
              spanLo,
              spanHi,
              true
            );
            registerVolume(
              prim,
              'cavity_Candidate',
              98,
              [arrA.view, arrB.view],
              `holereg_${arrB.view}_${Math.round(rB.bbox.uMin)}_${Math.round(rB.bbox.uMax)}_${Math.round(rB.bbox.vMin)}_${Math.round(rB.bbox.vMax)}_${Math.round(spanLo)}_${Math.round(spanHi)}`,
              rBIsInner && !matchedAsStepBossInA ? { isGuaranteedVoid: true } : undefined
            );
          }
        }

        // 5c. Pair with matching ParallelDashedBand in B along sharedAxis ONLY when neither view
        //     already explained this dashed band via an explicit visible inner hole opening!
        const hasVisibleInnerOpeningInA =
          arrA.carrierCircles.some(
            (cA) =>
              isStrictlyInnerCircle(cA, arrA) &&
              spansMatch(bandSharedSpan, [cA.center[m.keyInV1] - cA.radius, cA.center[m.keyInV1] + cA.radius], 1.8)
          ) ||
          arrA.regions.some(
            (rA) =>
              rA.isSolidOnly &&
              isStrictlyInnerRegion(rA, arrA) &&
              spansMatch(bandSharedSpan, getBBoxSpan(rA.bbox, m.keyInV1), 1.8)
          );

        if (!pairedWithBoundedProfileInB && !hasVisibleInnerOpeningInA) {
          for (const pBandB of arrB.parallelDashedBands) {
            const bwKeyB: 'u' | 'v' = pBandB.orientation === 'vertical' ? 'u' : 'v';
            if (bwKeyB !== m.keyInV2) continue;
            if (spansMatch(bandSharedSpan, [pBandB.coordMin, pBandB.coordMax], 1.8)) {
              pairedWithBoundedProfileInB = true;
              let bLo = pBandB.spanMin;
              let bHi = pBandB.spanMax;
              if (pBandB.touchesMinBoundary) bLo -= 2.0;
              if (pBandB.touchesMaxBoundary) bHi += 2.0;
              const box = makeBBox3DFromAxes(
                m.sharedAxis,
                bandSharedSpan,
                m.w2Axis,
                [spanLo, spanHi],
                m.w1Axis,
                [bLo, bHi]
              );
              const id = `cand_hole_dbl_dash_${seq++}`;
              registerVolume(
                {
                  id,
                  featureId: id,
                  label: '双虚线内腔槽',
                  operation: 'subtract',
                  shape: 'box',
                  ...box,
                  isInternalFeature: true,
                },
                'cavity_Candidate',
                92,
                [arrA.view, arrB.view],
                `holedbldash_${Math.round(box.xMin)}_${Math.round(box.xMax)}_${Math.round(box.yMin)}_${Math.round(box.yMax)}_${Math.round(box.zMin)}_${Math.round(box.zMax)}`
              );
            }
          }
        }

        // 5d. Only if NO bounded inner profile existed in B (and this dashed band is NOT merely an
        //     internal vertex crease pair of an inner polygon cavity in B!), lift a full-depth slot candidate
        const isInternalCreaseOfInnerPolygonInB = arrB.regions.some((rB) => {
          if (rB.isOuterEnvelope || rB.densePolygon.length < 3) return false;
          const rbSpan = getBBoxSpan(rB.bbox, m.keyInV2);
          if (pBand.coordMin < rbSpan[0] - 1.2 || pBand.coordMax > rbSpan[1] + 1.2) return false;
          const hasVertexNearMin = rB.densePolygon.some(
            (pt) => Math.abs(pt[m.keyInV2] - pBand.coordMin) <= 1.2
          );
          const hasVertexNearMax = rB.densePolygon.some(
            (pt) => Math.abs(pt[m.keyInV2] - pBand.coordMax) <= 1.2
          );
          return hasVertexNearMin && hasVertexNearMax;
        });

        if (!pairedWithBoundedProfileInB && !isInternalCreaseOfInnerPolygonInB) {
          const matchingSubDepths: [number, number][] = [[fullDepthOfA[0] - 1, fullDepthOfA[1] + 1]];
          for (const rB of solidRegionsB) {
            const rbSpan = getBBoxSpan(rB.bbox, m.keyInV2);
            if (spansOverlap(bandSharedSpan, rbSpan, 1.0)) {
              const dSpan = getBBoxSpan(rB.bbox, m.privKeyInV2);
              matchingSubDepths.push([dSpan[0] - 0.5, dSpan[1] + 0.5]);
            }
          }
          for (const dSpan of matchingSubDepths) {
            const box = makeBBox3DFromAxes(
              m.sharedAxis,
              bandSharedSpan,
              m.w2Axis,
              [spanLo, spanHi],
              m.w1Axis,
              dSpan
            );
            const id = `cand_slot_band_${seq++}`;
            registerVolume(
              {
                id,
                featureId: id,
                label: '贯通暗槽候选',
                operation: 'subtract',
                shape: 'box',
                ...box,
                isInternalFeature: true,
              },
              'cavity_Candidate',
              78,
              [arrA.view],
              `slotband_${Math.round(box.xMin)}_${Math.round(box.xMax)}_${Math.round(box.yMin)}_${Math.round(box.yMax)}_${Math.round(box.zMin)}_${Math.round(box.zMax)}`
            );
          }
        }
      } else if (bandWidthKey === m.privKeyInV1 && bandSpanKey === m.keyInV1) {
        // pBand's width [coordMin, coordMax] is along `w2Axis` (e.g. Z in Front or Y in Top),
        // and its length [spanLo, spanHi] runs along `sharedAxis`!
        // Note: if the other view B has an inner circle or inner loop along `w2Axis`, the symmetric pass
        // (arrB, arrA) will ALREADY pair B's `ParallelDashedBand` or A's band with B's inner profile when
        // `sharedAxis` matches! Wait: what if the hole runs ALONG `w1Axis` (perpendicular to A) — e.g.,
        // Front view has a solid inner circle/square at (X=60, Z=50) and Top view has horizontal dashed lines
        // Y in [42, 58] running across X?Wait: in Top view, horizontal lines have v = Y = const (`privKeyInV2`),
        // spanning X (`sharedAxis`) — wait: a hole along Y (Front view's sightline!) has:
        //   - in Front view: circle/rect spanning X=[52,68], Z=[42,58]
        //   - in Top view: vertical dashed lines X=52, X=68 spanning Y=[35,65]! (width along X = sharedAxis!)
        // What if the hole runs along X (Left view's sightline!), e.g. Case 9 Cone with transverse square hole along X,
        // or Case 8/10 hole along X?
        //   - When known views are Front (X,Z) and Top (X,Y), a transverse hole running along `sharedAxis` (X!) has:
        //     * in Front view: horizontal lines (dashed or solid!) Z = zMin, Z = zMax spanning X in [x0, x1]!
        //     * in Top view:   horizontal lines (dashed or solid!) Y = yMin, Y = yMax spanning X in [x0, x1]!
        // Let's handle transverse holes/slots running along `sharedAxis` explicitly right here!
        const w2HoleSpan: [number, number] = [pBand.coordMin, pBand.coordMax];
        const xSpanA: [number, number] = [spanLo, spanHi];

        // Pair with horizontal/privKeyInV2 dashed bands OR inner loops in B whose sharedAxis span overlaps xSpanA!
        for (const pBandB of arrB.parallelDashedBands) {
          const bwKeyB: 'u' | 'v' = pBandB.orientation === 'vertical' ? 'u' : 'v';
          if (bwKeyB !== m.privKeyInV2) continue;
          let bSpanLo = pBandB.spanMin;
          let bSpanHi = pBandB.spanMax;
          if (pBandB.touchesMinBoundary) bSpanLo -= 1.5;
          if (pBandB.touchesMaxBoundary) bSpanHi += 1.5;
          if (spansOverlap(xSpanA, [bSpanLo, bSpanHi], 2.0)) {
            const w1HoleSpan: [number, number] = [pBandB.coordMin, pBandB.coordMax];
            const xMerged: [number, number] = [
              Math.min(xSpanA[0], bSpanLo),
              Math.max(xSpanA[1], bSpanHi),
            ];
            const box = makeBBox3DFromAxes(m.sharedAxis, xMerged, m.w2Axis, w2HoleSpan, m.w1Axis, w1HoleSpan);
            const id = `cand_transverse_hole_${seq++}`;
            registerVolume(
              {
                id,
                featureId: id,
                label: '横向贯通孔槽',
                operation: 'subtract',
                shape: 'box',
                ...box,
                isInternalFeature: true,
              },
              'cavity_Candidate',
              95,
              [arrA.view, arrB.view],
              `transhole_${Math.round(box.xMin)}_${Math.round(box.xMax)}_${Math.round(box.yMin)}_${Math.round(box.yMax)}_${Math.round(box.zMin)}_${Math.round(box.zMax)}`
            );
          }
        }

        // Pair with inner regions in B whose sharedAxis span overlaps xSpanA
        for (const rB of arrB.regions) {
          if (rB.isOuterEnvelope) continue;
          const rbShared = getBBoxSpan(rB.bbox, m.keyInV2);
          if (spansOverlap(xSpanA, rbShared, 2.0)) {
            const w1HoleSpan = getBBoxSpan(rB.bbox, m.privKeyInV2);
            const box = makeBBox3DFromAxes(m.sharedAxis, xSpanA, m.w2Axis, w2HoleSpan, m.w1Axis, w1HoleSpan);
            const id = `cand_transverse_inner_${seq++}`;
            registerVolume(
              {
                id,
                featureId: id,
                label: '横向内腔槽',
                operation: 'subtract',
                shape: 'box',
                ...box,
                isInternalFeature: true,
              },
              'cavity_Candidate',
              94,
              [arrA.view, arrB.view],
              `transinner_${Math.round(box.xMin)}_${Math.round(box.xMax)}_${Math.round(box.yMin)}_${Math.round(box.yMax)}_${Math.round(box.zMin)}_${Math.round(box.zMax)}`
            );
          }
        }
      }
    }

    // ------------------------------------------------------------------------
    // 6. Inner Closed Loops in A (e.g., Square Hole in Cone Front View, Circle Hole
    //    Through Thin/Curved Wall, Slotted Groove) without Dashed Band in B or with
    //    Full-Body Penetration along w1Axis
    // ------------------------------------------------------------------------
    for (const rA of arrA.regions) {
      if (rA.isOuterEnvelope) continue;
      // Check if rA was ALREADY matched as a solid step boss in B!
      const sA = getBBoxSpan(rA.bbox, m.keyInV1);
      const isMatchedOuterStepInB = solidRegionsB.some((rB) => {
        if (spansMatch(sA, getBBoxSpan(rB.bbox, m.keyInV2), 1.4)) return true;
        if (rB.trapezoidSpec && rB.trapezoidSpec.taperAxis === m.privKeyInV2) {
          if (spansMatch(sA, [rB.trapezoidSpec.span0Min, rB.trapezoidSpec.span0Max], 1.6)) return true;
          if (spansMatch(sA, [rB.trapezoidSpec.span1Min, rB.trapezoidSpec.span1Max], 1.6)) return true;
        }
        return false;
      });

      // Generate a through-cavity candidate ONLY if `rA` is an atomic closed solid inner loop
      // strictly enclosed inside `arrA.outerSilhouetteLoops` (sharing ZERO outer silhouette edges —
      // panels touching the outer contour are exterior step/lateral faces, never internal holes!)
      // and not already matched as a solid step or frustum base in B.
      const sharesOuterContourEdge =
        arrA.outerSilhouetteLoops.length > 0 &&
        rA.segments.some((seg) => {
          const mid = { u: 0.5 * (seg.p1.u + seg.p2.u), v: 0.5 * (seg.p1.v + seg.p2.v) };
          return arrA.outerSilhouetteLoops.some(
            (ol) => Math.abs(evalCurvedRegion2DSDF(mid, ol.segments, ol.densePolygon)) <= 0.45
          );
        });

      if (rA.isSolidOnly && rA.isAtomic && !sharesOuterContourEdge && !isMatchedOuterStepInB) {
        const id = `cand_inner_through_${seq++}`;
        const prim = makeRegionExtrusionPrimitive(
          id,
          '内环穿透候选孔',
          'subtract',
          rA,
          fullDepthOfA[0] - 1.0,
          fullDepthOfA[1] + 1.0,
          true
        );
        registerVolume(
          prim,
          'cavity_Candidate',
          80,
          [arrA.view],
          `innerthru_${arrA.view}_${rA.shapeKind}_${Math.round(rA.bbox.uMin)}_${Math.round(rA.bbox.uMax)}_${Math.round(rA.bbox.vMin)}_${Math.round(rA.bbox.vMax)}`
        );
      }
    }

    // ------------------------------------------------------------------------
    // 7. Open Concave Boundary Slots / Notches on Outer Silhouettes (e.g. Slotted Sphere,
    //    Slotted Cylinder, Open Top/Bottom/Side Groove)
    // ------------------------------------------------------------------------
    // Detect pairs of parallel solid carrier lines bridged by an orthogonal solid floor/ceiling
    // where the interior of the notch lies strictly outside `arrA.outerSilhouetteLoops`!
    const bA = arrA.solidBBox ?? arrA.overallBBox;
    if (bA && arrA.outerSilhouetteLoops.length > 0) {
      const vSolids = arrA.carrierLines.filter((cl) => cl.isVertical && cl.hasSolid);
      const hSolids = arrA.carrierLines.filter((cl) => cl.isHorizontal && cl.hasSolid);

      // Vertical-walled U-notches (opening +v or -v)
      for (let i = 0; i < vSolids.length; i++) {
        for (let j = i + 1; j < vSolids.length; j++) {
          const u1 = Math.min(vSolids[i].pMin.u, vSolids[j].pMin.u);
          const u2 = Math.max(vSolids[i].pMin.u, vSolids[j].pMin.u);
          if (u2 - u1 < 2.0) continue;
          for (const hs of hSolids) {
            const hU0 = Math.min(hs.pMin.u, hs.pMax.u);
            const hU1 = Math.max(hs.pMin.u, hs.pMax.u);
            const floorV = hs.pMin.v;
            if (Math.abs(hU0 - u1) <= 1.5 && Math.abs(hU1 - u2) <= 1.5) {
              const midU = 0.5 * (u1 + u2);
              const probeUp = { u: midU, v: floorV + 2.5 };
              const probeDn = { u: midU, v: floorV - 2.5 };
              const upInside = arrA.outerSilhouetteLoops.some(
                (ol) => evalCurvedRegion2DSDF(probeUp, ol.segments, ol.densePolygon) <= 0
              );
              const dnInside = arrA.outerSilhouetteLoops.some(
                (ol) => evalCurvedRegion2DSDF(probeDn, ol.segments, ol.densePolygon) <= 0
              );
              if (!upInside && dnInside) {
                const maxV = Math.max(
                  bA.vMax,
                  ...arrA.carrierCircles.map((c) => c.center.v + c.radius)
                );
                const riserExtendsAbove =
                  Math.max(vSolids[i].pMin.v, vSolids[i].pMax.v) > floorV + 1.5 ||
                  Math.max(vSolids[j].pMin.v, vSolids[j].pMax.v) > floorV + 1.5;
                // Must be a genuine concave U-notch or step shoulder strictly below maxV (never the top edge of a plain rectangle!)
                if (maxV - floorV >= 2.0 && riserExtendsAbove) {
                  const box = makeBBox3DFromAxes(
                    m.sharedAxis,
                    m.keyInV1 === 'u' ? [u1, u2] : [floorV, maxV + 2.0],
                    m.w2Axis,
                    m.privKeyInV1 === 'v' ? [floorV, maxV + 2.0] : [u1, u2],
                    m.w1Axis,
                    [fullDepthOfA[0] - 1.5, fullDepthOfA[1] + 1.5]
                  );
                  const id = `cand_open_notch_${seq++}`;
                  registerVolume(
                    {
                      id,
                      featureId: id,
                      label: '开放贯通切槽',
                      operation: 'subtract',
                      shape: 'box',
                      ...box,
                      isInternalFeature: false,
                    },
                    'cavity_Candidate',
                    99,
                    [arrA.view],
                    `opennotch_${Math.round(box.xMin)}_${Math.round(box.xMax)}_${Math.round(box.yMin)}_${Math.round(box.yMax)}_${Math.round(box.zMin)}_${Math.round(box.zMax)}`,
                    { isGuaranteedVoid: true }
                  );
                }
              } else if (!dnInside && upInside) {
                const minV = Math.min(
                  bA.vMin,
                  ...arrA.carrierCircles.map((c) => c.center.v - c.radius)
                );
                const riserExtendsBelow =
                  Math.min(vSolids[i].pMin.v, vSolids[i].pMax.v) < floorV - 1.5 ||
                  Math.min(vSolids[j].pMin.v, vSolids[j].pMax.v) < floorV - 1.5;
                if (floorV - minV >= 2.0 && riserExtendsBelow) {
                  const box = makeBBox3DFromAxes(
                    m.sharedAxis,
                    m.keyInV1 === 'u' ? [u1, u2] : [minV - 2.0, floorV],
                    m.w2Axis,
                    m.privKeyInV1 === 'v' ? [minV - 2.0, floorV] : [u1, u2],
                    m.w1Axis,
                    [fullDepthOfA[0] - 1.5, fullDepthOfA[1] + 1.5]
                  );
                  const id = `cand_open_notch_${seq++}`;
                  registerVolume(
                    {
                      id,
                      featureId: id,
                      label: '底部开放切槽',
                      operation: 'subtract',
                      shape: 'box',
                      ...box,
                      isInternalFeature: false,
                    },
                    'cavity_Candidate',
                    99,
                    [arrA.view],
                    `opennotch_${Math.round(box.xMin)}_${Math.round(box.xMax)}_${Math.round(box.yMin)}_${Math.round(box.yMax)}_${Math.round(box.zMin)}_${Math.round(box.zMax)}`,
                    { isGuaranteedVoid: true }
                  );
                }
              }
            }
          }
        }
      }
    }
  };

  liftOrderedPair(arr1, arr2);
  liftOrderedPair(arr2, arr1);

  // Fallback Visual Hull Extrusions: ONLY if no specific quadric/loft/step/matched solid_body was lifted,
  // lift the outer silhouette extrusions of arr1 and arr2 so arbitrary freeform orthogonal intersections still solve!
  const hasSpecificSolid = volumes.some(
    (v) => v.roleHint === 'solid_body' || v.roleHint === 'step_boss'
  );
  if (!hasSpecificSolid) {
    const addFallbackHull = (arrA: PlanarArrangement2D, arrB: PlanarArrangement2D) => {
      const m = getSharedAxisMapping(arrA.view, arrB.view);
      const bB = arrB.solidBBox ?? arrB.overallBBox;
      if (!bB) return;
      const depthSpan = getBBoxSpan(bB, m.privKeyInV2);
      const outers = arrA.regions.filter((r) => r.isOuterEnvelope && r.isSolidOnly);
      for (const rA of outers) {
        const id = `cand_hull_ext_${seq++}`;
        const prim = makeRegionExtrusionPrimitive(
          id,
          '外轮廓包络柱',
          'add',
          rA,
          depthSpan[0],
          depthSpan[1],
          false
        );
        registerVolume(
          prim,
          'ambiguous',
          65,
          [arrA.view],
          `hull_${arrA.view}_${rA.shapeKind}_${Math.round(rA.bbox.uMin)}_${Math.round(rA.bbox.uMax)}_${Math.round(rA.bbox.vMin)}_${Math.round(rA.bbox.vMax)}_${Math.round(depthSpan[0])}_${Math.round(depthSpan[1])}`
        );
      }
    };
    addFallbackHull(arr1, arr2);
    addFallbackHull(arr2, arr1);
  }

  // Also lift standalone plane splitters from internal carrier lines in V1 and V2
  // (e.g., bevel / slot / step dividing lines inside silhouettes) so CellComplex3D partitions cleanly
  const surfaces: AnalyticalSurface3D[] = [];
  const seenSurfIds = new Set<string>();
  for (const vol of volumes) {
    for (const s of vol.surfaces) {
      if (!seenSurfIds.has(s.id)) {
        seenSurfIds.add(s.id);
        surfaces.push(s);
      }
    }
  }

  const addViewCarrierPlanes = (arr: PlanarArrangement2D) => {
    const hasLoftFromView = volumes.some(
      (v) =>
        v.primitive.shape === 'generalized_loft' &&
        v.roleHint !== 'cavity_Candidate' &&
        v.surfaces.some((s) => s.sourceViews.includes(arr.view))
    );
    const hasPolygonPrismFromView = volumes.some(
      (v) =>
        v.primitive.shape === 'prism' &&
        v.roleHint !== 'cavity_Candidate' &&
        v.surfaces.some((s) => s.sourceViews.includes(arr.view))
    );
    const hasPolygonalLoftFromView = volumes.some(
      (v) =>
        (v.primitive.shape === 'generalized_loft' || v.primitive.shape === 'pyramid') &&
        v.roleHint !== 'cavity_Candidate' &&
        (v.primitive.loftSpec?.section0.kind === 'polygon' ||
          v.primitive.loftSpec?.section1.kind === 'polygon') &&
        v.surfaces.some((s) => s.sourceViews.includes(arr.view))
    );
    for (const cl of arr.carrierLines) {
      if (!cl.hasSolid && !cl.hasDashed) continue;
      // Do not re-lift solid crease/rim lines of a polygonal pyramid/frustum as full-height extruded orthogonal planes!
      if (hasPolygonalLoftFromView && !hasPolygonPrismFromView && !cl.hasDashed) {
        continue;
      }
      // Do not re-lift sloped silhouette generators of a circular/semicircular GeneralizedLoft cone/frustum
      if (hasLoftFromView && !hasPolygonPrismFromView && !cl.isHorizontal && !cl.isVertical && !cl.hasDashed) {
        continue;
      }
      // Lift inclined bevels or internal dividing lines as exact 3D planes orthogonal to `arr.view`
      const n2D = cl.normal;
      const pt2D = cl.origin;
      const normal3D =
        arr.view === 'front'
          ? { x: n2D.u, y: 0, z: n2D.v }
          : arr.view === 'top'
            ? { x: n2D.u, y: n2D.v, z: 0 }
            : { x: 0, y: n2D.u, z: n2D.v };
      const pt3D =
        arr.view === 'front'
          ? { x: pt2D.u, y: 0.5 * (visualHullBBox.yMin + visualHullBBox.yMax), z: pt2D.v }
          : arr.view === 'top'
            ? { x: pt2D.u, y: pt2D.v, z: 0.5 * (visualHullBBox.zMin + visualHullBBox.zMax) }
            : { x: 0.5 * (visualHullBBox.xMin + visualHullBBox.xMax), y: pt2D.u, z: pt2D.v };

      // Check if an equivalent plane is already in surfaces
      const d = -(normal3D.x * pt3D.x + normal3D.y * pt3D.y + normal3D.z * pt3D.z);
      const dup = surfaces.some((s) => {
        if (s.kind !== 'plane' || !s.planeParams) return false;
        const p = s.planeParams;
        const sameDir =
          Math.abs(p.normal.x - normal3D.x) < 1e-2 &&
          Math.abs(p.normal.y - normal3D.y) < 1e-2 &&
          Math.abs(p.normal.z - normal3D.z) < 1e-2 &&
          Math.abs(p.d - d) < 0.4;
        const oppDir =
          Math.abs(p.normal.x + normal3D.x) < 1e-2 &&
          Math.abs(p.normal.y + normal3D.y) < 1e-2 &&
          Math.abs(p.normal.z + normal3D.z) < 1e-2 &&
          Math.abs(p.d + d) < 0.4;
        return sameDir || oppDir;
      });
      if (!dup) {
        surfaces.push(
          createPlaneSurface3D(
            `carrier_plane_${arr.view}_${cl.id}`,
            `${arr.view}分割平面`,
            normal3D,
            pt3D,
            visualHullBBox,
            [arr.view],
            !cl.hasSolid && cl.hasDashed
          )
        );
      }
    }
  };

  addViewCarrierPlanes(arr1);
  addViewCarrierPlanes(arr2);

  return {
    knownViews: [v1, v2],
    targetView,
    visualHullBBox,
    arr1,
    arr2,
    surfaces,
    volumes,
  };
}
