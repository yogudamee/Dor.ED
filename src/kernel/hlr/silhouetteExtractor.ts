import { Primitive3D, ViewType } from '../../types/cad';
import { CircleOrArc3D, Seg3D } from '../../types/kernel';
import {
  computePlaneQuadricSectionSegments,
  extractSlantedPlanesFromPrimitive,
} from '../intersection/planeSurfaceCut';
import { tracePairwiseCurvedSSI } from '../intersection/surfaceSurfaceSSI';
import {
  extractGeneralizedLoftEdgesAndSilhouettes,
  primitiveToGeneralizedLoft,
} from '../primitives/generalizedLoft';

/**
 * Unified 3D Candidate Edge & Silhouette Extractor across GeneralizedLoft,
 * Quadrics, Plane-Surface Conic Sections, and Surface-Surface Intersections (SSI).
 */
export function extractAllCandidate3DEdges(
  primitives: Primitive3D[],
  targetView: ViewType
): {
  lines3D: Seg3D[];
  circles3D: CircleOrArc3D[];
} {
  const lines3D: Seg3D[] = [];
  const circles3D: CircleOrArc3D[] = [];

  for (const prim of primitives) {
    const loft = primitiveToGeneralizedLoft(prim);
    if (loft) {
      const res = extractGeneralizedLoftEdgesAndSilhouettes(loft, targetView);
      lines3D.push(...res.lines3D);
      circles3D.push(...res.circles3D);
    }
  }

  // Plane-Quadric Conic Section Curves
  const allPlanes = primitives.flatMap((p) => extractSlantedPlanesFromPrimitive(p));
  for (const plane of allPlanes) {
    for (const prim of primitives) {
      const conicSegs = computePlaneQuadricSectionSegments(plane, prim, primitives);
      lines3D.push(...conicSegs);
    }
  }

  // Pairwise Curved Quadric SSI Curves
  for (let i = 0; i < primitives.length; i++) {
    for (let j = i + 1; j < primitives.length; j++) {
      const ssiSegs = tracePairwiseCurvedSSI(primitives[i], primitives[j], primitives);
      lines3D.push(...ssiSegs);
    }
  }

  return { lines3D, circles3D };
}
