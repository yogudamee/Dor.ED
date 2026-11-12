import { Point2D, Primitive3D, ViewType } from '../../types/cad';
import { pointInPolygonExact } from '../arrangement2d/dcelFaces';
import {
  add3,
  composeFromAxis,
  computeEyeDistance,
  decomposeByAxis,
  dot3,
  getSharedAxisBetweenViews,
  getViewAxisSpec,
  normalize3,
  projectPoint3DToView,
  scale3,
  sub3,
  unprojectViewPointTo3D,
} from '../core/coordSystem';
import {
  Axis3D,
  BoundingBox3D,
  LineCarrier2D,
  ReprojectionVerificationReport,
  Vec3,
  ViewArrangementResult,
} from '../core/types';
import {
  computePrimitiveBounds3D,
  evalCSGSolidSDF,
  evalPositiveBaseOnlySDF,
  evalPrimitive3DSDF,
} from '../lifting3d/analyticSurfaces';
import { verifyReprojectionFiniteIntervals } from './finiteReprojectionVerifier';
import { coalesceSolidPrimitives } from './volumeCoalescer';

const EXTERIOR_AIR_EXT_MM = 1.5;
const MAX_CUTTING_PLANES = 10;
const MAX_LEAF_CANDIDATES = 48;

export interface CuttingPlane3D {
  id: string;
  /** Canonical unit normal (first non-zero component > 0) */
  n: Vec3;
  /** Signed offset `n · p = d` */
  d: number;
  axisAlignedAxis: Axis3D | null;
  extrudeAxis: Axis3D | null;
  evidenceWeight: number;
  sources: {
    view: ViewType;
    carrier: LineCarrier2D;
    /** +1 if carrier 2D normal matches `n`, -1 if flipped */
    signFlip: 1 | -1;
  }[];
}

interface CurvedSubCell3D {
  index: number;
  signs: Int8Array;
  samplePoints: Vec3[];
  bounds: BoundingBox3D;
}

interface SightColumnHit {
  cellIndex: number;
  eyeDist: number;
  point3D: Vec3;
}

interface StepJumpConstraint {
  kind: 'dashed_step' | 'solid_step' | 'smooth_continuity';
  colMinus: SightColumnHit[];
  colPlus: SightColumnHit[];
  frontSurfaceSmooth: boolean;
  weight: number;
}

export interface PeripheralTruncationResult {
  accepted: boolean;
  primitives: Primitive3D[];
  verification: ReprojectionVerificationReport;
  subCellCount: number;
  removedCellCount: number;
}

function canonicalizePlane(rawN: Vec3, rawD: number): { n: Vec3; d: number; signFlip: 1 | -1 } {
  const unit = normalize3(rawN);
  let flip: 1 | -1 = 1;
  if (Math.abs(unit.x) > 1e-4) {
    if (unit.x < 0) flip = -1;
  } else if (Math.abs(unit.y) > 1e-4) {
    if (unit.y < 0) flip = -1;
  } else if (unit.z < 0) {
    flip = -1;
  }
  return {
    n: flip === 1 ? unit : scale3(unit, -1),
    d: rawD * flip,
    signFlip: flip,
  };
}

function detectAxisAligned(n: Vec3): Axis3D | null {
  if (Math.abs(n.x) > 0.9995) return 'X';
  if (Math.abs(n.y) > 0.9995) return 'Y';
  if (Math.abs(n.z) > 0.9995) return 'Z';
  return null;
}

function computeBasePositiveBounds(primitives: Primitive3D[]): BoundingBox3D | null {
  let xMin = Infinity;
  let xMax = -Infinity;
  let yMin = Infinity;
  let yMax = -Infinity;
  let zMin = Infinity;
  let zMax = -Infinity;
  let count = 0;
  for (const p of primitives) {
    if (p.operation === 'subtract') continue;
    const b = computePrimitiveBounds3D(p);
    xMin = Math.min(xMin, b.xMin);
    xMax = Math.max(xMax, b.xMax);
    yMin = Math.min(yMin, b.yMin);
    yMax = Math.max(yMax, b.yMax);
    zMin = Math.min(zMin, b.zMin);
    zMax = Math.max(zMax, b.zMax);
    count++;
  }
  return count > 0 ? { xMin, xMax, yMin, yMax, zMin, zMax } : null;
}

function evalCSGSolidGrad(p: Vec3, primitives: Primitive3D[], h = 0.02): Vec3 {
  const dx =
    evalCSGSolidSDF({ x: p.x + h, y: p.y, z: p.z }, primitives) -
    evalCSGSolidSDF({ x: p.x - h, y: p.y, z: p.z }, primitives);
  const dy =
    evalCSGSolidSDF({ x: p.x, y: p.y + h, z: p.z }, primitives) -
    evalCSGSolidSDF({ x: p.x, y: p.y - h, z: p.z }, primitives);
  const dz =
    evalCSGSolidSDF({ x: p.x, y: p.y, z: p.z + h }, primitives) -
    evalCSGSolidSDF({ x: p.x, y: p.y, z: p.z - h }, primitives);
  return normalize3({ x: dx, y: dy, z: dz });
}

function isPureExistingVoidWallCarrier(
  lc: LineCarrier2D,
  view: ViewType,
  existingVoids: Primitive3D[]
): boolean {
  if (lc.hasSolid || !lc.hasDashed) return false;
  if (!lc.isHorizontal && !lc.isVertical) return false;
  const cVal = lc.coordConst;
  if (cVal === undefined) return false;

  for (const vp of existingVoids) {
    const vb = computePrimitiveBounds3D(vp);
    const { uAxis, vAxis } = getViewAxisSpec(view);
    if (lc.isVertical) {
      const lo = uAxis === 'X' ? vb.xMin : uAxis === 'Y' ? vb.yMin : vb.zMin;
      const hi = uAxis === 'X' ? vb.xMax : uAxis === 'Y' ? vb.yMax : vb.zMax;
      if (Math.abs(cVal - lo) <= 0.65 || Math.abs(cVal - hi) <= 0.65) return true;
    } else if (lc.isHorizontal) {
      const lo = vAxis === 'X' ? vb.xMin : vAxis === 'Y' ? vb.yMin : vb.zMin;
      const hi = vAxis === 'X' ? vb.xMax : vAxis === 'Y' ? vb.yMax : vb.zMax;
      if (Math.abs(cVal - lo) <= 0.65 || Math.abs(cVal - hi) <= 0.65) return true;
    }
  }
  return false;
}

/**
 * Shared-Axis Edge-On Duality Theorem:
 * Between known views V1(U, F1) and V2(U, F2) sharing coordinate axis U:
 * - Any interior cutting carrier NOT perpendicular to U (i.e. parallel to U or oblique, cutting F1 or F2)
 *   projects edge-on only in its own view and lifts directly to a 3D cutting plane.
 * - Any interior carrier perpendicular to U (`U = u0`) is a true 3D cutting plane `U = u0` IF AND ONLY IF
 *   the conjugate view ALSO contains a line carrier perpendicular to U at `U ≈ u0` (`<= 0.85mm`).
 *   Otherwise it is a Plane-Quadric SSI generator/chord witness (e.g. X=32.5, 44, 76, 87.5) and MUST NOT lift!
 */
function extractInteriorCuttingPlanes3D(
  arr1: ViewArrangementResult,
  arr2: ViewArrangementResult,
  baseBounds: BoundingBox3D,
  existingVoids: Primitive3D[]
): CuttingPlane3D[] {
  const shared = getSharedAxisBetweenViews(arr1.view, arr2.view);
  const rawPlanes: CuttingPlane3D[] = [];

  const getSharedPerpCoord = (lc: LineCarrier2D, coord: 'u' | 'v'): number | null => {
    if (coord === 'u' && lc.isVertical && lc.coordConst !== undefined) {
      return lc.coordConst;
    }
    if (coord === 'v' && lc.isHorizontal && lc.coordConst !== undefined) {
      return lc.coordConst;
    }
    return null;
  };

  const hasDualSharedCarrier = (
    otherArr: ViewArrangementResult,
    otherCoord: 'u' | 'v',
    targetU: number
  ): boolean => {
    for (const olc of otherArr.lineCarriers) {
      if (!olc.hasSolid && !olc.hasDashed) continue;
      const uVal = getSharedPerpCoord(olc, otherCoord);
      if (uVal !== null && Math.abs(uVal - targetU) <= 0.85) {
        return true;
      }
    }
    return false;
  };

  const collectFromView = (
    arr: ViewArrangementResult,
    selfCoord: 'u' | 'v',
    otherArr: ViewArrangementResult,
    otherCoord: 'u' | 'v'
  ) => {
    const spec = getViewAxisSpec(arr.view);
    const vBounds = arr.bounds;
    if (!vBounds) return;

    const uMinB =
      spec.uAxis === 'X' ? baseBounds.xMin : spec.uAxis === 'Y' ? baseBounds.yMin : baseBounds.zMin;
    const uMaxB =
      spec.uAxis === 'X' ? baseBounds.xMax : spec.uAxis === 'Y' ? baseBounds.yMax : baseBounds.zMax;
    const vMinB =
      spec.vAxis === 'X' ? baseBounds.xMin : spec.vAxis === 'Y' ? baseBounds.yMin : baseBounds.zMin;
    const vMaxB =
      spec.vAxis === 'X' ? baseBounds.xMax : spec.vAxis === 'Y' ? baseBounds.yMax : baseBounds.zMax;

    for (const lc of arr.lineCarriers) {
      if (!lc.hasSolid && !lc.hasDashed) continue;

      // Skip outer silhouette borders of the smooth base
      if (lc.isVertical && lc.coordConst !== undefined) {
        if (lc.coordConst <= uMinB + 0.65 || lc.coordConst >= uMaxB - 0.65) continue;
      }
      if (lc.isHorizontal && lc.coordConst !== undefined) {
        if (lc.coordConst <= vMinB + 0.65 || lc.coordConst >= vMaxB - 0.65) continue;
      }

      // Skip pure dashed carriers already accounted for by active internal void bores/slots
      if (isPureExistingVoidWallCarrier(lc, arr.view, existingVoids)) {
        continue;
      }

      // Shared-Axis Edge-On Duality Filter!
      const sharedU = getSharedPerpCoord(lc, selfCoord);
      if (sharedU !== null) {
        if (!hasDualSharedCarrier(otherArr, otherCoord, sharedU)) {
          continue;
        }
      }

      // Lift 2D carrier normal `(nu, nv)` + signed offset `origin · normal` into 3D engineering space
      const lcOffset = lc.origin.u * lc.normal.u + lc.origin.v * lc.normal.v;
      const n3 = unprojectViewPointTo3D(arr.view, lc.normal.u, lc.normal.v, 0);
      const canon = canonicalizePlane(n3, lcOffset);

      // Verify the plane strictly slices the interior of `baseBounds`
      let minVal = Infinity;
      let maxVal = -Infinity;
      for (const x of [baseBounds.xMin, baseBounds.xMax]) {
        for (const y of [baseBounds.yMin, baseBounds.yMax]) {
          for (const z of [baseBounds.zMin, baseBounds.zMax]) {
            const val = canon.n.x * x + canon.n.y * y + canon.n.z * z - canon.d;
            if (val < minVal) minVal = val;
            if (val > maxVal) maxVal = val;
          }
        }
      }
      if (minVal >= -0.65 || maxVal <= 0.65) continue;

      let evidenceLen = 0;
      for (const iv of lc.solidIntervals) evidenceLen += iv.s1 - iv.s0;
      for (const iv of lc.dashedIntervals) evidenceLen += (iv.s1 - iv.s0) * 0.9;
      if (evidenceLen < 1.5) continue;

      const existing = rawPlanes.find(
        (pl) =>
          dot3(pl.n, canon.n) >= Math.cos((1.0 * Math.PI) / 180) &&
          Math.abs(pl.d - canon.d) <= 0.85
      );
      if (existing) {
        existing.evidenceWeight += evidenceLen;
        existing.sources.push({
          view: arr.view,
          carrier: lc,
          signFlip: canon.signFlip,
        });
      } else {
        const axAligned = detectAxisAligned(canon.n);
        rawPlanes.push({
          id: `cutplane_${rawPlanes.length}`,
          n: canon.n,
          d: canon.d,
          axisAlignedAxis: axAligned,
          extrudeAxis: axAligned ? null : spec.wAxis,
          evidenceWeight: evidenceLen,
          sources: [
            {
              view: arr.view,
              carrier: lc,
              signFlip: canon.signFlip,
            },
          ],
        });
      }
    }
  };

  collectFromView(arr1, shared.v1Coord, arr2, shared.v2Coord);
  collectFromView(arr2, shared.v2Coord, arr1, shared.v1Coord);

  rawPlanes.sort((a, b) => b.evidenceWeight - a.evidenceWeight);
  return rawPlanes.slice(0, MAX_CUTTING_PLANES);
}

function buildPlaneAwareSamples1D(minV: number, maxV: number, cuts: number[]): number[] {
  const sorted = [minV, ...cuts.filter((c) => c > minV + 0.4 && c < maxV - 0.4), maxV].sort(
    (a, b) => a - b
  );
  const uniq: number[] = [];
  for (const v of sorted) {
    if (uniq.length === 0 || v - uniq[uniq.length - 1] > 0.35) uniq.push(v);
  }
  const samples: number[] = [];
  for (let i = 0; i < uniq.length - 1; i++) {
    const a = uniq[i];
    const b = uniq[i + 1];
    const span = b - a;
    if (span < 0.45) continue;
    if (span <= 10.0) {
      samples.push(a + 0.25 * span, a + 0.5 * span, a + 0.75 * span);
    } else {
      const steps = Math.min(7, Math.max(3, Math.ceil(span / 5.0)));
      for (let k = 0; k < steps; k++) {
        samples.push(a + ((k + 0.5) / steps) * span);
      }
    }
  }
  return samples;
}

function buildCurvedAnalyticSubCells(
  basePrims: Primitive3D[],
  baseBounds: BoundingBox3D,
  planes: CuttingPlane3D[]
): CurvedSubCell3D[] {
  const xCuts = planes.filter((p) => p.axisAlignedAxis === 'X').map((p) => p.d);
  const yCuts = planes.filter((p) => p.axisAlignedAxis === 'Y').map((p) => p.d);
  const zCuts = planes.filter((p) => p.axisAlignedAxis === 'Z').map((p) => p.d);

  const xs = buildPlaneAwareSamples1D(baseBounds.xMin, baseBounds.xMax, xCuts);
  const ys = buildPlaneAwareSamples1D(baseBounds.yMin, baseBounds.yMax, yCuts);
  const zs = buildPlaneAwareSamples1D(baseBounds.zMin, baseBounds.zMax, zCuts);

  const cellMap = new Map<
    string,
    { signs: Int8Array; points: Vec3[]; bounds: BoundingBox3D }
  >();

  const registerSample = (pt: Vec3) => {
    if (evalCSGSolidSDF(pt, basePrims) > -0.15) return;
    const signs = new Int8Array(planes.length);
    let key = '';
    for (let m = 0; m < planes.length; m++) {
      const sd = dot3(planes[m].n, pt) - planes[m].d;
      if (Math.abs(sd) < 0.1) return;
      const sg = sd > 0 ? 1 : -1;
      signs[m] = sg;
      key += sg > 0 ? '1' : '0';
    }
    let entry = cellMap.get(key);
    if (!entry) {
      entry = {
        signs,
        points: [pt],
        bounds: {
          xMin: pt.x,
          xMax: pt.x,
          yMin: pt.y,
          yMax: pt.y,
          zMin: pt.z,
          zMax: pt.z,
        },
      };
      cellMap.set(key, entry);
    } else {
      entry.bounds.xMin = Math.min(entry.bounds.xMin, pt.x);
      entry.bounds.xMax = Math.max(entry.bounds.xMax, pt.x);
      entry.bounds.yMin = Math.min(entry.bounds.yMin, pt.y);
      entry.bounds.yMax = Math.max(entry.bounds.yMax, pt.y);
      entry.bounds.zMin = Math.min(entry.bounds.zMin, pt.z);
      entry.bounds.zMax = Math.max(entry.bounds.zMax, pt.z);
      if (entry.points.length < 28) {
        entry.points.push(pt);
      }
    }
  };

  // 1. Plane-partitioned 3D Cartesian lattice
  for (const x of xs) {
    for (const y of ys) {
      for (const z of zs) {
        registerSample({ x, y, z });
      }
    }
  }

  // 2. Polar cylindrical / conical boundary-hugging rings (captures narrow circular lunes!)
  for (const pr of basePrims) {
    if (pr.operation === 'subtract') continue;
    if (pr.shape.startsWith('cylinder_') || pr.shape.startsWith('cone_')) {
      const ax: Axis3D = pr.shape.endsWith('_x')
        ? 'X'
        : pr.shape.endsWith('_y')
        ? 'Y'
        : 'Z';
      const cu =
        ax === 'Z'
          ? pr.centerX ?? 0.5 * (pr.xMin + pr.xMax)
          : ax === 'Y'
          ? pr.centerX ?? 0.5 * (pr.xMin + pr.xMax)
          : pr.centerY ?? 0.5 * (pr.yMin + pr.yMax);
      const cv =
        ax === 'Z'
          ? pr.centerY ?? 0.5 * (pr.yMin + pr.yMax)
          : ax === 'Y'
          ? pr.centerZ ?? 0.5 * (pr.zMin + pr.zMax)
          : pr.centerZ ?? 0.5 * (pr.zMin + pr.zMax);
      const R =
        pr.radius ??
        Math.max(pr.rMin ?? 0, pr.rMax ?? 0, 0.5 * (pr.xMax - pr.xMin));
      const wSamples = ax === 'X' ? xs : ax === 'Y' ? ys : zs;
      const rFracs = [0.3, 0.58, 0.78, 0.9, 0.965];
      for (const w of wSamples) {
        for (const rf of rFracs) {
          const r = R * rf;
          for (let k = 0; k < 36; k++) {
            const ang = (k / 36) * Math.PI * 2;
            registerSample(
              composeFromAxis(ax, cu + r * Math.cos(ang), cv + r * Math.sin(ang), w)
            );
          }
        }
      }
    }
  }

  const cells: CurvedSubCell3D[] = [];
  for (const entry of cellMap.values()) {
    cells.push({
      index: cells.length,
      signs: entry.signs,
      samplePoints: entry.points,
      bounds: entry.bounds,
    });
  }
  return cells;
}

function findSubCellForPoint3D(
  p: Vec3,
  planes: CuttingPlane3D[],
  signToCellIndex: Map<string, number>
): number {
  let key = '';
  for (let m = 0; m < planes.length; m++) {
    const sd = dot3(planes[m].n, p) - planes[m].d;
    key += sd >= 0 ? '1' : '0';
  }
  return signToCellIndex.get(key) ?? -1;
}

function buildSightColumn(
  view: ViewType,
  u: number,
  v: number,
  baseBounds: BoundingBox3D,
  basePrims: Primitive3D[],
  planes: CuttingPlane3D[],
  signToCellIndex: Map<string, number>
): SightColumnHit[] {
  const spec = getViewAxisSpec(view);
  const wMin =
    spec.wAxis === 'X' ? baseBounds.xMin : spec.wAxis === 'Y' ? baseBounds.yMin : baseBounds.zMin;
  const wMax =
    spec.wAxis === 'X' ? baseBounds.xMax : spec.wAxis === 'Y' ? baseBounds.yMax : baseBounds.zMax;

  const pZero = unprojectViewPointTo3D(view, u, v, 0);
  const pUnit = sub3(unprojectViewPointTo3D(view, u, v, 1), pZero);

  const wBreaks: number[] = [wMin, wMax];
  const N_UNI = 18;
  for (let i = 1; i < N_UNI; i++) {
    wBreaks.push(wMin + ((wMax - wMin) * i) / N_UNI);
  }
  for (const pl of planes) {
    const nw = dot3(pl.n, pUnit);
    if (Math.abs(nw) > 1e-4) {
      const wHit = (pl.d - dot3(pl.n, pZero)) / nw;
      if (wHit > wMin + 0.05 && wHit < wMax - 0.05) {
        wBreaks.push(wHit);
      }
    }
  }
  wBreaks.sort((a, b) => a - b);

  const uniqW: number[] = [];
  for (const w of wBreaks) {
    if (uniqW.length === 0 || w - uniqW[uniqW.length - 1] > 0.08) {
      uniqW.push(w);
    }
  }

  const rawHits: SightColumnHit[] = [];
  for (let i = 0; i < uniqW.length - 1; i++) {
    const wMid = 0.5 * (uniqW[i] + uniqW[i + 1]);
    const pt = unprojectViewPointTo3D(view, u, v, wMid);
    if (evalCSGSolidSDF(pt, basePrims) < -0.04) {
      const cIdx = findSubCellForPoint3D(pt, planes, signToCellIndex);
      if (cIdx >= 0) {
        rawHits.push({
          cellIndex: cIdx,
          eyeDist: computeEyeDistance(pt, view),
          point3D: pt,
        });
      }
    }
  }

  // Sort strictly from observer eye inward (smaller `eyeDist` = closer to observer!)
  rawHits.sort((a, b) => a.eyeDist - b.eyeDist);

  // Merge consecutive hits belonging to the same sub-cell, keeping frontmost eyeDist & point3D
  const merged: SightColumnHit[] = [];
  for (const h of rawHits) {
    if (merged.length === 0 || merged[merged.length - 1].cellIndex !== h.cellIndex) {
      merged.push(h);
    }
  }
  return merged;
}

function build3DFaceAdjacencyGraph(
  cells: CurvedSubCell3D[],
  planes: CuttingPlane3D[],
  basePrims: Primitive3D[]
): number[][] {
  const adj: number[][] = cells.map(() => []);
  for (let i = 0; i < cells.length; i++) {
    for (let j = i + 1; j < cells.length; j++) {
      let diffCount = 0;
      let diffPlane = -1;
      for (let m = 0; m < planes.length; m++) {
        if (cells[i].signs[m] !== cells[j].signs[m]) {
          diffCount++;
          diffPlane = m;
          if (diffCount > 1) break;
        }
      }
      if (diffCount !== 1 || diffPlane < 0) continue;

      const pl = planes[diffPlane];
      let sharedFacetInsideBase = false;
      for (const sample of [...cells[i].samplePoints, ...cells[j].samplePoints]) {
        const sd = dot3(pl.n, sample) - pl.d;
        const proj = sub3(sample, scale3(pl.n, sd));
        if (evalCSGSolidSDF(proj, basePrims) > -0.04) continue;
        let sameOtherSigns = true;
        for (let m2 = 0; m2 < planes.length; m2++) {
          if (m2 === diffPlane) continue;
          const sd2 = dot3(planes[m2].n, proj) - planes[m2].d;
          if (sd2 * cells[i].signs[m2] < -0.04) {
            sameOtherSigns = false;
            break;
          }
        }
        if (sameOtherSigns) {
          sharedFacetInsideBase = true;
          break;
        }
      }

      if (sharedFacetInsideBase) {
        adj[i].push(j);
        adj[j].push(i);
      }
    }
  }
  return adj;
}

function isAssignmentFaceConnected(assign: Int8Array, adj: number[][]): boolean {
  let start = -1;
  let totalOnes = 0;
  for (let i = 0; i < assign.length; i++) {
    if (assign[i] === 1) {
      totalOnes++;
      if (start < 0) start = i;
    }
  }
  if (totalOnes <= 1) return totalOnes === 1;

  const visited = new Uint8Array(assign.length);
  const queue = [start];
  visited[start] = 1;
  let reached = 1;
  while (queue.length > 0) {
    const cur = queue.pop()!;
    for (const nb of adj[cur]) {
      if (assign[nb] === 1 && !visited[nb]) {
        visited[nb] = 1;
        reached++;
        queue.push(nb);
      }
    }
  }
  return reached === totalOnes;
}

function matchStraddlingPairsAcrossPlane(
  colMinus: SightColumnHit[],
  colPlus: SightColumnHit[],
  cells: CurvedSubCell3D[],
  planeIndex: number
): [number, number][] {
  const pairs: [number, number][] = [];
  for (const hm of colMinus) {
    for (const hp of colPlus) {
      if (hm.cellIndex === hp.cellIndex) continue;
      let sameOthers = true;
      for (let m = 0; m < cells[hm.cellIndex].signs.length; m++) {
        if (m === planeIndex) continue;
        if (cells[hm.cellIndex].signs[m] !== cells[hp.cellIndex].signs[m]) {
          sameOthers = false;
          break;
        }
      }
      if (sameOthers) {
        pairs.push([hm.cellIndex, hp.cellIndex]);
      }
    }
  }
  return pairs;
}

function clipPolygonByHalfSpace2D(
  poly: Point2D[],
  nu: number,
  nv: number,
  offset: number,
  keepGte: boolean
): Point2D[] {
  if (poly.length < 3) return [];
  const evalSide = (p: Point2D) =>
    keepGte ? nu * p.u + nv * p.v - offset : offset - (nu * p.u + nv * p.v);

  const out: Point2D[] = [];
  for (let i = 0; i < poly.length; i++) {
    const cur = poly[i];
    const nxt = poly[(i + 1) % poly.length];
    const sCur = evalSide(cur);
    const sNxt = evalSide(nxt);
    const inCur = sCur >= -1e-5;
    const inNxt = sNxt >= -1e-5;

    if (inCur && inNxt) {
      out.push(nxt);
    } else if (inCur && !inNxt) {
      const t = sCur / (sCur - sNxt);
      out.push({ u: cur.u + (nxt.u - cur.u) * t, v: cur.v + (nxt.v - cur.v) * t });
    } else if (!inCur && inNxt) {
      const t = sCur / (sCur - sNxt);
      out.push({ u: cur.u + (nxt.u - cur.u) * t, v: cur.v + (nxt.v - cur.v) * t });
      out.push(nxt);
    }
  }
  return out;
}

/**
 * Convert `x_k = 0` sub-cells into Dual Subtractive Cutters (`operation: 'subtract'`, `isInternalFeature: false`):
 * - Exterior faces lying 100% in exterior air outside the smooth positive base extend outward by `+1.5mm`
 *   to eliminate coplanar cylinder/cone grazing slivers during CSG & silhouette generator clipping.
 * - Interior step contact faces against `x_k = 1` cells remain at `0.00mm` exact analytical coordinates!
 */
function buildDualSubtractiveCuttersForAssignment(
  assign: Int8Array,
  cells: CurvedSubCell3D[],
  planes: CuttingPlane3D[],
  basePrims: Primitive3D[],
  baseBounds: BoundingBox3D
): Primitive3D[] {
  const isPureExteriorAirPoint = (pt: Vec3): boolean =>
    evalPositiveBaseOnlySDF(pt, basePrims) > 0.02;

  const isAxisFaceExteriorAir = (
    axis: Axis3D,
    coord: number,
    dirSign: -1 | 1,
    u0: number,
    u1: number,
    v0: number,
    v1: number
  ): boolean => {
    const wTest = coord + dirSign * 0.35;
    for (const fu of [0.15, 0.5, 0.85]) {
      for (const fv of [0.15, 0.5, 0.85]) {
        const u = u0 + (u1 - u0) * fu;
        const v = v0 + (v1 - v0) * fv;
        if (!isPureExteriorAirPoint(composeFromAxis(axis, u, v, wTest))) {
          return false;
        }
      }
    }
    return true;
  };

  const rawCutters: Primitive3D[] = [];

  for (let k = 0; k < cells.length; k++) {
    if (assign[k] !== 0) continue;

    let x0 = baseBounds.xMin;
    let x1 = baseBounds.xMax;
    let y0 = baseBounds.yMin;
    let y1 = baseBounds.yMax;
    let z0 = baseBounds.zMin;
    let z1 = baseBounds.zMax;

    const obliquePlanes: { plane: CuttingPlane3D; sign: number }[] = [];

    for (let m = 0; m < planes.length; m++) {
      const pl = planes[m];
      const sg = cells[k].signs[m];
      if (pl.axisAlignedAxis === 'X') {
        if (sg > 0) x0 = Math.max(x0, pl.d);
        else x1 = Math.min(x1, pl.d);
      } else if (pl.axisAlignedAxis === 'Y') {
        if (sg > 0) y0 = Math.max(y0, pl.d);
        else y1 = Math.min(y1, pl.d);
      } else if (pl.axisAlignedAxis === 'Z') {
        if (sg > 0) z0 = Math.max(z0, pl.d);
        else z1 = Math.min(z1, pl.d);
      } else {
        obliquePlanes.push({ plane: pl, sign: sg });
      }
    }

    if (x1 - x0 < 0.15 || y1 - y0 < 0.15 || z1 - z0 < 0.15) continue;

    if (obliquePlanes.length === 0) {
      rawCutters.push({
        id: `periph_cut_box_${k}`,
        shape: 'box',
        operation: 'subtract',
        xMin: x0,
        xMax: x1,
        yMin: y0,
        yMax: y1,
        zMin: z0,
        zMax: z1,
        featureId: `feat_periph_cut_${k}`,
        label: '边缘局部截切块',
        isInternalFeature: false,
      });
    } else {
      // Oblique bevel truncation: build exact 2D polygon prism along the shared extrusion axis!
      const extAxis: Axis3D = obliquePlanes[0].plane.extrudeAxis ?? 'Y';
      if ( obliquePlanes.every((op) => (op.plane.extrudeAxis ?? extAxis) === extAxis) ) {
        const bLo = decomposeByAxis({ x: x0, y: y0, z: z0 }, extAxis);
        const bHi = decomposeByAxis({ x: x1, y: y1, z: z1 }, extAxis);
        const extU0 = bLo.u - EXTERIOR_AIR_EXT_MM;
        const extU1 = bHi.u + EXTERIOR_AIR_EXT_MM;
        const extV0 = bLo.v - EXTERIOR_AIR_EXT_MM;
        const extV1 = bHi.v + EXTERIOR_AIR_EXT_MM;

        // Clip slightly-expanded outer air box against exact `0.00mm` interior planes!
        const uMinExact = bLo.u > (extAxis === 'Z' ? baseBounds.xMin : extAxis === 'Y' ? baseBounds.xMin : baseBounds.yMin) + 0.05 ? bLo.u : extU0;
        const uMaxExact = bHi.u < (extAxis === 'Z' ? baseBounds.xMax : extAxis === 'Y' ? baseBounds.xMax : baseBounds.yMax) - 0.05 ? bHi.u : extU1;
        const vMinExact = bLo.v > (extAxis === 'Z' ? baseBounds.yMin : extAxis === 'Y' ? baseBounds.zMin : baseBounds.zMin) + 0.05 ? bLo.v : extV0;
        const vMaxExact = bHi.v < (extAxis === 'Z' ? baseBounds.yMax : extAxis === 'Y' ? baseBounds.zMax : baseBounds.zMax) - 0.05 ? bHi.v : extV1;

        let poly: Point2D[] = [
          { u: uMinExact, v: vMinExact },
          { u: uMaxExact, v: vMinExact },
          { u: uMaxExact, v: vMaxExact },
          { u: uMinExact, v: vMaxExact },
        ];
        for (const { plane, sign } of obliquePlanes) {
          const n2 = decomposeByAxis(plane.n, extAxis);
          poly = clipPolygonByHalfSpace2D(poly, n2.u, n2.v, plane.d, sign > 0);
        }
        if (poly.length >= 3) {
          let puMin = Infinity,
            puMax = -Infinity,
            pvMin = Infinity,
            pvMax = -Infinity;
          for (const pt of poly) {
            puMin = Math.min(puMin, pt.u);
            puMax = Math.max(puMax, pt.u);
            pvMin = Math.min(pvMin, pt.v);
            pvMax = Math.max(pvMax, pt.v);
          }
          const wMinOut =
            bLo.w <= (extAxis === 'X' ? baseBounds.xMin : extAxis === 'Y' ? baseBounds.yMin : baseBounds.zMin) + 0.05
              ? bLo.w - EXTERIOR_AIR_EXT_MM
              : bLo.w;
          const wMaxOut =
            bHi.w >= (extAxis === 'X' ? baseBounds.xMax : extAxis === 'Y' ? baseBounds.yMax : baseBounds.zMax) - 0.05
              ? bHi.w + EXTERIOR_AIR_EXT_MM
              : bHi.w;
          const min3 = composeFromAxis(extAxis, puMin, pvMin, wMinOut);
          const max3 = composeFromAxis(extAxis, puMax, pvMax, wMaxOut);

          rawCutters.push({
            id: `periph_cut_prism_${k}`,
            shape: 'prism',
            operation: 'subtract',
            prismAxis: extAxis,
            prismPolygon: poly,
            xMin: Math.min(min3.x, max3.x),
            xMax: Math.max(min3.x, max3.x),
            yMin: Math.min(min3.y, max3.y),
            yMax: Math.max(min3.y, max3.y),
            zMin: Math.min(min3.z, max3.z),
            zMax: Math.max(min3.z, max3.z),
            featureId: `feat_periph_bevel_${k}`,
            label: '边缘斜切斜面块',
            isInternalFeature: false,
          });
        }
      }
    }
  }

  if (rawCutters.length === 0) return [];

  // Coalesce adjacent subtract boxes FIRST on exact bounds `[x0, x1]`, THEN extend only true exterior air faces by +1.5mm!
  const coalesced = coalesceSolidPrimitives([...basePrims, ...rawCutters]);
  for (let i = 0; i < coalesced.length; i++) {
    const p = coalesced[i];
    if (p.operation !== 'subtract' || p.isInternalFeature !== false || p.shape !== 'box') {
      continue;
    }
    const orig = { ...p };
    if (isAxisFaceExteriorAir('X', orig.xMin, -1, orig.yMin, orig.yMax, orig.zMin, orig.zMax)) {
      p.xMin -= EXTERIOR_AIR_EXT_MM;
    }
    if (isAxisFaceExteriorAir('X', orig.xMax, 1, orig.yMin, orig.yMax, orig.zMin, orig.zMax)) {
      p.xMax += EXTERIOR_AIR_EXT_MM;
    }
    if (isAxisFaceExteriorAir('Y', orig.yMin, -1, orig.xMin, orig.xMax, orig.zMin, orig.zMax)) {
      p.yMin -= EXTERIOR_AIR_EXT_MM;
    }
    if (isAxisFaceExteriorAir('Y', orig.yMax, 1, orig.xMin, orig.xMax, orig.zMin, orig.zMax)) {
      p.yMax += EXTERIOR_AIR_EXT_MM;
    }
    if (isAxisFaceExteriorAir('Z', orig.zMin, -1, orig.xMin, orig.xMax, orig.yMin, orig.yMax)) {
      p.zMin -= EXTERIOR_AIR_EXT_MM;
    }
    if (isAxisFaceExteriorAir('Z', orig.zMax, 1, orig.xMin, orig.xMax, orig.yMin, orig.yMax)) {
      p.zMax += EXTERIOR_AIR_EXT_MM;
    }
    p.featureId = `feat_periph_merged_${i}`;
  }

  return coalesced;
}

/**
 * Solve peripheral / chordal truncations, flat millings, and bore-breaching stepped cutouts
 * on smooth curved or composite bodies (`cylinder`, `hollow sleeve`, `cone`, `sphere`, etc.).
 */
export function solvePeripheralTruncations(
  basePrims: Primitive3D[],
  baseVerNoSSI: ReprojectionVerificationReport,
  arr1: ViewArrangementResult,
  arr2: ViewArrangementResult,
  startTimeMs: number,
  timeBudgetMs: number
): PeripheralTruncationResult {
  // Fast exit if base solid already explains all lines without SSI
  if (
    baseVerNoSSI.unexplainedError <= 1.8 &&
    baseVerNoSSI.viewReports.every((r) => r.missingStepJumpPenalty <= 0.5)
  ) {
    return {
      accepted: false,
      primitives: basePrims,
      verification: baseVerNoSSI,
      subCellCount: 1,
      removedCellCount: 0,
    };
  }

  // Evaluate apples-to-apples baseline WITH SSI curves so existing slotted/pierced solids
  // whose SSI lines already explain the drawing exit immediately with zero modification!
  const baseVerWithSSI = verifyReprojectionFiniteIntervals(
    basePrims,
    arr1,
    arr2,
    true
  );
  if (
    baseVerWithSSI.unexplainedError <= 2.2 &&
    baseVerWithSSI.viewReports.every((r) => r.missingStepJumpPenalty <= 0.8)
  ) {
    return {
      accepted: false,
      primitives: basePrims,
      verification: baseVerWithSSI,
      subCellCount: 1,
      removedCellCount: 0,
    };
  }

  const baseBounds = computeBasePositiveBounds(basePrims);
  if (!baseBounds) {
    return {
      accepted: false,
      primitives: basePrims,
      verification: baseVerWithSSI,
      subCellCount: 0,
      removedCellCount: 0,
    };
  }

  const existingVoids = basePrims.filter((p) => p.operation === 'subtract');
  const planes = extractInteriorCuttingPlanes3D(
    arr1,
    arr2,
    baseBounds,
    existingVoids
  );
  if (planes.length === 0) {
    return {
      accepted: false,
      primitives: basePrims,
      verification: baseVerWithSSI,
      subCellCount: 1,
      removedCellCount: 0,
    };
  }

  const cells = buildCurvedAnalyticSubCells(basePrims, baseBounds, planes);
  if (cells.length <= 1 || cells.length > 64) {
    return {
      accepted: false,
      primitives: basePrims,
      verification: baseVerWithSSI,
      subCellCount: cells.length,
      removedCellCount: 0,
    };
  }

  const signToCellIndex = new Map<string, number>();
  for (const c of cells) {
    let key = '';
    for (let m = 0; m < planes.length; m++) key += c.signs[m] > 0 ? '1' : '0';
    signToCellIndex.set(key, c.index);
  }

  const adj3D = build3DFaceAdjacencyGraph(cells, planes, basePrims);

  // ==========================================================================
  // Build First-Angle Projection Constraints over Sub-Cells `x in {-1, 0, 1}^K`
  // ==========================================================================
  const initialLock = new Int8Array(cells.length).fill(-1);

  // Law 1: Any sub-cell projecting predominantly outside either view's outer solid loop is `0`!
  for (const c of cells) {
    for (const arr of [arr1, arr2]) {
      if (arr.outerRegions.length === 0) continue;
      let outsideCount = 0;
      for (const pt of c.samplePoints) {
        const q = projectPoint3DToView(pt, arr.view);
        const insideOuter = arr.outerRegions.some((reg) =>
          pointInPolygonExact(q, reg.polygon)
        );
        if (!insideOuter) outsideCount++;
      }
      if (outsideCount > c.samplePoints.length * 0.6) {
        initialLock[c.index] = 0;
        break;
      }
    }
  }

  // Law 2: Outer Silhouette Coverage (Unique supporter => hard lock `x_k = 1`; multi-cell => soft clause)
  const softCoverColumns: { cells: number[]; weight: number }[] = [];
  for (const arr of [arr1, arr2]) {
    if (!arr.bounds) continue;
    for (const reg of arr.outerRegions) {
      const loop = reg.polygon;
      if (loop.length < 3) continue;
      const step = Math.max(1, Math.floor(loop.length / 28));
      for (let i = 0; i < loop.length; i += step) {
        const a = loop[i];
        const b = loop[(i + 1) % loop.length];
        const dx = b.u - a.u;
        const dy = b.v - a.v;
        const segLen = Math.hypot(dx, dy);
        if (segLen < 0.05) continue;
        const mid = { u: 0.5 * (a.u + b.u), v: 0.5 * (a.v + b.v) };
        // Try stepping 0.65mm inward along perpendicular normal
        const nLeft = { u: -dy / segLen, v: dx / segLen };
        let qIn = { u: mid.u + nLeft.u * 0.65, v: mid.v + nLeft.v * 0.65 };
        if (!pointInPolygonExact(qIn, loop)) {
          qIn = { u: mid.u - nLeft.u * 0.65, v: mid.v - nLeft.v * 0.65 };
          if (!pointInPolygonExact(qIn, loop)) continue;
        }

        const col = buildSightColumn(
          arr.view,
          qIn.u,
          qIn.v,
          baseBounds,
          basePrims,
          planes,
          signToCellIndex
        );
        const activeCol = col
          .map((h) => h.cellIndex)
          .filter((idx) => initialLock[idx] !== 0);
        if (activeCol.length === 1) {
          // Verify ray does not intersect an existing bore void to guard against untrimmed user outer rectangles
          const p3 = col[0].point3D;
          const nearBore = existingVoids.some(
            (vp) => Math.abs(evalPrimitive3DSDF(p3, vp)) < 0.8
          );
          if (!nearBore) {
            initialLock[activeCol[0]] = 1;
          } else {
            softCoverColumns.push({ cells: activeCol, weight: 4.0 });
          }
        } else if (activeCol.length >= 2) {
          softCoverColumns.push({ cells: activeCol, weight: 3.5 });
        }
      }
    }
  }

  // Laws 3, 4, 5: Carrier Step Jump & Smooth Continuity Constraints
  const stepConstraints: (StepJumpConstraint & {
    pairs: [number, number][];
    planeIndex: number;
  })[] = [];

  for (let m = 0; m < planes.length; m++) {
    const pl = planes[m];
    for (const src of pl.sources) {
      const lc = src.carrier;
      const arr = src.view === arr1.view ? arr1 : arr2;
      if (!arr.bounds) continue;

      // Determine scalar `s` range along `lc` inside view bounds
      let sLo = Infinity;
      let sHi = -Infinity;
      for (const uCorner of [arr.bounds.uMin, arr.bounds.uMax]) {
        for (const vCorner of [arr.bounds.vMin, arr.bounds.vMax]) {
          const s =
            (uCorner - lc.origin.u) * lc.dir.u + (vCorner - lc.origin.v) * lc.dir.v;
          sLo = Math.min(sLo, s);
          sHi = Math.max(sHi, s);
        }
      }
      if (sHi - sLo < 3.0) continue;

      const sampleCount = Math.min(20, Math.max(6, Math.ceil((sHi - sLo) / 4.0)));
      for (let k = 0; k < sampleCount; k++) {
        const s = sLo + ((k + 0.5) / sampleCount) * (sHi - sLo);
        const q = {
          u: lc.origin.u + lc.dir.u * s,
          v: lc.origin.v + lc.dir.v * s,
        };
        const qMinus = {
          u: q.u - lc.normal.u * 0.55,
          v: q.v - lc.normal.v * 0.55,
        };
        const qPlus = {
          u: q.u + lc.normal.u * 0.55,
          v: q.v + lc.normal.v * 0.55,
        };

        const colMinus = buildSightColumn(
          arr.view,
          qMinus.u,
          qMinus.v,
          baseBounds,
          basePrims,
          planes,
          signToCellIndex
        );
        const colPlus = buildSightColumn(
          arr.view,
          qPlus.u,
          qPlus.v,
          baseBounds,
          basePrims,
          planes,
          signToCellIndex
        );
        if (colMinus.length === 0 || colPlus.length === 0) continue;

        const pairs = matchStraddlingPairsAcrossPlane(colMinus, colPlus, cells, m);
        if (pairs.length === 0) continue;

        const onSolid = lc.solidIntervals.some(
          (iv) => s >= iv.s0 + 0.35 && s <= iv.s1 - 0.35
        );
        const onDashed =
          !onSolid &&
          lc.dashedIntervals.some((iv) => s >= iv.s0 + 0.35 && s <= iv.s1 - 0.35);
        const nearAnyEndpoint =
          lc.solidIntervals.some(
            (iv) => Math.abs(s - iv.s0) < 1.1 || Math.abs(s - iv.s1) < 1.1
          ) ||
          lc.dashedIntervals.some(
            (iv) => Math.abs(s - iv.s0) < 1.1 || Math.abs(s - iv.s1) < 1.1
          );

        let frontSurfaceSmooth = false;
        if (Math.abs(colMinus[0].eyeDist - colPlus[0].eyeDist) <= 1.8) {
          const spec = getViewAxisSpec(arr.view);
          const wFrontMinus = spec.largerWCloser
            ? 160 - colMinus[0].eyeDist
            : colMinus[0].eyeDist - 40;
          const wFrontPlus = spec.largerWCloser
            ? 160 - colPlus[0].eyeDist
            : colPlus[0].eyeDist - 40;
          const pFM = unprojectViewPointTo3D(arr.view, qMinus.u, qMinus.v, wFrontMinus);
          const pFP = unprojectViewPointTo3D(arr.view, qPlus.u, qPlus.v, wFrontPlus);
          const gM = evalCSGSolidGrad(pFM, basePrims);
          const gP = evalCSGSolidGrad(pFP, basePrims);
          frontSurfaceSmooth = dot3(gM, gP) > 0.94;
        }

        if (onSolid) {
          stepConstraints.push({
            kind: 'solid_step',
            colMinus,
            colPlus,
            frontSurfaceSmooth,
            weight: (sHi - sLo) / sampleCount,
            pairs,
            planeIndex: m,
          });
        } else if (onDashed) {
          stepConstraints.push({
            kind: 'dashed_step',
            colMinus,
            colPlus,
            frontSurfaceSmooth,
            weight: (sHi - sLo) / sampleCount,
            pairs,
            planeIndex: m,
          });
        } else if (!nearAnyEndpoint) {
          stepConstraints.push({
            kind: 'smooth_continuity',
            colMinus,
            colPlus,
            frontSurfaceSmooth,
            weight: ((sHi - sLo) / sampleCount) * 0.8,
            pairs,
            planeIndex: m,
          });
        }
      }
    }
  }

  // Detect exact GB/T view-depth reflection symmetry:
  // If view A looks along axis W (e.g. Front looks along Y), and conjugate view B (Top, where Y is in-plane)
  // has 100% mirror-symmetric `thick_solid` AND `thin_dashed` geometry across `W = wMid`, collect mirrored cell pairs!
  const symmetryPairs: [number, number][] = [];
  for (const [occArr, inPlaneArr] of [
    [arr1, arr2],
    [arr2, arr1],
  ] as const) {
    const wAxis = getViewAxisSpec(occArr.view).wAxis;
    const inSpec = getViewAxisSpec(inPlaneArr.view);
    const reflCoord: 'u' | 'v' | null =
      inSpec.uAxis === wAxis ? 'u' : inSpec.vAxis === wAxis ? 'v' : null;
    if (!reflCoord) continue;

    const wMid =
      wAxis === 'X'
        ? 0.5 * (baseBounds.xMin + baseBounds.xMax)
        : wAxis === 'Y'
        ? 0.5 * (baseBounds.yMin + baseBounds.yMax)
        : 0.5 * (baseBounds.zMin + baseBounds.zMax);

    const reflect3D = (pt: Vec3): Vec3 =>
      wAxis === 'X'
        ? { x: 2 * wMid - pt.x, y: pt.y, z: pt.z }
        : wAxis === 'Y'
        ? { x: pt.x, y: 2 * wMid - pt.y, z: pt.z }
        : { x: pt.x, y: pt.y, z: 2 * wMid - pt.z };

    // Verify smooth base `basePrims` is mirror-symmetric across `W = wMid`
    const baseSym = cells.every(
      (c) => evalCSGSolidSDF(reflect3D(c.samplePoints[0]), basePrims) < -0.02
    );
    if (!baseSym) continue;

    // Verify all solid & dashed segments in `inPlaneArr` are mirror-symmetric across `reflCoord = wMid`
    const segMids = inPlaneArr.splitSegments
      .filter((s) => s.lineType === 'thick_solid' || s.lineType === 'thin_dashed')
      .map((s) => {
        let mid: Point2D;
        if (
          s.kind === 'arc' &&
          s.center &&
          s.radius !== undefined &&
          s.startAngle !== undefined &&
          s.endAngle !== undefined
        ) {
          let sw = s.endAngle - s.startAngle;
          while (sw <= 0) sw += Math.PI * 2;
          const aMid = s.startAngle + 0.5 * sw;
          mid = {
            u: s.center.u + s.radius * Math.cos(aMid),
            v: s.center.v + s.radius * Math.sin(aMid),
          };
        } else {
          mid = { u: 0.5 * (s.p1.u + s.p2.u), v: 0.5 * (s.p1.v + s.p2.v) };
        }
        return { mid, lineType: s.lineType };
      });

    if (segMids.length === 0) continue;
    const viewSym = segMids.every((item) => {
      const target: Point2D =
        reflCoord === 'u'
          ? { u: 2 * wMid - item.mid.u, v: item.mid.v }
          : { u: item.mid.u, v: 2 * wMid - item.mid.v };
      return segMids.some(
        (other) =>
          other.lineType === item.lineType &&
          Math.hypot(other.mid.u - target.u, other.mid.v - target.v) <= 0.95
      );
    });
    if (!viewSym) continue;

    for (const c of cells) {
      const mIdx = findSubCellForPoint3D(
        reflect3D(c.samplePoints[0]),
        planes,
        signToCellIndex
      );
      if (mIdx > c.index) {
        symmetryPairs.push([c.index, mIdx]);
      }
    }
  }

  // ==========================================================================
  // Constraint Propagation + Bounded Branch-and-Bound Search
  // ==========================================================================
  const solveWithContinuityMode = (
    hardContinuity: boolean,
    enforceSymmetry: boolean
  ): Int8Array[] => {
    const solutions: { assign: Int8Array; softScore: number }[] = [];

    const propagate = (state: Int8Array): boolean => {
      let changed = true;
      let iter = 0;
      while (changed && iter < 48) {
        changed = false;
        iter++;

        if (enforceSymmetry) {
          for (const [a, b] of symmetryPairs) {
            if (state[a] !== -1 && state[b] === -1) {
              state[b] = state[a];
              changed = true;
            } else if (state[b] !== -1 && state[a] === -1) {
              state[a] = state[b];
              changed = true;
            } else if (state[a] !== -1 && state[b] !== -1 && state[a] !== state[b]) {
              return false;
            }
          }
        }

        for (const sc of stepConstraints) {
          const fM = sc.colMinus[0].cellIndex;
          const fP = sc.colPlus[0].cellIndex;

          if (sc.kind === 'dashed_step') {
            // Frontmost smooth skin must have equal occupancy across a pure hidden dashed line!
            if (sc.frontSurfaceSmooth && fM !== fP) {
              if (state[fM] !== -1 && state[fP] === -1) {
                state[fP] = state[fM];
                changed = true;
              } else if (state[fP] !== -1 && state[fM] === -1) {
                state[fM] = state[fP];
                changed = true;
              } else if (state[fM] !== -1 && state[fP] !== -1 && state[fM] !== state[fP]) {
                return false;
              }
            }

            // At least one matched pair across the plane must jump (`a !== b`)!
            let anyCanJump = false;
            let anyAlreadyJumps = false;
            let singleUnforcedPair: [number, number] | null = null;
            let unforcedCount = 0;

            for (const [a, b] of sc.pairs) {
              if (state[a] !== -1 && state[b] !== -1) {
                if (state[a] !== state[b]) {
                  anyAlreadyJumps = true;
                  anyCanJump = true;
                }
              } else {
                anyCanJump = true;
                unforcedCount++;
                singleUnforcedPair = [a, b];
              }
            }
            if (!anyCanJump) return false;
            if (!anyAlreadyJumps && unforcedCount === 1 && singleUnforcedPair) {
              const [a, b] = singleUnforcedPair;
              if (state[a] !== -1 && state[b] === -1) {
                state[b] = state[a] === 1 ? 0 : 1;
                changed = true;
              } else if (state[b] !== -1 && state[a] === -1) {
                state[a] = state[b] === 1 ? 0 : 1;
                changed = true;
              }
            }
          } else if (sc.kind === 'solid_step') {
            // On a smooth front skin, occupying BOTH frontmost cells leaves zero visible crease (`NAND(fM, fP)`)!
            if (sc.frontSurfaceSmooth && fM !== fP) {
              if (state[fM] === 1 && state[fP] === 1) return false;
              if (state[fM] === 1 && state[fP] === -1) {
                state[fP] = 0;
                changed = true;
              } else if (state[fP] === 1 && state[fM] === -1) {
                state[fM] = 0;
                changed = true;
              }
            }

            // At least one matched pair must differ
            let anyPossibleDiff = false;
            for (const [a, b] of sc.pairs) {
              if (state[a] === -1 || state[b] === -1 || state[a] !== state[b]) {
                anyPossibleDiff = true;
                break;
              }
            }
            if (!anyPossibleDiff) return false;
          } else if (sc.kind === 'smooth_continuity' && hardContinuity) {
            for (const [a, b] of sc.pairs) {
              if (state[a] !== -1 && state[b] === -1) {
                state[b] = state[a];
                changed = true;
              } else if (state[b] !== -1 && state[a] === -1) {
                state[a] = state[b];
                changed = true;
              } else if (state[a] !== -1 && state[b] !== -1 && state[a] !== state[b]) {
                return false;
              }
            }
          }
        }

        // Pruning isolated islands: if an unassigned or `1` cell has ZERO neighbors in `adj3D` that are `1` or `-1`
        // (while at least one other cell is `1`), it can never connect to the solid body!
        const hasLockedOne = state.some((v) => v === 1);
        if (hasLockedOne) {
          for (let i = 0; i < state.length; i++) {
            if (state[i] === 0) continue;
            if (adj3D[i].length > 0 && adj3D[i].every((nb) => state[nb] === 0)) {
              if (state[i] === 1) return false;
              state[i] = 0;
              changed = true;
            }
          }
        }
      }
      return true;
    };

    const scoreLeafAssignment = (state: Int8Array): number => {
      let score = 0;
      for (const cov of softCoverColumns) {
        if (cov.cells.some((idx) => state[idx] === 1)) {
          score += cov.weight;
        } else {
          score -= cov.weight * 2.5;
        }
      }
      for (const sc of stepConstraints) {
        if (sc.kind === 'smooth_continuity') {
          const allEqual = sc.pairs.every(([a, b]) => state[a] === state[b]);
          score += allEqual ? sc.weight : -sc.weight * 1.5;
        } else {
          const hasJump = sc.pairs.some(([a, b]) => state[a] !== state[b]);
          score += hasJump ? sc.weight : -sc.weight * 3.0;
        }
      }
      for (const [a, b] of symmetryPairs) {
        if (state[a] === state[b]) score += 3.0;
      }
      for (let i = 0; i < state.length; i++) {
        for (const nb of adj3D[i]) {
          if (nb > i && state[i] === state[nb]) score += 0.35;
        }
      }
      return score;
    };

    const root = new Int8Array(initialLock);
    if (!propagate(root)) return [];

    const varDegree = new Int32Array(cells.length);
    for (const sc of stepConstraints) {
      for (const [a, b] of sc.pairs) {
        varDegree[a]++;
        varDegree[b]++;
      }
    }

    let exploredNodes = 0;
    const dfs = (state: Int8Array) => {
      if (solutions.length >= MAX_LEAF_CANDIDATES || exploredNodes > 360) return;
      if (Date.now() - startTimeMs > timeBudgetMs * 0.88) return;
      exploredNodes++;

      let nextVar = -1;
      let bestDeg = -1;
      for (let i = 0; i < state.length; i++) {
        if (state[i] === -1 && varDegree[i] > bestDeg) {
          bestDeg = varDegree[i];
          nextVar = i;
        }
      }

      if (nextVar < 0) {
        const hasZero = state.some((v) => v === 0);
        const hasOne = state.some((v) => v === 1);
        if (hasZero && hasOne && isAssignmentFaceConnected(state, adj3D)) {
          solutions.push({
            assign: new Int8Array(state),
            softScore: scoreLeafAssignment(state),
          });
        }
        return;
      }

      const coveredHelpful = softCoverColumns.some(
        (cov) =>
          cov.cells.includes(nextVar) &&
          cov.cells.every((cIdx) => cIdx === nextVar || state[cIdx] === 0)
      );
      const branchOrder: (0 | 1)[] = coveredHelpful ? [1, 0] : [0, 1];

      for (const val of branchOrder) {
        const nextState = new Int8Array(state);
        nextState[nextVar] = val;
        if (propagate(nextState)) {
          dfs(nextState);
        }
      }
    };

    dfs(root);
    solutions.sort((a, b) => b.softScore - a.softScore);
    return solutions.map((s) => s.assign);
  };

  let candidateAssignments: Int8Array[] = [];
  if (symmetryPairs.length > 0) {
    candidateAssignments = solveWithContinuityMode(true, true);
    if (candidateAssignments.length === 0) {
      candidateAssignments = solveWithContinuityMode(false, true);
    }
  }
  if (candidateAssignments.length === 0) {
    candidateAssignments = solveWithContinuityMode(true, false);
  }
  if (candidateAssignments.length === 0) {
    candidateAssignments = solveWithContinuityMode(false, false);
  }
  if (candidateAssignments.length === 0) {
    return {
      accepted: false,
      primitives: basePrims,
      verification: baseVerWithSSI,
      subCellCount: cells.length,
      removedCellCount: 0,
    };
  }

  // Count interior solid-contact faces of peripheral cutters (open step = 2 faces vs enclosed groove = 3+ faces)
  const computeInteriorCutFaceCost = (prims: Primitive3D[]): number => {
    let faces = 0;
    for (const p of prims) {
      if (p.operation !== 'subtract' || p.isInternalFeature !== false) continue;
      if (p.shape === 'box') {
        if (p.xMin > baseBounds.xMin + 0.2) faces++;
        if (p.xMax < baseBounds.xMax - 0.2) faces++;
        if (p.yMin > baseBounds.yMin + 0.2) faces++;
        if (p.yMax < baseBounds.yMax - 0.2) faces++;
        if (p.zMin > baseBounds.zMin + 0.2) faces++;
        if (p.zMax < baseBounds.zMax - 0.2) faces++;
      } else {
        faces += 3;
      }
    }
    return faces * 1.25;
  };

  // ==========================================================================
  // Closed-Loop Reprojection Verification over Top Candidate Solids (Max 6)
  // ==========================================================================
  let bestPrims = basePrims;
  let bestVer = baseVerWithSSI;
  let bestObjective = baseVerWithSSI.totalError + basePrims.length * 0.4;
  let bestRemovedCount = 0;
  let foundImprovement = false;

  const evalLimit = Math.min(6, candidateAssignments.length);
  for (let idx = 0; idx < evalLimit; idx++) {
    if (idx > 0 && Date.now() - startTimeMs > timeBudgetMs * 0.94) break;
    const assign = candidateAssignments[idx];
    const candPrims = buildDualSubtractiveCuttersForAssignment(
      assign,
      cells,
      planes,
      basePrims,
      baseBounds
    );
    if (candPrims.length === 0) continue;

    const candVer = verifyReprojectionFiniteIntervals(
      candPrims,
      arr1,
      arr2,
      true
    );
    const objective =
      candVer.totalError +
      candPrims.length * 0.45 +
      computeInteriorCutFaceCost(candPrims);
    if (
      candVer.totalError < baseVerWithSSI.totalError - 2.5 &&
      objective < bestObjective
    ) {
      bestObjective = objective;
      bestPrims = candPrims;
      bestVer = candVer;
      bestRemovedCount = assign.reduce((acc, v) => acc + (v === 0 ? 1 : 0), 0);
      foundImprovement = true;
      if (candVer.totalError <= 4.5 && candVer.recallKnownViews >= 0.97) {
        break;
      }
    }
  }

  return {
    accepted: foundImprovement,
    primitives: bestPrims,
    verification: bestVer,
    subCellCount: cells.length,
    removedCellCount: bestRemovedCount,
  };
}
