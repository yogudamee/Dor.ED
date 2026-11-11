import { Point2D, Primitive3D, ViewType } from '../../types/cad';
import {
  arcSweepCCW,
  dist2,
  pointToArcSegDist,
  pointToLineSegDist,
} from '../core/coordSystem';
import {
  ClassifiedSegment2D,
  CurveSegment2D,
  ReprojectionVerificationReport,
  SSICurveChain3D,
  ViewArrangementResult,
  ViewReprojectionMetrics,
} from '../core/types';
import { extractAll3DEdgesForView } from '../hlr/edgeExtractor3D';
import { classifyEdgesForViewHLR } from '../hlr/visibilityClassifier';
import { traceAllSSICurves3D } from '../ssi/ssiTracer';

const MATCH_TOL_MM = 1.35;

function getCurveSegmentLength(seg: CurveSegment2D | ClassifiedSegment2D): number {
  if (
    seg.kind === 'arc' &&
    seg.center &&
    seg.radius !== undefined &&
    seg.startAngle !== undefined &&
    seg.endAngle !== undefined
  ) {
    return arcSweepCCW(seg.startAngle, seg.endAngle) * seg.radius;
  }
  return dist2(seg.p1, seg.p2);
}

function evalSegmentAt(
  seg: CurveSegment2D | ClassifiedSegment2D,
  t: number
): Point2D {
  if (
    seg.kind === 'arc' &&
    seg.center &&
    seg.radius !== undefined &&
    seg.startAngle !== undefined &&
    seg.endAngle !== undefined
  ) {
    const sw = arcSweepCCW(seg.startAngle, seg.endAngle);
    const ccw = 'ccw' in seg && seg.ccw === false ? false : true;
    const ang = ccw ? seg.startAngle + t * sw : seg.endAngle - t * sw;
    return {
      u: seg.center.u + seg.radius * Math.cos(ang),
      v: seg.center.v + seg.radius * Math.sin(ang),
    };
  }
  return {
    u: seg.p1.u + (seg.p2.u - seg.p1.u) * t,
    v: seg.p1.v + (seg.p2.v - seg.p1.v) * t,
  };
}

/**
 * Strictly FINITE segment/arc distance from point `p` to `seg` (NEVER infinite line!).
 * Any projected segment overhanging past `[p1, p2]` or `[startAngle, endAngle]` produces
 * positive distance equal to the exact overhang!
 */
export function pointToFiniteCurveDist(
  p: Point2D,
  seg: CurveSegment2D | ClassifiedSegment2D
): number {
  if (
    seg.kind === 'arc' &&
    seg.center &&
    seg.radius !== undefined &&
    seg.startAngle !== undefined &&
    seg.endAngle !== undefined
  ) {
    return pointToArcSegDist(
      p,
      seg.center,
      seg.radius,
      seg.startAngle,
      seg.endAngle
    ).dist;
  }
  return pointToLineSegDist(p, seg.p1, seg.p2).dist;
}

function minDistToCurveSet(
  p: Point2D,
  curves: (CurveSegment2D | ClassifiedSegment2D)[]
): number {
  let best = Infinity;
  for (const c of curves) {
    const d = pointToFiniteCurveDist(p, c);
    if (d < best) {
      best = d;
      if (best <= 0.15) return best;
    }
  }
  return best;
}

function verifySingleViewFiniteReprojection(
  primitives: Primitive3D[],
  arr: ViewArrangementResult,
  precomputedSSI?: SSICurveChain3D[]
): ViewReprojectionMetrics {
  const view: ViewType = arr.view;
  const extracted = extractAll3DEdgesForView(primitives, view, precomputedSSI);
  const derived = classifyEdgesForViewHLR(extracted, primitives, view);

  const userSolids = arr.splitSegments.filter(
    (s) => s.lineType === 'thick_solid'
  );
  const userDasheds = arr.splitSegments.filter(
    (s) => s.lineType === 'thin_dashed'
  );
  const derivedSolids = derived.filter((s) => s.lineType === 'thick_solid');
  const derivedDasheds = derived.filter((s) => s.lineType === 'thin_dashed');
  const allUserVisibleOrHidden = [...userSolids, ...userDasheds];

  // Identify polygonal prism featureIds so optional interior prism ridges in simplified views aren't over-penalized
  const prismFeatureIds = new Set<string>(
    primitives
      .filter((p) => p.operation !== 'subtract' && p.shape === 'prism')
      .map((p) => p.featureId)
  );

  // ==========================================================================
  // 1. User -> Derived Recall & Unexplained Error (strictly finite intervals!)
  // ==========================================================================
  let userSolidWeightTotal = 0;
  let userSolidWeightHit = 0;
  let unexplainedError = 0;

  let missingStepJumpPenalty = 0;
  const viewBounds = arr.bounds;

  for (const us of userSolids) {
    const len = getCurveSegmentLength(us);
    if (len < 0.25) continue;
    const nSamples = Math.max(3, Math.min(12, Math.ceil(len / 3.5)));
    const wPerSample = len / nSamples;

    let segMatchedSamples = 0;
    for (let k = 0; k < nSamples; k++) {
      const t = (k + 0.5) / nSamples;
      const pt = evalSegmentAt(us, t);
      const dSolid = minDistToCurveSet(pt, derivedSolids);
      userSolidWeightTotal += wPerSample;

      if (dSolid <= MATCH_TOL_MM) {
        userSolidWeightHit += wPerSample;
        segMatchedSamples++;
      } else {
        // Check if accidentally rendered as dashed (wrong depth/occlusion)
        const dAny = minDistToCurveSet(pt, derivedDasheds);
        const penaltyDist = Math.min(12.0, dSolid);
        unexplainedError +=
          dAny <= MATCH_TOL_MM
            ? wPerSample * 0.85
            : wPerSample * (1.0 + 0.15 * penaltyDist);
      }
    }

    // Hard Constraint 2: Interior `thick_solid` step line MUST correspond to a real 3D height/depth jump!
    if (viewBounds && segMatchedSamples / nSamples < 0.5 && len >= 3.0) {
      const mid = evalSegmentAt(us, 0.5);
      const strictlyInterior =
        mid.u > viewBounds.uMin + 1.5 &&
        mid.u < viewBounds.uMax - 1.5 &&
        mid.v > viewBounds.vMin + 1.5 &&
        mid.v < viewBounds.vMax - 1.5;
      if (strictlyInterior) {
        missingStepJumpPenalty += len * 1.8;
      }
    }
  }

  let userDashedWeightTotal = 0;
  let userDashedWeightHit = 0;

  for (const ud of userDasheds) {
    const len = getCurveSegmentLength(ud);
    if (len < 0.25) continue;
    const nSamples = Math.max(3, Math.min(10, Math.ceil(len / 4.0)));
    const wPerSample = len / nSamples;

    for (let k = 0; k < nSamples; k++) {
      const t = (k + 0.5) / nSamples;
      const pt = evalSegmentAt(ud, t);
      const dDash = minDistToCurveSet(pt, derivedDasheds);
      const dSolid = minDistToCurveSet(pt, derivedSolids);
      userDashedWeightTotal += wPerSample;

      if (dDash <= MATCH_TOL_MM) {
        userDashedWeightHit += wPerSample;
      } else if (dSolid <= MATCH_TOL_MM) {
        // Partially occluded/visible mismatch
        userDashedWeightHit += wPerSample * 0.35;
        unexplainedError += wPerSample * 0.65;
      } else {
        unexplainedError += wPerSample * 1.15;
      }
    }
  }

  const solidRecall =
    userSolidWeightTotal > 0 ? userSolidWeightHit / userSolidWeightTotal : 1.0;
  const dashedRecall =
    userDashedWeightTotal > 0
      ? userDashedWeightHit / userDashedWeightTotal
      : 1.0;

  // ==========================================================================
  // 2. Derived -> User Phantom Overhang & False Hole Penalty
  //    Because `pointToFiniteCurveDist` clamps to [p1, p2], any projected edge
  //    extending beyond a finite user line endpoint is penalized 100%!
  // ==========================================================================
  let phantomSolidError = 0;
  for (const ds of derivedSolids) {
    const len = getCurveSegmentLength(ds);
    if (len < 0.25) continue;
    const nSamples = Math.max(3, Math.min(10, Math.ceil(len / 4.0)));
    const wPerSample = len / nSamples;

    for (let k = 0; k < nSamples; k++) {
      const t = (k + 0.5) / nSamples;
      const pt = evalSegmentAt(ds, t);
      const dUserSolid = minDistToCurveSet(pt, userSolids);
      if (dUserSolid > MATCH_TOL_MM) {
        // Tolerate optional interior facet lines of polygonal prisms if inside bounds
        const isOptionalPrismCrease =
          ds.featureId !== undefined &&
          prismFeatureIds.has(ds.featureId) &&
          viewBounds !== null &&
          pt.u > viewBounds.uMin + 1.0 &&
          pt.u < viewBounds.uMax - 1.0 &&
          pt.v > viewBounds.vMin + 1.0 &&
          pt.v < viewBounds.vMax - 1.0;

        if (!isOptionalPrismCrease) {
          const overDist = Math.min(10.0, dUserSolid - MATCH_TOL_MM);
          phantomSolidError += wPerSample * (0.9 + 0.2 * overDist);
        }
      }
    }
  }

  // Track per-void-feature dashed evidence to enforce Hard Constraint 1 ("无虚线不打假孔")!
  const voidFeatureStats = new Map<
    string,
    { totalLen: number; matchedLen: number }
  >();
  let phantomDashedError = 0;

  for (const dd of derivedDasheds) {
    const len = getCurveSegmentLength(dd);
    if (len < 0.25) continue;
    const nSamples = Math.max(3, Math.min(10, Math.ceil(len / 4.0)));
    const wPerSample = len / nSamples;

    const fKey = dd.featureId ?? '';
    let stat = voidFeatureStats.get(fKey);
    if (!stat && fKey) {
      stat = { totalLen: 0, matchedLen: 0 };
      voidFeatureStats.set(fKey, stat);
    }

    for (let k = 0; k < nSamples; k++) {
      const t = (k + 0.5) / nSamples;
      const pt = evalSegmentAt(dd, t);
      const dUserDash = minDistToCurveSet(pt, userDasheds);
      const dUserAny = minDistToCurveSet(pt, allUserVisibleOrHidden);

      if (stat) stat.totalLen += wPerSample;

      if (dUserDash <= MATCH_TOL_MM) {
        if (stat) stat.matchedLen += wPerSample;
      } else if (dUserAny <= MATCH_TOL_MM * 0.9) {
        // Hidden line coincides with a foreground solid contour line (GB/T 4458.4 solid overrides dashed!)
        if (stat) stat.matchedLen += wPerSample * 0.9;
      } else {
        const overDist = Math.min(10.0, dUserDash - MATCH_TOL_MM);
        phantomDashedError += wPerSample * (1.1 + 0.2 * overDist);
      }
    }
  }

  // Identify subtract primitives whose projected hidden walls violate "无虚线不打假孔"
  const falseHoleIds: string[] = [];
  for (const vp of primitives) {
    if (vp.operation !== 'subtract') continue;
    const st = voidFeatureStats.get(vp.featureId);
    if (st && st.totalLen > 3.5) {
      const matchRatio = st.matchedLen / st.totalLen;
      if (matchRatio < 0.35) {
        falseHoleIds.push(vp.id);
        phantomDashedError += (st.totalLen - st.matchedLen) * 1.5;
      }
    }
  }

  // ==========================================================================
  // 3. Hard Constraint 3: Outer Solid Wall Integrity (No False Open Gap Splitting)
  // ==========================================================================
  let wallSplitPenalty = 0;
  if (viewBounds) {
    for (const lc of arr.lineCarriers) {
      if (!lc.hasSolid) continue;
      const onOuterBorder =
        (lc.isHorizontal &&
          (Math.abs((lc.coordConst ?? 0) - viewBounds.vMin) <= 0.8 ||
            Math.abs((lc.coordConst ?? 0) - viewBounds.vMax) <= 0.8)) ||
        (lc.isVertical &&
          (Math.abs((lc.coordConst ?? 0) - viewBounds.uMin) <= 0.8 ||
            Math.abs((lc.coordConst ?? 0) - viewBounds.uMax) <= 0.8));
      if (!onOuterBorder) continue;

      for (const iv of lc.intervals) {
        if (iv.lineType !== 'thick_solid') continue;
        const ivLen = iv.s1 - iv.s0;
        if (ivLen < 6.0) continue;
        // Sample 5 interior points on this continuous outer solid wall
        let hits = 0;
        for (const f of [0.15, 0.32, 0.5, 0.68, 0.85]) {
          const p = {
            u: iv.p1.u + (iv.p2.u - iv.p1.u) * f,
            v: iv.p1.v + (iv.p2.v - iv.p1.v) * f,
          };
          if (minDistToCurveSet(p, derivedSolids) <= MATCH_TOL_MM) {
            hits++;
          }
        }
        if (hits < 4) {
          wallSplitPenalty += ((5 - hits) / 5) * ivLen * 2.2;
        }
      }
    }
  }

  const totalScore =
    unexplainedError +
    phantomSolidError +
    phantomDashedError +
    missingStepJumpPenalty +
    wallSplitPenalty;

  return {
    view,
    solidRecall,
    dashedRecall,
    unexplainedError,
    phantomSolidError,
    phantomDashedError,
    missingStepJumpPenalty,
    wallSplitPenalty,
    falseHoleIds,
    totalScore,
  };
}

/**
 * Closed-loop 3D -> 2D quantitative reprojection verifier over the two known views `(arr1, arr2)`.
 */
export function verifyReprojectionFiniteIntervals(
  primitives: Primitive3D[],
  arr1: ViewArrangementResult,
  arr2: ViewArrangementResult,
  includeSSI = false
): ReprojectionVerificationReport {
  const ssi = includeSSI ? traceAllSSICurves3D(primitives) : [];
  const m1 = verifySingleViewFiniteReprojection(primitives, arr1, ssi);
  const m2 = verifySingleViewFiniteReprojection(primitives, arr2, ssi);

  const falseHoleSet = new Set<string>([...m1.falseHoleIds, ...m2.falseHoleIds]);
  const unexplainedError = m1.unexplainedError + m2.unexplainedError;
  const phantomError =
    m1.phantomSolidError +
    m1.phantomDashedError +
    m2.phantomSolidError +
    m2.phantomDashedError;
  const totalError = m1.totalScore + m2.totalScore;

  const r1 =
    arr1.splitSegments.some((s) => s.lineType === 'thin_dashed')
      ? 0.72 * m1.solidRecall + 0.28 * m1.dashedRecall
      : m1.solidRecall;
  const r2 =
    arr2.splitSegments.some((s) => s.lineType === 'thin_dashed')
      ? 0.72 * m2.solidRecall + 0.28 * m2.dashedRecall
      : m2.solidRecall;
  const recallKnownViews = Math.max(0, Math.min(1, 0.5 * (r1 + r2)));

  return {
    totalError,
    unexplainedError,
    phantomError,
    recallKnownViews,
    viewReports: [m1, m2],
    falseHoleIds: [...falseHoleSet],
  };
}
