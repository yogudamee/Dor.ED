import { ViewType } from '../../types/cad';
import {
  AnalyticalSurface3D,
  AtomicCell3D,
  BBox3D,
  CandidateVolume3D,
  CellBoundaryPatch3D,
  CellComplex3D,
  LiftedCandidatePool3D,
  PlanarArrangement2D,
  SightlineRay2D,
  Vec2,
  Vec3,
} from '../types';
import {
  clipPolygonByHalfSpace2D,
  ensureCCWPolygon2D,
  triangulateSimplePolygon2D,
} from '../lifting3d/generalizedLoft';
import { evalCurvedRegion2DSDF, projectPoint3DToView, unprojectViewPointTo3D } from '../lifting3d/surfacePrimitives';

const SIGN_EPS = 1e-3;
const MAX_CELLS_GUARD = 256;

/**
 * Checks whether a 2D point `pt` lies inside (or within `tol` of) the outer solid silhouette
 * of a `PlanarArrangement2D`.
 */
export function isPointInArrangementOuterSilhouette(
  pt: Vec2,
  arr: PlanarArrangement2D,
  tol = 0.35
): boolean {
  if (arr.outerSilhouetteLoops.length > 0) {
    for (const loop of arr.outerSilhouetteLoops) {
      if (
        pt.u < loop.bbox.uMin - tol ||
        pt.u > loop.bbox.uMax + tol ||
        pt.v < loop.bbox.vMin - tol ||
        pt.v > loop.bbox.vMax + tol
      ) {
        continue;
      }
      const d = evalCurvedRegion2DSDF(pt, loop.segments, loop.densePolygon);
      if (d <= tol) return true;
    }
    return false;
  }

  // Fallback if no outer silhouette loop was closed: check solidBBox
  const b = arr.solidBBox ?? arr.overallBBox;
  if (!b) return false;
  return (
    pt.u >= b.uMin - tol &&
    pt.u <= b.uMax + tol &&
    pt.v >= b.vMin - tol &&
    pt.v <= b.vMax + tol
  );
}

export function isPointInVisualHull3D(
  p: Vec3,
  arr1: PlanarArrangement2D,
  arr2: PlanarArrangement2D,
  tol = 0.35
): boolean {
  const q1 = projectPoint3DToView(p, arr1.view);
  if (!isPointInArrangementOuterSilhouette({ u: q1.u, v: q1.v }, arr1, tol)) return false;
  const q2 = projectPoint3DToView(p, arr2.view);
  return isPointInArrangementOuterSilhouette({ u: q2.u, v: q2.v }, arr2, tol);
}

interface HalfSpaceSplitter {
  id: string;
  evalPhi: (p: Vec3) => number;
  evalGrad: (p: Vec3) => Vec3;
  surface: AnalyticalSurface3D;
}

function encodeSignVector(vec: Int8Array): string {
  let s = '';
  for (let i = 0; i < vec.length; i++) {
    s += vec[i] < 0 ? '0' : '1';
  }
  return s;
}

/**
 * Constructs a curved-boundary `CellComplex3D` inside the Visual Hull using exact analytical
 * half-space sign vectors `sigma_k in {-1, +1}^M` + Sutherland-Hodgman / Earcut interior
 * witness points and Newton-refined boundary patches (`CellBoundaryPatch3D[]`).
 * Zero polyhedral/AABB approximation is ever applied to polygons, cylinders, spheres, hemispheres, or GeneralizedLofts.
 */
export function buildCurvedCellComplex3D(pool: LiftedCandidatePool3D): CellComplex3D {
  const { visualHullBBox: vh, arr1, arr2, volumes, surfaces } = pool;

  // 1. Assemble canonical splitting functions:
  //    Each CandidateVolume3D acts as an exact curved/polygonal region splitter (SDF < 0 vs > 0),
  //    supplemented by oblique polygon edge half-space planes and internal carrier planes!
  const splitters: HalfSpaceSplitter[] = [];
  for (const vol of volumes) {
    const repSurface: AnalyticalSurface3D = vol.surfaces[0] ?? {
      id: `${vol.id}_sdf`,
      kind: 'generalized_loft',
      label: vol.label,
      sourceViews: pool.knownViews,
      domainBox: vol.bbox,
      associatedPrimitive: vol.primitive,
      evalPhi: vol.evalSDF,
      evalGrad: vol.evalGrad,
    };
    splitters.push({
      id: `vol_${vol.id}`,
      evalPhi: vol.evalSDF,
      evalGrad: vol.evalGrad,
      surface: {
        ...repSurface,
        id: `vol_surf_${vol.id}`,
        associatedPrimitive: vol.primitive,
        evalPhi: vol.evalSDF,
        evalGrad: vol.evalGrad,
      },
    });
  }

  // Include both standalone carrier planes AND oblique polygon edge half-space planes (`_pedge_`),
  // deduplicating equivalent plane equations `(n, d)`!
  const addedPlaneSpecs: { nx: number; ny: number; nz: number; d: number }[] = [];
  for (const surf of surfaces) {
    if (splitters.length >= 56) break;
    if (
      surf.kind === 'plane' &&
      surf.planeParams &&
      (surf.id.startsWith('carrier_plane_') || surf.id.includes('_pedge_'))
    ) {
      const { normal: n, d } = surf.planeParams;
      const dup = addedPlaneSpecs.some(
        (ps) =>
          (Math.abs(ps.nx - n.x) < 1e-2 &&
            Math.abs(ps.ny - n.y) < 1e-2 &&
            Math.abs(ps.nz - n.z) < 1e-2 &&
            Math.abs(ps.d - d) < 0.35) ||
          (Math.abs(ps.nx + n.x) < 1e-2 &&
            Math.abs(ps.ny + n.y) < 1e-2 &&
            Math.abs(ps.nz + n.z) < 1e-2 &&
            Math.abs(ps.d + d) < 0.35)
      );
      if (!dup) {
        addedPlaneSpecs.push({ nx: n.x, ny: n.y, nz: n.z, d });
        splitters.push({
          id: surf.id,
          evalPhi: surf.evalPhi,
          evalGrad: surf.evalGrad,
          surface: surf,
        });
      }
    }
  }

  const M = splitters.length;

  const evalSignVec = (p: Vec3): { vec: Int8Array; minAbsPhi: number; minIdx: number } => {
    const vec = new Int8Array(M);
    let minAbsPhi = Infinity;
    let minIdx = -1;
    for (let m = 0; m < M; m++) {
      const val = splitters[m].evalPhi(p);
      const absV = Math.abs(val);
      if (absV < minAbsPhi) {
        minAbsPhi = absV;
        minIdx = m;
      }
      vec[m] = val < 0 ? -1 : 1;
    }
    return { vec, minAbsPhi, minIdx };
  };

  // 2. Generate dense + Sutherland-Hodgman polygon-clipped interior Witness Points inside Visual Hull
  const candidatePoints: Vec3[] = [];
  const dx = Math.max(1, vh.xMax - vh.xMin);
  const dy = Math.max(1, vh.yMax - vh.yMin);
  const dz = Math.max(1, vh.zMax - vh.zMin);

  const NX = 14;
  const NY = 14;
  const NZ = 14;
  const stepX = dx / NX;
  const stepY = dy / NY;
  const stepZ = dz / NZ;
  const cellVoxelVol = stepX * stepY * stepZ;
  const diagStep = 0.5 * Math.hypot(stepX, stepY, stepZ);

  for (let ix = 0; ix < NX; ix++) {
    const x = vh.xMin + (ix + 0.5) * stepX;
    for (let iy = 0; iy < NY; iy++) {
      const y = vh.yMin + (iy + 0.5) * stepY;
      for (let iz = 0; iz < NZ; iz++) {
        const z = vh.zMin + (iz + 0.5) * stepZ;
        const p = { x, y, z };
        if (!isPointInVisualHull3D(p, arr1, arr2, 0.25)) continue;
        candidatePoints.push(p);

        // Adaptive octree 2x2x2 sub-sampling near curved or oblique planar splitting boundaries
        const { minAbsPhi } = evalSignVec(p);
        if (minAbsPhi < diagStep) {
          for (const sx of [-0.25, 0.25]) {
            for (const sy of [-0.25, 0.25]) {
              for (const sz of [-0.25, 0.25]) {
                const sp = { x: x + sx * stepX, y: y + sy * stepY, z: z + sz * stepZ };
                if (isPointInVisualHull3D(sp, arr1, arr2, 0.2)) {
                  candidatePoints.push(sp);
                }
              }
            }
          }
        }
      }
    }
  }

  // Feature-targeted witness seeds for every CandidateVolume3D & thin annular walls
  for (const vol of volumes) {
    const b = vol.bbox;
    const cx = 0.5 * (b.xMin + b.xMax);
    const cy = 0.5 * (b.yMin + b.yMax);
    const cz = 0.5 * (b.zMin + b.zMax);
    const rx = 0.5 * (b.xMax - b.xMin);
    const ry = 0.5 * (b.yMax - b.yMin);
    const rz = 0.5 * (b.zMax - b.zMin);

    const localFracs = [-0.75, -0.35, 0, 0.35, 0.75];
    for (const fx of localFracs) {
      for (const fy of localFracs) {
        for (const fz of localFracs) {
          const sp = { x: cx + fx * rx, y: cy + fy * ry, z: cz + fz * rz };
          if (isPointInVisualHull3D(sp, arr1, arr2, 0.2)) {
            candidatePoints.push(sp);
          }
        }
      }
    }
  }

  // Inject exact interior centroids of Sutherland-Hodgman half-space-split polygons & ear-clipped
  // triangles for every 2D face and polygonal region (guarantees witnesses lie strictly inside
  // oblique triangle wedges and NEVER on a rectangle diagonal where SDF = 0!)
  const addClippedPolygonInteriorSeeds = (arr: PlanarArrangement2D) => {
    const wMin = arr.view === 'front' ? vh.yMin : arr.view === 'top' ? vh.zMin : vh.xMin;
    const wMax = arr.view === 'front' ? vh.yMax : arr.view === 'top' ? vh.zMax : vh.xMax;

    // Collect internal carrier lines in this view to recursively split polygons via Sutherland-Hodgman
    const viewSplitLines = arr.carrierLines.filter((cl) => cl.hasSolid || cl.hasDashed);

    const push2DSeedAlongRay = (u: number, v: number) => {
      for (let k = 1; k < 10; k++) {
        const w = wMin + (k / 10) * (wMax - wMin);
        const p = unprojectViewPointTo3D(arr.view, u, v, w);
        if (isPointInVisualHull3D(p, arr1, arr2, 0.2)) {
          candidatePoints.push(p);
        }
      }
    };

    for (const face of arr.atomicFaces) {
      push2DSeedAlongRay(face.interiorSample.u, face.interiorSample.v);
      const ccw = ensureCCWPolygon2D(face.densePolygon);
      if (ccw.length >= 3 && ccw.length <= 24) {
        const tris = triangulateSimplePolygon2D(ccw);
        for (const [ia, ib, ic] of tris) {
          const tu = (ccw[ia].u + ccw[ib].u + ccw[ic].u) / 3;
          const tv = (ccw[ia].v + ccw[ib].v + ccw[ic].v) / 3;
          push2DSeedAlongRay(tu, tv);
        }
      }
    }

    // Also clip outer polygon regions against orthogonal carrier lines from the OTHER view (shared-axis splits!)
    for (const reg of arr.regions) {
      if (reg.shapeKind !== 'polygon' && reg.shapeKind !== 'triangle' && reg.shapeKind !== 'trapezoid') {
        continue;
      }
      let pieces: Vec2[][] = [ensureCCWPolygon2D(reg.densePolygon)];
      for (const cl of viewSplitLines.slice(0, 8)) {
        const nextPieces: Vec2[][] = [];
        const dLine = -(cl.normal.u * cl.origin.u + cl.normal.v * cl.origin.v);
        for (const poly of pieces) {
          const left = clipPolygonByHalfSpace2D(poly, cl.normal.u, cl.normal.v, dLine);
          const right = clipPolygonByHalfSpace2D(poly, -cl.normal.u, -cl.normal.v, -dLine);
          if (left.length >= 3) nextPieces.push(left);
          if (right.length >= 3) nextPieces.push(right);
        }
        if (nextPieces.length > 0 && nextPieces.length <= 32) {
          pieces = nextPieces;
        }
      }
      for (const subPoly of pieces) {
        if (subPoly.length < 3) continue;
        const cu = subPoly.reduce((s, pt) => s + pt.u, 0) / subPoly.length;
        const cv = subPoly.reduce((s, pt) => s + pt.v, 0) / subPoly.length;
        push2DSeedAlongRay(cu, cv);
      }
    }
  };
  addClippedPolygonInteriorSeeds(arr1);
  addClippedPolygonInteriorSeeds(arr2);

  // 3. Group Witness Points into exact Sign-Vector Atomic Cells
  const cellMap = new Map<
    string,
    {
      signVector: Int8Array;
      witnesses: Vec3[];
      sumX: number;
      sumY: number;
      sumZ: number;
      bbox: BBox3D;
    }
  >();

  for (let p of candidatePoints) {
    let { vec, minAbsPhi, minIdx } = evalSignVec(p);
    // Nudge off exact splitting surface if within SIGN_EPS
    if (minAbsPhi < SIGN_EPS && minIdx >= 0) {
      const g = splitters[minIdx].evalGrad(p);
      const nudged = { x: p.x + g.x * 0.02, y: p.y + g.y * 0.02, z: p.z + g.z * 0.02 };
      if (isPointInVisualHull3D(nudged, arr1, arr2, 0.2)) {
        p = nudged;
        ({ vec, minAbsPhi } = evalSignVec(p));
      }
    }
    if (minAbsPhi < 1e-4) continue;

    const key = encodeSignVector(vec);
    let entry = cellMap.get(key);
    if (!entry) {
      if (cellMap.size >= MAX_CELLS_GUARD) continue;
      entry = {
        signVector: vec,
        witnesses: [p],
        sumX: p.x,
        sumY: p.y,
        sumZ: p.z,
        bbox: {
          xMin: p.x,
          xMax: p.x,
          yMin: p.y,
          yMax: p.y,
          zMin: p.z,
          zMax: p.z,
        },
      };
      cellMap.set(key, entry);
    } else {
      if (entry.witnesses.length < 24) {
        entry.witnesses.push(p);
      }
      entry.sumX += p.x;
      entry.sumY += p.y;
      entry.sumZ += p.z;
      if (p.x < entry.bbox.xMin) entry.bbox.xMin = p.x;
      if (p.x > entry.bbox.xMax) entry.bbox.xMax = p.x;
      if (p.y < entry.bbox.yMin) entry.bbox.yMin = p.y;
      if (p.y > entry.bbox.yMax) entry.bbox.yMax = p.y;
      if (p.z < entry.bbox.zMin) entry.bbox.zMin = p.z;
      if (p.z > entry.bbox.zMax) entry.bbox.zMax = p.z;
    }
  }

  // Fallback if Visual Hull had zero witnesses (e.g. degenerate thin drawing)
  if (cellMap.size === 0) {
    const center = {
      x: 0.5 * (vh.xMin + vh.xMax),
      y: 0.5 * (vh.yMin + vh.yMax),
      z: 0.5 * (vh.zMin + vh.zMax),
    };
    const { vec } = evalSignVec(center);
    cellMap.set(encodeSignVector(vec), {
      signVector: vec,
      witnesses: [center],
      sumX: center.x,
      sumY: center.y,
      sumZ: center.z,
      bbox: { ...vh },
    });
  }

  const cells: AtomicCell3D[] = [];
  const signKeyToCellId = new Map<string, number>();

  let cellIdx = 0;
  for (const [signKey, entry] of cellMap.entries()) {
    const count = Math.max(1, entry.witnesses.length);
    const centroid =
      entry.witnesses.find((w) => {
        const { vec } = evalSignVec(w);
        return encodeSignVector(vec) === signKey;
      }) ?? entry.witnesses[0];

    const coveringVolumeIds: string[] = [];
    const voidHintVolumeIds: string[] = [];
    let hasGuaranteedVoid = false;

    for (let vIdx = 0; vIdx < volumes.length; vIdx++) {
      if (entry.signVector[vIdx] < 0) {
        const vol = volumes[vIdx];
        if (vol.roleHint === 'cavity_Candidate' || vol.primitive.operation === 'subtract') {
          voidHintVolumeIds.push(vol.id);
          if (vol.isGuaranteedVoid) hasGuaranteedVoid = true;
        } else {
          coveringVolumeIds.push(vol.id);
        }
      }
    }

    const poolHasAnySolidVolume = volumes.some(
      (v) => v.roleHint !== 'cavity_Candidate' && v.primitive.operation !== 'subtract'
    );
    const isUncoveredHullCorner = poolHasAnySolidVolume && coveringVolumeIds.length === 0;

    cells.push({
      id: cellIdx,
      signKey,
      signVector: entry.signVector,
      witnessPoints: entry.witnesses,
      centroid,
      approxVolume: count * (cellVoxelVol * 0.25),
      bbox: entry.bbox,
      inVisualHull: true,
      fixedState: hasGuaranteedVoid || isUncoveredHullCorner ? 0 : -1,
      coveringVolumeIds,
      voidHintVolumeIds,
    });
    signKeyToCellId.set(signKey, cellIdx);
    cellIdx++;
  }

  // Fast O(M) point-to-cell lookup function:
  // Checks exact Visual Hull membership + Sign Vector hash (with nearest-Hamming fallback inside hull)
  const evalPointCellId = (p: Vec3): number => {
    if (
      p.x < vh.xMin - 0.35 ||
      p.x > vh.xMax + 0.35 ||
      p.y < vh.yMin - 0.35 ||
      p.y > vh.yMax + 0.35 ||
      p.z < vh.zMin - 0.35 ||
      p.z > vh.zMax + 0.35
    ) {
      return -1;
    }
    if (!isPointInVisualHull3D(p, arr1, arr2, 0.3)) return -1;

    const { vec } = evalSignVec(p);
    const key = encodeSignVector(vec);
    const exact = signKeyToCellId.get(key);
    if (exact !== undefined) return exact;

    // Nearest cell by Hamming distance on signVector + Euclidean proximity
    let bestId = -1;
    let bestScore = Infinity;
    for (let i = 0; i < cells.length; i++) {
      const sv = cells[i].signVector;
      let diff = 0;
      for (let m = 0; m < M; m++) {
        if (sv[m] !== vec[m]) diff++;
      }
      const c = cells[i].centroid;
      const dist = Math.hypot(p.x - c.x, p.y - c.y, p.z - c.z) * 0.01;
      const score = diff + dist;
      if (score < bestScore) {
        bestScore = score;
        bestId = i;
      }
    }
    return bestId;
  };

  // 4. Extract CellBoundaryPatch3D adjacency graph (including exterior boundary cellB = -1)
  const patchMap = new Map<
    string,
    {
      cellA: number;
      cellB: number;
      surface: AnalyticalSurface3D;
      samples: Vec3[];
      count: number;
    }
  >();

  const probeDirs: Vec3[] = [
    { x: stepX, y: 0, z: 0 },
    { x: -stepX, y: 0, z: 0 },
    { x: 0, y: stepY, z: 0 },
    { x: 0, y: -stepY, z: 0 },
    { x: 0, y: 0, z: stepZ },
    { x: 0, y: 0, z: -stepZ },
  ];
  const patchUnitArea = 0.33 * (stepX * stepY + stepY * stepZ + stepX * stepZ);

  for (const cell of cells) {
    for (const wPt of cell.witnessPoints) {
      for (const d of probeDirs) {
        const nbPt = { x: wPt.x + d.x, y: wPt.y + d.y, z: wPt.z + d.z };
        const nbId = evalPointCellId(nbPt);
        if (nbId === cell.id) continue;

        const a = nbId === -1 ? cell.id : Math.min(cell.id, nbId);
        const b = nbId === -1 ? -1 : Math.max(cell.id, nbId);

        // Identify the primary splitting surface separating wPt and nbPt
        let bestSplitter: HalfSpaceSplitter | null = null;
        let bestCrossScore = Infinity;
        for (let m = 0; m < M; m++) {
          const phi1 = splitters[m].evalPhi(wPt);
          const phi2 = splitters[m].evalPhi(nbPt);
          if ((phi1 < 0 && phi2 >= 0) || (phi1 >= 0 && phi2 < 0)) {
            const absSum = Math.abs(phi1) + Math.abs(phi2);
            if (absSum < bestCrossScore) {
              bestCrossScore = absSum;
              bestSplitter = splitters[m];
            }
          }
        }
        const surf: AnalyticalSurface3D =
          bestSplitter?.surface ??
          surfaces[0] ?? {
            id: 'hull_boundary',
            kind: 'plane',
            label: '外包络边界',
            sourceViews: pool.knownViews,
            domainBox: vh,
            evalPhi: () => 0,
            evalGrad: () => ({ x: 0, y: 0, z: 1 }),
          };

        // Refine midpoint onto phi(p) = 0 using 3 Newton steps
        let mid = {
          x: 0.5 * (wPt.x + nbPt.x),
          y: 0.5 * (wPt.y + nbPt.y),
          z: 0.5 * (wPt.z + nbPt.z),
        };
        if (bestSplitter) {
          for (let it = 0; it < 3; it++) {
            const f = bestSplitter.evalPhi(mid);
            if (Math.abs(f) < 1e-4) break;
            const g = bestSplitter.evalGrad(mid);
            mid = {
              x: mid.x - f * g.x,
              y: mid.y - f * g.y,
              z: mid.z - f * g.z,
            };
          }
        }

        const pKey = `${a}_${b}_${surf.id}`;
        const existing = patchMap.get(pKey);
        if (!existing) {
          patchMap.set(pKey, {
            cellA: a,
            cellB: b,
            surface: surf,
            samples: [mid],
            count: 1,
          });
        } else {
          existing.count++;
          if (existing.samples.length < 16) existing.samples.push(mid);
        }
      }
    }
  }

  const patches: CellBoundaryPatch3D[] = [];
  for (const [pKey, item] of patchMap.entries()) {
    patches.push({
      id: `patch_${pKey}`,
      cellA: item.cellA,
      cellB: item.cellB,
      surfaceId: item.surface.id,
      surface: item.surface,
      samplePoints: item.samples,
      approxArea: item.count * patchUnitArea * 0.5,
    });
  }

  // 5. Build Precomputed Sightline Rays for V1 and V2 from `solidAtomicFaces` (`solidDCEL`)
  //    so dashed hidden lines never invert `nestingDepth` of inner through-holes into `mustBeSolid = true`!
  const buildViewSightlines = (arr: PlanarArrangement2D): SightlineRay2D[] => {
    const rays: SightlineRay2D[] = [];
    const view: ViewType = arr.view;
    const wStart = view === 'front' ? vh.yMax : view === 'top' ? vh.zMax : vh.xMin;
    const wEnd = view === 'front' ? vh.yMin : view === 'top' ? vh.zMin : vh.xMax;
    const STEPS = 32;

    const sourceFaces = arr.solidAtomicFaces.length > 0 ? arr.solidAtomicFaces : arr.atomicFaces;
    for (const face of sourceFaces) {
      const orderedCellIds: number[] = [];
      for (let s = 0; s <= STEPS; s++) {
        const w = wStart + (s / STEPS) * (wEnd - wStart);
        const p3D = unprojectViewPointTo3D(view, face.interiorSample.u, face.interiorSample.v, w);
        const cid = evalPointCellId(p3D);
        if (cid >= 0 && (orderedCellIds.length === 0 || orderedCellIds[orderedCellIds.length - 1] !== cid)) {
          orderedCellIds.push(cid);
        }
      }

      if (orderedCellIds.length > 0) {
        const allGuaranteedVoid = orderedCellIds.every((cid) => cells[cid].fixedState === 0);
        const anyVoidHint = orderedCellIds.every((cid) => cells[cid].voidHintVolumeIds.length > 0);
        const mustBeSolid =
          face.nestingDepth === 0 &&
          face.allSolidBoundary &&
          !allGuaranteedVoid &&
          !anyVoidHint;
        rays.push({
          view,
          pt2D: face.interiorSample,
          mustBeSolid,
          mustBeEmpty: false,
          orderedCellIds,
        });
      }
    }
    return rays;
  };

  const sightlinesV1 = buildViewSightlines(arr1);
  const sightlinesV2 = buildViewSightlines(arr2);

  return {
    visualHullBBox: vh,
    surfaces,
    volumes,
    cells,
    patches,
    sightlinesV1,
    sightlinesV2,
    evalPointCellId,
  };
}
