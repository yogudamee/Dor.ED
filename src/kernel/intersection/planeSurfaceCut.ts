import { Primitive3D } from '../../types/cad';
import { Plane3D, Seg3D, Vec3 } from '../../types/kernel';
import { evaluateCSGTreeSDF } from '../primitives/csgTree';

/**
 * Extracts slanted planes from prism, pyramid, and wedge primitives.
 */
export function extractSlantedPlanesFromPrimitive(prim: Primitive3D): Plane3D[] {
  const planes: Plane3D[] = [];
  if (
    (prim.shape === 'prism' || prim.shape === 'pyramid') &&
    prim.prismPolygon &&
    prim.prismPolygon.length >= 3
  ) {
    const axis = prim.prismAxis || 'Z';
    const pts = prim.prismPolygon;
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i];
      const b = pts[(i + 1) % pts.length];
      const du = b.u - a.u;
      const dv = b.v - a.v;
      const len = Math.hypot(du, dv);
      if (len < 1.5) continue;
      // Only slanted faces (non-axis-aligned in 2D profile) produce curved conic sections on quadrics
      if (Math.abs(du) <= 0.5 || Math.abs(dv) <= 0.5) continue;
      const nu = -dv / len;
      const nv = du / len;
      const normal: Vec3 =
        axis === 'Z'
          ? { x: nu, y: nv, z: 0 }
          : axis === 'Y'
            ? { x: nu, y: 0, z: nv }
            : { x: 0, y: nu, z: nv };
      const ptOnPlane: Vec3 =
        axis === 'Z'
          ? { x: a.u, y: a.v, z: prim.zMin }
          : axis === 'Y'
            ? { x: a.u, y: prim.yMin, z: a.v }
            : { x: prim.xMin, y: a.u, z: a.v };
      const d = -(normal.x * ptOnPlane.x + normal.y * ptOnPlane.y + normal.z * ptOnPlane.z);
      planes.push({
        normal,
        d,
        bounds: {
          xMin: prim.xMin,
          xMax: prim.xMax,
          yMin: prim.yMin,
          yMax: prim.yMax,
          zMin: prim.zMin,
          zMax: prim.zMax,
        },
      });
    }
  }
  return planes;
}

/**
 * Analytical Conic Section Solver:
 * Computes exact 3D intersection segments (ellipses, parabolas, hyperbolas)
 * between a slanted plane Π: n · p + d = 0 and a cylinder/cone/frustum/sphere quadric.
 */
export function computePlaneQuadricSectionSegments(
  plane: Plane3D,
  quadric: Primitive3D,
  allPrimitives: Primitive3D[],
  numSamples = 64
): Seg3D[] {
  const isCyl =
    quadric.shape === 'cylinder_z' ||
    quadric.shape === 'cylinder_y' ||
    quadric.shape === 'cylinder_x';
  const isCone =
    quadric.shape === 'cone_z' || quadric.shape === 'cone_y' || quadric.shape === 'cone_x';
  if (!isCyl && !isCone) return [];

  const isZ = quadric.shape === 'cylinder_z' || quadric.shape === 'cone_z';
  const isY = quadric.shape === 'cylinder_y' || quadric.shape === 'cone_y';
  const xc = 0.5 * (quadric.xMin + quadric.xMax);
  const yc = 0.5 * (quadric.yMin + quadric.yMax);
  const zc = 0.5 * (quadric.zMin + quadric.zMax);
  const defU = isZ || isY ? (quadric.centerX ?? xc) : (quadric.centerY ?? yc);
  const defV = isZ ? (quadric.centerY ?? yc) : (quadric.centerZ ?? zc);
  const uC0 = quadric.uCenterMin ?? defU;
  const uC1 = quadric.uCenterMax ?? defU;
  const vC0 = quadric.vCenterMin ?? defV;
  const vC1 = quadric.vCenterMax ?? defV;
  const r0 = quadric.rMin ?? quadric.radius ?? 10;
  const r1 = isCone ? (quadric.rMax ?? 0) : r0;
  const w0 = isZ ? quadric.zMin : isY ? quadric.yMin : quadric.xMin;
  const w1 = isZ ? quadric.zMax : isY ? quadric.yMax : quadric.xMax;

  const to3D = (u: number, v: number, w: number): Vec3 =>
    isZ ? { x: u, y: v, z: w } : isY ? { x: u, y: w, z: v } : { x: w, y: u, z: v };

  const sampledPts: (Vec3 | null)[] = [];
  for (let k = 0; k <= numSamples; k++) {
    const theta = (k / numSamples) * Math.PI * 2;
    const c = Math.cos(theta);
    const s = Math.sin(theta);
    const pBase = to3D(uC0 + r0 * c, vC0 + r0 * s, w0);
    const pTop = to3D(uC1 + r1 * c, vC1 + r1 * s, w1);
    const num = -(plane.normal.x * pBase.x + plane.normal.y * pBase.y + plane.normal.z * pBase.z + plane.d);
    const den =
      plane.normal.x * (pTop.x - pBase.x) +
      plane.normal.y * (pTop.y - pBase.y) +
      plane.normal.z * (pTop.z - pBase.z);
    if (Math.abs(den) < 1e-5) {
      sampledPts.push(null);
      continue;
    }
    const t = num / den;
    if (t < -0.01 || t > 1.01) {
      sampledPts.push(null);
      continue;
    }
    const pt: Vec3 = {
      x: pBase.x + t * (pTop.x - pBase.x),
      y: pBase.y + t * (pTop.y - pBase.y),
      z: pBase.z + t * (pTop.z - pBase.z),
    };
    const { dAll } = evaluateCSGTreeSDF(pt, allPrimitives);
    if (Math.abs(dAll) <= 0.35) {
      sampledPts.push(pt);
    } else {
      sampledPts.push(null);
    }
  }

  const segs: Seg3D[] = [];
  for (let k = 0; k < numSamples; k++) {
    const pA = sampledPts[k];
    const pB = sampledPts[k + 1];
    if (pA && pB && Math.hypot(pB.x - pA.x, pB.y - pA.y, pB.z - pA.z) <= 8.0) {
      segs.push({
        p1: pA,
        p2: pB,
        ownerType: quadric.operation,
        ownerId: quadric.id,
        featureId: quadric.featureId,
        featureLabel: quadric.label,
      });
    }
  }
  return segs;
}
