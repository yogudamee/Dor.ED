import { Primitive3D } from '../../types/cad';
import {
  add3,
  boxesOverlap3D,
  cross3,
  dist3,
  dot3,
  len3,
  scale3,
  sub3,
} from '../core/coordSystem';
import { BoundingBox3D, SSICurveChain3D, Vec3 } from '../core/types';
import {
  computePrimitiveBounds3D,
  evalPositiveBaseOnlySDF,
  evalPrimitive3DGrad,
  evalPrimitive3DSDF,
} from '../lifting3d/analyticSurfaces';

const MAX_SSI_STEPS = 220;
const STEP_SIZE_MM = 1.1;

function projectOntoTwoSurfacesNewton(
  startPt: Vec3,
  primA: Primitive3D,
  primB: Primitive3D,
  maxIter = 8
): Vec3 | null {
  let p = { ...startPt };
  for (let it = 0; it < maxIter; it++) {
    const f1 = evalPrimitive3DSDF(p, primA);
    const f2 = evalPrimitive3DSDF(p, primB);
    if (Math.abs(f1) < 1e-4 && Math.abs(f2) < 1e-4) return p;

    const g1 = evalPrimitive3DGrad(p, primA, 5e-4);
    const g2 = evalPrimitive3DGrad(p, primB, 5e-4);
    const g11 = dot3(g1, g1);
    const g22 = dot3(g2, g2);
    const g12 = dot3(g1, g2);
    const det = g11 * g22 - g12 * g12;
    if (Math.abs(det) < 1e-5) return null;

    // Minimum-norm 2D orthogonal Newton-Raphson step: Δp = -(a * g1 + b * g2)
    const a = (g22 * f1 - g12 * f2) / det;
    const b = (g11 * f2 - g12 * f1) / det;
    const dp = add3(scale3(g1, -a), scale3(g2, -b));
    const stepLen = len3(dp);
    const clampScale = stepLen > 2.5 ? 2.5 / stepLen : 1.0;
    p = add3(p, scale3(dp, clampScale));
  }
  const f1End = Math.abs(evalPrimitive3DSDF(p, primA));
  const f2End = Math.abs(evalPrimitive3DSDF(p, primB));
  return f1End < 0.04 && f2End < 0.04 ? p : null;
}

function isSSIPointActiveOnCSGBoundary(
  p: Vec3,
  primA: Primitive3D,
  primB: Primitive3D,
  kind: 'solid_solid' | 'solid_void' | 'void_void',
  allPrimitives: Primitive3D[]
): boolean {
  const positives = allPrimitives.filter((pr) => pr.operation !== 'subtract');
  const subtracts = allPrimitives.filter((pr) => pr.operation === 'subtract');

  if (kind === 'solid_solid') {
    // Must not lie strictly inside a third positive solid
    for (const pr of positives) {
      if (pr.id === primA.id || pr.id === primB.id) continue;
      if (pr.weldGroup && (pr.weldGroup === primA.weldGroup || pr.weldGroup === primB.weldGroup)) {
        continue;
      }
      if (evalPrimitive3DSDF(p, pr) < -0.05) return false;
    }
    // Must not be carved away by any subtract void
    for (const vp of subtracts) {
      if (evalPrimitive3DSDF(p, vp) < -0.05) return false;
    }
    return true;
  }

  if (kind === 'solid_void') {
    const solidPrim = primA.operation !== 'subtract' ? primA : primB;
    const voidPrim = primA.operation === 'subtract' ? primA : primB;
    // Must be on the exterior of the positive union (not buried inside another positive solid!)
    for (const pr of positives) {
      if (pr.id === solidPrim.id) continue;
      if (pr.weldGroup && pr.weldGroup === solidPrim.weldGroup) continue;
      if (evalPrimitive3DSDF(p, pr) < -0.05) return false;
    }
    // Must not be carved away by another subtract void
    for (const vp of subtracts) {
      if (vp.id === voidPrim.id) continue;
      if (evalPrimitive3DSDF(p, vp) < -0.05) return false;
    }
    return true;
  }

  // kind === 'void_void': Intersection between two cavity channels!
  // Must lie INSIDE the positive solid body (or right up to its surface <= 0.02)
  // AND not inside the interior of a third void channel!
  const dPos = evalPositiveBaseOnlySDF(p, allPrimitives);
  if (dPos > 0.02) return false;
  for (const vp of subtracts) {
    if (vp.id === primA.id || vp.id === primB.id) continue;
    if (evalPrimitive3DSDF(p, vp) < -0.05) return false;
  }
  return true;
}

function isCurvedPrimitive(prim: Primitive3D): boolean {
  if (prim.loftSpec) {
    const k0 = prim.loftSpec.section0.kind;
    const k1 = prim.loftSpec.section1.kind;
    return k0 === 'circle' || k0 === 'semicircle' || k1 === 'circle' || k1 === 'semicircle';
  }
  return (
    prim.shape.startsWith('cylinder_') ||
    prim.shape.startsWith('cone_') ||
    prim.shape === 'sphere' ||
    prim.shape === 'hemisphere' ||
    (prim.shape === 'prism' &&
      Boolean(prim.prismSegments?.some((s) => s.kind === 'arc')))
  );
}

/**
 * Trace all 3D Surface-Surface Intersection (SSI) & Plane-Quadric Conic Section curves:
 * - `solid_solid`: e.g. straddling cylinder meeting stepped block, cylinder-cylinder union, cone + rear hemisphere
 * - `solid_void`: e.g. sphere slotted by box, cone slotted/pierced by lateral box (hyperbola/circle), hexagonal prism pierced by cylinder, cylinder pierced by cross-hole
 * - `void_void`: e.g. orthogonal crossed circular bores (45° Steinmetz lines / hyperbolic saddle curves), T-junction 3-way bores, arch square-bore ∩ circular-bore!
 */
export function traceAllSSICurves3D(
  primitives: Primitive3D[]
): SSICurveChain3D[] {
  const chains: SSICurveChain3D[] = [];
  const startTime = Date.now();
  const TIME_BUDGET_MS = 180;

  for (let i = 0; i < primitives.length; i++) {
    if (Date.now() - startTime > TIME_BUDGET_MS) break;
    const primA = primitives[i];
    const bA = computePrimitiveBounds3D(primA);

    for (let j = i + 1; j < primitives.length; j++) {
      if (Date.now() - startTime > TIME_BUDGET_MS) break;
      const primB = primitives[j];

      // Skip two pure axis-aligned boxes unless one is a tilted/polygonal prism or curved surface!
      // Wait: two axis-aligned boxes have straight edges already extracted by edgeExtractor3D!
      // Wait — what about `box` (solid) + `box` (subtract slot)? Their intersection edges ARE the edges of the subtract box clipped to the solid box, already extracted in edgeExtractor3D!
      // Whereas if AT LEAST ONE of (primA, primB) is a curved surface OR an oblique/polygonal prism/wedge/pyramid, their intersection produces NEW 3D curves/chords not present on the axis-aligned edges!
      const curvedOrSlanted =
        isCurvedPrimitive(primA) ||
        isCurvedPrimitive(primB) ||
        primA.shape === 'prism' ||
        primB.shape === 'prism' ||
        primA.shape === 'wedge_x' ||
        primB.shape === 'wedge_x' ||
        primA.shape === 'wedge_y' ||
        primB.shape === 'wedge_y' ||
        Boolean(primA.loftSpec) ||
        Boolean(primB.loftSpec);
      if (!curvedOrSlanted) continue;

      const bB = computePrimitiveBounds3D(primB);
      if (!boxesOverlap3D(bA, bB, 0.25)) continue;

      // Skip coaxial abutting primitives that only touch on a flat cap plane (handled cleanly by annular shoulder circle extractor!)
      if (arePureEndToEndAbutting(bA, bB)) continue;

      const opA = primA.operation;
      const opB = primB.operation;
      let kind: 'solid_solid' | 'solid_void' | 'void_void';
      if (opA === 'subtract' && opB === 'subtract') {
        kind = 'void_void';
      } else if (opA === 'subtract' || opB === 'subtract') {
        kind = 'solid_void';
      } else {
        kind = 'solid_solid';
      }

      const overlap: BoundingBox3D = {
        xMin: Math.max(bA.xMin, bB.xMin) - 0.5,
        xMax: Math.min(bA.xMax, bB.xMax) + 0.5,
        yMin: Math.max(bA.yMin, bB.yMin) - 0.5,
        yMax: Math.min(bA.yMax, bB.yMax) + 0.5,
        zMin: Math.max(bA.zMin, bB.zMin) - 0.5,
        zMax: Math.min(bA.zMax, bB.zMax) + 0.5,
      };

      const pairChains = tracePairSSI(
        primA,
        primB,
        kind,
        overlap,
        primitives,
        chains.length
      );
      chains.push(...pairChains);
    }
  }

  return chains;
}

function arePureEndToEndAbutting(a: BoundingBox3D, b: BoundingBox3D): boolean {
  const ox = Math.min(a.xMax, b.xMax) - Math.max(a.xMin, b.xMin);
  const oy = Math.min(a.yMax, b.yMax) - Math.max(a.yMin, b.yMin);
  const oz = Math.min(a.zMax, b.zMax) - Math.max(a.zMin, b.zMin);
  return ox <= 0.15 || oy <= 0.15 || oz <= 0.15;
}

function tracePairSSI(
  primA: Primitive3D,
  primB: Primitive3D,
  kind: 'solid_solid' | 'solid_void' | 'void_void',
  overlap: BoundingBox3D,
  allPrimitives: Primitive3D[],
  baseIndex: number
): SSICurveChain3D[] {
  // 1. Seed point discovery on adaptive 3D lattice inside overlap box
  const seeds: Vec3[] = [];
  const nx = 9;
  const ny = 9;
  const nz = 9;
  for (let ix = 0; ix <= nx; ix++) {
    const x = overlap.xMin + ((overlap.xMax - overlap.xMin) * ix) / nx;
    for (let iy = 0; iy <= ny; iy++) {
      const y = overlap.yMin + ((overlap.yMax - overlap.yMin) * iy) / ny;
      for (let iz = 0; iz <= nz; iz++) {
        const z = overlap.zMin + ((overlap.zMax - overlap.zMin) * iz) / nz;
        const p0 = { x, y, z };
        const dA = Math.abs(evalPrimitive3DSDF(p0, primA));
        const dB = Math.abs(evalPrimitive3DSDF(p0, primB));
        if (dA < 3.2 && dB < 3.2) {
          const refined = projectOntoTwoSurfacesNewton(p0, primA, primB, 8);
          if (
            refined &&
            isSSIPointActiveOnCSGBoundary(
              refined,
              primA,
              primB,
              kind,
              allPrimitives
            )
          ) {
            if (!seeds.some((s) => dist3(s, refined) < 0.45)) {
              seeds.push(refined);
            }
          }
        }
      }
    }
  }

  if (seeds.length === 0) return [];

  // 2. Predictor-corrector tangent marching (`t = normalize(grad(phi_A) x grad(phi_B))`) + 2D Newton-Raphson!
  const visitedSeeds = new Uint8Array(seeds.length);
  const outChains: SSICurveChain3D[] = [];

  const markNearbySeedsVisited = (pt: Vec3) => {
    for (let k = 0; k < seeds.length; k++) {
      if (!visitedSeeds[k] && dist3(seeds[k], pt) < STEP_SIZE_MM * 1.35) {
        visitedSeeds[k] = 1;
      }
    }
  };

  const marchFromSeed = (seed: Vec3, dirSign: 1 | -1, stopAt?: Vec3): Vec3[] => {
    const pts: Vec3[] = [];
    let curr = { ...seed };
    let prevTan: Vec3 | null = null;

    for (let step = 0; step < MAX_SSI_STEPS; step++) {
      const g1 = evalPrimitive3DGrad(curr, primA, 5e-4);
      const g2 = evalPrimitive3DGrad(curr, primB, 5e-4);
      const rawTan = cross3(g1, g2);
      const tLen = len3(rawTan);
      if (tLen < 1e-4) break; // Singular / tangent point -> stop branch cleanly so sharp corners (like Steinmetz X-point!) split cleanly

      let tan = scale3(rawTan, dirSign / tLen);
      if (prevTan && dot3(tan, prevTan) < 0) {
        tan = scale3(tan, -1);
      }
      // Stop at sharp kink (> 55 deg turn, e.g. hitting box corner edge or Steinmetz singular crossing!)
      if (prevTan && dot3(tan, prevTan) < 0.55) {
        break;
      }

      const pred = add3(curr, scale3(tan, STEP_SIZE_MM));
      const corr = projectOntoTwoSurfacesNewton(pred, primA, primB, 8);
      if (!corr) break;
      if (
        !isSSIPointActiveOnCSGBoundary(
          corr,
          primA,
          primB,
          kind,
          allPrimitives
        )
      ) {
        // Binary refine exact exit point on boundary!
        let lo = curr;
        let hi = corr;
        for (let b = 0; b < 5; b++) {
          const mid = scale3(add3(lo, hi), 0.5);
          const midProj = projectOntoTwoSurfacesNewton(mid, primA, primB, 5);
          if (
            midProj &&
            isSSIPointActiveOnCSGBoundary(
              midProj,
              primA,
              primB,
              kind,
              allPrimitives
            )
          ) {
            lo = midProj;
          } else {
            hi = mid;
          }
        }
        if (dist3(lo, curr) > 0.05) pts.push(lo);
        break;
      }

      pts.push(corr);
      markNearbySeedsVisited(corr);

      if (stopAt && pts.length >= 4 && dist3(corr, stopAt) < STEP_SIZE_MM * 0.95) {
        pts.push({ ...stopAt });
        break;
      }
      // Prevent self-looping
      if (pts.length >= 6 && dist3(corr, seed) < STEP_SIZE_MM * 0.95) {
        pts.push({ ...seed });
        break;
      }

      prevTan = tan;
      curr = corr;
    }
    return pts;
  };

  for (let sIdx = 0; sIdx < seeds.length; sIdx++) {
    if (visitedSeeds[sIdx]) continue;
    const seed = seeds[sIdx];
    visitedSeeds[sIdx] = 1;

    const fwd = marchFromSeed(seed, 1);
    const closedLoop =
      fwd.length >= 4 && dist3(fwd[fwd.length - 1], seed) < 0.15;

    let fullChain: Vec3[];
    if (closedLoop) {
      fullChain = [seed, ...fwd];
    } else {
      const bwd = marchFromSeed(seed, -1, fwd[fwd.length - 1]);
      fullChain = [...bwd.reverse(), seed, ...fwd];
    }

    if (fullChain.length < 2) continue;
    let arcLen = 0;
    for (let k = 0; k < fullChain.length - 1; k++) {
      arcLen += dist3(fullChain[k], fullChain[k + 1]);
    }
    if (arcLen < 0.8) continue;

    // Deduplicate against already traced chains for this pair
    const midPt = fullChain[Math.floor(fullChain.length / 2)];
    const alreadyCovered = outChains.some((ch) =>
      ch.points.some((q) => dist3(q, midPt) < 0.65)
    );
    if (alreadyCovered) continue;

    outChains.push({
      id: `ssi_${baseIndex + outChains.length}_${primA.id}_${primB.id}`,
      points: fullChain,
      closed: closedLoop,
      interactionKind: kind,
      primAId: primA.id,
      primBId: primB.id,
      featureId:
        kind === 'void_void'
          ? primA.featureId
          : primA.operation === 'subtract'
          ? primA.featureId
          : primB.featureId,
      featureLabel:
        kind === 'void_void'
          ? '内腔交叉孔相贯线'
          : kind === 'solid_void'
          ? '截交/孔口相贯轮廓线'
          : '组合体相贯线',
      forceHidden: false,
    });
  }

  return outChains;
}
