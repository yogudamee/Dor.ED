import { CadEntity, LineType, Point2D, ViewType } from '../../types/cad';
import {
  arcSweepCCW,
  computeBounds2D,
  dist2,
  normAngle,
  TWO_PI,
} from '../core/coordSystem';
import {
  BoundingBox2D,
  CircleArcInterval,
  CompositeRegion2D,
  CurveSegment2D,
  LineCarrier2D,
  LineCarrierInterval,
  OpenNotchFeature2D,
  ParallelDashedBand2D,
  TaperedDashedBand2D,
  ViewArrangementResult,
  VirtualCircleCarrier2D,
} from '../core/types';
import {
  buildPlanarDCEL,
  extractCompositeRegionsFromDCEL,
  pointInPolygonExact,
} from './dcelFaces';
import { preprocessAndSplitView, RawPrimitiveCurve } from './preprocessAndSplit';

/**
 * Reconstruct analytic line carriers (stitching collinear `thick_solid` and `thin_dashed` segments
 * interrupted by foreground circles or cross-holes, and recognizing coaxial "front solid + back dashed"
 * carriers) and circle carriers (stitching concentric trimmed arcs or solid+dashed spliced arcs into
 * virtual full circles while retaining exact solid/dashed angular evidence!).
 */
export function buildViewArrangementAndCarriers(
  entities: CadEntity[],
  view: ViewType
): ViewArrangementResult {
  const solidPrep = preprocessAndSplitView(entities, view, true);
  const fullPrep = preprocessAndSplitView(entities, view, false);

  const solidDCEL = buildPlanarDCEL(solidPrep.segments);
  const fullDCEL = buildPlanarDCEL(fullPrep.segments);

  const { regions, outerRegions, innerRegions, bounds: solidBounds } =
    extractCompositeRegionsFromDCEL(solidDCEL, view);

  const lineCarriers = extractLineCarriers(fullPrep.segments, view);
  const circleCarriers = extractVirtualCircleCarriers(
    fullPrep.rawCurves,
    regions,
    view
  );

  // Build solid+dashed cutting sub-face decomposition (`subFaces`):
  // Bridge cross-void collinear cutting carriers (e.g. annular dashed lines split across a central bore)
  // across `[pStart, pEnd]` so peripheral circular lunes, annular strips, and stepped sub-faces are cleanly extracted!
  const bridgedCuttingEntities: CadEntity[] = entities.filter(
    (e) => e.view === view
  );
  const extraBridgeLines: CadEntity[] = [];
  for (const lc of lineCarriers) {
    if (lc.intervals.length >= 2 && dist2(lc.pStart, lc.pEnd) > 2.0) {
      extraBridgeLines.push({
        id: `bridge_${lc.id}`,
        view,
        type: 'line',
        lineType: lc.hasSolid ? 'thick_solid' : 'thin_dashed',
        p1: { ...lc.pStart },
        p2: { ...lc.pEnd },
        source: 'derived',
      });
    }
  }
  const subFaceDCEL =
    extraBridgeLines.length > 0
      ? buildPlanarDCEL(
          preprocessAndSplitView(
            [...bridgedCuttingEntities, ...extraBridgeLines],
            view,
            false
          ).segments
        )
      : fullDCEL;
  const subFaces = extractCompositeRegionsFromDCEL(subFaceDCEL, view).regions.filter(
    (r) => !r.isSharedChordUnion
  );

  // Fallback global bounds if view has circles/segments
  let globalBounds = solidBounds;
  if (fullPrep.segments.length > 0) {
    const pts: Point2D[] = [];
    for (const s of fullPrep.segments) {
      pts.push(s.p1, s.p2);
      if (s.kind === 'arc' && s.center && s.radius !== undefined) {
        // Check cardinal points on arc
        for (const qa of [0, Math.PI / 2, Math.PI, (3 * Math.PI) / 2]) {
          const sweep = arcSweepCCW(s.startAngle!, s.endAngle!);
          const rel = normAngle(qa - s.startAngle!);
          if (rel <= sweep + 1e-3) {
            pts.push({
              u: s.center.u + s.radius * Math.cos(qa),
              v: s.center.v + s.radius * Math.sin(qa),
            });
          }
        }
      }
    }
    if (pts.length > 0) {
      const b2 = computeBounds2D(pts);
      globalBounds = globalBounds
        ? {
            uMin: Math.min(globalBounds.uMin, b2.uMin),
            uMax: Math.max(globalBounds.uMax, b2.uMax),
            vMin: Math.min(globalBounds.vMin, b2.vMin),
            vMax: Math.max(globalBounds.vMax, b2.vMax),
          }
        : b2;
    }
  }

  const { parallelBands, taperedBands } = extractDashedBandsFromCarriers(
    lineCarriers,
    solidPrep.centerlineEntities,
    globalBounds
  );

  const openNotches = detectOpenBoundaryNotches(
    regions,
    circleCarriers,
    lineCarriers,
    globalBounds,
    view
  );

  return {
    view,
    rawEntities: entities.filter((e) => e.view === view),
    centerlineEntities: solidPrep.centerlineEntities,
    splitSegments: fullPrep.segments,
    solidDCEL,
    fullDCEL,
    regions,
    subFaces,
    outerRegions,
    innerRegions,
    bounds: globalBounds,
    lineCarriers,
    circleCarriers,
    parallelDashedBands: parallelBands,
    taperedDashedBands: taperedBands,
    openNotches,
  };
}

const COS_ONE_DEG = Math.cos(Math.PI / 180); // ~0.9998477 (angle deviation <= 1.0°)
const CARRIER_NORMAL_TOL_MM = 0.8;

function mergeSameTypeCarrierIntervals(
  raw: LineCarrierInterval[]
): LineCarrierInterval[] {
  const sorted = [...raw].sort((a, b) => a.s0 - b.s0);
  const merged: LineCarrierInterval[] = [];
  for (const iv of sorted) {
    if (merged.length === 0) {
      merged.push({ ...iv, p1: { ...iv.p1 }, p2: { ...iv.p2 } });
      continue;
    }
    const prev = merged[merged.length - 1];
    if (prev.lineType === iv.lineType && iv.s0 <= prev.s1 + 0.35) {
      if (iv.s1 > prev.s1) {
        prev.s1 = iv.s1;
        prev.p2 = { ...iv.p2 };
      }
    } else {
      merged.push({ ...iv, p1: { ...iv.p1 }, p2: { ...iv.p2 } });
    }
  }
  return merged;
}

function extractLineCarriers(
  segments: CurveSegment2D[],
  view: ViewType
): LineCarrier2D[] {
  const lineSegs = segments.filter((s) => s.kind === 'line');
  const carriers: LineCarrier2D[] = [];

  for (const seg of lineSegs) {
    const du = seg.p2.u - seg.p1.u;
    const dv = seg.p2.v - seg.p1.v;
    const len = Math.hypot(du, dv);
    if (len < 0.05) continue;

    // Canonicalize unit direction so angle is in [0, π)
    let dirU = du / len;
    let dirV = dv / len;
    if (dirU < -1e-6 || (Math.abs(dirU) <= 1e-6 && dirV < 0)) {
      dirU = -dirU;
      dirV = -dirV;
    }

    // Match existing collinear analytical carrier (angle <= 1.0°, perpendicular distance <= 0.8mm),
    // stitching segments separated across central holes, bosses, or centerlines!
    let matched: LineCarrier2D | null = null;
    for (const c of carriers) {
      const dot = Math.abs(c.dir.u * dirU + c.dir.v * dirV);
      if (dot < COS_ONE_DEG) continue;
      const perpDist1 = Math.abs(
        (seg.p1.u - c.origin.u) * c.normal.u +
          (seg.p1.v - c.origin.v) * c.normal.v
      );
      const perpDist2 = Math.abs(
        (seg.p2.u - c.origin.u) * c.normal.u +
          (seg.p2.v - c.origin.v) * c.normal.v
      );
      if (
        perpDist1 <= CARRIER_NORMAL_TOL_MM &&
        perpDist2 <= CARRIER_NORMAL_TOL_MM
      ) {
        matched = c;
        break;
      }
    }

    if (!matched) {
      const isHoriz = Math.abs(dirV) < 0.0175;
      const isVert = Math.abs(dirU) < 0.0175;
      if (isHoriz) {
        dirU = 1;
        dirV = 0;
      } else if (isVert) {
        dirU = 0;
        dirV = 1;
      }
      const norm = { u: -dirV, v: dirU };
      matched = {
        id: `lc_${view}_${carriers.length}`,
        view,
        origin: { ...seg.p1 },
        dir: { u: dirU, v: dirV },
        normal: norm,
        sMin: 0,
        sMax: 0,
        pStart: { ...seg.p1 },
        pEnd: { ...seg.p2 },
        isHorizontal: isHoriz,
        isVertical: isVert,
        coordConst: isHoriz
          ? 0.5 * (seg.p1.v + seg.p2.v)
          : isVert
          ? 0.5 * (seg.p1.u + seg.p2.u)
          : undefined,
        intervals: [],
        solidIntervals: [],
        dashedIntervals: [],
        hasSolid: false,
        hasDashed: false,
        isCoaxialSolidDashed: false,
      };
      carriers.push(matched);
    }

    const sA =
      (seg.p1.u - matched.origin.u) * matched.dir.u +
      (seg.p1.v - matched.origin.v) * matched.dir.v;
    const sB =
      (seg.p2.u - matched.origin.u) * matched.dir.u +
      (seg.p2.v - matched.origin.v) * matched.dir.v;
    const s0 = Math.min(sA, sB);
    const s1 = Math.max(sA, sB);
    const pStart = sA <= sB ? seg.p1 : seg.p2;
    const pEnd = sA <= sB ? seg.p2 : seg.p1;

    matched.intervals.push({
      s0,
      s1,
      p1: { ...pStart },
      p2: { ...pEnd },
      lineType: seg.lineType,
      entityId: seg.sourceEntityId,
    });
    if (seg.lineType === 'thick_solid') matched.hasSolid = true;
    if (seg.lineType === 'thin_dashed') matched.hasDashed = true;
  }

  // Sort & merge contiguous same-linetype intervals on each carrier while preserving separate cross-void spans!
  for (const c of carriers) {
    c.solidIntervals = mergeSameTypeCarrierIntervals(
      c.intervals.filter((iv) => iv.lineType === 'thick_solid')
    );
    c.dashedIntervals = mergeSameTypeCarrierIntervals(
      c.intervals.filter((iv) => iv.lineType === 'thin_dashed')
    );
    c.intervals = mergeSameTypeCarrierIntervals(c.intervals);
    c.sMin = c.intervals[0].s0;
    c.sMax = c.intervals[c.intervals.length - 1].s1;
    c.pStart = { ...c.intervals[0].p1 };
    c.pEnd = { ...c.intervals[c.intervals.length - 1].p2 };
    if (c.isHorizontal) {
      let sumW = 0;
      let sumWV = 0;
      for (const iv of c.intervals) {
        const w = Math.max(0.1, iv.s1 - iv.s0);
        sumW += w;
        sumWV += w * 0.5 * (iv.p1.v + iv.p2.v);
      }
      if (sumW > 0) c.coordConst = sumWV / sumW;
    } else if (c.isVertical) {
      let sumW = 0;
      let sumWU = 0;
      for (const iv of c.intervals) {
        const w = Math.max(0.1, iv.s1 - iv.s0);
        sumW += w;
        sumWU += w * 0.5 * (iv.p1.u + iv.p2.u);
      }
      if (sumW > 0) c.coordConst = sumWU / sumW;
    }
    c.isCoaxialSolidDashed = c.hasSolid && c.hasDashed;
  }

  return carriers;
}

function extractVirtualCircleCarriers(
  rawCurves: RawPrimitiveCurve[],
  regions: CompositeRegion2D[],
  view: ViewType
): VirtualCircleCarrier2D[] {
  interface Group {
    center: Point2D;
    radius: number;
    hasFullCircle: boolean;
    intervals: CircleArcInterval[];
    entityIds: Set<string>;
  }
  const groups: Group[] = [];

  for (const rc of rawCurves) {
    if ((rc.kind !== 'circle' && rc.kind !== 'arc') || !rc.center || !rc.radius) {
      continue;
    }
    let grp = groups.find(
      (g) =>
        dist2(g.center, rc.center!) <= 0.45 &&
        Math.abs(g.radius - rc.radius!) <= 0.45
    );
    if (!grp) {
      grp = {
        center: { ...rc.center },
        radius: rc.radius,
        hasFullCircle: false,
        intervals: [],
        entityIds: new Set(),
      };
      groups.push(grp);
    }
    grp.entityIds.add(rc.sourceEntityId);
    if (rc.kind === 'circle') {
      grp.hasFullCircle = true;
      grp.intervals.push({
        startAngle: 0,
        endAngle: 0,
        sweep: TWO_PI,
        lineType: rc.lineType,
        entityId: rc.sourceEntityId,
      });
    } else {
      const sw = arcSweepCCW(rc.startAngle!, rc.endAngle!);
      grp.intervals.push({
        startAngle: rc.startAngle!,
        endAngle: rc.endAngle!,
        sweep: sw,
        lineType: rc.lineType,
        entityId: rc.sourceEntityId,
      });
    }
  }

  // Promote full circles AND major arcs (> 195 deg, e.g. slotted sphere or notched cylinder!) AND stitched solid+dashed arcs (>= 270 deg)
  const out: VirtualCircleCarrier2D[] = [];
  for (let i = 0; i < groups.length; i++) {
    const g = groups[i];
    // Sample 360 degree coverage
    let solidBins = 0;
    let dashedBins = 0;
    const N_BINS = 360;
    for (let b = 0; b < N_BINS; b++) {
      const ang = ((b + 0.5) / N_BINS) * TWO_PI;
      let hitSolid = false;
      let hitDashed = false;
      for (const iv of g.intervals) {
        if (iv.sweep >= TWO_PI - 1e-3) {
          if (iv.lineType === 'thick_solid') hitSolid = true;
          else if (iv.lineType === 'thin_dashed') hitDashed = true;
        } else {
          const rel = normAngle(ang - iv.startAngle);
          if (rel <= iv.sweep + 1e-3) {
            if (iv.lineType === 'thick_solid') hitSolid = true;
            else if (iv.lineType === 'thin_dashed') hitDashed = true;
          }
        }
      }
      if (hitSolid) solidBins++;
      else if (hitDashed) dashedBins++;
    }
    const totalDeg = solidBins + dashedBins;
    if (!g.hasFullCircle && totalDeg < 195) {
      continue;
    }

    // Compute nesting depth relative to solid atomic regions
    const atomicRegs = regions.filter((r) => !r.isSharedChordUnion && !r.isSubDecomposed);
    let depth = 0;
    let parentId: string | null = null;
    let smallestArea = Infinity;
    for (const r of atomicRegs) {
      // Skip the circle's own face!
      if (
        r.profileKind === 'circle' &&
        r.profileMeta?.center &&
        dist2(r.profileMeta.center, g.center) < 0.8 &&
        Math.abs((r.profileMeta.radius ?? 0) - g.radius) < 0.8
      ) {
        continue;
      }
      if (
        r.area > Math.PI * g.radius * g.radius + 2.0 &&
        pointInPolygonExact(g.center, r.polygon)
      ) {
        // Check if circle boundary is inside or touches parent region
        const testPt = { u: g.center.u + g.radius * 0.85, v: g.center.v };
        if (pointInPolygonExact(testPt, r.polygon)) {
          depth++;
          if (r.area < smallestArea) {
            smallestArea = r.area;
            parentId = r.id;
          }
        }
      }
    }

    const dominantLineType: LineType =
      solidBins >= dashedBins ? 'thick_solid' : 'thin_dashed';

    out.push({
      id: `vc_${view}_${i}`,
      view,
      center: g.center,
      radius: g.radius,
      dominantLineType,
      isStitchedFromArcs: !g.hasFullCircle,
      isFullCircleEntity: g.hasFullCircle,
      totalSolidDegrees: solidBins,
      totalDashedDegrees: dashedBins,
      coverageDegrees: totalDeg,
      intervals: g.intervals,
      sourceEntityIds: [...g.entityIds],
      nestingDepth: depth,
      parentRegionId: parentId,
    });
  }

  out.sort((a, b) => b.radius - a.radius);
  return out;
}

function extractDashedBandsFromCarriers(
  carriers: LineCarrier2D[],
  centerlines: CadEntity[],
  _bounds: BoundingBox2D | null
): {
  parallelBands: ParallelDashedBand2D[];
  taperedBands: TaperedDashedBand2D[];
} {
  const parallelBands: ParallelDashedBand2D[] = [];
  const taperedBands: TaperedDashedBand2D[] = [];

  // Extract continuous dashed spans on each carrier (bridging small cross-hole interruptions <= 36mm if collinear dashed segments align!)
  interface DashedSpan {
    carrier: LineCarrier2D;
    p1: Point2D;
    p2: Point2D;
    coordConst?: number;
    spanMin: number;
    spanMax: number;
    ids: string[];
  }

  const vertDashed: DashedSpan[] = [];
  const horizDashed: DashedSpan[] = [];
  const slantedDashed: DashedSpan[] = [];

  for (const c of carriers) {
    const dIntervals = c.intervals.filter((iv) => iv.lineType === 'thin_dashed');
    if (dIntervals.length === 0) continue;

    // Group collinear dashed intervals on this carrier:
    // Bridge across cross-hole interruptions when two dashed intervals lie on the exact same carrier!
    const bridged: { s0: number; s1: number; p1: Point2D; p2: Point2D; ids: string[] }[] = [];
    for (const iv of dIntervals) {
      if (bridged.length === 0) {
        bridged.push({
          s0: iv.s0,
          s1: iv.s1,
          p1: iv.p1,
          p2: iv.p2,
          ids: [iv.entityId],
        });
      } else {
        const last = bridged[bridged.length - 1];
        // Check if gap between last.s1 and iv.s0 does NOT contain a solid interval of this same carrier
        const hasBlockingSolid = c.intervals.some(
          (o) =>
            o.lineType === 'thick_solid' &&
            o.s0 >= last.s1 - 0.2 &&
            o.s1 <= iv.s0 + 0.2
        );
        if (!hasBlockingSolid && iv.s0 - last.s1 <= 42) {
          // Keep BOTH individual spans if needed? Bridging cross-hole interruption restores full continuous hole generator!
          last.s1 = iv.s1;
          last.p2 = iv.p2;
          last.ids.push(iv.entityId);
        } else {
          bridged.push({
            s0: iv.s0,
            s1: iv.s1,
            p1: iv.p1,
            p2: iv.p2,
            ids: [iv.entityId],
          });
        }
      }
    }

    for (const br of bridged) {
      if (c.isVertical && c.coordConst !== undefined) {
        vertDashed.push({
          carrier: c,
          p1: br.p1,
          p2: br.p2,
          coordConst: c.coordConst,
          spanMin: Math.min(br.p1.v, br.p2.v),
          spanMax: Math.max(br.p1.v, br.p2.v),
          ids: br.ids,
        });
      } else if (c.isHorizontal && c.coordConst !== undefined) {
        horizDashed.push({
          carrier: c,
          p1: br.p1,
          p2: br.p2,
          coordConst: c.coordConst,
          spanMin: Math.min(br.p1.u, br.p2.u),
          spanMax: Math.max(br.p1.u, br.p2.u),
          ids: br.ids,
        });
      } else {
        slantedDashed.push({
          carrier: c,
          p1: br.p1,
          p2: br.p2,
          spanMin: 0,
          spanMax: dist2(br.p1, br.p2),
          ids: br.ids,
        });
      }
    }
  }

  const hasCenterlineAt = (axis: 'u' | 'v', coord: number): boolean => {
    for (const cl of centerlines) {
      if (cl.type !== 'line') continue;
      if (axis === 'u' && Math.abs(cl.p1.u - cl.p2.u) < 0.5) {
        if (Math.abs(cl.p1.u - coord) <= 1.2) return true;
      }
      if (axis === 'v' && Math.abs(cl.p1.v - cl.p2.v) < 0.5) {
        if (Math.abs(cl.p1.v - coord) <= 1.2) return true;
      }
    }
    return false;
  };

  // Pair vertical dashed lines into u-bands
  vertDashed.sort((a, b) => a.coordConst! - b.coordConst!);
  for (let i = 0; i < vertDashed.length; i++) {
    for (let j = i + 1; j < vertDashed.length; j++) {
      const a = vertDashed[i];
      const b = vertDashed[j];
      const width = b.coordConst! - a.coordConst!;
      if (width < 2.0) continue;
      const ovMin = Math.max(a.spanMin, b.spanMin);
      const ovMax = Math.min(a.spanMax, b.spanMax);
      if (ovMax - ovMin < 2.0) continue;
      // Require similar span endpoints (within 2.5mm) so unrelated holes don't cross-pair unless symmetric around a centerline
      const center = 0.5 * (a.coordConst! + b.coordConst!);
      const hasCL = hasCenterlineAt('u', center);
      const endsMatch =
        Math.abs(a.spanMin - b.spanMin) <= 2.5 &&
        Math.abs(a.spanMax - b.spanMax) <= 2.5;
      if (!endsMatch && !hasCL) continue;

      parallelBands.push({
        id: `pband_u_${i}_${j}`,
        axis: 'u',
        c1: a.coordConst!,
        c2: b.coordConst!,
        center,
        width,
        spanMin: Math.min(a.spanMin, b.spanMin),
        spanMax: Math.max(a.spanMax, b.spanMax),
        hasCenterline: hasCL,
        sourceIds: [...a.ids, ...b.ids],
      });
    }
  }

  // Pair horizontal dashed lines into v-bands
  horizDashed.sort((a, b) => a.coordConst! - b.coordConst!);
  for (let i = 0; i < horizDashed.length; i++) {
    for (let j = i + 1; j < horizDashed.length; j++) {
      const a = horizDashed[i];
      const b = horizDashed[j];
      const width = b.coordConst! - a.coordConst!;
      if (width < 2.0) continue;
      const ovMin = Math.max(a.spanMin, b.spanMin);
      const ovMax = Math.min(a.spanMax, b.spanMax);
      if (ovMax - ovMin < 2.0) continue;
      const center = 0.5 * (a.coordConst! + b.coordConst!);
      const hasCL = hasCenterlineAt('v', center);
      const endsMatch =
        Math.abs(a.spanMin - b.spanMin) <= 2.5 &&
        Math.abs(a.spanMax - b.spanMax) <= 2.5;
      if (!endsMatch && !hasCL) continue;

      parallelBands.push({
        id: `pband_v_${i}_${j}`,
        axis: 'v',
        c1: a.coordConst!,
        c2: b.coordConst!,
        center,
        width,
        spanMin: Math.min(a.spanMin, b.spanMin),
        spanMax: Math.max(a.spanMax, b.spanMax),
        hasCenterline: hasCL,
        sourceIds: [...a.ids, ...b.ids],
      });
    }
  }

  // Pair slanted dashed lines into tapered ("八字" / frustum / slanted hole) bands!
  for (let i = 0; i < slantedDashed.length; i++) {
    for (let j = i + 1; j < slantedDashed.length; j++) {
      const a = slantedDashed[i];
      const b = slantedDashed[j];

      // Check sweep along v (v0..v1 match within 1.5mm)
      const av0 = Math.min(a.p1.v, a.p2.v);
      const av1 = Math.max(a.p1.v, a.p2.v);
      const bv0 = Math.min(b.p1.v, b.p2.v);
      const bv1 = Math.max(b.p1.v, b.p2.v);
      if (
        av1 - av0 > 3.0 &&
        Math.abs(av0 - bv0) <= 1.5 &&
        Math.abs(av1 - bv1) <= 1.5
      ) {
        const au0 = a.p1.v <= a.p2.v ? a.p1.u : a.p2.u;
        const au1 = a.p1.v <= a.p2.v ? a.p2.u : a.p1.u;
        const bu0 = b.p1.v <= b.p2.v ? b.p1.u : b.p2.u;
        const bu1 = b.p1.v <= b.p2.v ? b.p2.u : b.p1.u;
        const p0Min = Math.min(au0, bu0);
        const p0Max = Math.max(au0, bu0);
        const p1Min = Math.min(au1, bu1);
        const p1Max = Math.max(au1, bu1);
        if (p0Max - p0Min > 0.5 || p1Max - p1Min > 0.5) {
          taperedBands.push({
            id: `tband_v_${i}_${j}`,
            sweepAxis: 'v',
            w0: 0.5 * (av0 + bv0),
            w1: 0.5 * (av1 + bv1),
            p0Min,
            p0Max,
            p1Min,
            p1Max,
            center0: 0.5 * (p0Min + p0Max),
            center1: 0.5 * (p1Min + p1Max),
            r0: 0.5 * (p0Max - p0Min),
            r1: 0.5 * (p1Max - p1Min),
            sourceIds: [...a.ids, ...b.ids],
          });
        }
      }

      // Check sweep along u (u0..u1 match within 1.5mm)
      const au0x = Math.min(a.p1.u, a.p2.u);
      const au1x = Math.max(a.p1.u, a.p2.u);
      const bu0x = Math.min(b.p1.u, b.p2.u);
      const bu1x = Math.max(b.p1.u, b.p2.u);
      if (
        au1x - au0x > 3.0 &&
        Math.abs(au0x - bu0x) <= 1.5 &&
        Math.abs(au1x - bu1x) <= 1.5
      ) {
        const avAt0 = a.p1.u <= a.p2.u ? a.p1.v : a.p2.v;
        const avAt1 = a.p1.u <= a.p2.u ? a.p2.v : a.p1.v;
        const bvAt0 = b.p1.u <= b.p2.u ? b.p1.v : b.p2.v;
        const bvAt1 = b.p1.u <= b.p2.u ? b.p2.v : b.p1.v;
        const p0Min = Math.min(avAt0, bvAt0);
        const p0Max = Math.max(avAt0, bvAt0);
        const p1Min = Math.min(avAt1, bvAt1);
        const p1Max = Math.max(avAt1, bvAt1);
        if (p0Max - p0Min > 0.5 || p1Max - p1Min > 0.5) {
          taperedBands.push({
            id: `tband_u_${i}_${j}`,
            sweepAxis: 'u',
            w0: 0.5 * (au0x + bu0x),
            w1: 0.5 * (au1x + bu1x),
            p0Min,
            p0Max,
            p1Min,
            p1Max,
            center0: 0.5 * (p0Min + p0Max),
            center1: 0.5 * (p1Min + p1Max),
            r0: 0.5 * (p0Max - p0Min),
            r1: 0.5 * (p1Max - p1Min),
            sourceIds: [...a.ids, ...b.ids],
          });
        }
      }
    }
  }

  return { parallelBands, taperedBands };
}

/**
 * Detect concave open U-slots / notches cut into an outer profile (e.g., slotted cylinder,
 * slotted cone, or sphere with a through rectangular slot!).
 */
function detectOpenBoundaryNotches(
  regions: CompositeRegion2D[],
  circleCarriers: VirtualCircleCarrier2D[],
  lineCarriers: LineCarrier2D[],
  bounds: BoundingBox2D | null,
  view: ViewType
): OpenNotchFeature2D[] {
  const notches: OpenNotchFeature2D[] = [];
  if (!bounds) return notches;

  // Look for U-shaped 3-wall solid pockets: two parallel walls + perpendicular floor inside outer bounds
  const vertSolids = lineCarriers.filter(
    (c) => c.isVertical && c.hasSolid && c.coordConst !== undefined
  );
  const horizSolids = lineCarriers.filter(
    (c) => c.isHorizontal && c.hasSolid && c.coordConst !== undefined
  );

  // Top-open or bottom-open U-notch: two vertical walls u1 < u2 connected by a horizontal floor at vFloor
  for (let i = 0; i < vertSolids.length; i++) {
    for (let j = i + 1; j < vertSolids.length; j++) {
      const cL = vertSolids[i];
      const cR = vertSolids[j];
      const u1 = Math.min(cL.coordConst!, cR.coordConst!);
      const u2 = Math.max(cL.coordConst!, cR.coordConst!);
      if (u2 - u1 < 3.0) continue;
      // Must be strictly interior in u relative to global bounds (a notch, not the outer left/right wall!)
      if (u1 <= bounds.uMin + 1.0 && u2 >= bounds.uMax - 1.0) continue;

      const lMin = Math.min(cL.pStart.v, cL.pEnd.v);
      const lMax = Math.max(cL.pStart.v, cL.pEnd.v);
      const rMin = Math.min(cR.pStart.v, cR.pEnd.v);
      const rMax = Math.max(cR.pStart.v, cR.pEnd.v);
      const vMin = Math.max(lMin, rMin);
      const vMax = Math.min(lMax, rMax);
      if (vMax - vMin < 3.0) continue;

      // Check for horizontal floor at vMin (open at vMax / top) or ceiling at vMax (open at vMin / bottom)
      const hasFloorAtMin = horizSolids.some(
        (h) =>
          Math.abs(h.coordConst! - vMin) <= 0.6 &&
          Math.min(h.pStart.u, h.pEnd.u) <= u1 + 0.8 &&
          Math.max(h.pStart.u, h.pEnd.u) >= u2 - 0.8
      );
      const hasCeilAtMax = horizSolids.some(
        (h) =>
          Math.abs(h.coordConst! - vMax) <= 0.6 &&
          Math.min(h.pStart.u, h.pEnd.u) <= u1 + 0.8 &&
          Math.max(h.pStart.u, h.pEnd.u) >= u2 - 0.8
      );

      // Verify midpoint inside the U-pocket is OUTSIDE the solid region (i.e. truly an open void pocket!)
      const midPt = { u: 0.5 * (u1 + u2), v: 0.5 * (vMin + vMax) };
      const atomicSolids = regions.filter((r) => !r.isSharedChordUnion);
      const isHollowInView = !atomicSolids.some((r) =>
        pointInPolygonExact(midPt, r.polygon)
      );

      if (isHollowInView && hasFloorAtMin && !hasCeilAtMax) {
        // Extend vMax to stitched circle top or global bounds.vMax
        let topReach = bounds.vMax;
        for (const vc of circleCarriers) {
          if (vc.center.u + vc.radius > u2 && vc.center.u - vc.radius < u1) {
            topReach = Math.max(topReach, vc.center.v + vc.radius);
          }
        }
        notches.push({
          id: `notch_${view}_top_${notches.length}`,
          view,
          uMin: u1,
          uMax: u2,
          vMin,
          vMax: topReach,
          openSide: 'vMax',
          lineType: 'thick_solid',
        });
      } else if (isHollowInView && hasCeilAtMax && !hasFloorAtMin) {
        let botReach = bounds.vMin;
        for (const vc of circleCarriers) {
          if (vc.center.u + vc.radius > u2 && vc.center.u - vc.radius < u1) {
            botReach = Math.min(botReach, vc.center.v - vc.radius);
          }
        }
        notches.push({
          id: `notch_${view}_bot_${notches.length}`,
          view,
          uMin: u1,
          uMax: u2,
          vMin: botReach,
          vMax,
          openSide: 'vMin',
          lineType: 'thick_solid',
        });
      }
    }
  }

  // Left-open or right-open U-notch, plus parallel chord bands cutting across a circle (like top view of a slotted cylinder/sphere!)
  for (let i = 0; i < horizSolids.length; i++) {
    for (let j = i + 1; j < horizSolids.length; j++) {
      const cB = horizSolids[i];
      const cT = horizSolids[j];
      const v1 = Math.min(cB.coordConst!, cT.coordConst!);
      const v2 = Math.max(cB.coordConst!, cT.coordConst!);
      if (v2 - v1 < 3.0) continue;
      if (v1 <= bounds.vMin + 1.0 && v2 >= bounds.vMax - 1.0) continue;

      const bMin = Math.min(cB.pStart.u, cB.pEnd.u);
      const bMax = Math.max(cB.pStart.u, cB.pEnd.u);
      const tMin = Math.min(cT.pStart.u, cT.pEnd.u);
      const tMax = Math.max(cT.pStart.u, cT.pEnd.u);
      const uMin = Math.max(bMin, tMin);
      const uMax = Math.min(bMax, tMax);
      if (uMax - uMin < 3.0) continue;

      const hasWallLeft = vertSolids.some(
        (vs) =>
          Math.abs(vs.coordConst! - uMin) <= 0.6 &&
          Math.min(vs.pStart.v, vs.pEnd.v) <= v1 + 0.8 &&
          Math.max(vs.pStart.v, vs.pEnd.v) >= v2 - 0.8
      );
      const hasWallRight = vertSolids.some(
        (vs) =>
          Math.abs(vs.coordConst! - uMax) <= 0.6 &&
          Math.min(vs.pStart.v, vs.pEnd.v) <= v1 + 0.8 &&
          Math.max(vs.pStart.v, vs.pEnd.v) >= v2 - 0.8
      );

      const midPt = { u: 0.5 * (uMin + uMax), v: 0.5 * (v1 + v2) };
      const atomicSolids = regions.filter((r) => !r.isSharedChordUnion);
      const isHollowInView = !atomicSolids.some((r) =>
        pointInPolygonExact(midPt, r.polygon)
      );

      if (isHollowInView && hasWallLeft && !hasWallRight) {
        notches.push({
          id: `notch_${view}_right_${notches.length}`,
          view,
          uMin,
          uMax: bounds.uMax,
          vMin: v1,
          vMax: v2,
          openSide: 'uMax',
          lineType: 'thick_solid',
        });
      } else if (isHollowInView && hasWallRight && !hasWallLeft) {
        notches.push({
          id: `notch_${view}_left_${notches.length}`,
          view,
          uMin: bounds.uMin,
          uMax,
          vMin: v1,
          vMax: v2,
          openSide: 'uMin',
          lineType: 'thick_solid',
        });
      } else if (!hasWallLeft && !hasWallRight) {
        // Check if both chords terminate on an outer circle (e.g. top view of slotted cylinder/sphere!)
        const hostCirc = circleCarriers.find(
          (vc) =>
            vc.nestingDepth === 0 &&
            Math.abs(
              Math.hypot(bMin - vc.center.u, v1 - vc.center.v) - vc.radius
            ) <= 2.5 &&
            Math.abs(
              Math.hypot(bMax - vc.center.u, v1 - vc.center.v) - vc.radius
            ) <= 2.5
        );
        if (hostCirc) {
          notches.push({
            id: `notch_${view}_chordslot_${notches.length}`,
            view,
            uMin: hostCirc.center.u - hostCirc.radius,
            uMax: hostCirc.center.u + hostCirc.radius,
            vMin: v1,
            vMax: v2,
            openSide: 'uMax',
            lineType: 'thick_solid',
          });
        }
      }
    }
  }

  return notches;
}
