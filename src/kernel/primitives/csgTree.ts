import { Primitive3D } from '../../types/cad';
import { Vec3 } from '../../types/kernel';
import { evalGeneralizedLoftSDF, primitiveToGeneralizedLoft } from './generalizedLoft';
import { evalLateralSurfaceImplicit } from './quadrics';

/**
 * Evaluates a single Primitive3D's full bounded 3D Signed Distance Function.
 */
export function evalBoundedPrimitiveSDF(p: Vec3, prim: Primitive3D): number {
  const loft = primitiveToGeneralizedLoft(prim);
  if (loft) {
    return evalGeneralizedLoftSDF(p, loft);
  }
  const xc = 0.5 * (prim.xMin + prim.xMax);
  const yc = 0.5 * (prim.yMin + prim.yMax);
  const zc = 0.5 * (prim.zMin + prim.zMax);
  const hx = Math.max(0.25, 0.5 * (prim.xMax - prim.xMin));
  const hy = Math.max(0.25, 0.5 * (prim.yMax - prim.yMin));
  const hz = Math.max(0.25, 0.5 * (prim.zMax - prim.zMin));
  const dBox = Math.max(Math.abs(p.x - xc) - hx, Math.abs(p.y - yc) - hy, Math.abs(p.z - zc) - hz);

  if (prim.shape === 'box') return dBox;
  const dLat = evalLateralSurfaceImplicit(p, prim);
  if (prim.shape === 'hemisphere') return Math.max(dLat, dBox);
  if (prim.shape === 'cylinder_z') return Math.max(dLat, Math.abs(p.z - zc) - hz);
  if (prim.shape === 'cylinder_y') return Math.max(dLat, Math.abs(p.y - yc) - hy);
  if (prim.shape === 'cylinder_x') return Math.max(dLat, Math.abs(p.x - xc) - hx);
  return Math.max(dLat, dBox);
}

/**
 * Evaluates the complete 3D CSG Boolean Tree SDF at point p:
 *   - dAddOnly: SDF of all 'add' and 'intersect' base solids (excluding 'subtract' voids)
 *   - dAll: Final CSG SDF after subtracting all 'subtract' primitives
 */
export function evaluateCSGTreeSDF(
  p: Vec3,
  primitives: Primitive3D[]
): {
  dAll: number;
  dAddOnly: number;
  activeSubtractOwner?: Primitive3D;
} {
  let dAddOnly = Infinity;
  for (const prim of primitives) {
    if (prim.operation === 'add') {
      dAddOnly = Math.min(dAddOnly, evalBoundedPrimitiveSDF(p, prim));
    } else if (prim.operation === 'intersect') {
      dAddOnly = Math.max(dAddOnly, evalBoundedPrimitiveSDF(p, prim));
    }
  }

  let dAll = dAddOnly;
  let activeSubtractOwner: Primitive3D | undefined;
  for (const prim of primitives) {
    if (prim.operation === 'subtract') {
      const dSub = evalBoundedPrimitiveSDF(p, prim);
      if (-dSub > dAll) {
        dAll = -dSub;
        activeSubtractOwner = prim;
      }
    }
  }

  return { dAll, dAddOnly, activeSubtractOwner };
}

/**
 * 26-Neighborhood Knife-Edge & Thin-Wall Protection Probe:
 * Prevents co-radial frustum rims (where r_hole == R_min) or tangent thin walls
 * from being discarded as empty space due to floating-point tolerance.
 */
export function isPointOnKnifeEdgeOrThinWall(
  p: Vec3,
  primitives: Primitive3D[],
  delta = 0.35
): boolean {
  let hasSolidNeighbor = false;
  let hasAirNeighbor = false;
  for (const dx of [-delta, 0, delta]) {
    for (const dy of [-delta, 0, delta]) {
      for (const dz of [-delta, 0, delta]) {
        const { dAll } = evaluateCSGTreeSDF(
          { x: p.x + dx, y: p.y + dy, z: p.z + dz },
          primitives
        );
        if (dAll <= 0.05) hasSolidNeighbor = true;
        if (dAll > 0.05) hasAirNeighbor = true;
        if (hasSolidNeighbor && hasAirNeighbor) return true;
      }
    }
  }
  return false;
}
