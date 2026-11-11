import { CadEntity, Point2D, Primitive3D, ViewType } from '../../types/cad';
import { SolvedSolidModel3D, Vec2 } from '../types';
import { normAngle } from '../arrangement2d/snapAndSplit';
import { projectPoint3DToView } from '../lifting3d/surfacePrimitives';
import {
  ClassifiedArcSpan2D,
  ClassifiedCurveSpan2D,
  ClassifiedLineSpan2D,
  ClassifiedPolylineSpan2D,
} from './quantitativeHLR';

const TWO_PI = Math.PI * 2;

function roundCoord(v: number): number {
  return Math.round(v * 1000) / 1000;
}

function roundPt(p: Vec2): Point2D {
  return { u: roundCoord(p.u), v: roundCoord(p.v) };
}

interface Interval1D {
  a: number;
  b: number;
  featureId?: string;
  featureLabel?: string;
}

function merge1DIntervals(intervals: Interval1D[], gapTol = 0.35): Interval1D[] {
  if (intervals.length === 0) return [];
  const sorted = intervals
    .map((iv) => ({
      a: Math.min(iv.a, iv.b),
      b: Math.max(iv.a, iv.b),
      featureId: iv.featureId,
      featureLabel: iv.featureLabel,
    }))
    .sort((x, y) => x.a - y.a);

  const out: Interval1D[] = [{ ...sorted[0] }];
  for (let i = 1; i < sorted.length; i++) {
    const cur = sorted[i];
    const last = out[out.length - 1];
    if (cur.a <= last.b + gapTol) {
      last.b = Math.max(last.b, cur.b);
      if (!last.featureLabel && cur.featureLabel) {
        last.featureId = cur.featureId;
        last.featureLabel = cur.featureLabel;
      }
    } else {
      out.push({ ...cur });
    }
  }
  return out.filter((iv) => iv.b - iv.a >= 0.35);
}

function subtract1DIntervals(
  target: Interval1D[],
  occluders: Interval1D[],
  minRemain = 0.45
): Interval1D[] {
  let current = [...target];
  for (const occ of occluders) {
    const next: Interval1D[] = [];
    for (const seg of current) {
      if (occ.b <= seg.a + 0.08 || occ.a >= seg.b - 0.08) {
        next.push(seg);
        continue;
      }
      if (occ.a - seg.a >= minRemain) {
        next.push({ ...seg, b: occ.a });
      }
      if (seg.b - occ.b >= minRemain) {
        next.push({ ...seg, a: occ.b });
      }
    }
    current = next;
  }
  return current.filter((iv) => iv.b - iv.a >= minRemain);
}

function distPointToSeg2D(p: Vec2, a: Vec2, b: Vec2): number {
  const dx = b.u - a.u;
  const dy = b.v - a.v;
  const lenSq = dx * dx + dy * dy;
  if (lenSq < 1e-8) return Math.hypot(p.u - a.u, p.v - a.v);
  const t = Math.max(0, Math.min(1, ((p.u - a.u) * dx + (p.v - a.v) * dy) / lenSq));
  return Math.hypot(p.u - (a.u + t * dx), p.v - (a.v + t * dy));
}

function rdpSimplifyIndices2D(pts: Vec2[], i0: number, i1: number, tol: number, out: number[]): void {
  if (i1 <= i0 + 1) return;
  let maxDist = -1;
  let maxIdx = -1;
  const a = pts[i0];
  const b = pts[i1];
  for (let i = i0 + 1; i < i1; i++) {
    const d = distPointToSeg2D(pts[i], a, b);
    if (d > maxDist) {
      maxDist = d;
      maxIdx = i;
    }
  }
  if (maxDist > tol && maxIdx > i0 && maxIdx < i1) {
    rdpSimplifyIndices2D(pts, i0, maxIdx, tol, out);
    out.push(maxIdx);
    rdpSimplifyIndices2D(pts, maxIdx, i1, tol, out);
  }
}

/**
 * Decomposes a projected 2D SSI polyline into exact `ClassifiedLineSpan2D[]` if it is genuinely
 * piecewise-linear (e.g., equal-diameter cylinder Steinmetz V-lines, X-lines, or folded loops),
 * while preserving smooth curves (ellipses, hyperbolas, parabolas, saddles) as `ClassifiedPolylineSpan2D`.
 */
function decomposePolylineIntoLinesOrCurve(
  poly: ClassifiedPolylineSpan2D
): ClassifiedLineSpan2D[] | null {
  const pts = poly.points;
  if (pts.length < 2) return null;

  const idxList: number[] = [0];
  rdpSimplifyIndices2D(pts, 0, pts.length - 1, 0.13, idxList);
  idxList.push(pts.length - 1);

  const chords: { a: Vec2; b: Vec2; len: number; dirU: number; dirV: number }[] = [];
  for (let k = 0; k + 1 < idxList.length; k++) {
    const a = pts[idxList[k]];
    const b = pts[idxList[k + 1]];
    const du = b.u - a.u;
    const dv = b.v - a.v;
    const len = Math.hypot(du, dv);
    if (len < 0.45) continue;
    chords.push({ a, b, len, dirU: du / len, dirV: dv / len });
  }

  if (chords.length === 0) return null;
  if (chords.length > 8) return null;

  // Distinguish genuine straight-line intersections (zero curvature along long arms, meeting only at
  // sharp corners >= 28° or 180° fold-backs) from smooth curved arcs (gentle consecutive 5°–22° turns)
  if (chords.length >= 2) {
    const minChordLen = Math.min(...chords.map((c) => c.len));
    if (minChordLen < 2.0) return null;
    for (let k = 0; k + 1 < chords.length; k++) {
      const c1 = chords[k];
      const c2 = chords[k + 1];
      const dot = c1.dirU * c2.dirU + c1.dirV * c2.dirV;
      // Gentle turn (`0.88 < dot < 0.994`, ~6° to 28°) indicates a smooth curved arc, NOT straight lines!
      if (dot > 0.88 && dot < 0.994) {
        return null;
      }
    }
  } else if (chords[0].len < 0.6) {
    return null;
  }

  return chords.map((c) => ({
    kind: 'line' as const,
    p1: c.a,
    p2: c.b,
    lineType: poly.lineType,
    featureId: poly.featureId,
    featureLabel: poly.featureLabel,
  }));
}

/**
 * Reconstructs clean, non-overlapping GB/T 4458.4 `CadEntity[]` for `targetView` from HLR spans:
 * 1. Enforces strict `thick_solid > thin_dashed > center_dot_dash` priority on all collinear
 *    line carriers and concentric circular carriers.
 * 2. Merges contiguous/overlapping spans into single native `CadLineEntity`, `CadCircleEntity`,
 *    `CadArcEntity`, or smooth SSI `CadPolygonEntity`.
 * 3. Synthesizes GB/T 4458.4 symmetry cross-centerlines for circles/arcs and revolution axes
 *    for cylinders/cones/frustums/spheres/hemispheres.
 */
export function reconstructClean2DEntitiesFromHLR(
  rawSpans: ClassifiedCurveSpan2D[],
  model: SolvedSolidModel3D,
  targetView: ViewType,
  idPrefix = 'derived'
): CadEntity[] {
  const lineSpans: ClassifiedLineSpan2D[] = [];
  const arcSpans: ClassifiedArcSpan2D[] = [];
  const polySpans: ClassifiedPolylineSpan2D[] = [];

  for (const sp of rawSpans) {
    if (sp.kind === 'line') {
      lineSpans.push(sp);
    } else if (sp.kind === 'arc') {
      arcSpans.push(sp);
    } else {
      const fittedLines = decomposePolylineIntoLinesOrCurve(sp);
      if (fittedLines) lineSpans.push(...fittedLines);
      else polySpans.push(sp);
    }
  }

  const entities: CadEntity[] = [];
  let seq = 1;

  // ==========================================================================
  // 1. Collinear Line Carrier Grouping + `thick_solid > thin_dashed` Priority
  // ==========================================================================
  interface LineCarrierBucket {
    dir: Vec2;
    normal: Vec2;
    anchor: Vec2;
    solidIntervals: Interval1D[];
    dashedIntervals: Interval1D[];
  }
  const lineBuckets: LineCarrierBucket[] = [];

  for (const ls of lineSpans) {
    const du = ls.p2.u - ls.p1.u;
    const dv = ls.p2.v - ls.p1.v;
    const len = Math.hypot(du, dv);
    if (len < 0.25) continue;

    let dirU = du / len;
    let dirV = dv / len;
    if (Math.abs(dirU) < 5e-3) {
      dirU = 0;
      dirV = 1;
    } else if (Math.abs(dirV) < 5e-3) {
      dirU = 1;
      dirV = 0;
    } else if (dirU < 0) {
      dirU = -dirU;
      dirV = -dirV;
    }

    const normU = -dirV;
    const normV = dirU;
    const mid = { u: 0.5 * (ls.p1.u + ls.p2.u), v: 0.5 * (ls.p1.v + ls.p2.v) };

    let bucket: LineCarrierBucket | null = null;
    for (const b of lineBuckets) {
      const dot = b.dir.u * dirU + b.dir.v * dirV;
      const perpDist = Math.abs(
        (mid.u - b.anchor.u) * b.normal.u + (mid.v - b.anchor.v) * b.normal.v
      );
      if (dot > 0.9985 && perpDist <= 0.36) {
        bucket = b;
        break;
      }
    }
    if (!bucket) {
      bucket = {
        dir: { u: dirU, v: dirV },
        normal: { u: normU, v: normV },
        anchor: mid,
        solidIntervals: [],
        dashedIntervals: [],
      };
      lineBuckets.push(bucket);
    }

    const t1 = (ls.p1.u - bucket.anchor.u) * bucket.dir.u + (ls.p1.v - bucket.anchor.v) * bucket.dir.v;
    const t2 = (ls.p2.u - bucket.anchor.u) * bucket.dir.u + (ls.p2.v - bucket.anchor.v) * bucket.dir.v;
    const iv: Interval1D = {
      a: Math.min(t1, t2),
      b: Math.max(t1, t2),
      featureId: ls.featureId,
      featureLabel: ls.featureLabel,
    };
    if (ls.lineType === 'thick_solid') bucket.solidIntervals.push(iv);
    else bucket.dashedIntervals.push(iv);
  }

  for (const b of lineBuckets) {
    const mergedSolid = merge1DIntervals(b.solidIntervals, 0.35);
    const mergedDashedRaw = merge1DIntervals(b.dashedIntervals, 0.35);
    // Strict GB/T 4458.4 priority: `thick_solid` completely masks coincident `thin_dashed`!
    const cleanDashed = subtract1DIntervals(mergedDashedRaw, mergedSolid, 0.5);

    for (const sIv of mergedSolid) {
      entities.push({
        id: `${idPrefix}_ln_${seq++}`,
        view: targetView,
        type: 'line',
        lineType: 'thick_solid',
        p1: roundPt({
          u: b.anchor.u + sIv.a * b.dir.u,
          v: b.anchor.v + sIv.a * b.dir.v,
        }),
        p2: roundPt({
          u: b.anchor.u + sIv.b * b.dir.u,
          v: b.anchor.v + sIv.b * b.dir.v,
        }),
        source: 'derived',
        featureId: sIv.featureId,
        featureLabel: sIv.featureLabel,
      });
    }

    for (const dIv of cleanDashed) {
      entities.push({
        id: `${idPrefix}_ln_${seq++}`,
        view: targetView,
        type: 'line',
        lineType: 'thin_dashed',
        p1: roundPt({
          u: b.anchor.u + dIv.a * b.dir.u,
          v: b.anchor.v + dIv.a * b.dir.v,
        }),
        p2: roundPt({
          u: b.anchor.u + dIv.b * b.dir.u,
          v: b.anchor.v + dIv.b * b.dir.v,
        }),
        source: 'derived',
        featureId: dIv.featureId,
        featureLabel: dIv.featureLabel,
      });
    }
  }

  // ==========================================================================
  // 2. Concentric Circle/Arc Grouping + `thick_solid > thin_dashed` Priority
  // ==========================================================================
  interface CircleCarrierBucket {
    center: Vec2;
    radius: number;
    solidArcs: ClassifiedArcSpan2D[];
    dashedArcs: ClassifiedArcSpan2D[];
  }
  const circleBuckets: CircleCarrierBucket[] = [];

  for (const as of arcSpans) {
    let bucket: CircleCarrierBucket | null = null;
    for (const cb of circleBuckets) {
      if (
        Math.hypot(cb.center.u - as.center.u, cb.center.v - as.center.v) <= 0.3 &&
        Math.abs(cb.radius - as.radius) <= 0.3
      ) {
        bucket = cb;
        break;
      }
    }
    if (!bucket) {
      bucket = {
        center: as.center,
        radius: as.radius,
        solidArcs: [],
        dashedArcs: [],
      };
      circleBuckets.push(bucket);
    }
    if (as.lineType === 'thick_solid') bucket.solidArcs.push(as);
    else bucket.dashedArcs.push(as);
  }

  const circlesForCenterlines: { center: Vec2; radius: number }[] = [];

  for (const cb of circleBuckets) {
    // Discretize angular coverage into 360 bins (1 degree each) for exact cyclic wrap-around union & subtraction
    const BINS = 360;
    const solidMask = new Uint8Array(BINS);
    const dashedMask = new Uint8Array(BINS);

    const markBins = (arcs: ClassifiedArcSpan2D[], mask: Uint8Array) => {
      for (const a of arcs) {
        if (a.sweep >= TWO_PI - 1e-2) {
          mask.fill(1);
          return;
        }
        const nSteps = Math.max(4, Math.ceil((a.sweep / TWO_PI) * BINS * 2));
        for (let k = 0; k <= nSteps; k++) {
          const ang = normAngle(a.startAngle + (k / nSteps) * a.sweep);
          const idx = Math.min(BINS - 1, Math.floor((ang / TWO_PI) * BINS));
          mask[idx] = 1;
        }
      }
    };

    markBins(cb.solidArcs, solidMask);
    markBins(cb.dashedArcs, dashedMask);

    // Mask dashed where solid already exists
    for (let i = 0; i < BINS; i++) {
      if (solidMask[i] === 1) dashedMask[i] = 0;
    }

    const emitFromAngularMask = (
      mask: Uint8Array,
      lineType: 'thick_solid' | 'thin_dashed',
      sourceArcs: ClassifiedArcSpan2D[]
    ) => {
      const countOnes = mask.reduce((s, v) => s + v, 0);
      if (countOnes === 0) return;

      const meta = sourceArcs[0];
      if (countOnes >= BINS - 2) {
        entities.push({
          id: `${idPrefix}_cir_${seq++}`,
          view: targetView,
          type: 'circle',
          lineType,
          center: roundPt(cb.center),
          radius: roundCoord(cb.radius),
          source: 'derived',
          featureId: meta?.featureId,
          featureLabel: meta?.featureLabel,
        });
        circlesForCenterlines.push({ center: cb.center, radius: cb.radius });
        return;
      }

      // If single original arc with exact endpoints and no overlap fragmentation, preserve exact angles!
      if (
        sourceArcs.length === 1 &&
        (lineType === 'thick_solid' || cb.solidArcs.length === 0)
      ) {
        const orig = sourceArcs[0];
        entities.push({
          id: `${idPrefix}_arc_${seq++}`,
          view: targetView,
          type: 'arc',
          lineType,
          center: roundPt(cb.center),
          radius: roundCoord(cb.radius),
          startAngle: normAngle(orig.startAngle),
          endAngle: normAngle(orig.startAngle + orig.sweep),
          source: 'derived',
          featureId: orig.featureId,
          featureLabel: orig.featureLabel,
        });
        circlesForCenterlines.push({ center: cb.center, radius: cb.radius });
        return;
      }

      // Extract cyclic runs from mask
      let startZero = 0;
      while (startZero < BINS && mask[startZero] === 1) startZero++;
      let inRun = false;
      let runStart = 0;
      for (let step = 0; step <= BINS; step++) {
        const idx = (startZero + step) % BINS;
        const val = step === BINS ? 0 : mask[idx];
        if (val === 1 && !inRun) {
          inRun = true;
          runStart = idx;
        } else if (val === 0 && inRun) {
          inRun = false;
          const aStart = (runStart / BINS) * TWO_PI;
          const aEnd = (idx / BINS) * TWO_PI;
          entities.push({
            id: `${idPrefix}_arc_${seq++}`,
            view: targetView,
            type: 'arc',
            lineType,
            center: roundPt(cb.center),
            radius: roundCoord(cb.radius),
            startAngle: normAngle(aStart),
            endAngle: normAngle(aEnd),
            source: 'derived',
            featureId: meta?.featureId,
            featureLabel: meta?.featureLabel,
          });
          circlesForCenterlines.push({ center: cb.center, radius: cb.radius });
        }
      }
    };

    emitFromAngularMask(solidMask, 'thick_solid', cb.solidArcs);
    emitFromAngularMask(dashedMask, 'thin_dashed', cb.dashedArcs);
  }

  // ==========================================================================
  // 3. Smooth SSI Non-Linear Polylines (Saddle Curves, Hyperbolic Cone Cuts)
  // ==========================================================================
  for (const ps of polySpans) {
    if (ps.points.length < 2) continue;
    entities.push({
      id: `${idPrefix}_ssi_${seq++}`,
      view: targetView,
      type: 'polygon',
      lineType: ps.lineType,
      points: ps.points.map(roundPt),
      closed: ps.closed,
      source: 'derived',
      featureId: ps.featureId,
      featureLabel: ps.featureLabel ?? '曲面相贯线',
    });
  }

  // ==========================================================================
  // 4. GB/T 4458.4 Symmetry Cross-Centerlines & Revolution Axes (`center_dot_dash`)
  // ==========================================================================
  const centerlineCandidates: { p1: Vec2; p2: Vec2; label: string }[] = [];

  // 4a. Group concentric circles/arcs in targetView and emit crosshairs on max radius + 3.5mm
  const groupedCenters: { center: Vec2; maxR: number }[] = [];
  for (const c of circlesForCenterlines) {
    const existing = groupedCenters.find(
      (g) => Math.hypot(g.center.u - c.center.u, g.center.v - c.center.v) <= 0.6
    );
    if (existing) {
      existing.maxR = Math.max(existing.maxR, c.radius);
    } else {
      groupedCenters.push({ center: c.center, maxR: c.radius });
    }
  }

  for (const gc of groupedCenters) {
    const ext = gc.maxR + 3.5;
    centerlineCandidates.push(
      {
        p1: { u: gc.center.u - ext, v: gc.center.v },
        p2: { u: gc.center.u + ext, v: gc.center.v },
        label: '圆对称中心线',
      },
      {
        p1: { u: gc.center.u, v: gc.center.v - ext },
        p2: { u: gc.center.u, v: gc.center.v + ext },
        label: '圆对称中心线',
      }
    );
  }

  // 4b. Side-projected revolution axes for cylinders, cones/frustums, spheres, hemispheres
  const emitSideAxisForPrimitive = (pr: Primitive3D) => {
    if (pr.shape === 'cylinder_x' || pr.shape === 'cylinder_y' || pr.shape === 'cylinder_z') {
      const cx = pr.centerX ?? 0.5 * (pr.xMin + pr.xMax);
      const cy = pr.centerY ?? 0.5 * (pr.yMin + pr.yMax);
      const cz = pr.centerZ ?? 0.5 * (pr.zMin + pr.zMax);
      const xLo = pr.operation === 'subtract' ? Math.max(pr.xMin, model.bounds.xMin) : pr.xMin;
      const xHi = pr.operation === 'subtract' ? Math.min(pr.xMax, model.bounds.xMax) : pr.xMax;
      const yLo = pr.operation === 'subtract' ? Math.max(pr.yMin, model.bounds.yMin) : pr.yMin;
      const yHi = pr.operation === 'subtract' ? Math.min(pr.yMax, model.bounds.yMax) : pr.yMax;
      const zLo = pr.operation === 'subtract' ? Math.max(pr.zMin, model.bounds.zMin) : pr.zMin;
      const zHi = pr.operation === 'subtract' ? Math.min(pr.zMax, model.bounds.zMax) : pr.zMax;
      const pA =
        pr.shape === 'cylinder_z'
          ? { x: cx, y: cy, z: zLo }
          : pr.shape === 'cylinder_y'
            ? { x: cx, y: yLo, z: cz }
            : { x: xLo, y: cy, z: cz };
      const pB =
        pr.shape === 'cylinder_z'
          ? { x: cx, y: cy, z: zHi }
          : pr.shape === 'cylinder_y'
            ? { x: cx, y: yHi, z: cz }
            : { x: xHi, y: cy, z: cz };
      const qA = projectPoint3DToView(pA, targetView);
      const qB = projectPoint3DToView(pB, targetView);
      const d = Math.hypot(qB.u - qA.u, qB.v - qA.v);
      if (d > 2.0) {
        const du = (qB.u - qA.u) / d;
        const dv = (qB.v - qA.v) / d;
        centerlineCandidates.push({
          p1: { u: qA.u - 3.5 * du, v: qA.v - 3.5 * dv },
          p2: { u: qB.u + 3.5 * du, v: qB.v + 3.5 * dv },
          label: '回转体轴线',
        });
      }
    } else if (
      pr.shape === 'generalized_loft' &&
      pr.loftSpec &&
      (pr.loftSpec.section0.kind === 'circle' || pr.loftSpec.section1.kind === 'circle')
    ) {
      const s0 = pr.loftSpec.section0;
      const s1 = pr.loftSpec.section1;
      // Only emit revolution axis if coaxial (not eccentric oblique frustum!)
      if (Math.hypot(s0.centerU - s1.centerU, s0.centerV - s1.centerV) <= 0.5) {
        const ax = pr.loftSpec.axis;
        const pA =
          ax === 'Z'
            ? { x: s0.centerU, y: s0.centerV, z: pr.loftSpec.w0 }
            : ax === 'Y'
              ? { x: s0.centerU, y: pr.loftSpec.w0, z: s0.centerV }
              : { x: pr.loftSpec.w0, y: s0.centerU, z: s0.centerV };
        const pB =
          ax === 'Z'
            ? { x: s1.centerU, y: s1.centerV, z: pr.loftSpec.w1 }
            : ax === 'Y'
              ? { x: s1.centerU, y: pr.loftSpec.w1, z: s1.centerV }
              : { x: pr.loftSpec.w1, y: s1.centerU, z: s1.centerV };
        const qA = projectPoint3DToView(pA, targetView);
        const qB = projectPoint3DToView(pB, targetView);
        const d = Math.hypot(qB.u - qA.u, qB.v - qA.v);
        if (d > 2.0) {
          const du = (qB.u - qA.u) / d;
          const dv = (qB.v - qA.v) / d;
          centerlineCandidates.push({
            p1: { u: qA.u - 3.5 * du, v: qA.v - 3.5 * dv },
            p2: { u: qB.u + 3.5 * du, v: qB.v + 3.5 * dv },
            label: '回转体轴线',
          });
        }
      }
    }
  };

  for (const pr of model.coalescedPrimitives) {
    emitSideAxisForPrimitive(pr);
  }

  // Merge collinear centerlines so coaxial stepped cylinders emit ONE unified axis line!
  const centerBuckets: {
    dir: Vec2;
    origin: Vec2;
    offsetC: number;
    intervals: Interval1D[];
  }[] = [];

  for (const cl of centerlineCandidates) {
    const du = cl.p2.u - cl.p1.u;
    const dv = cl.p2.v - cl.p1.v;
    const len = Math.hypot(du, dv);
    if (len < 1.0) continue;
    let dirU = du / len;
    let dirV = dv / len;
    if (Math.abs(dirU) < 5e-3) {
      dirU = 0;
      dirV = 1;
    } else if (Math.abs(dirV) < 5e-3) {
      dirU = 1;
      dirV = 0;
    } else if (dirU < 0) {
      dirU = -dirU;
      dirV = -dirV;
    }
    const normU = -dirV;
    const normV = dirU;
    const offsetC = normU * cl.p1.u + normV * cl.p1.v;

    let cb = centerBuckets.find(
      (b) => b.dir.u * dirU + b.dir.v * dirV > 0.999 && Math.abs(b.offsetC - offsetC) <= 0.4
    );
    if (!cb) {
      cb = {
        dir: { u: dirU, v: dirV },
        origin: { u: normU * offsetC, v: normV * offsetC },
        offsetC,
        intervals: [],
      };
      centerBuckets.push(cb);
    }
    const t1 = (cl.p1.u - cb.origin.u) * cb.dir.u + (cl.p1.v - cb.origin.v) * cb.dir.v;
    const t2 = (cl.p2.u - cb.origin.u) * cb.dir.u + (cl.p2.v - cb.origin.v) * cb.dir.v;
    cb.intervals.push({ a: Math.min(t1, t2), b: Math.max(t1, t2), featureLabel: cl.label });
  }

  for (const cb of centerBuckets) {
    const mergedRaw = merge1DIntervals(cb.intervals, 2.5);
    // Strict GB/T 4458.4 priority: `thick_solid` and `thin_dashed` mask coincident `center_dot_dash`!
    const collinearOccluders: Interval1D[] = [];
    for (const lb of lineBuckets) {
      const dot = lb.dir.u * cb.dir.u + lb.dir.v * cb.dir.v;
      const perpDist = Math.abs(
        (lb.anchor.u - cb.origin.u) * cb.dir.v - (lb.anchor.v - cb.origin.v) * cb.dir.u
      );
      if (dot > 0.999 && perpDist <= 0.4) {
        for (const iv of [...lb.solidIntervals, ...lb.dashedIntervals]) {
          const pA = { u: lb.anchor.u + iv.a * lb.dir.u, v: lb.anchor.v + iv.a * lb.dir.v };
          const pB = { u: lb.anchor.u + iv.b * lb.dir.u, v: lb.anchor.v + iv.b * lb.dir.v };
          const tA = (pA.u - cb.origin.u) * cb.dir.u + (pA.v - cb.origin.v) * cb.dir.v;
          const tB = (pB.u - cb.origin.u) * cb.dir.u + (pB.v - cb.origin.v) * cb.dir.v;
          collinearOccluders.push({ a: Math.min(tA, tB), b: Math.max(tA, tB) });
        }
      }
    }
    const merged =
      collinearOccluders.length > 0
        ? subtract1DIntervals(mergedRaw, merge1DIntervals(collinearOccluders, 0.35), 4.0)
        : mergedRaw;

    for (const iv of merged) {
      entities.push({
        id: `${idPrefix}_cl_${seq++}`,
        view: targetView,
        type: 'line',
        lineType: 'center_dot_dash',
        p1: roundPt({ u: cb.origin.u + iv.a * cb.dir.u, v: cb.origin.v + iv.a * cb.dir.v }),
        p2: roundPt({ u: cb.origin.u + iv.b * cb.dir.u, v: cb.origin.v + iv.b * cb.dir.v }),
        source: 'derived',
        featureLabel: iv.featureLabel ?? '对称中心线',
      });
    }
  }

  return entities;
}
