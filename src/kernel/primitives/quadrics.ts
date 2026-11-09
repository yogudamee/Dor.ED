import { Primitive3D } from '../../types/cad';
import { Vec3 } from '../../types/kernel';
import { evalGeneralizedLoftSDF, primitiveToGeneralizedLoft } from './generalizedLoft';

/**
 * Evaluates the exact lateral (uncapped) implicit surface function f(p) = 0
 * for curved primitives (cylinder, cone/frustum, sphere, hemisphere) used in SSI marching.
 */
export function evalLateralSurfaceImplicit(p: Vec3, prim: Primitive3D): number {
  const xc = 0.5 * (prim.xMin + prim.xMax);
  const yc = 0.5 * (prim.yMin + prim.yMax);
  const zc = 0.5 * (prim.zMin + prim.zMax);

  if (prim.shape === 'sphere' || prim.shape === 'hemisphere') {
    const cx = prim.centerX ?? xc;
    const cy = prim.centerY ?? yc;
    const cz = prim.centerZ ?? zc;
    const r = prim.radius ?? 0.5 * Math.max(prim.xMax - prim.xMin, prim.yMax - prim.yMin, prim.zMax - prim.zMin);
    return Math.hypot(p.x - cx, p.y - cy, p.z - cz) - r;
  }

  if (prim.shape === 'cylinder_z' && prim.radius !== undefined) {
    const cx = prim.centerX ?? xc;
    const cy = prim.centerY ?? yc;
    return Math.hypot(p.x - cx, p.y - cy) - prim.radius;
  }
  if (prim.shape === 'cylinder_y' && prim.radius !== undefined) {
    const cx = prim.centerX ?? xc;
    const cz = prim.centerZ ?? zc;
    return Math.hypot(p.x - cx, p.z - cz) - prim.radius;
  }
  if (prim.shape === 'cylinder_x' && prim.radius !== undefined) {
    const cy = prim.centerY ?? yc;
    const cz = prim.centerZ ?? zc;
    return Math.hypot(p.y - cy, p.z - cz) - prim.radius;
  }

  if (prim.shape === 'cone_z' || prim.shape === 'cone_y' || prim.shape === 'cone_x') {
    const isZ = prim.shape === 'cone_z';
    const isY = prim.shape === 'cone_y';
    const uVal = isZ ? p.x : isY ? p.x : p.y;
    const vVal = isZ ? p.y : isY ? p.z : p.z;
    const wVal = isZ ? p.z : isY ? p.y : p.x;
    const uC = isZ ? (prim.centerX ?? xc) : isY ? (prim.centerX ?? xc) : (prim.centerY ?? yc);
    const vC = isZ ? (prim.centerY ?? yc) : isY ? (prim.centerZ ?? zc) : (prim.centerZ ?? zc);
    const uCMin = prim.uCenterMin ?? uC;
    const uCMax = prim.uCenterMax ?? uC;
    const vCMin = prim.vCenterMin ?? vC;
    const vCMax = prim.vCenterMax ?? vC;
    const wMin = isZ ? prim.zMin : isY ? prim.yMin : prim.xMin;
    const wMax = isZ ? prim.zMax : isY ? prim.yMax : prim.xMax;
    const r0 = prim.rMin ?? prim.radius ?? 10;
    const r1 = prim.rMax ?? 0;
    const t = Math.max(0, Math.min(1, (wVal - wMin) / Math.max(1e-3, wMax - wMin)));
    const uCt = (1 - t) * uCMin + t * uCMax;
    const vCt = (1 - t) * vCMin + t * vCMax;
    const rAtT = (1 - t) * r0 + t * r1;
    const cosAlpha = (wMax - wMin) / Math.max(1e-3, Math.hypot(wMax - wMin, r0 - r1));
    return (Math.hypot(uVal - uCt, vVal - vCt) - rAtT) * cosAlpha;
  }

  const loft = primitiveToGeneralizedLoft(prim);
  if (loft) {
    return evalGeneralizedLoftSDF(p, loft);
  }

  const dx = Math.abs(p.x - xc) - 0.5 * (prim.xMax - prim.xMin);
  const dy = Math.abs(p.y - yc) - 0.5 * (prim.yMax - prim.yMin);
  const dz = Math.abs(p.z - zc) - 0.5 * (prim.zMax - prim.zMin);
  return Math.max(dx, dy, dz);
}

/**
 * Computes the unit 3D surface gradient vector ∇f(p) / ||∇f(p)|| via central differences
 * for Newton-Raphson SSI marching.
 */
export function evalPrimitiveSurfaceGradient3D(p: Vec3, prim: Primitive3D, eps = 0.02): Vec3 {
  const gx =
    evalLateralSurfaceImplicit({ x: p.x + eps, y: p.y, z: p.z }, prim) -
    evalLateralSurfaceImplicit({ x: p.x - eps, y: p.y, z: p.z }, prim);
  const gy =
    evalLateralSurfaceImplicit({ x: p.x, y: p.y + eps, z: p.z }, prim) -
    evalLateralSurfaceImplicit({ x: p.x, y: p.y - eps, z: p.z }, prim);
  const gz =
    evalLateralSurfaceImplicit({ x: p.x, y: p.y, z: p.z + eps }, prim) -
    evalLateralSurfaceImplicit({ x: p.x, y: p.y, z: p.z - eps }, prim);
  const len = Math.hypot(gx, gy, gz);
  if (len < 1e-9) return { x: 0, y: 0, z: 1 };
  return { x: gx / len, y: gy / len, z: gz / len };
}
