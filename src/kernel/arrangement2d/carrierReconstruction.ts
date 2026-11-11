import { CadEntity, ViewType } from '../../types/cad';
import {
  AngularEvidenceSpan,
  BBox2D,
  CarrierCircle2D,
  CarrierLine2D,
  EvidenceSpan1D,
  ParallelDashedBand2D,
  PlanarArrangement2D,
  RegionProfile2D,
  SplitCurveSegment2D,
  TaperedDashedBand2D,
  Vec2,
} from '../types';
import {
  buildDCELFromSplitSegments,
  buildUnionFaceProfiles,
  classifyRegionProfile2D,
} from './dcelBuilder';
import { arcSweepCCW, computeArcBBox, dist2, normAngle, snapAndSplitViewEntities } from './snapAndSplit';

const TWO_PI = Math.PI * 2;

function unionBBox(boxes: BBox2D[]): BBox2D | null {
  if (boxes.length === 0) return null;
  let uMin = Infinity;
  let uMax = -Infinity;
  let vMin = Infinity;
  let vMax = -Infinity;
  for (const b of boxes) {
    if (b.uMin < uMin) uMin = b.uMin;
    if (b.uMax > uMax) uMax = b.uMax;
    if (b.vMin < vMin) vMin = b.vMin;
    if (b.vMax > vMax) vMax = b.vMax;
  }
  return Number.isFinite(uMin) ? { uMin, uMax, vMin, vMax } : null;
}

/**
 * Reconstructs underlying infinite analytical carrier lines (`CarrierLine2D[]`)
 * from split segments, merging collinear interrupted solid/dashed segments into unified carriers
 * while retaining exact solid/dashed interval spans.
 */
export function reconstructCarrierLines(
  splitSegments: SplitCurveSegment2D[],
  view: ViewType
): CarrierLine2D[] {
  const lineSegs = splitSegments.filter((s) => s.kind === 'line');
  const carriers: CarrierLine2D[] = [];

  for (const seg of lineSegs) {
    const du = seg.p2.u - seg.p1.u;
    const dv = seg.p2.v - seg.p1.v;
    const len = Math.hypot(du, dv);
    if (len < 0.25) continue;

    // Canonicalize unit direction so dir.u > 0, or dir.u == 0 and dir.v > 0
    let dirU = du / len;
    let dirV = dv / len;
    if (dirU < -1e-4 || (Math.abs(dirU) <= 1e-4 && dirV < 0)) {
      dirU = -dirU;
      dirV = -dirV;
    }
    const normU = -dirV;
    const normV = dirU;
    const offsetC = normU * seg.p1.u + normV * seg.p1.v;

    let matched: CarrierLine2D | null = null;
    for (const c of carriers) {
      const cosAng = Math.abs(c.dir.u * dirU + c.dir.v * dirV);
      if (cosAng >= Math.cos((1.2 * Math.PI) / 180) && Math.abs(c.offsetC - offsetC) <= 0.9) {
        matched = c;
        break;
      }
    }

    if (!matched) {
      const t1 = dirU * seg.p1.u + dirV * seg.p1.v;
      const t2 = dirU * seg.p2.u + dirV * seg.p2.v;
      const tMin = Math.min(t1, t2);
      const tMax = Math.max(t1, t2);
      const pMin = t1 <= t2 ? { ...seg.p1 } : { ...seg.p2 };
      const pMax = t1 <= t2 ? { ...seg.p2 } : { ...seg.p1 };
      matched = {
        id: `cl-${view}-${carriers.length}`,
        kind: 'line',
        view,
        origin: { ...pMin },
        dir: { u: dirU, v: dirV },
        normal: { u: normU, v: normV },
        offsetC,
        tMin,
        tMax,
        pMin,
        pMax,
        isHorizontal: Math.abs(dirV) <= 0.02,
        isVertical: Math.abs(dirU) <= 0.02,
        hasSolid: seg.lineType === 'thick_solid',
        hasDashed: seg.lineType === 'thin_dashed',
        spans: [
          {
            tMin,
            tMax,
            p1: { ...pMin },
            p2: { ...pMax },
            lineType: seg.lineType,
            sourceEntityId: seg.sourceEntityId,
          },
        ],
      };
      carriers.push(matched);
    } else {
      const t1 = matched.dir.u * seg.p1.u + matched.dir.v * seg.p1.v;
      const t2 = matched.dir.u * seg.p2.u + matched.dir.v * seg.p2.v;
      const sMin = Math.min(t1, t2);
      const sMax = Math.max(t1, t2);
      const pMin = t1 <= t2 ? { ...seg.p1 } : { ...seg.p2 };
      const pMax = t1 <= t2 ? { ...seg.p2 } : { ...seg.p1 };
      if (sMin < matched.tMin) {
        matched.tMin = sMin;
        matched.pMin = pMin;
      }
      if (sMax > matched.tMax) {
        matched.tMax = sMax;
        matched.pMax = pMax;
      }
      if (seg.lineType === 'thick_solid') matched.hasSolid = true;
      if (seg.lineType === 'thin_dashed') matched.hasDashed = true;
      matched.spans.push({
        tMin: sMin,
        tMax: sMax,
        p1: pMin,
        p2: pMax,
        lineType: seg.lineType,
        sourceEntityId: seg.sourceEntityId,
      });
    }
  }

  for (const c of carriers) {
    c.spans.sort((a, b) => a.tMin - b.tMin);
    // Coalesce contiguous spans of identical lineType
    const mergedSpans: EvidenceSpan1D[] = [];
    for (const sp of c.spans) {
      if (
        mergedSpans.length > 0 &&
        mergedSpans[mergedSpans.length - 1].lineType === sp.lineType &&
        sp.tMin <= mergedSpans[mergedSpans.length - 1].tMax + 0.5
      ) {
        const prev = mergedSpans[mergedSpans.length - 1];
        if (sp.tMax > prev.tMax) {
          prev.tMax = sp.tMax;
          prev.p2 = sp.p2;
        }
      } else {
        mergedSpans.push({ ...sp });
      }
    }
    c.spans = mergedSpans;
  }

  return carriers;
}

/**
 * Reconstructs underlying analytical circles (`CarrierCircle2D[]`) by stitching concentric
 * equal-radius solid + dashed arcs (e.g., Cone + Rear Hemisphere!) and identifying trimmed
 * major arcs and shared-chord semicircles.
 */
export function reconstructCarrierCircles(
  splitSegments: SplitCurveSegment2D[],
  carrierLines: CarrierLine2D[],
  view: ViewType
): CarrierCircle2D[] {
  const arcSegs = splitSegments.filter((s) => s.kind === 'arc' && s.center && s.radius);
  const circles: CarrierCircle2D[] = [];

  for (const seg of arcSegs) {
    const center = seg.center!;
    const radius = seg.radius!;
    const sA = seg.startAngle ?? 0;
    const eA = seg.endAngle ?? 0;
    const sweep = arcSweepCCW(sA, eA);

    let matched: CarrierCircle2D | null = null;
    for (const c of circles) {
      if (dist2(c.center, center) <= 1.0 && Math.abs(c.radius - radius) <= 1.0) {
        matched = c;
        break;
      }
    }

    const angSpan: AngularEvidenceSpan = {
      startAngle: sA,
      sweep,
      lineType: seg.lineType,
      sourceEntityId: seg.sourceEntityId,
    };

    if (!matched) {
      matched = {
        id: `cc-${view}-${circles.length}`,
        kind: 'circle',
        view,
        center: { ...center },
        radius,
        totalSolidSweep: seg.lineType === 'thick_solid' ? sweep : 0,
        totalDashedSweep: seg.lineType === 'thin_dashed' ? sweep : 0,
        totalSweep: sweep,
        isFullCircle: false,
        isMajorTrimmedArc: false,
        isSemicircle: false,
        angularSpans: [angSpan],
        bbox: computeArcBBox(center, radius, sA, eA),
      };
      circles.push(matched);
    } else {
      matched.angularSpans.push(angSpan);
      if (seg.lineType === 'thick_solid') matched.totalSolidSweep += sweep;
      if (seg.lineType === 'thin_dashed') matched.totalDashedSweep += sweep;
      matched.totalSweep = Math.min(TWO_PI, matched.totalSolidSweep + matched.totalDashedSweep);
      const b = computeArcBBox(center, radius, sA, eA);
      matched.bbox = {
        uMin: Math.min(matched.bbox.uMin, b.uMin),
        uMax: Math.max(matched.bbox.uMax, b.uMax),
        vMin: Math.min(matched.bbox.vMin, b.vMin),
        vMax: Math.max(matched.bbox.vMax, b.vMax),
      };
    }
  }

  for (const c of circles) {
    if (c.totalSweep >= TWO_PI - 0.18) {
      c.isFullCircle = true;
      c.bbox = {
        uMin: c.center.u - c.radius,
        uMax: c.center.u + c.radius,
        vMin: c.center.v - c.radius,
        vMax: c.center.v + c.radius,
      };
    } else if (c.totalSweep >= Math.PI + 0.25) {
      // Trimmed major arc (> 195°), e.g., hemisphere partially occluded by front cone!
      c.isMajorTrimmedArc = true;
    } else if (Math.abs(c.totalSweep - Math.PI) <= 0.22) {
      // Check if endpoints lie on a horizontal or vertical solid/dashed carrier chord passing through center!
      const horizChord = carrierLines.find(
        (cl) =>
          cl.isHorizontal &&
          Math.abs(cl.pMin.v - c.center.v) <= 1.5 &&
          Math.min(cl.pMin.u, cl.pMax.u) <= c.center.u - c.radius + 2.0 &&
          Math.max(cl.pMin.u, cl.pMax.u) >= c.center.u + c.radius - 2.0
      );
      const vertChord = !horizChord
        ? carrierLines.find(
            (cl) =>
              cl.isVertical &&
              Math.abs(cl.pMin.u - c.center.u) <= 1.5 &&
              Math.min(cl.pMin.v, cl.pMax.v) <= c.center.v - c.radius + 2.0 &&
              Math.max(cl.pMin.v, cl.pMax.v) >= c.center.v + c.radius - 2.0
          )
        : undefined;

      if (horizChord) {
        c.isSemicircle = true;
        const midAng = normAngle(
          c.angularSpans[0].startAngle + 0.5 * c.angularSpans[0].sweep
        );
        const midV = c.center.v + c.radius * Math.sin(midAng);
        const keepGreater = midV > c.center.v;
        c.sharedChord = {
          axis: 'v',
          coord: c.center.v,
          keepGreater,
          uMin: c.center.u - c.radius,
          uMax: c.center.u + c.radius,
          vMin: keepGreater ? c.center.v : c.center.v - c.radius,
          vMax: keepGreater ? c.center.v + c.radius : c.center.v,
        };
      } else if (vertChord) {
        c.isSemicircle = true;
        const midAng = normAngle(
          c.angularSpans[0].startAngle + 0.5 * c.angularSpans[0].sweep
        );
        const midU = c.center.u + c.radius * Math.cos(midAng);
        const keepGreater = midU > c.center.u;
        c.sharedChord = {
          axis: 'u',
          coord: c.center.u,
          keepGreater,
          uMin: keepGreater ? c.center.u : c.center.u - c.radius,
          uMax: keepGreater ? c.center.u + c.radius : c.center.u,
          vMin: c.center.v - c.radius,
          vMax: c.center.v + c.radius,
        };
      }
    }
  }

  return circles;
}

/**
 * Extracts parallel dashed bands (including collinear interrupted dashed lines passing through a circle/box!)
 * and tapered dashed bands (`八字形斜細虛線對`).
 */
export function extractDashedBandsFromCarriers(
  carrierLines: CarrierLine2D[],
  carrierCircles: CarrierCircle2D[],
  solidSegments: SplitCurveSegment2D[],
  solidBBox: BBox2D | null,
  view: ViewType,
  outerSilhouetteLoops: RegionProfile2D[] = []
): {
  parallelDashedBands: ParallelDashedBand2D[];
  taperedDashedBands: TaperedDashedBand2D[];
} {
  const parallelDashedBands: ParallelDashedBand2D[] = [];
  const taperedDashedBands: TaperedDashedBand2D[] = [];

  const isPointNearOuterBoundary = (pt: Vec2, tol = 2.6): boolean => {
    if (outerSilhouetteLoops.length > 0) {
      for (const ol of outerSilhouetteLoops) {
        for (const s of ol.segments) {
          if (s.kind === 'line') {
            const du = s.p2.u - s.p1.u;
            const dv = s.p2.v - s.p1.v;
            const lenSq = du * du + dv * dv;
            const t =
              lenSq > 1e-6
                ? Math.max(0, Math.min(1, ((pt.u - s.p1.u) * du + (pt.v - s.p1.v) * dv) / lenSq))
                : 0;
            const foot = { u: s.p1.u + t * du, v: s.p1.v + t * dv };
            if (dist2(pt, foot) <= tol) return true;
          } else if (s.center && s.radius !== undefined) {
            if (Math.abs(dist2(pt, s.center) - s.radius) <= tol) return true;
          }
        }
      }
      return false;
    }

    for (const s of solidSegments) {
      if (s.kind === 'line') {
        const du = s.p2.u - s.p1.u;
        const dv = s.p2.v - s.p1.v;
        const lenSq = du * du + dv * dv;
        const t =
          lenSq > 1e-6
            ? Math.max(0, Math.min(1, ((pt.u - s.p1.u) * du + (pt.v - s.p1.v) * dv) / lenSq))
            : 0;
        const foot = { u: s.p1.u + t * du, v: s.p1.v + t * dv };
        if (dist2(pt, foot) <= tol) return true;
      } else if (s.center && s.radius) {
        if (Math.abs(dist2(pt, s.center) - s.radius) <= tol) return true;
      }
    }
    return false;
  };

  // Advances open-mouth span endpoints across slanted polygon prows (e.g. regular hexagon front vertex
  // at Y=100 while generators at X=50,70 hit slanted edges at Y=94.23) or curved arches!
  const extendOpenMouthToOuterProw = (
    orientation: 'vertical' | 'horizontal',
    coordMin: number,
    coordMax: number,
    unionMin: number,
    unionMax: number,
    touchMin: boolean,
    touchMax: boolean
  ): { effMin: number; effMax: number } => {
    let effMin = unionMin;
    let effMax = unionMax;
    if (!touchMin && !touchMax) return { effMin, effMax };

    const sampleCoords = [coordMin, 0.5 * (coordMin + coordMax), coordMax];
    for (const ol of outerSilhouetteLoops) {
      const poly = ol.densePolygon;
      if (poly.length < 3) continue;

      for (const p of poly) {
        const c = orientation === 'vertical' ? p.u : p.v;
        const s = orientation === 'vertical' ? p.v : p.u;
        if (c >= coordMin - 0.5 && c <= coordMax + 0.5) {
          if (touchMax && s > effMax) effMax = s;
          if (touchMin && s < effMin) effMin = s;
        }
      }

      for (let k = 0; k < poly.length; k++) {
        const a = poly[k];
        const b = poly[(k + 1) % poly.length];
        const cA = orientation === 'vertical' ? a.u : a.v;
        const cB = orientation === 'vertical' ? b.u : b.v;
        const sA = orientation === 'vertical' ? a.v : a.u;
        const sB = orientation === 'vertical' ? b.v : b.u;
        if (Math.abs(cB - cA) < 1e-6) continue;
        for (const sc of sampleCoords) {
          if ((sc >= cA && sc <= cB) || (sc >= cB && sc <= cA)) {
            const t = (sc - cA) / (cB - cA);
            const sHit = sA + t * (sB - sA);
            if (touchMax && sHit > effMax) effMax = sHit;
            if (touchMin && sHit < effMin) effMin = sHit;
          }
        }
      }
    }

    if (orientation === 'vertical' && solidBBox) {
      if (touchMax) {
        for (const cc of carrierCircles) {
          if (cc.center.u >= coordMin - 1 && cc.center.u <= coordMax + 1) {
            const archTop = cc.center.v + cc.radius;
            if (
              archTop > effMax &&
              archTop <= solidBBox.vMax + 1.5 &&
              Math.abs(dist2({ u: coordMin, v: unionMax }, cc.center) - cc.radius) <= 2.8
            ) {
              effMax = archTop;
            }
          }
        }
      }
      if (touchMin) {
        for (const cc of carrierCircles) {
          if (cc.center.u >= coordMin - 1 && cc.center.u <= coordMax + 1) {
            const archBot = cc.center.v - cc.radius;
            if (
              archBot < effMin &&
              archBot >= solidBBox.vMin - 1.5 &&
              Math.abs(dist2({ u: coordMin, v: unionMin }, cc.center) - cc.radius) <= 2.8
            ) {
              effMin = archBot;
            }
          }
        }
      }
    }

    return { effMin, effMax };
  };

  // Collect vertical dashed carrier lines
  const vertDashed = carrierLines
    .filter((cl) => cl.isVertical && cl.hasDashed)
    .map((cl) => {
      const dashedSpans = cl.spans.filter((sp) => sp.lineType === 'thin_dashed');
      const uVal = 0.5 * (cl.pMin.u + cl.pMax.u);
      const vMin = Math.min(...dashedSpans.map((s) => Math.min(s.p1.v, s.p2.v)));
      const vMax = Math.max(...dashedSpans.map((s) => Math.max(s.p1.v, s.p2.v)));
      let wasInterrupted = dashedSpans.length >= 2;
      if (wasInterrupted) {
        // Verify gap is bridged by a circle or inner loop or small interruption
        const gapMidV =
          0.5 *
          (Math.max(dashedSpans[0].p1.v, dashedSpans[0].p2.v) +
            Math.min(
              dashedSpans[dashedSpans.length - 1].p1.v,
              dashedSpans[dashedSpans.length - 1].p2.v
            ));
        const inCircle = carrierCircles.some(
          (cc) => dist2({ u: uVal, v: gapMidV }, cc.center) <= cc.radius + 2.5
        );
        wasInterrupted = inCircle || dashedSpans.length >= 2;
      }
      return { uVal, vMin, vMax, wasInterrupted, spans: dashedSpans };
    })
    .sort((a, b) => a.uVal - b.uVal);

  for (let i = 0; i < vertDashed.length; i++) {
    for (let j = i + 1; j < vertDashed.length; j++) {
      const L = vertDashed[i];
      const R = vertDashed[j];
      if (R.uVal - L.uVal < 2.0) continue;
      const overlapMin = Math.max(L.vMin, R.vMin);
      const overlapMax = Math.min(L.vMax, R.vMax);
      const unionMin = Math.min(L.vMin, R.vMin);
      const unionMax = Math.max(L.vMax, R.vMax);
      if (
        overlapMax - overlapMin >= 2.0 ||
        (Math.abs(L.vMin - R.vMin) <= 4.0 && Math.abs(L.vMax - R.vMax) <= 4.0)
      ) {
        const touchMin =
          isPointNearOuterBoundary({ u: L.uVal, v: L.vMin }, 2.6) ||
          isPointNearOuterBoundary({ u: R.uVal, v: R.vMin }, 2.6) ||
          (solidBBox ? unionMin <= solidBBox.vMin + 2.2 : false);
        const touchMax =
          isPointNearOuterBoundary({ u: L.uVal, v: L.vMax }, 2.6) ||
          isPointNearOuterBoundary({ u: R.uVal, v: R.vMax }, 2.6) ||
          (solidBBox ? unionMax >= solidBBox.vMax - 2.2 : false);

        const { effMin, effMax } = extendOpenMouthToOuterProw(
          'vertical',
          L.uVal,
          R.uVal,
          unionMin,
          unionMax,
          touchMin,
          touchMax
        );

        parallelDashedBands.push({
          id: `pdb-${view}-v-${parallelDashedBands.length}`,
          view,
          orientation: 'vertical',
          coordMin: L.uVal,
          coordMax: R.uVal,
          spanMin: effMin,
          spanMax: effMax,
          touchesMinBoundary: touchMin,
          touchesMaxBoundary: touchMax,
          wasInterruptedByHole: L.wasInterrupted || R.wasInterrupted,
        });
      }
    }
  }

  // Collect horizontal dashed carrier lines
  const horizDashed = carrierLines
    .filter((cl) => cl.isHorizontal && cl.hasDashed)
    .map((cl) => {
      const dashedSpans = cl.spans.filter((sp) => sp.lineType === 'thin_dashed');
      const vVal = 0.5 * (cl.pMin.v + cl.pMax.v);
      const uMin = Math.min(...dashedSpans.map((s) => Math.min(s.p1.u, s.p2.u)));
      const uMax = Math.max(...dashedSpans.map((s) => Math.max(s.p1.u, s.p2.u)));
      return { vVal, uMin, uMax, wasInterrupted: dashedSpans.length >= 2 };
    })
    .sort((a, b) => a.vVal - b.vVal);

  for (let i = 0; i < horizDashed.length; i++) {
    for (let j = i + 1; j < horizDashed.length; j++) {
      const B = horizDashed[i];
      const T = horizDashed[j];
      if (T.vVal - B.vVal < 2.0) continue;
      const overlapMin = Math.max(B.uMin, T.uMin);
      const overlapMax = Math.min(B.uMax, T.uMax);
      const unionMin = Math.min(B.uMin, T.uMin);
      const unionMax = Math.max(B.uMax, T.uMax);
      if (
        overlapMax - overlapMin >= 2.0 ||
        (Math.abs(B.uMin - T.uMin) <= 4.0 && Math.abs(B.uMax - T.uMax) <= 4.0)
      ) {
        const touchMin =
          isPointNearOuterBoundary({ u: B.uMin, v: B.vVal }, 2.6) ||
          isPointNearOuterBoundary({ u: T.uMin, v: T.vVal }, 2.6) ||
          (solidBBox ? unionMin <= solidBBox.uMin + 2.2 : false);
        const touchMax =
          isPointNearOuterBoundary({ u: B.uMax, v: B.vVal }, 2.6) ||
          isPointNearOuterBoundary({ u: T.uMax, v: T.vVal }, 2.6) ||
          (solidBBox ? unionMax >= solidBBox.uMax - 2.2 : false);

        const { effMin, effMax } = extendOpenMouthToOuterProw(
          'horizontal',
          B.vVal,
          T.vVal,
          unionMin,
          unionMax,
          touchMin,
          touchMax
        );

        parallelDashedBands.push({
          id: `pdb-${view}-h-${parallelDashedBands.length}`,
          view,
          orientation: 'horizontal',
          coordMin: B.vVal,
          coordMax: T.vVal,
          spanMin: effMin,
          spanMax: effMax,
          touchesMinBoundary: touchMin,
          touchesMaxBoundary: touchMax,
          wasInterruptedByHole: B.wasInterrupted || T.wasInterrupted,
        });
      }
    }
  }

  // Extract Tapered Dashed Bands (八字形斜細虛線對): oblique dashed carrier lines
  const obliqueDashed = carrierLines.filter(
    (cl) => cl.hasDashed && (!cl.isHorizontal || !cl.isVertical) && !(cl.isHorizontal || cl.isVertical)
  );
  // Also allow pairing one oblique dashed line with one vertical/horizontal dashed line (e.g., right-angled half-cone hole!)
  const candidateTaperLines = carrierLines.filter((cl) => cl.hasDashed);

  for (let i = 0; i < candidateTaperLines.length; i++) {
    for (let j = i + 1; j < candidateTaperLines.length; j++) {
      const cA = candidateTaperLines[i];
      const cB = candidateTaperLines[j];
      // At least one must be genuinely sloped!
      if ((cA.isHorizontal || cA.isVertical) && (cB.isHorizontal || cB.isVertical)) continue;

      const spA = cA.spans.filter((s) => s.lineType === 'thin_dashed');
      const spB = cB.spans.filter((s) => s.lineType === 'thin_dashed');
      if (spA.length === 0 || spB.length === 0) continue;

      const aP1 = spA[0].p1;
      const aP2 = spA[spA.length - 1].p2;
      const bP1 = spB[0].p1;
      const bP2 = spB[spB.length - 1].p2;

      // Test taper along 'v' (matching v-interval [v0, v1])
      const aVMin = Math.min(aP1.v, aP2.v);
      const aVMax = Math.max(aP1.v, aP2.v);
      const bVMin = Math.min(bP1.v, bP2.v);
      const bVMax = Math.max(bP1.v, bP2.v);
      if (Math.abs(aVMin - bVMin) <= 2.2 && Math.abs(aVMax - bVMax) <= 2.2 && aVMax - aVMin >= 4.0) {
        const w0 = 0.5 * (aVMin + bVMin);
        const w1 = 0.5 * (aVMax + bVMax);
        const uA0 = aP1.v <= aP2.v ? aP1.u : aP2.u;
        const uA1 = aP1.v <= aP2.v ? aP2.u : aP1.u;
        const uB0 = bP1.v <= bP2.v ? bP1.u : bP2.u;
        const uB1 = bP1.v <= bP2.v ? bP2.u : bP1.u;
        const span0Min = Math.min(uA0, uB0);
        const span0Max = Math.max(uA0, uB0);
        const span1Min = Math.min(uA1, uB1);
        const span1Max = Math.max(uA1, uB1);
        if (Math.abs((span0Max - span0Min) - (span1Max - span1Min)) >= 1.5 || Math.abs(span0Min - span1Min) >= 1.5) {
          taperedDashedBands.push({
            id: `tdb-${view}-v-${taperedDashedBands.length}`,
            view,
            taperAxis: 'v',
            w0,
            w1,
            span0Min,
            span0Max,
            span1Min,
            span1Max,
          });
        }
      }

      // Test taper along 'u' (matching u-interval [u0, u1])
      const aUMin = Math.min(aP1.u, aP2.u);
      const aUMax = Math.max(aP1.u, aP2.u);
      const bUMin = Math.min(bP1.u, bP2.u);
      const bUMax = Math.max(bP1.u, bP2.u);
      if (Math.abs(aUMin - bUMin) <= 2.2 && Math.abs(aUMax - bUMax) <= 2.2 && aUMax - aUMin >= 4.0) {
        const w0 = 0.5 * (aUMin + bUMin);
        const w1 = 0.5 * (aUMax + bUMax);
        const vA0 = aP1.u <= aP2.u ? aP1.v : aP2.v;
        const vA1 = aP1.u <= aP2.u ? aP2.v : aP1.v;
        const vB0 = bP1.u <= bP2.u ? bP1.v : bP2.v;
        const vB1 = bP1.u <= bP2.u ? bP2.v : bP1.v;
        const span0Min = Math.min(vA0, vB0);
        const span0Max = Math.max(vA0, vB0);
        const span1Min = Math.min(vA1, vB1);
        const span1Max = Math.max(vA1, vB1);
        if (Math.abs((span0Max - span0Min) - (span1Max - span1Min)) >= 1.5 || Math.abs(span0Min - span1Min) >= 1.5) {
          taperedDashedBands.push({
            id: `tdb-${view}-u-${taperedDashedBands.length}`,
            view,
            taperAxis: 'u',
            w0,
            w1,
            span0Min,
            span0Max,
            span1Min,
            span1Max,
          });
        }
      }
    }
  }
  void obliqueDashed;

  return { parallelDashedBands, taperedDashedBands };
}

/**
 * Full Layer-1 Pipeline: Builds `PlanarArrangement2D` for a single orthographic view.
 */
export function buildPlanarArrangement2D(
  entities: CadEntity[],
  view: ViewType
): PlanarArrangement2D {
  const splitSegments = snapAndSplitViewEntities(entities, view, ['thick_solid', 'thin_dashed']);
  const solidSegments = splitSegments.filter((s) => s.lineType === 'thick_solid');

  // 1. Solid-only DCEL for exact solid atomic faces and outer solid silhouette envelope(s)
  const solidDCEL = buildDCELFromSplitSegments(solidSegments);
  const outerSilhouetteLoops = buildUnionFaceProfiles(
    solidDCEL.boundedFaces.filter((f) => f.nestingDepth === 0),
    solidDCEL.halfEdges,
    solidDCEL.vertices,
    view,
    `outer-${view}`,
    true
  );

  // 2. Mixed (solid + dashed) DCEL for complete sub-region / slot / composite cycle topology
  const fullDCEL = buildDCELFromSplitSegments(splitSegments);

  // 3. Reconstruct underlying analytical carrier lines and circles (including stitched solid+dashed circles!)
  const carrierLines = reconstructCarrierLines(splitSegments, view);
  const carrierCircles = reconstructCarrierCircles(splitSegments, carrierLines, view);

  // 4. Build multi-scale RegionProfile2D pool:
  //    a) Every solid atomic face (e.g. each stacked step rectangle, inner box, inner semicircle)
  //    b) Outer silhouette union loops
  //    c) Carrier-guided multi-face unions (e.g., concentric circles, shared-chord concentric semicircles,
  //       stitched solid+dashed circles, trimmed major arcs!)
  const regions: RegionProfile2D[] = [];

  for (const sf of solidDCEL.boundedFaces) {
    regions.push(
      classifyRegionProfile2D(
        `reg-solid-atom-${view}-${sf.id}`,
        view,
        [sf.id],
        sf.boundarySegments,
        true,
        false,
        true,
        false
      )
    );
  }

  for (const mf of fullDCEL.boundedFaces) {
    if (!mf.hasDashedBoundary) continue;
    regions.push(
      classifyRegionProfile2D(
        `reg-mixed-atom-${view}-${mf.id}`,
        view,
        [mf.id],
        mf.boundarySegments,
        true,
        false,
        false,
        true
      )
    );
  }

  const pushUniqueRegion = (up: RegionProfile2D) => {
    const alreadyExists = regions.some(
      (r) =>
        r.shapeKind === up.shapeKind &&
        Math.abs(r.area - up.area) <= 2.0 &&
        Math.abs(r.bbox.uMin - up.bbox.uMin) <= 0.8 &&
        Math.abs(r.bbox.uMax - up.bbox.uMax) <= 0.8 &&
        Math.abs(r.bbox.vMin - up.bbox.vMin) <= 0.8 &&
        Math.abs(r.bbox.vMax - up.bbox.vMax) <= 0.8
    );
    if (!alreadyExists) regions.push(up);
  };

  // Enumerate pairwise & connected-component unions in solidDCEL so creased multi-panel views
  // (e.g. creased rectangles, radial-edged pyramids/frustums, concentric semicircles) get clean RegionProfile2Ds!
  if (solidDCEL.boundedFaces.length >= 2 && solidDCEL.boundedFaces.length <= 28) {
    for (let i = 0; i < solidDCEL.boundedFaces.length; i++) {
      for (let j = i + 1; j < solidDCEL.boundedFaces.length; j++) {
        const fA = solidDCEL.boundedFaces[i];
        const fB = solidDCEL.boundedFaces[j];
        const setA = new Set(fA.boundaryHalfEdgeIds);
        const shareEdge = fB.boundaryHalfEdgeIds.some((hid) =>
          setA.has(solidDCEL.halfEdges[hid].twinId)
        );
        if (!shareEdge) continue;
        const unionProfiles = buildUnionFaceProfiles(
          [fA, fB],
          solidDCEL.halfEdges,
          solidDCEL.vertices,
          view,
          `reg-union2-${view}-${i}-${j}`,
          false
        );
        for (const up of unionProfiles) {
          if (
            up.shapeKind === 'circle' ||
            up.shapeKind === 'semicircle' ||
            up.shapeKind === 'rect' ||
            up.shapeKind === 'trapezoid' ||
            up.shapeKind === 'triangle' ||
            up.shapeKind === 'polygon'
          ) {
            pushUniqueRegion(up);
          }
        }
      }
    }

    // Connected components of edge-sharing solid faces (handles 3+ panel prism/pyramid/frustum projections)
    const compVisited = new Set<number>();
    let compIdx = 0;
    for (let i = 0; i < solidDCEL.boundedFaces.length; i++) {
      const root = solidDCEL.boundedFaces[i];
      if (compVisited.has(root.id)) continue;
      const comp = [root];
      compVisited.add(root.id);
      let qHead = 0;
      while (qHead < comp.length) {
        const cur = comp[qHead++];
        const curSet = new Set(cur.boundaryHalfEdgeIds);
        for (const other of solidDCEL.boundedFaces) {
          if (compVisited.has(other.id)) continue;
          const adj = other.boundaryHalfEdgeIds.some((hid) =>
            curSet.has(solidDCEL.halfEdges[hid].twinId)
          );
          if (adj) {
            compVisited.add(other.id);
            comp.push(other);
          }
        }
      }
      if (comp.length >= 3) {
        const compProfiles = buildUnionFaceProfiles(
          comp,
          solidDCEL.halfEdges,
          solidDCEL.vertices,
          view,
          `reg-unioncomp-${view}-${compIdx++}`,
          false
        );
        for (const up of compProfiles) {
          pushUniqueRegion(up);
        }
      }
    }
  }

  // Synthesize explicit RegionProfile2Ds from stitched CarrierCircles (full circles, major trimmed arcs, shared-chord semicircles)
  for (const cc of carrierCircles) {
    if (cc.isFullCircle || cc.isMajorTrimmedArc) {
      const exists = regions.some(
        (r) =>
          r.shapeKind === 'circle' &&
          r.circleSpec &&
          dist2(r.circleSpec.center, cc.center) <= 1.0 &&
          Math.abs(r.circleSpec.radius - cc.radius) <= 1.0
      );
      if (!exists) {
        const segs = [
          {
            kind: 'arc' as const,
            p1: { u: cc.center.u + cc.radius, v: cc.center.v },
            p2: { u: cc.center.u - cc.radius, v: cc.center.v },
            center: { ...cc.center },
            radius: cc.radius,
            startAngle: 0,
            endAngle: Math.PI,
            ccw: true,
          },
          {
            kind: 'arc' as const,
            p1: { u: cc.center.u - cc.radius, v: cc.center.v },
            p2: { u: cc.center.u + cc.radius, v: cc.center.v },
            center: { ...cc.center },
            radius: cc.radius,
            startAngle: Math.PI,
            endAngle: 0,
            ccw: true,
          },
        ];
        regions.push(
          classifyRegionProfile2D(
            `reg-carrier-cir-${cc.id}`,
            view,
            [],
            segs,
            false,
            false,
            cc.totalDashedSweep < 0.05,
            cc.totalDashedSweep >= 0.05
          )
        );
      }
    } else if (cc.isSemicircle && cc.sharedChord) {
      const sc = cc.sharedChord;
      const exists = regions.some(
        (r) =>
          r.shapeKind === 'semicircle' &&
          r.semicircleSpec &&
          dist2(r.semicircleSpec.center, cc.center) <= 1.0 &&
          Math.abs(r.semicircleSpec.radius - cc.radius) <= 1.0 &&
          r.semicircleSpec.keepGreater === sc.keepGreater
      );
      if (!exists) {
        const arcStart =
          sc.axis === 'v'
            ? sc.keepGreater
              ? 0
              : Math.PI
            : sc.keepGreater
            ? 1.5 * Math.PI
            : 0.5 * Math.PI;
        const arcEnd = normAngle(arcStart + Math.PI);
        const pStart = {
          u: cc.center.u + cc.radius * Math.cos(arcStart),
          v: cc.center.v + cc.radius * Math.sin(arcStart),
        };
        const pEnd = {
          u: cc.center.u + cc.radius * Math.cos(arcEnd),
          v: cc.center.v + cc.radius * Math.sin(arcEnd),
        };
        const segs = [
          {
            kind: 'arc' as const,
            p1: pStart,
            p2: pEnd,
            center: { ...cc.center },
            radius: cc.radius,
            startAngle: arcStart,
            endAngle: arcEnd,
            ccw: true,
          },
          {
            kind: 'line' as const,
            p1: pEnd,
            p2: pStart,
          },
        ];
        regions.push(
          classifyRegionProfile2D(
            `reg-carrier-semi-${cc.id}`,
            view,
            [],
            segs,
            false,
            false,
            cc.totalDashedSweep < 0.05,
            cc.totalDashedSweep >= 0.05
          )
        );
      }
    }
  }

  for (const ol of outerSilhouetteLoops) {
    const existing = regions.find(
      (r) =>
        r.isSolidOnly &&
        Math.abs(r.area - ol.area) <= 2.0 &&
        Math.abs(r.bbox.uMin - ol.bbox.uMin) <= 0.8 &&
        Math.abs(r.bbox.uMax - ol.bbox.uMax) <= 0.8 &&
        Math.abs(r.bbox.vMin - ol.bbox.vMin) <= 0.8 &&
        Math.abs(r.bbox.vMax - ol.bbox.vMax) <= 0.8
    );
    if (existing) {
      existing.isOuterEnvelope = true;
    } else {
      regions.push(ol);
    }
  }

  const overallBBox = unionBBox(splitSegments.map((s) => s.bbox));
  const solidBBox = unionBBox(solidSegments.map((s) => s.bbox)) || overallBBox;
  const { parallelDashedBands, taperedDashedBands } = extractDashedBandsFromCarriers(
    carrierLines,
    carrierCircles,
    solidSegments,
    solidBBox,
    view,
    outerSilhouetteLoops
  );

  return {
    view,
    overallBBox,
    solidBBox,
    splitSegments,
    vertices: fullDCEL.vertices,
    halfEdges: fullDCEL.halfEdges,
    atomicFaces: fullDCEL.boundedFaces,
    solidAtomicFaces: solidDCEL.boundedFaces,
    outerSilhouetteLoops,
    regions,
    carrierLines,
    carrierCircles,
    parallelDashedBands,
    taperedDashedBands,
  };
}
