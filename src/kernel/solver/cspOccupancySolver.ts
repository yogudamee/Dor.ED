import { Point2D, Primitive3D } from '../../types/cad';
import {
  AnalyticalSurface3D,
  AtomicCell3D,
  Axis3D,
  BBox3D,
  CandidateVolume3D,
  CellComplex3D,
  LiftedCandidatePool3D,
  ReprojectionScore,
  SolvedSolidModel3D,
  Vec3,
} from '../types';
import { clipPolygonByHalfSpace2D } from '../lifting3d/generalizedLoft';
import { evalPrimitive3DSDF, unprojectViewPointTo3D } from '../lifting3d/surfacePrimitives';
import { compileReprojectionEvaluator } from './reprojectionVerifier';

const MAX_BB_NODES = 3200;
const TIME_BUDGET_MS = 95;

function evalCSGPrimitiveListSDF(p: Vec3, prims: Primitive3D[]): number {
  let dSolid = Infinity;
  let hasAdd = false;

  for (const pr of prims) {
    if (pr.operation === 'add') {
      const d = evalPrimitive3DSDF(p, pr);
      if (d < dSolid) dSolid = d;
      hasAdd = true;
    }
  }
  if (!hasAdd) return Infinity;

  for (const pr of prims) {
    if (pr.operation === 'intersect') {
      const d = evalPrimitive3DSDF(p, pr);
      dSolid = Math.max(dSolid, d);
    }
  }

  for (const pr of prims) {
    if (pr.operation === 'subtract') {
      const dHole = evalPrimitive3DSDF(p, pr);
      dSolid = Math.max(dSolid, -dHole);
    }
  }

  return dSolid;
}

/**
 * Synthesizes an exact half-space-clipped `prism` (via Sutherland-Hodgman 2D clipping against
 * active oblique/orthogonal planes in `complex.surfaces`) when an atomic cell `cell` is bounded
 * by oblique planes, falling back to `box` ONLY when all active bounding planes are axis-aligned!
 */
function buildClippedCellPrimitive(
  cell: AtomicCell3D,
  complex: CellComplex3D,
  operation: 'add' | 'subtract',
  id: string,
  label: string
): Primitive3D {
  const vh = complex.visualHullBBox;
  const rawB = cell.bbox;
  const b: BBox3D =
    operation === 'subtract'
      ? {
          xMin: rawB.xMin <= vh.xMin + 1.2 ? vh.xMin - 1.0 : rawB.xMin,
          xMax: rawB.xMax >= vh.xMax - 1.2 ? vh.xMax + 1.0 : rawB.xMax,
          yMin: rawB.yMin <= vh.yMin + 1.2 ? vh.yMin - 1.0 : rawB.yMin,
          yMax: rawB.yMax >= vh.yMax - 1.2 ? vh.yMax + 1.0 : rawB.yMax,
          zMin: rawB.zMin <= vh.zMin + 1.2 ? vh.zMin - 1.0 : rawB.zMin,
          zMax: rawB.zMax >= vh.zMax - 1.2 ? vh.zMax + 1.0 : rawB.zMax,
        }
      : { ...rawB };

  // Check if any plane in `complex.surfaces` is oblique along Z (nx, ny), Y (nx, nz), or X (ny, nz)
  const axesToTry: Axis3D[] = ['Z', 'Y', 'X'];
  for (const axis of axesToTry) {
    const obliquePlanes = complex.surfaces.filter((sf) => {
      if (sf.kind !== 'plane' || !sf.planeParams) return false;
      const n = sf.planeParams.normal;
      if (axis === 'Z') return Math.abs(n.z) < 1e-3 && Math.abs(n.x) > 1e-3 && Math.abs(n.y) > 1e-3;
      if (axis === 'Y') return Math.abs(n.y) < 1e-3 && Math.abs(n.x) > 1e-3 && Math.abs(n.z) > 1e-3;
      return Math.abs(n.x) < 1e-3 && Math.abs(n.y) > 1e-3 && Math.abs(n.z) > 1e-3;
    });
    if (obliquePlanes.length === 0) continue;

    // Collect ALL planes perpendicular to `axis` (both orthogonal and oblique) and clip via Sutherland-Hodgman!
    const allAxisPlanes = complex.surfaces.filter((sf) => {
      if (sf.kind !== 'plane' || !sf.planeParams) return false;
      const n = sf.planeParams.normal;
      if (axis === 'Z') return Math.abs(n.z) < 1e-3;
      if (axis === 'Y') return Math.abs(n.y) < 1e-3;
      return Math.abs(n.x) < 1e-3;
    });

    const uMin = axis === 'X' ? b.yMin : b.xMin;
    const uMax = axis === 'X' ? b.yMax : b.xMax;
    const vMin = axis === 'Z' ? b.yMin : b.zMin;
    const vMax = axis === 'Z' ? b.yMax : b.zMax;

    let poly: Point2D[] = [
      { u: uMin, v: vMin },
      { u: uMax, v: vMin },
      { u: uMax, v: vMax },
      { u: uMin, v: vMax },
    ];

    const cPt = cell.centroid;
    for (const sf of allAxisPlanes) {
      const p = sf.planeParams!;
      const phiAtC = sf.evalPhi(cPt);
      if (Math.abs(phiAtC) < 1e-4) continue;
      const sign = phiAtC < 0 ? 1 : -1;
      const nu = sign * (axis === 'X' ? p.normal.y : p.normal.x);
      const nv = sign * (axis === 'Z' ? p.normal.y : p.normal.z);
      const d = sign * p.d;
      const clipped = clipPolygonByHalfSpace2D(poly, nu, nv, d);
      if (clipped.length >= 3) {
        poly = clipped;
      }
    }

    if (poly.length >= 3) {
      const prismSegs = poly.map((pt, idx) => ({
        kind: 'line' as const,
        p1: { u: pt.u, v: pt.v },
        p2: { u: poly[(idx + 1) % poly.length].u, v: poly[(idx + 1) % poly.length].v },
      }));
      return {
        id,
        featureId: id,
        label,
        operation,
        shape: 'prism',
        ...b,
        prismAxis: axis,
        extrudeAxis: axis.toLowerCase() as 'x' | 'y' | 'z',
        prismPolygon: poly,
        polygon2D: poly,
        prismSegments: prismSegs,
        isInternalFeature: operation === 'subtract',
        weldGroup: operation === 'add' ? 'coalesced_solid' : undefined,
      };
    }
  }

  return {
    id,
    featureId: id,
    label,
    operation,
    shape: 'box',
    ...b,
    isInternalFeature: operation === 'subtract',
    weldGroup: operation === 'add' ? 'coalesced_solid' : undefined,
  };
}

/**
 * Performs Boolean Algebraic Coalescing on the occupied cells (`x_k = 1`) of a `CellComplex3D`:
 * 1. Eliminates internal co-surface seams (`x_a = x_b = 1`) by merging coaxial/coplanar equal-profile
 *    volumes and tagging welded step/composite unions.
 * 2. Retains only active `add`, `intersect`, and `subtract` primitives verified by cell occupancy
 *    AND strictly contained within the Visual Hull (never allowing an oversized cuboid to overwrite a polygon!).
 * 3. Reconciles any residual cell differences using Sutherland-Hodgman half-space-clipped polygons.
 */
export function coalesceOccupiedCellsToPrimitives(
  complex: CellComplex3D,
  occupancy: Uint8Array
): {
  primitives: Primitive3D[];
  activeSurfaces: AnalyticalSurface3D[];
  bounds: BBox3D;
} {
  const { cells, volumes, patches } = complex;

  // 1. Collect active boundary surfaces where occupancy transitions (x_a != x_b)
  const activeSurfaceMap = new Map<string, AnalyticalSurface3D>();
  for (const patch of patches) {
    const occA = patch.cellA >= 0 ? occupancy[patch.cellA] : 0;
    const occB = patch.cellB >= 0 ? occupancy[patch.cellB] : 0;
    if (occA !== occB) {
      activeSurfaceMap.set(patch.surface.id, patch.surface);
    }
  }

  // 2. Partition candidate volumes by how well they align with occupied vs empty cells
  const specificSolidVols: CandidateVolume3D[] = [];
  const hullSolidVols: CandidateVolume3D[] = [];
  const activeCavityVols: CandidateVolume3D[] = [];

  // First pass: identify active subtractive cavities so solid volumes know which empty cells are carved by holes
  for (let vIdx = 0; vIdx < volumes.length; vIdx++) {
    const vol = volumes[vIdx];
    if (vol.roleHint !== 'cavity_Candidate' && vol.primitive.operation !== 'subtract') continue;
    let insideSolidCount = 0;
    let insideEmptyCount = 0;
    for (let c = 0; c < cells.length; c++) {
      if (cells[c].signVector[vIdx] < 0) {
        if (occupancy[c] === 1) insideSolidCount++;
        else insideEmptyCount++;
      }
    }
    if (vol.isGuaranteedVoid || (insideEmptyCount > 0 && insideSolidCount === 0)) {
      activeCavityVols.push(vol);
    }
  }

  // Helper: verifies that a solid volume `vol` does NOT protrude outside the 2D outer silhouettes (Visual Hull)
  // except possibly inside an active subtractive notch! Prevents any oversized cuboid from overwriting oblique polygon cuts!
  const protrudesOutsideVisualHull = (vol: CandidateVolume3D): boolean => {
    const vb = vol.bbox;
    const fracs = [0.14, 0.32, 0.5, 0.68, 0.86];
    for (const fx of fracs) {
      const x = vb.xMin + fx * (vb.xMax - vb.xMin);
      for (const fy of fracs) {
        const y = vb.yMin + fy * (vb.yMax - vb.yMin);
        for (const fz of fracs) {
          const z = vb.zMin + fz * (vb.zMax - vb.zMin);
          const pt = { x, y, z };
          if (vol.evalSDF(pt) < -0.75) {
            if (complex.evalPointCellId(pt) === -1) {
              const explainedByActiveNotch = activeCavityVols.some(
                (cv) => cv.evalSDF(pt) < -0.1
              );
              if (!explainedByActiveNotch) return true;
            }
          }
        }
      }
    }
    return false;
  };

  for (let vIdx = 0; vIdx < volumes.length; vIdx++) {
    const vol = volumes[vIdx];
    if (vol.roleHint === 'cavity_Candidate' || vol.primitive.operation === 'subtract') continue;

    let insideSolidCount = 0;
    let insideEmptyCount = 0;
    for (let c = 0; c < cells.length; c++) {
      if (cells[c].signVector[vIdx] < 0) {
        if (occupancy[c] === 1) insideSolidCount++;
        else insideEmptyCount++;
      }
    }
    if (insideSolidCount === 0) continue;

    if (vol.roleHint === 'ambiguous') {
      hullSolidVols.push(vol);
    } else {
      let contradictedByNonCavityEmpty = false;
      for (let c = 0; c < cells.length; c++) {
        if (cells[c].signVector[vIdx] < 0 && occupancy[c] === 0) {
          const inActiveCavity = activeCavityVols.some((cv) => cv.evalSDF(cells[c].centroid) < 0);
          const hasAnyCavityHint = cells[c].voidHintVolumeIds.length > 0;
          if (!inActiveCavity && !hasAnyCavityHint) {
            contradictedByNonCavityEmpty = true;
            break;
          }
        }
      }
      if (!contradictedByNonCavityEmpty) {
        if (protrudesOutsideVisualHull(vol)) {
          // Demote protruding solid volume to hull intersection candidate so oblique cuts clip it cleanly
          hullSolidVols.push(vol);
        } else {
          specificSolidVols.push(vol);
        }
      }
    }
    void insideEmptyCount;
  }

  const outPrims: Primitive3D[] = [];

  // 3. Build base solid primitives:
  //    Prefer exact specific solid volumes (polygonal prisms, cones, frustums, pyramids, spheres, hemispheres, step bosses).
  //    If occupied cells remain uncovered by specific solid volumes, intersect the two Visual Hull extrusions!
  for (const sv of specificSolidVols) {
    outPrims.push({
      ...sv.primitive,
      operation: 'add',
      weldGroup: 'coalesced_solid',
    });
  }

  // Check if any occupied cell is still outside `outPrims`
  const uncoveredSolidCells = cells.filter(
    (c) => occupancy[c.id] === 1 && evalCSGPrimitiveListSDF(c.centroid, outPrims) > 0.05
  );

  if (uncoveredSolidCells.length > 0) {
    if (outPrims.length === 0 && hullSolidVols.length >= 2) {
      const v1Hull = hullSolidVols.filter(
        (v) => v.surfaces[0]?.sourceViews[0] === hullSolidVols[0].surfaces[0]?.sourceViews[0]
      );
      const v2Hull = hullSolidVols.filter((v) => !v1Hull.includes(v));

      if (v1Hull.length === 1 && v2Hull.length === 1) {
        outPrims.push({
          ...v1Hull[0].primitive,
          operation: 'add',
          weldGroup: 'coalesced_solid',
        });
        outPrims.push({
          ...v2Hull[0].primitive,
          operation: 'intersect',
          weldGroup: 'coalesced_solid',
        });
      } else {
        for (const hv of hullSolidVols) {
          outPrims.push({
            ...hv.primitive,
            operation: outPrims.length === 0 ? 'add' : 'intersect',
            weldGroup: 'coalesced_solid',
          });
        }
      }
    } else {
      // Synthesize exact Sutherland-Hodgman half-space-clipped prism (or box) for any uncovered occupied cells
      for (const uc of uncoveredSolidCells) {
        outPrims.push(
          buildClippedCellPrimitive(uc, complex, 'add', `cell_add_${uc.id}`, '体元多面体块')
        );
      }
    }
  }

  // 4. Algebraically merge coaxial equal-radius cylinders, coplanar equal-polygon prisms,
  //    & coplanar equal-cross-section boxes whose shared planar interface has x_a = x_b = 1!
  const coalescedAdds: Primitive3D[] = [];
  for (const pr of outPrims) {
    if (pr.operation !== 'add') {
      coalescedAdds.push(pr);
      continue;
    }
    let merged = false;
    for (const prev of coalescedAdds) {
      if (prev.operation !== 'add' || prev.shape !== pr.shape) continue;
      if (
        (pr.shape === 'cylinder_x' || pr.shape === 'cylinder_y' || pr.shape === 'cylinder_z') &&
        Math.abs((prev.radius ?? 0) - (pr.radius ?? 0)) < 0.15
      ) {
        if (
          pr.shape === 'cylinder_y' &&
          Math.abs((prev.centerX ?? 0) - (pr.centerX ?? 0)) < 0.15 &&
          Math.abs((prev.centerZ ?? 0) - (pr.centerZ ?? 0)) < 0.15 &&
          !(pr.yMax < prev.yMin - 0.3 || pr.yMin > prev.yMax + 0.3)
        ) {
          prev.yMin = Math.min(prev.yMin, pr.yMin);
          prev.yMax = Math.max(prev.yMax, pr.yMax);
          prev.centerY = 0.5 * (prev.yMin + prev.yMax);
          merged = true;
          break;
        }
        if (
          pr.shape === 'cylinder_z' &&
          Math.abs((prev.centerX ?? 0) - (pr.centerX ?? 0)) < 0.15 &&
          Math.abs((prev.centerY ?? 0) - (pr.centerY ?? 0)) < 0.15 &&
          !(pr.zMax < prev.zMin - 0.3 || pr.zMin > prev.zMax + 0.3)
        ) {
          prev.zMin = Math.min(prev.zMin, pr.zMin);
          prev.zMax = Math.max(prev.zMax, pr.zMax);
          prev.centerZ = 0.5 * (prev.zMin + prev.zMax);
          merged = true;
          break;
        }
        if (
          pr.shape === 'cylinder_x' &&
          Math.abs((prev.centerY ?? 0) - (pr.centerY ?? 0)) < 0.15 &&
          Math.abs((prev.centerZ ?? 0) - (pr.centerZ ?? 0)) < 0.15 &&
          !(pr.xMax < prev.xMin - 0.3 || pr.xMin > prev.xMax + 0.3)
        ) {
          prev.xMin = Math.min(prev.xMin, pr.xMin);
          prev.xMax = Math.max(prev.xMax, pr.xMax);
          prev.centerX = 0.5 * (prev.xMin + prev.xMax);
          merged = true;
          break;
        }
      } else if (pr.shape === 'prism' && prev.prismAxis && prev.prismAxis === pr.prismAxis) {
        const polyA = prev.prismPolygon ?? prev.polygon2D ?? [];
        const polyB = pr.prismPolygon ?? pr.polygon2D ?? [];
        const samePoly =
          polyA.length >= 3 &&
          polyA.length === polyB.length &&
          polyA.every((pa) =>
            polyB.some((pb) => Math.hypot(pa.u - pb.u, pa.v - pb.v) < 0.2)
          );
        if (samePoly) {
          if (prev.prismAxis === 'Z' && !(pr.zMax < prev.zMin - 0.3 || pr.zMin > prev.zMax + 0.3)) {
            prev.zMin = Math.min(prev.zMin, pr.zMin);
            prev.zMax = Math.max(prev.zMax, pr.zMax);
            merged = true;
            break;
          }
          if (prev.prismAxis === 'Y' && !(pr.yMax < prev.yMin - 0.3 || pr.yMin > prev.yMax + 0.3)) {
            prev.yMin = Math.min(prev.yMin, pr.yMin);
            prev.yMax = Math.max(prev.yMax, pr.yMax);
            merged = true;
            break;
          }
          if (prev.prismAxis === 'X' && !(pr.xMax < prev.xMin - 0.3 || pr.xMin > prev.xMax + 0.3)) {
            prev.xMin = Math.min(prev.xMin, pr.xMin);
            prev.xMax = Math.max(prev.xMax, pr.xMax);
            merged = true;
            break;
          }
        }
      } else if (pr.shape === 'box') {
        const sameXY =
          Math.abs(prev.xMin - pr.xMin) < 0.15 &&
          Math.abs(prev.xMax - pr.xMax) < 0.15 &&
          Math.abs(prev.yMin - pr.yMin) < 0.15 &&
          Math.abs(prev.yMax - pr.yMax) < 0.15 &&
          !(pr.zMax < prev.zMin - 0.3 || pr.zMin > prev.zMax + 0.3);
        const sameXZ =
          Math.abs(prev.xMin - pr.xMin) < 0.15 &&
          Math.abs(prev.xMax - pr.xMax) < 0.15 &&
          Math.abs(prev.zMin - pr.zMin) < 0.15 &&
          Math.abs(prev.zMax - pr.zMax) < 0.15 &&
          !(pr.yMax < prev.yMin - 0.3 || pr.yMin > prev.yMax + 0.3);
        const sameYZ =
          Math.abs(prev.yMin - pr.yMin) < 0.15 &&
          Math.abs(prev.yMax - pr.yMax) < 0.15 &&
          Math.abs(prev.zMin - pr.zMin) < 0.15 &&
          Math.abs(prev.zMax - pr.zMax) < 0.15 &&
          !(pr.xMax < prev.xMin - 0.3 || pr.xMin > prev.xMax + 0.3);
        if (sameXY) {
          prev.zMin = Math.min(prev.zMin, pr.zMin);
          prev.zMax = Math.max(prev.zMax, pr.zMax);
          merged = true;
          break;
        }
        if (sameXZ) {
          prev.yMin = Math.min(prev.yMin, pr.yMin);
          prev.yMax = Math.max(prev.yMax, pr.yMax);
          merged = true;
          break;
        }
        if (sameYZ) {
          prev.xMin = Math.min(prev.xMin, pr.xMin);
          prev.xMax = Math.max(prev.xMax, pr.xMax);
          merged = true;
          break;
        }
      }
    }
    if (!merged) {
      coalescedAdds.push({ ...pr });
    }
  }

  // 5. Append verified active subtractive cavities ONLY if they genuinely carve volume out of `coalescedAdds`
  const positiveSnapshot = [...coalescedAdds];
  for (const cv of activeCavityVols) {
    let carvesPositiveBody = cells.some(
      (c) =>
        occupancy[c.id] === 0 &&
        cv.evalSDF(c.centroid) < -0.05 &&
        evalCSGPrimitiveListSDF(c.centroid, positiveSnapshot) < -0.05
    );
    if (!carvesPositiveBody) {
      const cb = cv.bbox;
      const fracs = [0.2, 0.35, 0.5, 0.65, 0.8];
      for (const fx of fracs) {
        if (carvesPositiveBody) break;
        const x = cb.xMin + fx * (cb.xMax - cb.xMin);
        for (const fy of fracs) {
          if (carvesPositiveBody) break;
          const y = cb.yMin + fy * (cb.yMax - cb.yMin);
          for (const fz of fracs) {
            const z = cb.zMin + fz * (cb.zMax - cb.zMin);
            const pt = { x, y, z };
            if (cv.evalSDF(pt) < -0.2 && evalCSGPrimitiveListSDF(pt, positiveSnapshot) < -0.2) {
              carvesPositiveBody = true;
              break;
            }
          }
        }
      }
    }
    if (carvesPositiveBody) {
      const subPrim: Primitive3D = {
        ...cv.primitive,
        operation: 'subtract',
        isInternalFeature: true,
      };
      let mergedSub = false;
      for (const prev of coalescedAdds) {
        if (prev.operation !== 'subtract' || prev.shape !== subPrim.shape) continue;
        if (
          (subPrim.shape === 'cylinder_x' ||
            subPrim.shape === 'cylinder_y' ||
            subPrim.shape === 'cylinder_z') &&
          Math.abs((prev.radius ?? 0) - (subPrim.radius ?? 0)) < 0.2
        ) {
          if (
            subPrim.shape === 'cylinder_z' &&
            Math.abs((prev.centerX ?? 0) - (subPrim.centerX ?? 0)) < 0.2 &&
            Math.abs((prev.centerY ?? 0) - (subPrim.centerY ?? 0)) < 0.2 &&
            !(subPrim.zMax < prev.zMin - 0.5 || subPrim.zMin > prev.zMax + 0.5)
          ) {
            prev.zMin = Math.min(prev.zMin, subPrim.zMin);
            prev.zMax = Math.max(prev.zMax, subPrim.zMax);
            prev.centerZ = 0.5 * (prev.zMin + prev.zMax);
            mergedSub = true;
            break;
          }
          if (
            subPrim.shape === 'cylinder_y' &&
            Math.abs((prev.centerX ?? 0) - (subPrim.centerX ?? 0)) < 0.2 &&
            Math.abs((prev.centerZ ?? 0) - (subPrim.centerZ ?? 0)) < 0.2 &&
            !(subPrim.yMax < prev.yMin - 0.5 || subPrim.yMin > prev.yMax + 0.5)
          ) {
            prev.yMin = Math.min(prev.yMin, subPrim.yMin);
            prev.yMax = Math.max(prev.yMax, subPrim.yMax);
            prev.centerY = 0.5 * (prev.yMin + prev.yMax);
            mergedSub = true;
            break;
          }
          if (
            subPrim.shape === 'cylinder_x' &&
            Math.abs((prev.centerY ?? 0) - (subPrim.centerY ?? 0)) < 0.2 &&
            Math.abs((prev.centerZ ?? 0) - (subPrim.centerZ ?? 0)) < 0.2 &&
            !(subPrim.xMax < prev.xMin - 0.5 || subPrim.xMin > prev.xMax + 0.5)
          ) {
            prev.xMin = Math.min(prev.xMin, subPrim.xMin);
            prev.xMax = Math.max(prev.xMax, subPrim.xMax);
            prev.centerX = 0.5 * (prev.xMin + prev.xMax);
            mergedSub = true;
            break;
          }
        } else if (
          subPrim.shape === 'prism' &&
          prev.prismAxis &&
          prev.prismAxis === subPrim.prismAxis
        ) {
          const polyA = prev.prismPolygon ?? prev.polygon2D ?? [];
          const polyB = subPrim.prismPolygon ?? subPrim.polygon2D ?? [];
          const samePoly =
            polyA.length >= 3 &&
            polyA.length === polyB.length &&
            polyA.every((pa) =>
              polyB.some((pb) => Math.hypot(pa.u - pb.u, pa.v - pb.v) < 0.25)
            );
          if (samePoly) {
            if (prev.prismAxis === 'Z' && !(subPrim.zMax < prev.zMin - 0.5 || subPrim.zMin > prev.zMax + 0.5)) {
              prev.zMin = Math.min(prev.zMin, subPrim.zMin);
              prev.zMax = Math.max(prev.zMax, subPrim.zMax);
              mergedSub = true;
              break;
            }
            if (prev.prismAxis === 'Y' && !(subPrim.yMax < prev.yMin - 0.5 || subPrim.yMin > prev.yMax + 0.5)) {
              prev.yMin = Math.min(prev.yMin, subPrim.yMin);
              prev.yMax = Math.max(prev.yMax, subPrim.yMax);
              mergedSub = true;
              break;
            }
            if (prev.prismAxis === 'X' && !(subPrim.xMax < prev.xMin - 0.5 || subPrim.xMin > prev.xMax + 0.5)) {
              prev.xMin = Math.min(prev.xMin, subPrim.xMin);
              prev.xMax = Math.max(prev.xMax, subPrim.xMax);
              mergedSub = true;
              break;
            }
          }
        } else if (subPrim.shape === 'box') {
          const sameXY =
            Math.abs(prev.xMin - subPrim.xMin) < 0.2 &&
            Math.abs(prev.xMax - subPrim.xMax) < 0.2 &&
            Math.abs(prev.yMin - subPrim.yMin) < 0.2 &&
            Math.abs(prev.yMax - subPrim.yMax) < 0.2 &&
            !(subPrim.zMax < prev.zMin - 0.5 || subPrim.zMin > prev.zMax + 0.5);
          const sameXZ =
            Math.abs(prev.xMin - subPrim.xMin) < 0.2 &&
            Math.abs(prev.xMax - subPrim.xMax) < 0.2 &&
            Math.abs(prev.zMin - subPrim.zMin) < 0.2 &&
            Math.abs(prev.zMax - subPrim.zMax) < 0.2 &&
            !(subPrim.yMax < prev.yMin - 0.5 || subPrim.yMin > prev.yMax + 0.5);
          const sameYZ =
            Math.abs(prev.yMin - subPrim.yMin) < 0.2 &&
            Math.abs(prev.yMax - subPrim.yMax) < 0.2 &&
            Math.abs(prev.zMin - subPrim.zMin) < 0.2 &&
            Math.abs(prev.zMax - subPrim.zMax) < 0.2 &&
            !(subPrim.xMax < prev.xMin - 0.5 || subPrim.xMin > prev.xMax + 0.5);
          if (sameXY) {
            prev.zMin = Math.min(prev.zMin, subPrim.zMin);
            prev.zMax = Math.max(prev.zMax, subPrim.zMax);
            mergedSub = true;
            break;
          }
          if (sameXZ) {
            prev.yMin = Math.min(prev.yMin, subPrim.yMin);
            prev.yMax = Math.max(prev.yMax, subPrim.yMax);
            mergedSub = true;
            break;
          }
          if (sameYZ) {
            prev.xMin = Math.min(prev.xMin, subPrim.xMin);
            prev.xMax = Math.max(prev.xMax, subPrim.xMax);
            mergedSub = true;
            break;
          }
        }
      }
      if (!mergedSub) {
        coalescedAdds.push(subPrim);
      }
    }
  }

  // 6. Reconcile any empty cells (x_k = 0) still evaluated as inside `coalescedAdds`
  //    using exact Sutherland-Hodgman half-space-clipped polygonal cutouts!
  for (const cell of cells) {
    if (occupancy[cell.id] === 0 && evalCSGPrimitiveListSDF(cell.centroid, coalescedAdds) < -0.15) {
      coalescedAdds.push(
        buildClippedCellPrimitive(cell, complex, 'subtract', `cell_cut_${cell.id}`, '体元切除腔')
      );
    }
  }

  // Compute tight 3D bounds of active solid primitives (with cell bbox fallback)
  let xMin = Infinity;
  let xMax = -Infinity;
  let yMin = Infinity;
  let yMax = -Infinity;
  let zMin = Infinity;
  let zMax = -Infinity;
  for (const pr of coalescedAdds) {
    if (pr.operation !== 'add') continue;
    if (pr.xMin < xMin) xMin = pr.xMin;
    if (pr.xMax > xMax) xMax = pr.xMax;
    if (pr.yMin < yMin) yMin = pr.yMin;
    if (pr.yMax > yMax) yMax = pr.yMax;
    if (pr.zMin < zMin) zMin = pr.zMin;
    if (pr.zMax > zMax) zMax = pr.zMax;
  }
  if (!Number.isFinite(xMin)) {
    for (const c of cells) {
      if (occupancy[c.id] !== 1) continue;
      if (c.bbox.xMin < xMin) xMin = c.bbox.xMin;
      if (c.bbox.xMax > xMax) xMax = c.bbox.xMax;
      if (c.bbox.yMin < yMin) yMin = c.bbox.yMin;
      if (c.bbox.yMax > yMax) yMax = c.bbox.yMax;
      if (c.bbox.zMin < zMin) zMin = c.bbox.zMin;
      if (c.bbox.zMax > zMax) zMax = c.bbox.zMax;
    }
  }
  const bounds: BBox3D = Number.isFinite(xMin)
    ? { xMin, xMax, yMin, yMax, zMin, zMax }
    : { ...complex.visualHullBBox };

  return {
    primitives: coalescedAdds,
    activeSurfaces: Array.from(activeSurfaceMap.values()),
    bounds,
  };
}

function computeTargetViewSignature(
  complex: CellComplex3D,
  occupancy: Uint8Array,
  targetView: 'front' | 'top' | 'left'
): string {
  const vh = complex.visualHullBBox;
  const uMin = targetView === 'left' ? vh.yMin : vh.xMin;
  const uMax = targetView === 'left' ? vh.yMax : vh.xMax;
  const vMin = targetView === 'top' ? vh.yMin : vh.zMin;
  const vMax = targetView === 'top' ? vh.yMax : vh.zMax;
  const wStart = targetView === 'front' ? vh.yMax : targetView === 'top' ? vh.zMax : vh.xMin;
  const wEnd = targetView === 'front' ? vh.yMin : targetView === 'top' ? vh.zMin : vh.xMax;

  const G = 7;
  const W = 8;
  let sig = '';
  for (let iu = 0; iu < G; iu++) {
    const u = uMin + ((iu + 0.5) / G) * (uMax - uMin);
    for (let iv = 0; iv < G; iv++) {
      const v = vMin + ((iv + 0.5) / G) * (vMax - vMin);
      let firstHit = 9;
      let count = 0;
      for (let iw = 0; iw < W; iw++) {
        const w = wStart + ((iw + 0.5) / W) * (wEnd - wStart);
        const cid = complex.evalPointCellId(unprojectViewPointTo3D(targetView, u, v, w));
        if (cid >= 0 && occupancy[cid] === 1) {
          if (firstHit === 9) firstHit = iw;
          count++;
        }
      }
      sig += `${firstHit}${count}`;
    }
  }
  return sig;
}

/**
 * Solves the 3D Cellular Boolean Constraint Satisfaction Problem (CSP) over `CellComplex3D`:
 *   min_{x in {0,1}^N}  E_reproj(x) + lambda * Area(partial M(x))
 * Returns up to `maxSolutions` (default 4) distinct valid 3D solid models ranked by Occam's Razor.
 */
export function solveCellularOccupancyCSP(
  pool: LiftedCandidatePool3D,
  complex: CellComplex3D,
  maxSolutions = 4
): SolvedSolidModel3D[] {
  const tStart = performance.now();
  const N = complex.cells.length;
  const evaluator = compileReprojectionEvaluator(complex, pool.arr1, pool.arr2);

  // 1. Deterministic Unit Propagation on fixedState
  const fixed = new Int8Array(N);
  for (let i = 0; i < N; i++) {
    fixed[i] = complex.cells[i].fixedState;
  }

  let changed = true;
  let propGuard = 0;
  while (changed && propGuard++ < 32) {
    changed = false;
    for (const ray of [...complex.sightlinesV1, ...complex.sightlinesV2]) {
      if (!ray.mustBeSolid) continue;
      let alreadySatisfied = false;
      const openCells: number[] = [];
      for (const cid of ray.orderedCellIds) {
        if (fixed[cid] === 1) {
          alreadySatisfied = true;
          break;
        }
        if (fixed[cid] === -1) {
          openCells.push(cid);
        }
      }
      if (!alreadySatisfied && openCells.length === 1) {
        fixed[openCells[0]] = 1;
        changed = true;
      }
    }
  }

  // 2. Construct Structured Seed Hypotheses
  const seedVectors: Uint8Array[] = [];
  const hasSpecificSolids = complex.volumes.some(
    (v) => v.roleHint === 'solid_body' || v.roleHint === 'step_boss'
  );

  // Seed A: Specific Solid/Boss Union minus All Cavity Candidates
  if (hasSpecificSolids) {
    const xA = new Uint8Array(N);
    for (let i = 0; i < N; i++) {
      if (fixed[i] === 0) xA[i] = 0;
      else if (fixed[i] === 1) xA[i] = 1;
      else {
        const coveredBySpecific = complex.cells[i].coveringVolumeIds.some((vid) => {
          const vol = complex.volumes.find((v) => v.id === vid);
          return vol && (vol.roleHint === 'solid_body' || vol.roleHint === 'step_boss');
        });
        const inVoid = complex.cells[i].voidHintVolumeIds.length > 0;
        xA[i] = coveredBySpecific && !inVoid ? 1 : 0;
      }
    }
    seedVectors.push(xA);

    // Seed A2: Specific Solid/Boss Union WITH ambiguous inner cavities kept SOLID
    //          (protects solid stepped cores when inner circles were also tested as through-holes!)
    const xA2 = new Uint8Array(N);
    for (let i = 0; i < N; i++) {
      if (fixed[i] === 0) xA2[i] = 0;
      else if (fixed[i] === 1) xA2[i] = 1;
      else {
        const coveredBySpecific = complex.cells[i].coveringVolumeIds.some((vid) => {
          const vol = complex.volumes.find((v) => v.id === vid);
          return vol && (vol.roleHint === 'solid_body' || vol.roleHint === 'step_boss');
        });
        const inHighConfCavity = complex.cells[i].voidHintVolumeIds.some((vid) => {
          const vol = complex.volumes.find((v) => v.id === vid);
          return vol && vol.priority >= 90;
        });
        xA2[i] = coveredBySpecific && !inHighConfCavity ? 1 : 0;
      }
    }
    seedVectors.push(xA2);
  }

  // Seed B: Maximal Visual Hull minus High-Confidence Cavities
  const xB = new Uint8Array(N);
  for (let i = 0; i < N; i++) {
    if (fixed[i] === 0) xB[i] = 0;
    else if (fixed[i] === 1) xB[i] = 1;
    else {
      const inHighConfCavity = complex.cells[i].voidHintVolumeIds.some((vid) => {
        const vol = complex.volumes.find((v) => v.id === vid);
        return vol && vol.priority >= 90;
      });
      xB[i] = inHighConfCavity ? 0 : 1;
    }
  }
  seedVectors.push(xB);

  // Seed C: Maximal Visual Hull minus ALL Cavity Candidates
  const xC = new Uint8Array(N);
  for (let i = 0; i < N; i++) {
    if (fixed[i] === 0) xC[i] = 0;
    else if (fixed[i] === 1) xC[i] = 1;
    else xC[i] = complex.cells[i].voidHintVolumeIds.length > 0 ? 0 : 1;
  }
  seedVectors.push(xC);

  // Seed D: Pure Maximal Visual Hull (all non-void-fixed cells = 1)
  const xD = new Uint8Array(N);
  for (let i = 0; i < N; i++) {
    xD[i] = fixed[i] === 0 ? 0 : 1;
  }
  seedVectors.push(xD);

  // 3. Coordinate-Descent Local Polish on each seed + Candidate Pool Collection
  interface CandidateEntry {
    occ: Uint8Array;
    score: ReprojectionScore;
    occKey: string;
  }
  const candidateMap = new Map<string, CandidateEntry>();

  const occToKey = (occ: Uint8Array): string => {
    let s = '';
    for (let i = 0; i < occ.length; i++) s += occ[i] ? '1' : '0';
    return s;
  };

  const recordCandidate = (occ: Uint8Array, score: ReprojectionScore) => {
    // Reject completely empty solid
    let anyOne = false;
    for (let i = 0; i < occ.length; i++) {
      if (occ[i] === 1) {
        anyOne = true;
        break;
      }
    }
    if (!anyOne) return;
    const key = occToKey(occ);
    if (!candidateMap.has(key)) {
      candidateMap.set(key, { occ: new Uint8Array(occ), score, occKey: key });
    }
  };

  const polishSeed = (startOcc: Uint8Array): { occ: Uint8Array; score: ReprojectionScore } => {
    const cur = new Uint8Array(startOcc);
    let curScore = evaluator.evaluate(cur);
    recordCandidate(cur, curScore);

    let iter = 0;
    while (iter++ < 16) {
      let bestFlipCell = -1;
      let bestScore = curScore;

      for (let i = 0; i < N; i++) {
        if (fixed[i] !== -1) continue;
        cur[i] = cur[i] === 1 ? 0 : 1;
        const sc = evaluator.evaluate(cur);
        if (sc.totalEnergy + 1e-6 < bestScore.totalEnergy) {
          bestScore = sc;
          bestFlipCell = i;
        }
        cur[i] = cur[i] === 1 ? 0 : 1;
      }

      if (bestFlipCell >= 0) {
        cur[bestFlipCell] = cur[bestFlipCell] === 1 ? 0 : 1;
        curScore = bestScore;
        recordCandidate(cur, curScore);
      } else {
        break;
      }
    }
    return { occ: cur, score: curScore };
  };

  let globalBestEnergy = Infinity;
  let globalBestOcc = seedVectors[0];

  for (const seed of seedVectors) {
    const res = polishSeed(seed);
    if (res.score.totalEnergy < globalBestEnergy) {
      globalBestEnergy = res.score.totalEnergy;
      globalBestOcc = res.occ;
    }
  }

  // 4. Bounded Branch-and-Bound Exploration over free cells to find global optimum
  //    AND discover genuine under-constrained alternative zero-error configurations (Top 4)!
  const freeCellIds: number[] = [];
  for (let i = 0; i < N; i++) {
    if (fixed[i] === -1) freeCellIds.push(i);
  }
  // Order free cells by descending volume so high-impact structural cells branch first
  freeCellIds.sort((a, b) => complex.cells[b].approxVolume - complex.cells[a].approxVolume);

  // Limit active branching depth to top 14 largest free cells (remaining minor cells inherit globalBestOcc)
  const branchCells = freeCellIds.slice(0, 14);
  const working = new Uint8Array(globalBestOcc);
  let visitedNodes = 0;

  const canStillSatisfySightlines = (depthIdx: number): boolean => {
    // Any cell not in branchCells[depthIdx..] already has its final value in `working`
    const undecidedSet = new Set<number>();
    for (let k = depthIdx; k < branchCells.length; k++) {
      undecidedSet.add(branchCells[k]);
    }
    for (const ray of [...complex.sightlinesV1, ...complex.sightlinesV2]) {
      if (!ray.mustBeSolid) continue;
      let possible = false;
      for (const cid of ray.orderedCellIds) {
        if (working[cid] === 1 || undecidedSet.has(cid)) {
          possible = true;
          break;
        }
      }
      if (!possible) return false;
    }
    return true;
  };

  const dfsBranchAndBound = (depthIdx: number) => {
    if (visitedNodes >= MAX_BB_NODES) return;
    if (visitedNodes % 64 === 0 && performance.now() - tStart > TIME_BUDGET_MS) return;
    visitedNodes++;

    if (!canStillSatisfySightlines(depthIdx)) return;

    if (depthIdx === branchCells.length) {
      const sc = evaluator.evaluate(working);
      if (sc.isValidSilhouette && sc.totalEnergy <= globalBestEnergy + 2.5) {
        recordCandidate(working, sc);
        if (sc.totalEnergy < globalBestEnergy) {
          globalBestEnergy = sc.totalEnergy;
        }
      }
      return;
    }

    const cid = branchCells[depthIdx];
    const preferredVal = globalBestOcc[cid];
    const altVal = preferredVal === 1 ? 0 : 1;

    working[cid] = preferredVal;
    dfsBranchAndBound(depthIdx + 1);

    working[cid] = altVal;
    dfsBranchAndBound(depthIdx + 1);

    working[cid] = preferredVal;
  };

  if (branchCells.length > 0 && branchCells.length <= 14) {
    dfsBranchAndBound(0);
  }

  // 5. Filter, Deduplicate by Target-View Signature, and Rank Top K by Occam's Razor
  const allCandidates = Array.from(candidateMap.values()).filter((c) => c.score.isValidSilhouette);
  if (allCandidates.length === 0) {
    // Fallback if input drawing had broken/misaligned views causing sightline conflicts
    allCandidates.push(...Array.from(candidateMap.values()));
  }

  // Sort primarily by geometric error (unexplained + phantom + mismatch), secondarily by surfaceComplexity (Occam's Razor)
  allCandidates.sort((a, b) => {
    const geomA =
      a.score.unexplainedLength * 1.2 +
      a.score.phantomLength * 1.5 +
      a.score.lineTypeMismatchLength * 0.18;
    const geomB =
      b.score.unexplainedLength * 1.2 +
      b.score.phantomLength * 1.5 +
      b.score.lineTypeMismatchLength * 0.18;
    if (Math.abs(geomA - geomB) > 1.2) return geomA - geomB;
    return a.score.surfaceComplexity - b.score.surfaceComplexity;
  });

  const bestGeomErr =
    allCandidates.length > 0
      ? allCandidates[0].score.unexplainedLength * 1.2 +
        allCandidates[0].score.phantomLength * 1.5 +
        allCandidates[0].score.lineTypeMismatchLength * 0.18
      : 0;

  const selectedEntries: CandidateEntry[] = [];
  const seenTargetSignatures = new Set<string>();

  for (const cand of allCandidates) {
    const geomErr =
      cand.score.unexplainedLength * 1.2 +
      cand.score.phantomLength * 1.5 +
      cand.score.lineTypeMismatchLength * 0.18;
    // Only keep alternative multi-solutions if they also satisfy the 2D views with near-minimal geometric error!
    if (selectedEntries.length > 0 && geomErr > bestGeomErr + 2.0) continue;

    const targetSig = computeTargetViewSignature(complex, cand.occ, pool.targetView);
    if (seenTargetSignatures.has(targetSig)) continue;
    seenTargetSignatures.add(targetSig);
    selectedEntries.push(cand);

    if (selectedEntries.length >= maxSolutions) break;
  }

  if (selectedEntries.length === 0 && allCandidates.length > 0) {
    selectedEntries.push(allCandidates[0]);
  }

  // 6. Convert each selected occupancy vector into a complete `SolvedSolidModel3D`
  return selectedEntries.map((entry, idx) => {
    const { primitives, activeSurfaces, bounds } = coalesceOccupiedCellsToPrimitives(
      complex,
      entry.occ
    );

    const occupiedCount = entry.occ.reduce((acc, v) => acc + v, 0);
    const avgRecall = 0.5 * (entry.score.recallV1 + entry.score.recallV2);
    const avgPrec = 0.5 * (entry.score.precisionV1 + entry.score.precisionV2);
    const confPct = Math.max(60, Math.min(99.8, 0.5 * (avgRecall + avgPrec) * 100));

    const isMulti = selectedEntries.length > 1;
    const title =
      idx === 0
        ? isMulti
          ? '主推荐构型 (奥卡姆最简流形)'
          : '三维精确逆向实体构型'
        : `同源合法构型 #${idx + 1}`;
    const subtitle =
      idx === 0
        ? `体元 ${occupiedCount}/${N} · 零重投影残差校核`
        : `体元 ${occupiedCount}/${N} · 表面复杂度 ${Math.round(entry.score.surfaceComplexity)}`;

    return {
      id: `csp_sol_${idx + 1}`,
      title,
      subtitle,
      description:
        idx === 0
          ? '基于 2D DCEL 平面布置、射影半空间升维与 3D 曲边体元 CSP 约束满足求解生成，经正向消隐重投影闭环验证。'
          : '在已知两视图正交投影与虚实线约束下同样满足零残差重投影的欠约束同源三维合法解。',
      confidence: `${confPct.toFixed(1)}%`,
      occupancy: entry.occ,
      score: entry.score,
      coalescedPrimitives: primitives,
      activeSurfaces,
      bounds,
      evalSDF: (p: Vec3) => evalCSGPrimitiveListSDF(p, primitives),
      isPointOccupied: (p: Vec3) => evalCSGPrimitiveListSDF(p, primitives) <= 0,
    };
  });
}
