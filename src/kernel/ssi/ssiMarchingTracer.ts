import { Primitive3D } from '../../types/cad';
import { BBox3D, SolvedSolidModel3D, SpacePolyline3D, Vec3 } from '../types';
import { evalPrimitive3DGrad, evalPrimitive3DSDF } from '../lifting3d/surfacePrimitives';

const MAX_NEWTON_STEPS = 8;
const MAX_MARCH_STEPS = 320;
const MARCH_STEP_MM = 0.75;

function intersectBBox3D(a: BBox3D, b: BBox3D, pad = 0.4): BBox3D | null {
  const xMin = Math.max(a.xMin, b.xMin) - pad;
  const xMax = Math.min(a.xMax, b.xMax) + pad;
  const yMin = Math.max(a.yMin, b.yMin) - pad;
  const yMax = Math.min(a.yMax, b.yMax) + pad;
  const zMin = Math.max(a.zMin, b.zMin) - pad;
  const zMax = Math.min(a.zMax, b.zMax) + pad;
  if (xMin >= xMax || yMin >= yMax || zMin >= zMax) return null;
  return { xMin, xMax, yMin, yMax, zMin, zMax };
}

function isPointInBox(p: Vec3, b: BBox3D): boolean {
  return (
    p.x >= b.xMin &&
    p.x <= b.xMax &&
    p.y >= b.yMin &&
    p.y <= b.yMax &&
    p.z >= b.zMin &&
    p.z <= b.zMax
  );
}

function dist3(a: Vec3, b: Vec3): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

function cross3(a: Vec3, b: Vec3): Vec3 {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  };
}

function dot3(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

function isCurvedPrimitive(p: Primitive3D): boolean {
  return p.shape !== 'box';
}

function evalPositiveBodyOnlySDF(p: Vec3, prims: Primitive3D[]): number {
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
      dSolid = Math.max(dSolid, evalPrimitive3DSDF(p, pr));
    }
  }
  return dSolid;
}

/**
 * Projects a 3D point `p0` onto the simultaneous zero-set `{ phi1(p) = 0, phi2(p) = 0 }`
 * using damped 2D Newton-Raphson in `span{grad1, grad2}`.
 */
function projectPointOntoSSI(
  p0: Vec3,
  p1: Primitive3D,
  p2: Primitive3D
): { pt: Vec3; tangent: Vec3 } | null {
  const MIN_TAN_LEN = 0.008;
  let p = { ...p0 };
  for (let it = 0; it < MAX_NEWTON_STEPS; it++) {
    const f1 = evalPrimitive3DSDF(p, p1);
    const f2 = evalPrimitive3DSDF(p, p2);
    if (Math.abs(f1) < 1e-4 && Math.abs(f2) < 1e-4) {
      const g1 = evalPrimitive3DGrad(p, p1);
      const g2 = evalPrimitive3DGrad(p, p2);
      const tRaw = cross3(g1, g2);
      const tLen = Math.hypot(tRaw.x, tRaw.y, tRaw.z);
      if (tLen < MIN_TAN_LEN) return null; // Nearly tangent surfaces, not a transversal crease curve
      return {
        pt: p,
        tangent: { x: tRaw.x / tLen, y: tRaw.y / tLen, z: tRaw.z / tLen },
      };
    }

    const g1 = evalPrimitive3DGrad(p, p1);
    const g2 = evalPrimitive3DGrad(p, p2);
    const g11 = dot3(g1, g1);
    const g12 = dot3(g1, g2);
    const g22 = dot3(g2, g2);
    const det = g11 * g22 - g12 * g12;
    if (det < 1e-6) return null;

    const alpha = (g22 * f1 - g12 * f2) / det;
    const beta = (g11 * f2 - g12 * f1) / det;
    const dx = -(alpha * g1.x + beta * g2.x);
    const dy = -(alpha * g1.y + beta * g2.y);
    const dz = -(alpha * g1.z + beta * g2.z);
    const stepLen = Math.hypot(dx, dy, dz);
    const scale = stepLen > 2.5 ? 2.5 / stepLen : 1.0;

    p = {
      x: p.x + dx * scale,
      y: p.y + dy * scale,
      z: p.z + dz * scale,
    };
  }

  const f1 = evalPrimitive3DSDF(p, p1);
  const f2 = evalPrimitive3DSDF(p, p2);
  if (Math.abs(f1) <= 1.5e-3 && Math.abs(f2) <= 1.5e-3) {
    const g1 = evalPrimitive3DGrad(p, p1);
    const g2 = evalPrimitive3DGrad(p, p2);
    const tRaw = cross3(g1, g2);
    const tLen = Math.hypot(tRaw.x, tRaw.y, tRaw.z);
    if (tLen >= MIN_TAN_LEN) {
      return {
        pt: p,
        tangent: { x: tRaw.x / tLen, y: tRaw.y / tLen, z: tRaw.z / tLen },
      };
    }
  }
  return null;
}

/**
 * Verifies whether a point `p` on `{ phi1 = 0, phi2 = 0 }` lies on the TRUE active boundary
 * of the solved solid `model` (i.e. neither buried deep inside solid material nor floating in air).
 */
function isPointOnActiveSolidCrease(
  p: Vec3,
  p1: Primitive3D,
  p2: Primitive3D,
  model: SolvedSolidModel3D
): boolean {
  // For Void-Void (`subtract ∩ subtract`), the internal intersection ridge MUST lie strictly inside
  // the positive outer solid body (never in outside air where open-mouth CSG extensions protrude!)
  // and must not be swallowed inside a third larger cavity.
  if (p1.operation === 'subtract' && p2.operation === 'subtract') {
    if (evalPositiveBodyOnlySDF(p, model.coalescedPrimitives) >= -0.03) {
      return false;
    }
    for (const pr of model.coalescedPrimitives) {
      if (pr.operation === 'subtract' && pr.id !== p1.id && pr.id !== p2.id) {
        if (evalPrimitive3DSDF(p, pr) < -0.04) return false;
      }
    }
  }

  const g1 = evalPrimitive3DGrad(p, p1);
  const g2 = evalPrimitive3DGrad(p, p2);
  const eps = 0.2;

  // Sample 8 points in the normal plane around `p`
  let hasInside = false;
  let hasOutside = false;
  const dirs = [
    { x: g1.x, y: g1.y, z: g1.z },
    { x: -g1.x, y: -g1.y, z: -g1.z },
    { x: g2.x, y: g2.y, z: g2.z },
    { x: -g2.x, y: -g2.y, z: -g2.z },
    { x: g1.x + g2.x, y: g1.y + g2.y, z: g1.z + g2.z },
    { x: g1.x - g2.x, y: g1.y - g2.y, z: g1.z - g2.z },
    { x: -g1.x + g2.x, y: -g1.y + g2.y, z: -g1.z + g2.z },
    { x: -g1.x - g2.x, y: -g1.y - g2.y, z: -g1.z - g2.z },
  ];

  for (const d of dirs) {
    const len = Math.hypot(d.x, d.y, d.z) || 1;
    const q = {
      x: p.x + (d.x / len) * eps,
      y: p.y + (d.y / len) * eps,
      z: p.z + (d.z / len) * eps,
    };
    const sdf = model.evalSDF(q);
    if (sdf < -0.025) hasInside = true;
    if (sdf > 0.025) hasOutside = true;
    if (hasInside && hasOutside) return true;
  }
  return false;
}

/**
 * Traces high-precision 3D Surface-Surface Intersection (SSI) space curves across all active
 * primitive pairs where at least one primitive has curved surfaces (cylinders, cones, frustums,
 * spheres, hemispheres, GeneralizedLofts, curved prisms) OR oblique non-axial intersections.
 */
export function traceModelSSICurves3D(model: SolvedSolidModel3D): SpacePolyline3D[] {
  const prims = model.coalescedPrimitives;
  const curves: SpacePolyline3D[] = [];
  let curveSeq = 1;

  for (let i = 0; i < prims.length; i++) {
    for (let j = i + 1; j < prims.length; j++) {
      const p1 = prims[i];
      const p2 = prims[j];

      // Pure axis-aligned box-box intersections are crisp straight segments handled analytically,
      // unless at least one primitive is curved!
      if (!isCurvedPrimitive(p1) && !isCurvedPrimitive(p2)) continue;

      // Coaxial cylinders sharing a flat step shoulder plane already have exact SpaceCircleArc3D rims
      if (
        (p1.shape === 'cylinder_x' || p1.shape === 'cylinder_y' || p1.shape === 'cylinder_z') &&
        p1.shape === p2.shape &&
        Math.abs((p1.centerX ?? 0) - (p2.centerX ?? 0)) < 0.1 &&
        Math.abs((p1.centerY ?? 0) - (p2.centerY ?? 0)) < 0.1 &&
        Math.abs((p1.centerZ ?? 0) - (p2.centerZ ?? 0)) < 0.1
      ) {
        continue;
      }

      const overlap = intersectBBox3D(
        {
          xMin: p1.xMin,
          xMax: p1.xMax,
          yMin: p1.yMin,
          yMax: p1.yMax,
          zMin: p1.zMin,
          zMax: p1.zMax,
        },
        {
          xMin: p2.xMin,
          xMax: p2.xMax,
          yMin: p2.yMin,
          yMax: p2.yMax,
          zMin: p2.zMin,
          zMax: p2.zMax,
        },
        0.5
      );
      if (!overlap) continue;

      const isCavityPair =
        p1.operation === 'subtract' && p2.operation === 'subtract';

      // 1. Collect candidate SSI seeds on a 12x12x12 lattice inside `overlap`
      const seeds: Vec3[] = [];
      const G = 12;
      const sx = (overlap.xMax - overlap.xMin) / G;
      const sy = (overlap.yMax - overlap.yMin) / G;
      const sz = (overlap.zMax - overlap.zMin) / G;
      const captureTol = 1.35 * Math.hypot(sx, sy, sz);

      for (let ix = 0; ix <= G; ix++) {
        const x = overlap.xMin + ix * sx;
        for (let iy = 0; iy <= G; iy++) {
          const y = overlap.yMin + iy * sy;
          for (let iz = 0; iz <= G; iz++) {
            const z = overlap.zMin + iz * sz;
            const pt = { x, y, z };
            const f1 = Math.abs(evalPrimitive3DSDF(pt, p1));
            if (f1 > captureTol) continue;
            const f2 = Math.abs(evalPrimitive3DSDF(pt, p2));
            if (f2 > captureTol) continue;

            const proj = projectPointOntoSSI(pt, p1, p2);
            if (!proj) continue;
            if (!isPointInBox(proj.pt, overlap)) continue;
            if (!isPointOnActiveSolidCrease(proj.pt, p1, p2, model)) continue;

            seeds.push(proj.pt);
          }
        }
      }

      if (seeds.length === 0) continue;

      // 2. March complete curves from unvisited seeds, marking visited curve points within 1.05mm
      const visitedPts: Vec3[] = [];
      const isAlreadyCovered = (pt: Vec3, tol = 1.05): boolean =>
        visitedPts.some((vp) => dist3(vp, pt) <= tol);

      for (const seed of seeds) {
        if (isAlreadyCovered(seed, 0.85)) continue;

        const startProj = projectPointOntoSSI(seed, p1, p2);
        if (!startProj) continue;

        const marchOneDirection = (dirSign: 1 | -1): { pts: Vec3[]; closedLoop: boolean } => {
          const pts: Vec3[] = [];
          let curPt = startProj.pt;
          let prevTan = {
            x: startProj.tangent.x * dirSign,
            y: startProj.tangent.y * dirSign,
            z: startProj.tangent.z * dirSign,
          };

          for (let step = 0; step < MAX_MARCH_STEPS; step++) {
            let corr: { pt: Vec3; tangent: Vec3 } | null = null;
            let usedStepMm = MARCH_STEP_MM;

            // Adaptive step-down near tangent bifurcations (e.g. equal-radius Steinmetz apex) or cap boundaries
            for (const stepMm of [MARCH_STEP_MM, 0.25, 0.06]) {
              const pred = {
                x: curPt.x + prevTan.x * stepMm,
                y: curPt.y + prevTan.y * stepMm,
                z: curPt.z + prevTan.z * stepMm,
              };
              const cand = projectPointOntoSSI(pred, p1, p2);
              if (
                cand &&
                isPointInBox(cand.pt, overlap) &&
                isPointOnActiveSolidCrease(cand.pt, p1, p2, model)
              ) {
                corr = cand;
                usedStepMm = stepMm;
                break;
              }
            }
            if (!corr) break;

            // Orient tangent consistently with previous direction
            let nextTan = corr.tangent;
            if (dot3(nextTan, prevTan) < 0) {
              nextTan = { x: -nextTan.x, y: -nextTan.y, z: -nextTan.z };
            }

            // Detect closed loop back to seed
            if (dirSign === 1 && step >= 5 && dist3(corr.pt, startProj.pt) <= MARCH_STEP_MM * 1.15) {
              return { pts, closedLoop: true };
            }

            // Stop if running into an already traced branch
            if (step >= 2 && isAlreadyCovered(corr.pt, Math.max(0.18, usedStepMm * 0.65))) {
              pts.push(corr.pt);
              break;
            }

            pts.push(corr.pt);
            curPt = corr.pt;
            prevTan = nextTan;
          }
          return { pts, closedLoop: false };
        };

        const forward = marchOneDirection(1);
        let fullChain: Vec3[];
        let closed = false;

        if (forward.closedLoop) {
          fullChain = [startProj.pt, ...forward.pts, startProj.pt];
          closed = true;
        } else {
          const backward = marchOneDirection(-1);
          fullChain = [...backward.pts.reverse(), startProj.pt, ...forward.pts];
        }

        let chainLen = 0;
        for (let k = 1; k < fullChain.length; k++) {
          chainLen += dist3(fullChain[k], fullChain[k - 1]);
        }

        if (fullChain.length >= 3 && chainLen >= 1.6) {
          for (const fp of fullChain) visitedPts.push(fp);
          curves.push({
            id: `ssi_curve_${curveSeq++}`,
            kind: 'polyline3d',
            points: fullChain,
            closed,
            // Only lock to dashed when BOTH primitives are internal cavities (`subtract ∩ subtract`).
            // When a cavity pierces an outer surface (`add ∩ subtract`, e.g. hole piercing cone/arch/sphere),
            // the intersection mouth on the front side is VISIBLE (`thick_solid`) and on the rear side is `thin_dashed`!
            isCavityBoundary: isCavityPair,
            surfaceIds: [p1.id, p2.id],
            featureId: p2.operation === 'subtract' ? p2.featureId : p1.featureId,
            featureLabel: `${p1.label}与${p2.label}相贯线`,
          });
        }
      }
    }
  }

  return curves;
}
