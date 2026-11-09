import { LineType, Point2D, Primitive3D, ViewType } from '../../types/cad';
import { BoundingBox3D, Seg3D, Vec3 } from '../../types/kernel';
import { evaluateCSGTreeSDF, isPointOnKnifeEdgeOrThinWall } from '../primitives/csgTree';

export interface ClassifiedSegment2D {
  p1: Point2D;
  p2: Point2D;
  lineType: LineType;
  featureId?: string;
  featureLabel?: string;
}

export function projectPoint3DTo2D(p: Vec3, view: ViewType): Point2D {
  if (view === 'front') return { u: p.x, v: p.z };
  if (view === 'top') return { u: p.x, v: p.y };
  return { u: p.y, v: p.z };
}

/**
 * Quantitative HLR Visibility Classifier with:
 *   1. Subtract Hole Wall Strict Interior Clipping (dAddOnly < -0.05 -> forced thin_dashed)
 *   2. 26-Neighborhood Knife-Edge & Thin-Wall Protection
 *   3. Adaptive Subdivision Raycast Occlusion Testing
 */
export function classifySegment3DVisibility(
  seg: Seg3D,
  primitives: Primitive3D[],
  targetView: ViewType,
  bounds: BoundingBox3D,
  numSubdivisions = 24
): ClassifiedSegment2D[] {
  const results: ClassifiedSegment2D[] = [];
  const isSubtractEdge = seg.ownerType === 'subtract' || seg.forceHidden === true;

  const isRayOccluded = (pt: Vec3): boolean => {
    const raySteps = 32;
    if (targetView === 'front') {
      const yEnd = bounds.yMin - 2;
      const dist = pt.y - yEnd;
      if (dist <= 0.4) return false;
      for (let k = 1; k <= raySteps; k++) {
        const yTest = pt.y - (k / raySteps) * dist;
        if (pt.y - yTest < 0.35) continue;
        const { dAll } = evaluateCSGTreeSDF({ x: pt.x, y: yTest, z: pt.z }, primitives);
        if (dAll < -0.08) return true;
      }
      return false;
    }
    if (targetView === 'top') {
      const zEnd = bounds.zMax + 2;
      const dist = zEnd - pt.z;
      if (dist <= 0.4) return false;
      for (let k = 1; k <= raySteps; k++) {
        const zTest = pt.z + (k / raySteps) * dist;
        if (zTest - pt.z < 0.35) continue;
        const { dAll } = evaluateCSGTreeSDF({ x: pt.x, y: pt.y, z: zTest }, primitives);
        if (dAll < -0.08) return true;
      }
      return false;
    }
    const xEnd = bounds.xMin - 2;
    const dist = pt.x - xEnd;
    if (dist <= 0.4) return false;
    for (let k = 1; k <= raySteps; k++) {
      const xTest = pt.x - (k / raySteps) * dist;
      if (pt.x - xTest < 0.35) continue;
      const { dAll } = evaluateCSGTreeSDF({ x: xTest, y: pt.y, z: pt.z }, primitives);
      if (dAll < -0.08) return true;
    }
    return false;
  };

  let currentStart2D: Point2D | null = null;
  let currentEnd2D: Point2D | null = null;
  let currentLineType: LineType | null = null;

  const flushRun = () => {
    if (
      currentStart2D &&
      currentEnd2D &&
      currentLineType &&
      Math.hypot(currentEnd2D.u - currentStart2D.u, currentEnd2D.v - currentStart2D.v) >= 0.4
    ) {
      results.push({
        p1: currentStart2D,
        p2: currentEnd2D,
        lineType: currentLineType,
        featureId: seg.featureId,
        featureLabel: seg.featureLabel,
      });
    }
    currentStart2D = null;
    currentEnd2D = null;
    currentLineType = null;
  };

  for (let i = 0; i < numSubdivisions; i++) {
    const t0 = i / numSubdivisions;
    const t1 = (i + 1) / numSubdivisions;
    const tMid = 0.5 * (t0 + t1);
    const pMid: Vec3 = {
      x: seg.p1.x + tMid * (seg.p2.x - seg.p1.x),
      y: seg.p1.y + tMid * (seg.p2.y - seg.p1.y),
      z: seg.p1.z + tMid * (seg.p2.z - seg.p1.z),
    };
    const { dAll, dAddOnly } = evaluateCSGTreeSDF(pMid, primitives);

    // Iron Rule 1: Subtract hole wall generators must lie strictly inside the base solid (dAddOnly < -0.05)
    // and are unconditionally classified as thin_dashed!
    if (isSubtractEdge) {
      if (dAddOnly >= -0.05 || Math.abs(dAll) > 0.45) {
        flushRun();
        continue;
      }
      const pA2D = projectPoint3DTo2D(
        {
          x: seg.p1.x + t0 * (seg.p2.x - seg.p1.x),
          y: seg.p1.y + t0 * (seg.p2.y - seg.p1.y),
          z: seg.p1.z + t0 * (seg.p2.z - seg.p1.z),
        },
        targetView
      );
      const pB2D = projectPoint3DTo2D(
        {
          x: seg.p1.x + t1 * (seg.p2.x - seg.p1.x),
          y: seg.p1.y + t1 * (seg.p2.y - seg.p1.y),
          z: seg.p1.z + t1 * (seg.p2.z - seg.p1.z),
        },
        targetView
      );
      if (currentLineType !== 'thin_dashed') {
        flushRun();
        currentStart2D = pA2D;
        currentLineType = 'thin_dashed';
      }
      currentEnd2D = pB2D;
      continue;
    }

    // Iron Rule 2: 26-Neighborhood Knife-Edge & Thin-Wall Protection for add/intersect edges
    const onSurface = Math.abs(dAll) <= 0.35 || isPointOnKnifeEdgeOrThinWall(pMid, primitives, 0.35);
    if (!onSurface) {
      flushRun();
      continue;
    }

    const occluded = isRayOccluded(pMid);
    const lt: LineType = occluded ? 'thin_dashed' : 'thick_solid';
    const pA2D = projectPoint3DTo2D(
      {
        x: seg.p1.x + t0 * (seg.p2.x - seg.p1.x),
        y: seg.p1.y + t0 * (seg.p2.y - seg.p1.y),
        z: seg.p1.z + t0 * (seg.p2.z - seg.p1.z),
      },
      targetView
    );
    const pB2D = projectPoint3DTo2D(
      {
        x: seg.p1.x + t1 * (seg.p2.x - seg.p1.x),
        y: seg.p1.y + t1 * (seg.p2.y - seg.p1.y),
        z: seg.p1.z + t1 * (seg.p2.z - seg.p1.z),
      },
      targetView
    );
    if (currentLineType !== lt) {
      flushRun();
      currentStart2D = pA2D;
      currentLineType = lt;
    }
    currentEnd2D = pB2D;
  }

  flushRun();
  return results;
}
