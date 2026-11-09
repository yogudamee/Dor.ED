import { CadEntity, CadLineEntity, Point2D, Primitive3D, ViewType } from '../../types/cad';
import {
  BackProjectionErrorMetrics,
  BoundingBox3D,
  CompositeRegion2D,
  DashedTopologyFeatures,
  VirtualCircleFeature,
} from '../../types/kernel';
import { dist2D, pointToSegmentDist } from '../arrangement/curveIntersector';
import { cleanMicroSolidFragmentsInDerivedEntities } from '../hlr/curveFitter2D';
import { pairTaperedHolesAcrossViews } from './featurePairingMatrix';

/**
 * Computes back-projection error metrics between a projected view E_hat and user-drawn entities E_user.
 */
export function evaluateViewBackProjectionMetrics(
  view: ViewType,
  userEntities: CadEntity[],
  reprojectedEntities: CadEntity[],
  primitives: Primitive3D[],
  dashedFeatures: DashedTopologyFeatures
): BackProjectionErrorMetrics {
  const userViewEnts = userEntities.filter((e) => e.view === view && e.source !== 'derived');
  const userDashedLines = userViewEnts.filter(
    (e): e is CadLineEntity => e.type === 'line' && e.lineType === 'thin_dashed'
  );
  const userSolidLines = userViewEnts.filter(
    (e): e is CadLineEntity => e.type === 'line' && e.lineType === 'thick_solid'
  );
  const projDashedLines = reprojectedEntities.filter(
    (e): e is CadLineEntity => e.type === 'line' && e.lineType === 'thin_dashed'
  );
  const projSolidLines = reprojectedEntities.filter(
    (e): e is CadLineEntity => e.type === 'line' && e.lineType === 'thick_solid'
  );

  const isPointNearAnyLine = (pt: Point2D, lines: CadLineEntity[], tol = 2.5): boolean =>
    lines.some((ln) => pointToSegmentDist(pt, ln.p1, ln.p2).dist <= tol);

  // 1. Check for False Holes (reprojected dashed lines that have no user dashed/solid match)
  let unmatchedProjDashed = 0;
  const falseHolePrimitiveIds: string[] = [];
  for (const pd of projDashedLines) {
    const mid = { u: 0.5 * (pd.p1.u + pd.p2.u), v: 0.5 * (pd.p1.v + pd.p2.v) };
    if (!isPointNearAnyLine(mid, userDashedLines, 2.8) && !isPointNearAnyLine(mid, userSolidLines, 2.5)) {
      unmatchedProjDashed++;
      if (pd.featureId) {
        const owner = primitives.find(
          (p) => p.operation === 'subtract' && (p.featureId === pd.featureId || p.id === pd.featureId)
        );
        if (owner && !falseHolePrimitiveIds.includes(owner.id)) {
          falseHolePrimitiveIds.push(owner.id);
        }
      }
    }
  }
  const falseDashedRatio =
    projDashedLines.length > 0 ? unmatchedProjDashed / projDashedLines.length : 0;

  // 2. Check for Missing Voids (user dashed lines not present in reprojected view)
  let unmatchedUserDashed = 0;
  for (const ud of userDashedLines) {
    const mid = { u: 0.5 * (ud.p1.u + ud.p2.u), v: 0.5 * (ud.p1.v + ud.p2.v) };
    if (!isPointNearAnyLine(mid, projDashedLines, 2.8) && !isPointNearAnyLine(mid, projSolidLines, 2.5)) {
      unmatchedUserDashed++;
    }
  }
  const missedDashedRatio =
    userDashedLines.length > 0 ? unmatchedUserDashed / userDashedLines.length : 0;

  // Identify any unpaired tapered dashed bands in this view
  const unpairedTaperedBands = dashedFeatures.taperedUBands.filter((tb) => {
    const midLeft = { u: 0.5 * (tb.u1Min + tb.u2Min), v: 0.5 * (tb.v1 + tb.v2) };
    const midRight = { u: 0.5 * (tb.u1Max + tb.u2Max), v: 0.5 * (tb.v1 + tb.v2) };
    return (
      !isPointNearAnyLine(midLeft, projDashedLines, 2.8) ||
      !isPointNearAnyLine(midRight, projDashedLines, 2.8)
    );
  });
  const unpairedTaperedVBands = dashedFeatures.taperedVBands.filter((tb) => {
    const midBot = { u: 0.5 * (tb.u1 + tb.u2), v: 0.5 * (tb.v1Min + tb.v2Min) };
    const midTop = { u: 0.5 * (tb.u1 + tb.u2), v: 0.5 * (tb.v1Max + tb.v2Max) };
    return (
      !isPointNearAnyLine(midBot, projDashedLines, 2.8) ||
      !isPointNearAnyLine(midTop, projDashedLines, 2.8)
    );
  });

  return {
    view,
    solidChamferDist: 0,
    falseDashedRatio,
    missedDashedRatio,
    silhouetteHausdorffDist: 0,
    falseHolePrimitiveIds,
    unpairedTaperedBands,
    unpairedTaperedVBands,
    hasInvertedArcSilhouette: false,
  };
}

/**
 * Closed-Loop 3D -> 2D Self-Verification & Self-Healing Solver:
 *   1. Intercepts illegal through-holes when no dashed lines exist and the hole matches a frustum cap or outer flat step
 *   2. Synthesizes missing tapered cone/pyramid subtract primitives if tapered dashed bands were left unpaired
 *   3. Cleans dangling micro thick_solid fragments (< 2.2mm) and heals open contour base gaps
 */
export function verifyAndSelfHealSolidDerivation(params: {
  rawPrimitives: Primitive3D[];
  rawDerivedEntities: CadEntity[];
  knownViews: [ViewType, ViewType];
  targetView: ViewType;
  userEntities: CadEntity[];
  bounds: BoundingBox3D;
  slotsFront: DashedTopologyFeatures;
  slotsTop: DashedTopologyFeatures;
  slotsLeft: DashedTopologyFeatures;
  innerCircles: VirtualCircleFeature[];
  innerRegions: CompositeRegion2D[];
  isSpanMatchingOuterFlatEndOrStep: (
    view: ViewType,
    coordAxis: 'u' | 'v',
    s1: number,
    s2: number
  ) => boolean;
  projectSolidFn: (
    view: ViewType,
    primitives: Primitive3D[],
    bounds: BoundingBox3D
  ) => CadEntity[];
}): {
  healedPrims: Primitive3D[];
  healedEntities: CadEntity[];
} {
  const {
    rawPrimitives,
    rawDerivedEntities,
    knownViews,
    targetView,
    userEntities,
    bounds,
    slotsFront,
    slotsTop,
    slotsLeft,
    innerCircles,
    innerRegions,
    isSpanMatchingOuterFlatEndOrStep,
    projectSolidFn,
  } = params;

  const [v1, v2] = knownViews;
  let prims = [...rawPrimitives];
  let modifiedPrims = false;

  // Self-Healing Rule 1 (Type A False Hole Removal):
  const hasConeOrFrustum = prims.some(
    (p) =>
      p.operation === 'add' &&
      (p.shape === 'cone_z' || p.shape === 'cone_y' || p.shape === 'cone_x' || p.shape === 'pyramid')
  );
  const hasAnyDashedInKnownViews = userEntities.some(
    (e) => (e.view === v1 || e.view === v2) && e.lineType === 'thin_dashed'
  );

  prims = prims.filter((p) => {
    if (p.operation !== 'subtract') return true;
    if (p.id.startsWith('sub-hole-') && !p.isInsideLoopContour) {
      if (hasConeOrFrustum && !hasAnyDashedInKnownViews) {
        modifiedPrims = true;
        return false;
      }
      if (
        p.shape === 'cylinder_z' &&
        !slotsFront.uBands.some((b) => Math.abs(b.u1 - p.xMin) <= 3 && Math.abs(b.u2 - p.xMax) <= 3) &&
        !slotsLeft.uBands.some((b) => Math.abs(b.u1 - p.yMin) <= 3 && Math.abs(b.u2 - p.yMax) <= 3) &&
        (isSpanMatchingOuterFlatEndOrStep('front', 'u', p.xMin, p.xMax) ||
          isSpanMatchingOuterFlatEndOrStep('left', 'u', p.yMin, p.yMax))
      ) {
        modifiedPrims = true;
        return false;
      }
      if (
        p.shape === 'cylinder_y' &&
        !slotsTop.uBands.some((b) => Math.abs(b.u1 - p.xMin) <= 3 && Math.abs(b.u2 - p.xMax) <= 3) &&
        !slotsLeft.vBands.some((b) => Math.abs(b.v1 - p.zMin) <= 3 && Math.abs(b.v2 - p.zMax) <= 3) &&
        (isSpanMatchingOuterFlatEndOrStep('top', 'u', p.xMin, p.xMax) ||
          isSpanMatchingOuterFlatEndOrStep('left', 'v', p.zMin, p.zMax))
      ) {
        modifiedPrims = true;
        return false;
      }
      if (
        p.shape === 'cylinder_x' &&
        !slotsFront.vBands.some((b) => Math.abs(b.v1 - p.zMin) <= 3 && Math.abs(b.v2 - p.zMax) <= 3) &&
        !slotsTop.vBands.some((b) => Math.abs(b.v1 - p.yMin) <= 3 && Math.abs(b.v2 - p.yMax) <= 3) &&
        (isSpanMatchingOuterFlatEndOrStep('front', 'v', p.zMin, p.zMax) ||
          isSpanMatchingOuterFlatEndOrStep('top', 'v', p.yMin, p.yMax))
      ) {
        modifiedPrims = true;
        return false;
      }
    }
    return true;
  });

  // Self-Healing Rule 2 (Type B Missing Tapered Hole Recovery):
  // If any tapered dashed band exists in the known views but no subtract cone/pyramid was created yet, pair it via DCEL regions!
  const hasTaperedBandsInKnownViews =
    slotsFront.taperedUBands.length > 0 ||
    slotsFront.taperedVBands.length > 0 ||
    slotsTop.taperedUBands.length > 0 ||
    slotsTop.taperedVBands.length > 0 ||
    slotsLeft.taperedUBands.length > 0 ||
    slotsLeft.taperedVBands.length > 0;
  const hasTaperedSubtractAlready = prims.some(
    (p) =>
      p.operation === 'subtract' &&
      (p.id.startsWith('sub-tapered-') ||
        p.shape === 'cone_x' ||
        p.shape === 'cone_y' ||
        p.shape === 'cone_z' ||
        p.shape === 'pyramid')
  );
  if (hasTaperedBandsInKnownViews && !hasTaperedSubtractAlready) {
    for (const kv of [v1, v2]) {
      const recovered = pairTaperedHolesAcrossViews(
        kv,
        innerCircles,
        innerRegions,
        slotsFront,
        slotsTop,
        slotsLeft
      );
      if (recovered.taperedSubtracts.length > 0) {
        prims.push(...recovered.taperedSubtracts);
        modifiedPrims = true;
      }
    }
  }

  let derived = modifiedPrims ? projectSolidFn(targetView, prims, bounds) : [...rawDerivedEntities];

  // Self-Healing Rule 3: Clean isolated micro thick_solid fragments (< 2.2mm) at solid/dashed transitions
  derived = cleanMicroSolidFragmentsInDerivedEntities(derived);

  // Self-Healing Rule 4: Topological Closed-Loop Verification on targetView solid outer contour
  const remainingSolidLines = derived.filter(
    (e): e is CadLineEntity => e.type === 'line' && e.lineType === 'thick_solid'
  );
  const solidCurvesAndArcs = derived.filter(
    (e) =>
      (e.type === 'arc' || e.type === 'circle' || e.type === 'polygon') &&
      e.lineType === 'thick_solid'
  );
  if (remainingSolidLines.length >= 2) {
    const endpointCounts: { pt: Point2D; count: number }[] = [];
    const addPt = (pt: Point2D) => {
      const found = endpointCounts.find((item) => dist2D(item.pt, pt) <= 0.75);
      if (found) found.count++;
      else endpointCounts.push({ pt: { ...pt }, count: 1 });
    };
    for (const sl of remainingSolidLines) {
      addPt(sl.p1);
      addPt(sl.p2);
    }
    for (const sc of solidCurvesAndArcs) {
      if (sc.type === 'arc') {
        addPt({
          u: sc.center.u + sc.radius * Math.cos(sc.startAngle),
          v: sc.center.v + sc.radius * Math.sin(sc.startAngle),
        });
        addPt({
          u: sc.center.u + sc.radius * Math.cos(sc.endAngle),
          v: sc.center.v + sc.radius * Math.sin(sc.endAngle),
        });
      }
    }
    const danglingPts = endpointCounts.filter((item) => item.count === 1).map((item) => item.pt);
    if (danglingPts.length === 2) {
      const [pA, pB] = danglingPts;
      if ((Math.abs(pA.u - pB.u) <= 0.8 || Math.abs(pA.v - pB.v) <= 0.8) && dist2D(pA, pB) >= 1.5) {
        derived.push({
          id: `derived-${targetView}-healed-base-${derived.length}`,
          view: targetView,
          type: 'line',
          lineType: 'thick_solid',
          p1: { u: Number(pA.u.toFixed(2)), v: Number(pA.v.toFixed(2)) },
          p2: { u: Number(pB.u.toFixed(2)), v: Number(pB.v.toFixed(2)) },
          source: 'derived',
          featureId: 'custom_main',
        });
      }
    }
  }

  return { healedPrims: prims, healedEntities: derived };
}
