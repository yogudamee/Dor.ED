import { Primitive3D, ViewType } from '../../types/cad';
import { BoundingBox3D } from '../../types/kernel';

export interface NestedCircleAmbiguity {
  view: ViewType;
  outerCircle: { id: string; center: { u: number; v: number }; radius: number };
  innerCircle: { id: string; center: { u: number; v: number }; radius: number };
  outerHoleId: string;
}

/**
 * Generates alternative 3D candidate solid configurations for under-constrained nested features
 * (e.g., Front Counterbore vs. Back Counterbore vs. Outward Cylindrical Boss + Through-Hole).
 */
export function buildNestedCircleCandidateVariants(
  baseSubtracts: Primitive3D[],
  nestedCircles: NestedCircleAmbiguity[],
  bounds: BoundingBox3D
): {
  frontCounterboreSubtracts: Primitive3D[];
  backCounterboreSubtracts: Primitive3D[];
  bossAddPrimitives: Primitive3D[];
  bossFilteredSubtracts: Primitive3D[];
} {
  const outerHoleIds = new Set(nestedCircles.map((nc) => nc.outerHoleId));
  const { xMin, xMax, yMin, yMax, zMin, zMax } = bounds;

  const backCounterboreSubtracts = baseSubtracts.map((p) => {
    if (!outerHoleIds.has(p.id)) return p;
    if (p.shape === 'cylinder_y') {
      const yMid = Number((0.5 * (yMin + yMax)).toFixed(1));
      return { ...p, yMin: yMid, yMax: yMax + 2 };
    }
    if (p.shape === 'cylinder_z') {
      const zMid = Number((0.5 * (zMin + zMax)).toFixed(1));
      return { ...p, zMin: zMin - 2, zMax: zMid };
    }
    const xMid = Number((0.5 * (xMin + xMax)).toFixed(1));
    return { ...p, xMin: xMid, xMax: xMax + 2 };
  });

  const bossFilteredSubtracts = baseSubtracts.filter((p) => !outerHoleIds.has(p.id));
  const bossAddPrimitives: Primitive3D[] = nestedCircles.map((nc, i) => {
    const c = nc.outerCircle;
    if (nc.view === 'front') {
      const bossDepth = Math.max(8, Math.round(0.25 * (yMax - yMin)));
      return {
        id: `boss-nested-y-${i}`,
        featureId: `boss_ny_${i}`,
        label: `Boss Ø${Math.round(c.radius * 2)}`,
        operation: 'add',
        shape: 'cylinder_y',
        xMin: c.center.u - c.radius,
        xMax: c.center.u + c.radius,
        yMin: yMin - bossDepth,
        yMax: yMin + 2,
        zMin: c.center.v - c.radius,
        zMax: c.center.v + c.radius,
        centerX: c.center.u,
        centerZ: c.center.v,
        radius: c.radius,
      };
    }
    if (nc.view === 'top') {
      const bossDepth = Math.max(8, Math.round(0.25 * (zMax - zMin)));
      return {
        id: `boss-nested-z-${i}`,
        featureId: `boss_nz_${i}`,
        label: `Boss Ø${Math.round(c.radius * 2)}`,
        operation: 'add',
        shape: 'cylinder_z',
        xMin: c.center.u - c.radius,
        xMax: c.center.u + c.radius,
        yMin: c.center.v - c.radius,
        yMax: c.center.v + c.radius,
        zMin: zMax - 2,
        zMax: zMax + bossDepth,
        centerX: c.center.u,
        centerY: c.center.v,
        radius: c.radius,
      };
    }
    const bossDepth = Math.max(8, Math.round(0.25 * (xMax - xMin)));
    return {
      id: `boss-nested-x-${i}`,
      featureId: `boss_nx_${i}`,
      label: `Boss Ø${Math.round(c.radius * 2)}`,
      operation: 'add',
      shape: 'cylinder_x',
      xMin: xMin - bossDepth,
      xMax: xMin + 2,
      yMin: c.center.u - c.radius,
      yMax: c.center.u + c.radius,
      zMin: c.center.v - c.radius,
      zMax: c.center.v + c.radius,
      centerY: c.center.u,
      centerZ: c.center.v,
      radius: c.radius,
    };
  });

  return {
    frontCounterboreSubtracts: baseSubtracts,
    backCounterboreSubtracts,
    bossAddPrimitives,
    bossFilteredSubtracts,
  };
}
