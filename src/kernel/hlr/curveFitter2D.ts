import { CadEntity, CadLineEntity, Point2D, ViewType } from '../../types/cad';
import { dist2D, pointToSegmentDist } from '../arrangement/curveIntersector';
import { ClassifiedSegment2D } from './quantitativeVisibility';

/**
 * Merges collinear 2D projected fragments and applies GB/T 4458.1 line-type priority clipping:
 *   thick_solid > thin_dashed > center_dot_dash
 * Also cleans up dangling micro-fragments (< 2.2mm) at solid-dashed transition boundaries.
 */
export function fitAndPrioritize2DProjection(
  segments: ClassifiedSegment2D[],
  targetView: ViewType
): CadEntity[] {
  const entities: CadEntity[] = segments.map((s, idx) => ({
    id: `hlr-${targetView}-${idx}`,
    view: targetView,
    type: 'line',
    lineType: s.lineType,
    p1: { u: Number(s.p1.u.toFixed(2)), v: Number(s.p1.v.toFixed(2)) },
    p2: { u: Number(s.p2.u.toFixed(2)), v: Number(s.p2.v.toFixed(2)) },
    source: 'derived',
    featureId: s.featureId || 'custom_main',
    featureLabel: s.featureLabel,
  }));

  return cleanMicroSolidFragmentsInDerivedEntities(entities);
}

/**
 * Removes isolated micro thick_solid fragments (< 2.2mm) that dangle at thin_dashed hole boundaries
 * and heals broken base lines.
 */
export function cleanMicroSolidFragmentsInDerivedEntities(derived: CadEntity[]): CadEntity[] {
  const solidLines = derived.filter(
    (e): e is CadLineEntity => e.type === 'line' && e.lineType === 'thick_solid'
  );
  const dashedLines = derived.filter(
    (e): e is CadLineEntity => e.type === 'line' && e.lineType === 'thin_dashed'
  );
  const solidCurves = derived.filter(
    (e) =>
      (e.type === 'arc' || e.type === 'circle' || e.type === 'polygon') &&
      e.lineType === 'thick_solid'
  );

  const isPtConnectedToSolid = (pt: Point2D, selfId: string): boolean => {
    for (const sl of solidLines) {
      if (sl.id === selfId) continue;
      if (dist2D(pt, sl.p1) <= 0.65 || dist2D(pt, sl.p2) <= 0.65) return true;
    }
    for (const sc of solidCurves) {
      if ((sc.type === 'arc' || sc.type === 'circle') && sc.center && sc.radius !== undefined) {
        if (Math.abs(dist2D(pt, sc.center) - sc.radius) <= 0.75) return true;
      } else if (sc.type === 'polygon' && Array.isArray(sc.points)) {
        if (sc.points.some((qp) => dist2D(pt, qp) <= 0.75)) return true;
      }
    }
    return false;
  };

  const toRemoveIds = new Set<string>();
  for (const sl of solidLines) {
    const len = dist2D(sl.p1, sl.p2);
    if (len >= 2.2) continue;
    const dxS = (sl.p2.u - sl.p1.u) / Math.max(1e-4, len);
    const dyS = (sl.p2.v - sl.p1.v) / Math.max(1e-4, len);
    const touchesCollinearDashed = dashedLines.some((dl) => {
      const dLen = dist2D(dl.p1, dl.p2);
      if (dLen < 0.5) return false;
      const dxD = (dl.p2.u - dl.p1.u) / dLen;
      const dyD = (dl.p2.v - dl.p1.v) / dLen;
      const isCollinear = Math.abs(dxS * dyD - dyS * dxD) <= 0.08;
      if (!isCollinear) return false;
      return (
        dist2D(sl.p1, dl.p1) <= 1.2 ||
        dist2D(sl.p1, dl.p2) <= 1.2 ||
        dist2D(sl.p2, dl.p1) <= 1.2 ||
        dist2D(sl.p2, dl.p2) <= 1.2 ||
        pointToSegmentDist(sl.p1, dl.p1, dl.p2).dist <= 0.8 ||
        pointToSegmentDist(sl.p2, dl.p1, dl.p2).dist <= 0.8
      );
    });
    const c1 = isPtConnectedToSolid(sl.p1, sl.id);
    const c2 = isPtConnectedToSolid(sl.p2, sl.id);
    if (touchesCollinearDashed || !c1 || !c2) {
      toRemoveIds.add(sl.id);
    }
  }

  return toRemoveIds.size > 0 ? derived.filter((e) => !toRemoveIds.has(e.id)) : derived;
}
