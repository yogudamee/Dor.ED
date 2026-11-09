import { Primitive3D, ViewType } from '../../types/cad';
import {
  CompositeRegion2D,
  DashedTopologyFeatures,
  VirtualCircleFeature,
} from '../../types/kernel';

/**
 * Pairs two inner circles or two inner composite loops (such as concentric semicircles sharing a chord)
 * with matching taperedDashedBands in the adjacent view to produce exact 'subtract' cone/pyramid primitives.
 */
export function pairTaperedHolesAcrossViews(
  view: ViewType,
  innerCircles: VirtualCircleFeature[],
  innerRegions: CompositeRegion2D[],
  slotsFront: DashedTopologyFeatures,
  slotsTop: DashedTopologyFeatures,
  slotsLeft: DashedTopologyFeatures,
  pairTol = 2.5
): {
  taperedSubtracts: Primitive3D[];
  consumedCircleIds: Set<string>;
  consumedRegionIds: Set<string>;
} {
  const taperedSubtracts: Primitive3D[] = [];
  const consumedCircleIds = new Set<string>();
  const consumedRegionIds = new Set<string>();

  // 1. Pair two inner circles with tapered dashed bands -> cone_x / cone_y / cone_z (subtract)
  const viewCircles = innerCircles.filter((c) => c.view === view);
  for (let i = 0; i < viewCircles.length; i++) {
    for (let j = i + 1; j < viewCircles.length; j++) {
      const cA = viewCircles[i];
      const cB = viewCircles[j];
      if (consumedCircleIds.has(cA.id) || consumedCircleIds.has(cB.id)) continue;
      if (Math.abs(cA.radius - cB.radius) < 1.0) continue;
      const cSmall = cA.radius <= cB.radius ? cA : cB;
      const cBig = cA.radius <= cB.radius ? cB : cA;
      const sU1 = cSmall.center.u - cSmall.radius,
        sU2 = cSmall.center.u + cSmall.radius;
      const sV1 = cSmall.center.v - cSmall.radius,
        sV2 = cSmall.center.v + cSmall.radius;
      const bU1 = cBig.center.u - cBig.radius,
        bU2 = cBig.center.u + cBig.radius;
      const bV1 = cBig.center.v - cBig.radius,
        bV2 = cBig.center.v + cBig.radius;

      if (view === 'front') {
        const tbU = slotsTop.taperedUBands.find(
          (tb) =>
            (Math.abs(tb.u1Min - sU1) <= pairTol &&
              Math.abs(tb.u1Max - sU2) <= pairTol &&
              Math.abs(tb.u2Min - bU1) <= pairTol &&
              Math.abs(tb.u2Max - bU2) <= pairTol) ||
            (Math.abs(tb.u2Min - sU1) <= pairTol &&
              Math.abs(tb.u2Max - sU2) <= pairTol &&
              Math.abs(tb.u1Min - bU1) <= pairTol &&
              Math.abs(tb.u1Max - bU2) <= pairTol)
        );
        const tbLeftV = slotsLeft.taperedVBands.find(
          (tb) =>
            (Math.abs(tb.v1Min - sV1) <= pairTol &&
              Math.abs(tb.v1Max - sV2) <= pairTol &&
              Math.abs(tb.v2Min - bV1) <= pairTol &&
              Math.abs(tb.v2Max - bV2) <= pairTol) ||
            (Math.abs(tb.v2Min - sV1) <= pairTol &&
              Math.abs(tb.v2Max - sV2) <= pairTol &&
              Math.abs(tb.v1Min - bV1) <= pairTol &&
              Math.abs(tb.v1Max - bV2) <= pairTol)
        );
        if (tbU || tbLeftV) {
          consumedCircleIds.add(cSmall.id);
          consumedCircleIds.add(cBig.id);
          const smallAtMin = tbU
            ? Math.abs(tbU.u1Min - sU1) <= pairTol && Math.abs(tbU.u1Max - sU2) <= pairTol
            : Math.abs(tbLeftV!.v1Min - sV1) <= pairTol && Math.abs(tbLeftV!.v1Max - sV2) <= pairTol;
          const w1 = tbU ? tbU.v1 : tbLeftV!.u1;
          const w2 = tbU ? tbU.v2 : tbLeftV!.u2;
          const cAtMin = smallAtMin ? cSmall : cBig;
          const cAtMax = smallAtMin ? cBig : cSmall;
          taperedSubtracts.push({
            id: `sub-tapered-cone-y-${i}-${j}`,
            featureId: `taper_hole_y_${i}`,
            label: `Tapered Hole Ø${Math.round(cSmall.radius * 2)}-Ø${Math.round(cBig.radius * 2)}`,
            operation: 'subtract',
            shape: 'cone_y',
            xMin: Math.min(sU1, bU1),
            xMax: Math.max(sU2, bU2),
            yMin: w1,
            yMax: w2,
            zMin: Math.min(sV1, bV1),
            zMax: Math.max(sV2, bV2),
            centerX: cBig.center.u,
            centerZ: cBig.center.v,
            uCenterMin: cAtMin.center.u,
            vCenterMin: cAtMin.center.v,
            uCenterMax: cAtMax.center.u,
            vCenterMax: cAtMax.center.v,
            radius: cBig.radius,
            rMin: cAtMin.radius,
            rMax: cAtMax.radius,
            isInternalFeature: true,
            isInsideLoopContour: true,
          });
        }
      } else if (view === 'top') {
        const tbFrontU = slotsFront.taperedUBands.find(
          (tb) =>
            (Math.abs(tb.u1Min - sU1) <= pairTol &&
              Math.abs(tb.u1Max - sU2) <= pairTol &&
              Math.abs(tb.u2Min - bU1) <= pairTol &&
              Math.abs(tb.u2Max - bU2) <= pairTol) ||
            (Math.abs(tb.u2Min - sU1) <= pairTol &&
              Math.abs(tb.u2Max - sU2) <= pairTol &&
              Math.abs(tb.u1Min - bU1) <= pairTol &&
              Math.abs(tb.u1Max - bU2) <= pairTol)
        );
        const tbLeftU = slotsLeft.taperedUBands.find(
          (tb) =>
            (Math.abs(tb.u1Min - sV1) <= pairTol &&
              Math.abs(tb.u1Max - sV2) <= pairTol &&
              Math.abs(tb.u2Min - bV1) <= pairTol &&
              Math.abs(tb.u2Max - bV2) <= pairTol) ||
            (Math.abs(tb.u2Min - sV1) <= pairTol &&
              Math.abs(tb.u2Max - sV2) <= pairTol &&
              Math.abs(tb.u1Min - bV1) <= pairTol &&
              Math.abs(tb.u1Max - bV2) <= pairTol)
        );
        if (tbFrontU || tbLeftU) {
          consumedCircleIds.add(cSmall.id);
          consumedCircleIds.add(cBig.id);
          const tb = tbFrontU || tbLeftU!;
          const smallAtMin = tbFrontU
            ? Math.abs(tbFrontU.u1Min - sU1) <= pairTol && Math.abs(tbFrontU.u1Max - sU2) <= pairTol
            : Math.abs(tbLeftU!.u1Min - sV1) <= pairTol && Math.abs(tbLeftU!.u1Max - sV2) <= pairTol;
          const cAtMin = smallAtMin ? cSmall : cBig;
          const cAtMax = smallAtMin ? cBig : cSmall;
          taperedSubtracts.push({
            id: `sub-tapered-cone-z-${i}-${j}`,
            featureId: `taper_hole_z_${i}`,
            label: `Tapered Hole Ø${Math.round(cSmall.radius * 2)}-Ø${Math.round(cBig.radius * 2)}`,
            operation: 'subtract',
            shape: 'cone_z',
            xMin: Math.min(sU1, bU1),
            xMax: Math.max(sU2, bU2),
            yMin: Math.min(sV1, bV1),
            yMax: Math.max(sV2, bV2),
            zMin: tb.v1,
            zMax: tb.v2,
            centerX: cBig.center.u,
            centerY: cBig.center.v,
            uCenterMin: cAtMin.center.u,
            vCenterMin: cAtMin.center.v,
            uCenterMax: cAtMax.center.u,
            vCenterMax: cAtMax.center.v,
            radius: cBig.radius,
            rMin: cAtMin.radius,
            rMax: cAtMax.radius,
            isInternalFeature: true,
            isInsideLoopContour: true,
          });
        }
      }
    }
  }

  // 2. Pair two inner composite regions (e.g. concentric semicircles sharing a chord) with tapered dashed bands -> pyramid (subtract)
  const viewRegs = innerRegions.filter((r) => r.view === view);
  for (let i = 0; i < viewRegs.length; i++) {
    for (let j = i + 1; j < viewRegs.length; j++) {
      const rA = viewRegs[i];
      const rB = viewRegs[j];
      if (consumedRegionIds.has(rA.id) || consumedRegionIds.has(rB.id)) continue;
      const rSmall = rA.area <= rB.area ? rA : rB;
      const rBig = rSmall === rA ? rB : rA;
      const sU1 = rSmall.bounds.uMin,
        sU2 = rSmall.bounds.uMax,
        sV1 = rSmall.bounds.vMin,
        sV2 = rSmall.bounds.vMax;
      const bU1 = rBig.bounds.uMin,
        bU2 = rBig.bounds.uMax,
        bV1 = rBig.bounds.vMin,
        bV2 = rBig.bounds.vMax;
      if (Math.abs(bU2 - bU1 - (sU2 - sU1)) < 1.5 && Math.abs(bV2 - bV1 - (sV2 - sV1)) < 1.5) {
        continue;
      }

      if (view === 'front') {
        const tbTopU = slotsTop.taperedUBands.find(
          (tb) =>
            (Math.abs(tb.u1Min - sU1) <= pairTol &&
              Math.abs(tb.u1Max - sU2) <= pairTol &&
              Math.abs(tb.u2Min - bU1) <= pairTol &&
              Math.abs(tb.u2Max - bU2) <= pairTol) ||
            (Math.abs(tb.u2Min - sU1) <= pairTol &&
              Math.abs(tb.u2Max - sU2) <= pairTol &&
              Math.abs(tb.u1Min - bU1) <= pairTol &&
              Math.abs(tb.u1Max - bU2) <= pairTol)
        );
        const tbLeftV = slotsLeft.taperedVBands.find(
          (tb) =>
            (Math.abs(tb.v1Min - sV1) <= pairTol &&
              Math.abs(tb.v1Max - sV2) <= pairTol &&
              Math.abs(tb.v2Min - bV1) <= pairTol &&
              Math.abs(tb.v2Max - bV2) <= pairTol) ||
            (Math.abs(tb.v2Min - sV1) <= pairTol &&
              Math.abs(tb.v2Max - sV2) <= pairTol &&
              Math.abs(tb.v1Min - bV1) <= pairTol &&
              Math.abs(tb.v1Max - bV2) <= pairTol)
        );
        if (tbTopU || tbLeftV) {
          consumedRegionIds.add(rSmall.id);
          consumedRegionIds.add(rBig.id);
          const smallAtMin = tbTopU
            ? Math.abs(tbTopU.u1Min - sU1) <= pairTol && Math.abs(tbTopU.u1Max - sU2) <= pairTol
            : Math.abs(tbLeftV!.v1Min - sV1) <= pairTol && Math.abs(tbLeftV!.v1Max - sV2) <= pairTol;
          const y1 = tbTopU ? tbTopU.v1 : tbLeftV!.u1;
          const y2 = tbTopU ? tbTopU.v2 : tbLeftV!.u2;
          const wTop = smallAtMin ? y1 : y2;
          const topScale = Math.max(
            0.05,
            Math.min(
              0.95,
              sU2 - sU1 > 1.5 && bU2 - bU1 > 1.5
                ? (sU2 - sU1) / (bU2 - bU1)
                : (sV2 - sV1) / Math.max(1.5, bV2 - bV1)
            )
          );
          const uApex =
            Math.abs(bU2 - sU2) <= 1.5
              ? bU2
              : Math.abs(bU1 - sU1) <= 1.5
                ? bU1
                : (0.5 * (sU1 + sU2) - topScale * 0.5 * (bU1 + bU2)) / Math.max(1e-3, 1 - topScale);
          const vApex =
            Math.abs(bV2 - sV2) <= 1.5
              ? bV2
              : Math.abs(bV1 - sV1) <= 1.5
                ? bV1
                : (0.5 * (sV1 + sV2) - topScale * 0.5 * (bV1 + bV2)) / Math.max(1e-3, 1 - topScale);
          taperedSubtracts.push({
            id: `sub-tapered-pyramid-y-${i}-${j}`,
            featureId: `taper_loop_y_${i}`,
            label: `Tapered Frustum Cutout (${Math.round(bU2 - bU1)}→${Math.round(sU2 - sU1)})`,
            operation: 'subtract',
            shape: 'pyramid',
            prismAxis: 'Y',
            extrudeAxis: 'y',
            prismPolygon: rBig.polygon,
            polygon2D: rBig.polygon,
            prismSegments: rBig.boundarySegments,
            apex3D: [uApex, wTop, vApex],
            pyramidTopScale: topScale,
            xMin: Math.min(sU1, bU1),
            xMax: Math.max(sU2, bU2),
            yMin: y1,
            yMax: y2,
            zMin: Math.min(sV1, bV1),
            zMax: Math.max(sV2, bV2),
            isInternalFeature: true,
            isInsideLoopContour: true,
          });
        }
      }
    }
  }

  return { taperedSubtracts, consumedCircleIds, consumedRegionIds };
}
