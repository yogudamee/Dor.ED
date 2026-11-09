import { CadArcEntity, CadCircleEntity, CadEntity, LineType, Point2D, ViewType } from '../../types/cad';
import { VirtualCircleFeature } from '../../types/kernel';
import { ccwSweepAngle, dist2D, pointToSegmentDist } from './curveIntersector';

/**
 * Stitches concentric trimmed arcs and solid+dashed occluded arcs into VirtualCircleFeatures,
 * and marks participating thin_dashed arcs as consumed so they are never mistaken for hole subtractions.
 */
export function stitchVirtualCirclesInView(
  entities: CadEntity[],
  view: ViewType
): {
  virtualCircles: VirtualCircleFeature[];
  consumedDashedArcIds: Set<string>;
} {
  const viewEnts = entities.filter((e) => e.view === view && e.source !== 'derived');
  const rawCircles = viewEnts.filter(
    (e) => e.type === 'circle' && (e.lineType === 'thick_solid' || e.lineType === 'thin_dashed')
  ) as CadCircleEntity[];
  const rawArcs = viewEnts.filter(
    (e) => e.type === 'arc' && (e.lineType === 'thick_solid' || e.lineType === 'thin_dashed')
  ) as CadArcEntity[];
  const solidLines = viewEnts.filter((e) => e.type === 'line' && e.lineType === 'thick_solid');

  const consumedDashedArcIds = new Set<string>();
  const virtualCircles: VirtualCircleFeature[] = [];

  for (const c of rawCircles) {
    virtualCircles.push({
      id: c.id,
      view,
      center: { ...c.center },
      radius: c.radius,
      lineType: c.lineType,
      isStitchedFromArcs: false,
      coverageDegrees: 360,
      sourceEntityIds: [c.id],
      nestingDepth: 0,
      parentRegionId: null,
      parentCircleId: null,
    });
  }

  // Group concentric equal-radius arcs (center dist <= 1.5mm, radius diff <= 1.5mm)
  const visitedArcIds = new Set<string>();
  for (let i = 0; i < rawArcs.length; i++) {
    const a0 = rawArcs[i];
    if (visitedArcIds.has(a0.id)) continue;
    const group: CadArcEntity[] = [a0];
    visitedArcIds.add(a0.id);

    for (let j = i + 1; j < rawArcs.length; j++) {
      const aj = rawArcs[j];
      if (visitedArcIds.has(aj.id)) continue;
      if (dist2D(a0.center, aj.center) <= 1.5 && Math.abs(a0.radius - aj.radius) <= 1.5) {
        group.push(aj);
        visitedArcIds.add(aj.id);
      }
    }

    const avgU = group.reduce((acc, a) => acc + a.center.u, 0) / group.length;
    const avgV = group.reduce((acc, a) => acc + a.center.v, 0) / group.length;
    const avgR = group.reduce((acc, a) => acc + a.radius, 0) / group.length;
    const center: Point2D = { u: avgU, v: avgV };

    // Already have an explicit circle here?
    if (virtualCircles.some((vc) => dist2D(vc.center, center) <= 1.5 && Math.abs(vc.radius - avgR) <= 1.5)) {
      continue;
    }

    const totalSweepRad = group.reduce((acc, a) => acc + ccwSweepAngle(a.startAngle, a.endAngle), 0);
    const totalDeg = Math.min(360, (totalSweepRad * 180) / Math.PI);

    // Case 1: Concentric multi-arc stitch covering >= 240 deg
    if (group.length >= 2 && totalDeg >= 240) {
      const hasSolid = group.some((a) => a.lineType === 'thick_solid');
      const lineType: LineType = hasSolid ? 'thick_solid' : 'thin_dashed';
      for (const a of group) {
        if (a.lineType === 'thin_dashed') {
          consumedDashedArcIds.add(a.id);
        }
      }
      virtualCircles.push({
        id: `vcircle_stitched_${view}_${virtualCircles.length}`,
        view,
        center,
        radius: avgR,
        lineType,
        isStitchedFromArcs: true,
        coverageDegrees: totalDeg,
        sourceEntityIds: group.map((a) => a.id),
        nestingDepth: 0,
        parentRegionId: null,
        parentCircleId: null,
      });
      continue;
    }

    // Case 2: Single trimmed major arc (> 195 deg) without a direct closing flat chord
    if (group.length === 1 && totalDeg > 195 && a0.lineType === 'thick_solid') {
      const pS = {
        u: a0.center.u + a0.radius * Math.cos(a0.startAngle),
        v: a0.center.v + a0.radius * Math.sin(a0.startAngle),
      };
      const pE = {
        u: a0.center.u + a0.radius * Math.cos(a0.endAngle),
        v: a0.center.v + a0.radius * Math.sin(a0.endAngle),
      };
      const hasDirectClosingChord = solidLines.some(
        (ln) =>
          ln.type === 'line' &&
          pointToSegmentDist(pS, ln.p1, ln.p2).dist <= 2.0 &&
          pointToSegmentDist(pE, ln.p1, ln.p2).dist <= 2.0
      );
      if (!hasDirectClosingChord) {
        virtualCircles.push({
          id: `vcircle_major_${view}_${virtualCircles.length}`,
          view,
          center,
          radius: avgR,
          lineType: 'thick_solid',
          isStitchedFromArcs: true,
          coverageDegrees: totalDeg,
          sourceEntityIds: [a0.id],
          nestingDepth: 0,
          parentRegionId: null,
          parentCircleId: null,
        });
      }
    }
  }

  return { virtualCircles, consumedDashedArcIds };
}
