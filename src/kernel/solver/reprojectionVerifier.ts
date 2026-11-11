import { LineType, ViewType } from '../../types/cad';
import {
  CellComplex3D,
  PlanarArrangement2D,
  ReprojectionScore,
  SplitCurveSegment2D,
  Vec2,
} from '../types';
import { arcSweepCCW, pointToLineSegDist } from '../arrangement2d/snapAndSplit';
import { projectPoint3DToView, unprojectViewPointTo3D } from '../lifting3d/surfacePrimitives';

export interface DifferentialRayProbe2D {
  view: ViewType;
  pt: Vec2;
  weight: number;
  expectedType: 'thick_solid' | 'thin_dashed' | 'none';
  // Precomputed cell IDs along parallel sightlines pt - delta*n and pt + delta*n
  // ordered strictly from front-most (closest to eye) to back-most!
  rayMinusCells: Int16Array;
  rayPlusCells: Int16Array;
  // Precomputed flag (1 if two distinct angled 3D boundary surfaces meet across pt at slice i
  // with dihedral turn dot(n_minus, n_plus) < 0.975, e.g. polygonal prism/pyramid/frustum crease!).
  creaseSlices?: Uint8Array;
}

export interface CompiledReprojectionEvaluator {
  probesV1: DifferentialRayProbe2D[];
  probesV2: DifferentialRayProbe2D[];
  evaluate: (occupancy: Uint8Array) => ReprojectionScore;
}

function sampleSegmentProbePoints(seg: SplitCurveSegment2D): {
  pt: Vec2;
  normal: Vec2;
  weight: number;
}[] {
  if (seg.kind === 'arc' && seg.center && seg.radius !== undefined) {
    const sA = seg.startAngle ?? 0;
    const eA = seg.endAngle ?? 0;
    const sweep = arcSweepCCW(sA, eA);
    const totalLen = seg.radius * sweep;
    if (totalLen < 0.6) return [];

    // Sample up to 4 distributed angular probes on full circles / wide arcs so an internal
    // symmetry carrier plane (e.g. X=60) can NEVER leave half of a hole unmonitored!
    const count = Math.max(1, Math.min(4, Math.ceil(sweep / (Math.PI * 0.55))));
    const perWeight = Math.min(totalLen, 56) / count;
    const out: { pt: Vec2; normal: Vec2; weight: number }[] = [];
    for (let k = 0; k < count; k++) {
      const ang = sA + ((k + 0.5) / count) * sweep;
      const nx = Math.cos(ang);
      const ny = Math.sin(ang);
      out.push({
        pt: {
          u: seg.center.u + seg.radius * nx,
          v: seg.center.v + seg.radius * ny,
        },
        normal: { u: nx, v: ny },
        weight: perWeight,
      });
    }
    return out;
  }

  const du = seg.p2.u - seg.p1.u;
  const dv = seg.p2.v - seg.p1.v;
  const len = Math.hypot(du, dv);
  if (len < 0.6) return [];
  const normal = { u: -dv / len, v: du / len };

  if (len >= 28) {
    const w = Math.min(len, 48) * 0.5;
    return [0.27, 0.73].map((t) => ({
      pt: { u: seg.p1.u + t * du, v: seg.p1.v + t * dv },
      normal,
      weight: w,
    }));
  }

  return [
    {
      pt: { u: 0.5 * (seg.p1.u + seg.p2.u), v: 0.5 * (seg.p1.v + seg.p2.v) },
      normal,
      weight: Math.min(len, 40),
    },
  ];
}

function isNearAnyDrawnSegment(
  pt: Vec2,
  segments: SplitCurveSegment2D[],
  tol = 1.35
): LineType | null {
  let bestType: LineType | null = null;
  let bestDist = tol;
  for (const seg of segments) {
    if (seg.lineType !== 'thick_solid' && seg.lineType !== 'thin_dashed') continue;
    if (
      pt.u < seg.bbox.uMin - tol ||
      pt.u > seg.bbox.uMax + tol ||
      pt.v < seg.bbox.vMin - tol ||
      pt.v > seg.bbox.vMax + tol
    ) {
      continue;
    }
    let d: number;
    if (seg.kind === 'arc' && seg.center && seg.radius !== undefined) {
      const dx = pt.u - seg.center.u;
      const dy = pt.v - seg.center.v;
      const r = Math.hypot(dx, dy);
      const ang = Math.atan2(dy, dx);
      const sA = seg.startAngle ?? 0;
      const sweep = arcSweepCCW(sA, seg.endAngle ?? 0);
      let rel = (ang - sA) % (Math.PI * 2);
      if (rel < 0) rel += Math.PI * 2;
      if (rel <= sweep + 0.05 || Math.PI * 2 - rel <= 0.05) {
        d = Math.abs(r - seg.radius);
      } else {
        d = Math.min(
          Math.hypot(pt.u - seg.p1.u, pt.v - seg.p1.v),
          Math.hypot(pt.u - seg.p2.u, pt.v - seg.p2.v)
        );
      }
    } else {
      d = pointToLineSegDist(pt, seg.p1, seg.p2).dist;
    }
    if (d <= bestDist) {
      bestDist = d;
      bestType = seg.lineType;
    }
  }
  return bestType;
}

/**
 * Classifies what kind of 2D projected edge (`'thick_solid' | 'thin_dashed' | 'none'`)
 * a 3D cell occupancy state `occupancy` produces across a differential ray pair `(rayMinus, rayPlus)`.
 */
function classifyDifferentialProbe(
  rayMinus: Int16Array,
  rayPlus: Int16Array,
  occupancy: Uint8Array,
  creaseSlices?: Uint8Array
): 'thick_solid' | 'thin_dashed' | 'none' {
  const n = rayMinus.length;
  let frontMinus = -1;
  let frontPlus = -1;
  let hasHiddenDiff = false;

  for (let i = 0; i < n; i++) {
    const cM = rayMinus[i];
    const cP = rayPlus[i];
    const occM = cM >= 0 ? occupancy[cM] : 0;
    const occP = cP >= 0 ? occupancy[cP] : 0;

    if (frontMinus === -1 && occM === 1) frontMinus = i;
    if (frontPlus === -1 && occP === 1) frontPlus = i;

    if (occM !== occP) {
      // If neither ray has been occluded prior to depth slice `i`, this depth jump is directly visible!
      const occludedOnBothBeforeI =
        frontMinus !== -1 && frontMinus < i && frontPlus !== -1 && frontPlus < i;
      if (!occludedOnBothBeforeI) {
        return 'thick_solid';
      }
      hasHiddenDiff = true;
    } else if (occM === 1 && occP === 1 && creaseSlices && creaseSlices[i] === 1) {
      // True 3D dihedral surface-normal crease edge (e.g. X=60 front apex of a symmetric hexagonal prism,
      // slanted pyramid/frustum edge, or rear/internal hexagonal cavity crease)!
      const occludedOnBothBeforeI =
        frontMinus !== -1 && frontMinus < i && frontPlus !== -1 && frontPlus < i;
      if (!occludedOnBothBeforeI) {
        return 'thick_solid';
      }
      hasHiddenDiff = true;
    }
  }

  // Visible silhouette or step jump when one side hits solid and the other is empty,
  // or when front-most solid depth jumps by >= 1 slice
  if ((frontMinus === -1) !== (frontPlus === -1)) {
    return 'thick_solid';
  }
  if (frontMinus !== -1 && frontPlus !== -1 && Math.abs(frontMinus - frontPlus) >= 1) {
    return 'thick_solid';
  }
  if (hasHiddenDiff) {
    return 'thin_dashed';
  }
  return 'none';
}

/**
 * Compiles an ultra-fast O(Probes) analytical reprojection verifier for a `CellComplex3D`
 * and its two known arrangements `(arr1, arr2)`.
 * Every probe stores precomputed cell ID slices along sightlines, enabling microsecond evaluation
 * inside CSP Branch-and-Bound with zero mesh construction.
 */
export function compileReprojectionEvaluator(
  complex: CellComplex3D,
  arr1: PlanarArrangement2D,
  arr2: PlanarArrangement2D
): CompiledReprojectionEvaluator {
  const vh = complex.visualHullBBox;
  const DEPTH_SLICES = 36;
  const DELTA_PERP = 0.55;

  const sampleRayPair = (
    view: ViewType,
    pt: Vec2,
    normal: Vec2,
    detectSurfaceCreases = false
  ) => {
    const wStart = view === 'front' ? vh.yMax : view === 'top' ? vh.zMax : vh.xMin;
    const wEnd = view === 'front' ? vh.yMin : view === 'top' ? vh.zMin : vh.xMax;
    const stepW = Math.abs(wEnd - wStart) / DEPTH_SLICES;
    const rayMinus = new Int16Array(DEPTH_SLICES);
    const rayPlus = new Int16Array(DEPTH_SLICES);
    const pts3M: { x: number; y: number; z: number }[] = [];
    const pts3P: { x: number; y: number; z: number }[] = [];

    const pMinus2D = { u: pt.u - DELTA_PERP * normal.u, v: pt.v - DELTA_PERP * normal.v };
    const pPlus2D = { u: pt.u + DELTA_PERP * normal.u, v: pt.v + DELTA_PERP * normal.v };

    for (let s = 0; s < DEPTH_SLICES; s++) {
      const w = wStart + ((s + 0.5) / DEPTH_SLICES) * (wEnd - wStart);
      const p3M = unprojectViewPointTo3D(view, pMinus2D.u, pMinus2D.v, w);
      const p3P = unprojectViewPointTo3D(view, pPlus2D.u, pPlus2D.v, w);
      rayMinus[s] = complex.evalPointCellId(p3M);
      rayPlus[s] = complex.evalPointCellId(p3P);
      if (detectSurfaceCreases) {
        pts3M.push(p3M);
        pts3P.push(p3P);
      }
    }

    let creaseSlices: Uint8Array | undefined;
    if (detectSurfaceCreases) {
      creaseSlices = new Uint8Array(DEPTH_SLICES);
      // Candidate 3D boundary surfaces excluding view-orthogonal internal carrier split planes of `view` itself
      const boundarySurfs = complex.surfaces.filter(
        (sf) => !sf.id.startsWith(`carrier_plane_${view}_`)
      );
      const nearTol = Math.max(1.2, stepW * 1.45);

      for (let s = 0; s < DEPTH_SLICES; s++) {
        // Only check boundary entry/exit slices where solid meets exterior (-1) or transitions across a cavity
        const isBoundaryM =
          s === 0 ||
          s === DEPTH_SLICES - 1 ||
          rayMinus[s - 1] !== rayMinus[s] ||
          rayMinus[s + 1] !== rayMinus[s];
        const isBoundaryP =
          s === 0 ||
          s === DEPTH_SLICES - 1 ||
          rayPlus[s - 1] !== rayPlus[s] ||
          rayPlus[s + 1] !== rayPlus[s];
        if (!isBoundaryM && !isBoundaryP) continue;

        const pM = pts3M[s];
        const pP = pts3P[s];
        let bestSurfM: (typeof boundarySurfs)[0] | null = null;
        let bestAbsM = nearTol;
        let bestSurfP: (typeof boundarySurfs)[0] | null = null;
        let bestAbsP = nearTol;

        for (const sf of boundarySurfs) {
          const dM = Math.abs(sf.evalPhi(pM));
          if (dM < bestAbsM) {
            bestAbsM = dM;
            bestSurfM = sf;
          }
          const dP = Math.abs(sf.evalPhi(pP));
          if (dP < bestAbsP) {
            bestAbsP = dP;
            bestSurfP = sf;
          }
        }

        if (bestSurfM && bestSurfP) {
          const gM = bestSurfM.evalGrad(pM);
          const gP = bestSurfP.evalGrad(pP);
          const dot = gM.x * gP.x + gM.y * gP.y + gM.z * gP.z;
          // Dihedral surface-normal turn >= ~12.8 deg (e.g. 60 deg turn on hexagonal prism/pyramid/hole!)
          if (dot < 0.975) {
            creaseSlices[s] = 1;
          }
        }
      }
    }

    return { rayMinus, rayPlus, creaseSlices };
  };

  const buildProbesForArrangement = (arr: PlanarArrangement2D): DifferentialRayProbe2D[] => {
    const probes: DifferentialRayProbe2D[] = [];
    const structuralSegs = arr.splitSegments.filter(
      (s) => s.lineType === 'thick_solid' || s.lineType === 'thin_dashed'
    );

    // 1. Positive Evidence Probes along every user-drawn solid and dashed segment
    for (const seg of structuralSegs) {
      const samples = sampleSegmentProbePoints(seg);
      for (const { pt, normal, weight } of samples) {
        const { rayMinus, rayPlus, creaseSlices } = sampleRayPair(arr.view, pt, normal, true);

        let canDiffer = false;
        for (let i = 0; i < DEPTH_SLICES; i++) {
          if (rayMinus[i] !== rayPlus[i] || (creaseSlices && creaseSlices[i] === 1)) {
            canDiffer = true;
            break;
          }
        }
        if (!canDiffer) continue;

        probes.push({
          view: arr.view,
          pt,
          weight,
          expectedType: seg.lineType === 'thick_solid' ? 'thick_solid' : 'thin_dashed',
          rayMinusCells: rayMinus,
          rayPlusCells: rayPlus,
          creaseSlices,
        });
      }
    }

    // 2. Negative (Phantom-Guard) Probes across internal cell patches that project into blank 2D regions!
    //    Prevents digging phantom through-holes or cutting outer walls where the user drew NO lines,
    //    while NEVER penalizing simplified drawings that omit exterior dihedral crease lines!
    for (const patch of complex.patches) {
      if (patch.cellB === -1) continue; // Exterior hull boundary already aligns with outer silhouette
      if (patch.samplePoints.length === 0) continue;

      const sample3D = patch.samplePoints[0];
      const g3D = patch.surface.evalGrad(sample3D);
      const gProj =
        arr.view === 'front'
          ? { u: g3D.x, v: g3D.z }
          : arr.view === 'top'
            ? { u: g3D.x, v: g3D.y }
            : { u: g3D.y, v: g3D.z };
      const gLen = Math.hypot(gProj.u, gProj.v);
      if (gLen < 0.35) continue; // Patch is nearly parallel to the view plane, not edge-on

      const normal2D = { u: gProj.u / gLen, v: gProj.v / gLen };
      const q = projectPoint3DToView(sample3D, arr.view);
      const pt2D = { u: q.u, v: q.v };

      if (isNearAnyDrawnSegment(pt2D, structuralSegs, 1.5) !== null) continue;

      const { rayMinus, rayPlus } = sampleRayPair(arr.view, pt2D, normal2D, false);
      probes.push({
        view: arr.view,
        pt: pt2D,
        weight: Math.min(25, Math.sqrt(Math.max(1, patch.approxArea)) * 2.2),
        expectedType: 'none',
        rayMinusCells: rayMinus,
        rayPlusCells: rayPlus,
      });
    }

    return probes;
  };

  const probesV1 = buildProbesForArrangement(arr1);
  const probesV2 = buildProbesForArrangement(arr2);

  // Precompute active surface patch list for fast Occam surface complexity scoring
  const patches = complex.patches;

  const evaluate = (occupancy: Uint8Array): ReprojectionScore => {
    // 1. Hard Sightline Coverage Check on outermost solid regions
    let missedSightlines = 0;
    for (const ray of complex.sightlinesV1) {
      if (!ray.mustBeSolid) continue;
      let hit = false;
      for (let i = 0; i < ray.orderedCellIds.length; i++) {
        if (occupancy[ray.orderedCellIds[i]] === 1) {
          hit = true;
          break;
        }
      }
      if (!hit) missedSightlines++;
    }
    for (const ray of complex.sightlinesV2) {
      if (!ray.mustBeSolid) continue;
      let hit = false;
      for (let i = 0; i < ray.orderedCellIds.length; i++) {
        if (occupancy[ray.orderedCellIds[i]] === 1) {
          hit = true;
          break;
        }
      }
      if (!hit) missedSightlines++;
    }

    // 2. Score V1 and V2 positive & phantom differential probes
    let unexplainedLength = 0;
    let phantomLength = 0;
    let lineTypeMismatchLength = 0;

    const evalViewProbes = (probes: DifferentialRayProbe2D[]) => {
      let posTotal = 0;
      let posMatched = 0;
      let genTotal = 0;
      let genValid = 0;

      for (let i = 0; i < probes.length; i++) {
        const pr = probes[i];
        const actual = classifyDifferentialProbe(
          pr.rayMinusCells,
          pr.rayPlusCells,
          occupancy,
          pr.creaseSlices
        );

        if (pr.expectedType === 'none') {
          if (actual !== 'none') {
            phantomLength += pr.weight;
            genTotal += pr.weight;
          }
        } else {
          posTotal += pr.weight;
          if (actual === pr.expectedType) {
            posMatched += pr.weight;
            genTotal += pr.weight;
            genValid += pr.weight;
          } else if (actual !== 'none') {
            // Sealing a visible `thick_solid` opening behind a wall (`actual === 'thin_dashed'`)
            // violates GB/T 4458.1 Visible Opening Law much more severely than exposing a hidden line!
            const penaltyScale = pr.expectedType === 'thick_solid' ? 2.4 : 1.0;
            lineTypeMismatchLength += pr.weight * penaltyScale;
            posMatched += pr.weight * (pr.expectedType === 'thick_solid' ? 0.55 : 0.85);
            genTotal += pr.weight;
            genValid += pr.weight * (pr.expectedType === 'thick_solid' ? 0.55 : 0.85);
          } else {
            unexplainedLength += pr.weight;
          }
        }
      }

      return {
        recall: posTotal > 0 ? posMatched / posTotal : 1,
        precision: genTotal > 0 ? genValid / genTotal : 1,
      };
    };

    const m1 = evalViewProbes(probesV1);
    const m2 = evalViewProbes(probesV2);

    // 3. Active boundary surface complexity (Occam's Razor tie-breaker)
    let surfaceComplexity = 0;
    for (let i = 0; i < patches.length; i++) {
      const pa = patches[i];
      const occA = pa.cellA >= 0 ? occupancy[pa.cellA] : 0;
      const occB = pa.cellB >= 0 ? occupancy[pa.cellB] : 0;
      if (occA !== occB) {
        surfaceComplexity += pa.approxArea;
      }
    }

    const sightlinePenalty = missedSightlines * 250;
    const totalEnergy =
      sightlinePenalty +
      unexplainedLength * 1.2 +
      phantomLength * 1.5 +
      lineTypeMismatchLength * 0.18 +
      surfaceComplexity * 1e-4;

    return {
      totalEnergy,
      unexplainedLength,
      phantomLength,
      lineTypeMismatchLength,
      surfaceComplexity,
      recallV1: m1.recall,
      precisionV1: m1.precision,
      recallV2: m2.recall,
      precisionV2: m2.precision,
      isValidSilhouette: missedSightlines === 0,
    };
  };

  return {
    probesV1,
    probesV2,
    evaluate,
  };
}
