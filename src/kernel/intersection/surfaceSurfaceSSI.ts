import { Primitive3D } from '../../types/cad';
import { Seg3D, Vec3 } from '../../types/kernel';
import { evaluateCSGTreeSDF } from '../primitives/csgTree';
import {
  evalLateralSurfaceImplicit,
  evalPrimitiveSurfaceGradient3D,
} from '../primitives/quadrics';

function isCurvedQuadricPrimitive(prim: Primitive3D): boolean {
  return (
    prim.shape === 'cylinder_x' ||
    prim.shape === 'cylinder_y' ||
    prim.shape === 'cylinder_z' ||
    prim.shape === 'cone_x' ||
    prim.shape === 'cone_y' ||
    prim.shape === 'cone_z' ||
    prim.shape === 'sphere' ||
    prim.shape === 'hemisphere'
  );
}

/**
 * Projects a candidate 3D point onto the intersection manifold f_A(p) = 0, f_B(p) = 0
 * using 2D Moore-Penrose Newton-Raphson iteration.
 */
export function projectPointOntoSSIManifold(
  seed: Vec3,
  primA: Primitive3D,
  primB: Primitive3D,
  maxIter = 5
): Vec3 | null {
  let p = { ...seed };
  for (let iter = 0; iter < maxIter; iter++) {
    const fA = evalLateralSurfaceImplicit(p, primA);
    const fB = evalLateralSurfaceImplicit(p, primB);
    if (Math.abs(fA) < 1e-3 && Math.abs(fB) < 1e-3) {
      return p;
    }
    const gA = evalPrimitiveSurfaceGradient3D(p, primA);
    const gB = evalPrimitiveSurfaceGradient3D(p, primB);
    const c = gA.x * gB.x + gA.y * gB.y + gA.z * gB.z;
    const det = Math.max(1e-3, 1 - c * c);
    const alpha = (fA - c * fB) / det;
    const beta = (fB - c * fA) / det;
    p = {
      x: p.x - (alpha * gA.x + beta * gB.x),
      y: p.y - (alpha * gA.y + beta * gB.y),
      z: p.z - (alpha * gA.z + beta * gB.z),
    };
  }
  const finalFA = Math.abs(evalLateralSurfaceImplicit(p, primA));
  const finalFB = Math.abs(evalLateralSurfaceImplicit(p, primB));
  return finalFA <= 0.08 && finalFB <= 0.08 ? p : null;
}

/**
 * Samples a point (theta, t) on the lateral surface of a curved primitive A
 * and refines zero-crossings against curved primitive B to extract exact SSI curves.
 */
export function tracePairwiseCurvedSSI(
  primA: Primitive3D,
  primB: Primitive3D,
  allPrimitives: Primitive3D[]
): Seg3D[] {
  if (!isCurvedQuadricPrimitive(primA) || !isCurvedQuadricPrimitive(primB)) return [];
  // Quick bounding box overlap check
  if (
    primA.xMax < primB.xMin - 1 ||
    primA.xMin > primB.xMax + 1 ||
    primA.yMax < primB.yMin - 1 ||
    primA.yMin > primB.yMax + 1 ||
    primA.zMax < primB.zMin - 1 ||
    primA.zMin > primB.zMax + 1
  ) {
    return [];
  }

  const isZ = primA.shape === 'cylinder_z' || primA.shape === 'cone_z';
  const isY = primA.shape === 'cylinder_y' || primA.shape === 'cone_y';
  const isSph = primA.shape === 'sphere' || primA.shape === 'hemisphere';
  const xc = 0.5 * (primA.xMin + primA.xMax);
  const yc = 0.5 * (primA.yMin + primA.yMax);
  const zc = 0.5 * (primA.zMin + primA.zMax);

  const sampleParamPt = (theta: number, t: number): Vec3 => {
    if (isSph) {
      const cx = primA.centerX ?? xc;
      const cy = primA.centerY ?? yc;
      const cz = primA.centerZ ?? zc;
      const r = primA.radius ?? 0.5 * Math.max(primA.xMax - primA.xMin, primA.yMax - primA.yMin);
      const phi = (t - 0.5) * Math.PI;
      return {
        x: cx + r * Math.cos(phi) * Math.cos(theta),
        y: cy + r * Math.cos(phi) * Math.sin(theta),
        z: cz + r * Math.sin(phi),
      };
    }
    const defU = isZ || isY ? (primA.centerX ?? xc) : (primA.centerY ?? yc);
    const defV = isZ ? (primA.centerY ?? yc) : (primA.centerZ ?? zc);
    const uC0 = primA.uCenterMin ?? defU;
    const uC1 = primA.uCenterMax ?? defU;
    const vC0 = primA.vCenterMin ?? defV;
    const vC1 = primA.vCenterMax ?? defV;
    const isCone = primA.shape.startsWith('cone_');
    const r0 = primA.rMin ?? primA.radius ?? 10;
    const r1 = isCone ? (primA.rMax ?? 0) : r0;
    const w0 = isZ ? primA.zMin : isY ? primA.yMin : primA.xMin;
    const w1 = isZ ? primA.zMax : isY ? primA.yMax : primA.xMax;
    const u = (1 - t) * uC0 + t * uC1 + ((1 - t) * r0 + t * r1) * Math.cos(theta);
    const v = (1 - t) * vC0 + t * vC1 + ((1 - t) * r0 + t * r1) * Math.sin(theta);
    const w = w0 + t * (w1 - w0);
    return isZ ? { x: u, y: v, z: w } : isY ? { x: u, y: w, z: v } : { x: w, y: u, z: v };
  };

  const nTheta = 48;
  const nT = 24;
  const segments: Seg3D[] = [];
  const ownerType =
    primA.operation === 'subtract' || primB.operation === 'subtract' ? 'subtract' : 'add';
  const ownerId = primA.operation === 'subtract' ? primA.id : primB.id;
  const featureId = primA.operation === 'subtract' ? primA.featureId : primB.featureId;
  const featureLabel = primA.operation === 'subtract' ? primA.label : primB.label;

  // For each theta slice, locate axial zero-crossings along t in [0, 1] and connect adjacent theta slices
  const upperBranch: (Vec3 | null)[] = [];
  const lowerBranch: (Vec3 | null)[] = [];

  for (let i = 0; i <= nTheta; i++) {
    const theta = (i / nTheta) * Math.PI * 2;
    const roots: Vec3[] = [];
    let prevPt = sampleParamPt(theta, 0);
    let prevF = evalLateralSurfaceImplicit(prevPt, primB);

    for (let j = 1; j <= nT; j++) {
      const t = j / nT;
      const currPt = sampleParamPt(theta, t);
      const currF = evalLateralSurfaceImplicit(currPt, primB);
      if (prevF * currF <= 0) {
        const frac = Math.abs(prevF) / Math.max(1e-6, Math.abs(prevF) + Math.abs(currF));
        const seed: Vec3 = {
          x: prevPt.x + frac * (currPt.x - prevPt.x),
          y: prevPt.y + frac * (currPt.y - prevPt.y),
          z: prevPt.z + frac * (currPt.z - prevPt.z),
        };
        const refined = projectPointOntoSSIManifold(seed, primA, primB, 5) || seed;
        const { dAll } = evaluateCSGTreeSDF(refined, allPrimitives);
        if (Math.abs(dAll) <= 0.35) {
          roots.push(refined);
        }
      }
      prevPt = currPt;
      prevF = currF;
    }

    upperBranch.push(roots[0] || null);
    lowerBranch.push(roots.length > 1 ? roots[roots.length - 1] : null);
  }

  for (const branch of [upperBranch, lowerBranch]) {
    for (let i = 0; i < nTheta; i++) {
      const p1 = branch[i];
      const p2 = branch[i + 1];
      if (p1 && p2 && Math.hypot(p2.x - p1.x, p2.y - p1.y, p2.z - p1.z) <= 8.0) {
        segments.push({
          p1,
          p2,
          ownerType,
          ownerId,
          featureId,
          featureLabel,
        });
      }
    }
  }

  return segments;
}
