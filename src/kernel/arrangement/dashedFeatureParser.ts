import { CadEntity, CadLineEntity, Point2D, ViewType } from '../../types/cad';
import {
  BoundingBox2D,
  DashedTopologyFeatures,
  OpenDashedSlot,
  ParallelDashedUBand,
  ParallelDashedVBand,
  TaperedDashedBand,
  TaperedDashedVBand,
} from '../../types/kernel';
import { dist2D, pointToSegmentDist } from './curveIntersector';

/**
 * Parses all 5 classes of dashed hidden features in a view:
 * 1. Parallel vertical/horizontal bands (uBands / vBands)
 * 2. Tapered slanted dashed bands (taperedUBands / taperedVBands) for frustum/semi-cone through-holes
 * 3. U-shaped open blind slots (uSlots)
 * 4. Single step/back-wall dashed lines (singleHorizDashed / singleVertDashed)
 * 5. Internal solid divider bands (solidUBands / solidVBands)
 */
export function parseDashedFeaturesInView(
  entities: CadEntity[],
  view: ViewType,
  viewBounds: BoundingBox2D
): DashedTopologyFeatures {
  const viewUserEnts = entities.filter((e) => e.view === view && e.source !== 'derived');
  const lineEnts = viewUserEnts.filter(
    (e) => (e.lineType === 'thin_dashed' || e.lineType === 'thick_solid') && e.type === 'line'
  ) as CadLineEntity[];
  const onlyDashed = lineEnts.filter((e) => e.lineType === 'thin_dashed');
  const onlySolid = lineEnts.filter((e) => e.lineType === 'thick_solid');
  const solidCurves = viewUserEnts.filter(
    (e) => e.lineType === 'thick_solid' && (e.type === 'circle' || e.type === 'arc')
  );

  const allViewCirclesAndArcs = viewUserEnts.filter(
    (e) => e.type === 'circle' || e.type === 'arc'
  );
  const isInnerHoleCircle = (c: CadEntity): boolean => {
    if (c.type !== 'circle') return false;
    return (
      c.center.u - c.radius > viewBounds.uMin + 1.5 &&
      c.center.u + c.radius < viewBounds.uMax - 1.5 &&
      c.center.v - c.radius > viewBounds.vMin + 1.5 &&
      c.center.v + c.radius < viewBounds.vMax - 1.5
    );
  };

  const isTouchingSolidBoundary = (pt: Point2D, tol = 2.5): boolean => {
    for (const s of onlySolid) {
      if (pointToSegmentDist(pt, s.p1, s.p2).dist <= tol) return true;
    }
    for (const c of solidCurves) {
      if (isInnerHoleCircle(c)) continue;
      if (
        (c.type === 'circle' || c.type === 'arc') &&
        Math.abs(dist2D(pt, c.center) - c.radius) <= tol
      ) {
        return true;
      }
    }
    if (
      Math.abs(pt.u - viewBounds.uMin) <= tol ||
      Math.abs(pt.u - viewBounds.uMax) <= tol ||
      Math.abs(pt.v - viewBounds.vMin) <= tol ||
      Math.abs(pt.v - viewBounds.vMax) <= tol
    ) {
      return true;
    }
    return false;
  };

  const rawVertDashed: { u: number; vMin: number; vMax: number; id: string }[] = [];
  const rawHorizDashed: { v: number; uMin: number; uMax: number; id: string }[] = [];
  const slantedDashed: { p1: Point2D; p2: Point2D; id: string }[] = [];
  const rawVertSolid: { u: number; vMin: number; vMax: number }[] = [];
  const rawHorizSolid: { v: number; uMin: number; uMax: number }[] = [];

  for (const ln of onlyDashed) {
    if (Math.abs(ln.p1.u - ln.p2.u) <= 1.5 && Math.abs(ln.p1.v - ln.p2.v) > 1.5) {
      rawVertDashed.push({
        u: 0.5 * (ln.p1.u + ln.p2.u),
        vMin: Math.min(ln.p1.v, ln.p2.v),
        vMax: Math.max(ln.p1.v, ln.p2.v),
        id: ln.id,
      });
    } else if (Math.abs(ln.p1.v - ln.p2.v) <= 1.5 && Math.abs(ln.p1.u - ln.p2.u) > 1.5) {
      rawHorizDashed.push({
        v: 0.5 * (ln.p1.v + ln.p2.v),
        uMin: Math.min(ln.p1.u, ln.p2.u),
        uMax: Math.max(ln.p1.u, ln.p2.u),
        id: ln.id,
      });
    } else if (Math.abs(ln.p1.u - ln.p2.u) > 1.5 && Math.abs(ln.p1.v - ln.p2.v) > 1.5) {
      slantedDashed.push({ p1: ln.p1, p2: ln.p2, id: ln.id });
    }
  }

  for (const ln of onlySolid) {
    if (Math.abs(ln.p1.u - ln.p2.u) <= 1.5 && Math.abs(ln.p1.v - ln.p2.v) > 1.5) {
      const u = 0.5 * (ln.p1.u + ln.p2.u);
      if (u > viewBounds.uMin + 1.5 && u < viewBounds.uMax - 1.5) {
        rawVertSolid.push({
          u,
          vMin: Math.min(ln.p1.v, ln.p2.v),
          vMax: Math.max(ln.p1.v, ln.p2.v),
        });
      }
    } else if (Math.abs(ln.p1.v - ln.p2.v) <= 1.5 && Math.abs(ln.p1.u - ln.p2.u) > 1.5) {
      const v = 0.5 * (ln.p1.v + ln.p2.v);
      if (v > viewBounds.vMin + 1.5 && v < viewBounds.vMax - 1.5) {
        rawHorizSolid.push({
          v,
          uMin: Math.min(ln.p1.u, ln.p2.u),
          uMax: Math.max(ln.p1.u, ln.p2.u),
        });
      }
    }
  }

  const isVertGapBridgedByInnerFeature = (u: number, gapVMin: number, gapVMax: number): boolean => {
    if (gapVMax <= gapVMin + 1.5) return true;
    for (const c of allViewCirclesAndArcs) {
      if (c.type !== 'circle' && c.type !== 'arc') continue;
      const du = Math.abs(u - c.center.u);
      if (du <= c.radius + 2.5) {
        const dv = du < c.radius ? Math.sqrt(c.radius * c.radius - du * du) : 0;
        const cVMin = c.center.v - Math.max(dv, c.radius);
        const cVMax = c.center.v + Math.max(dv, c.radius);
        if (gapVMin >= cVMin - 3.5 && gapVMax <= cVMax + 3.5) return true;
      }
    }
    return false;
  };

  const isHorizGapBridgedByInnerFeature = (v: number, gapUMin: number, gapUMax: number): boolean => {
    if (gapUMax <= gapUMin + 1.5) return true;
    for (const c of allViewCirclesAndArcs) {
      if (c.type !== 'circle' && c.type !== 'arc') continue;
      const dv = Math.abs(v - c.center.v);
      if (dv <= c.radius + 2.5) {
        const du = dv < c.radius ? Math.sqrt(c.radius * c.radius - dv * dv) : 0;
        const cUMin = c.center.u - Math.max(du, c.radius);
        const cUMax = c.center.u + Math.max(du, c.radius);
        if (gapUMin >= cUMin - 3.5 && gapUMax <= cUMax + 3.5) return true;
      }
    }
    return false;
  };

  const vertDashed: typeof rawVertDashed = [];
  for (const seg of [...rawVertDashed].sort((a, b) => a.u - b.u || a.vMin - b.vMin)) {
    const prev = vertDashed[vertDashed.length - 1];
    if (
      prev &&
      Math.abs(prev.u - seg.u) <= 1.2 &&
      (seg.vMin <= prev.vMax + 1 || isVertGapBridgedByInnerFeature(0.5 * (prev.u + seg.u), prev.vMax, seg.vMin))
    ) {
      prev.u = 0.5 * (prev.u + seg.u);
      prev.vMin = Math.min(prev.vMin, seg.vMin);
      prev.vMax = Math.max(prev.vMax, seg.vMax);
    } else {
      vertDashed.push({ ...seg });
    }
  }

  const horizDashed: typeof rawHorizDashed = [];
  for (const seg of [...rawHorizDashed].sort((a, b) => a.v - b.v || a.uMin - b.uMin)) {
    const prev = horizDashed[horizDashed.length - 1];
    if (
      prev &&
      Math.abs(prev.v - seg.v) <= 1.2 &&
      (seg.uMin <= prev.uMax + 1 || isHorizGapBridgedByInnerFeature(0.5 * (prev.v + seg.v), prev.uMax, seg.uMin))
    ) {
      prev.v = 0.5 * (prev.v + seg.v);
      prev.uMin = Math.min(prev.uMin, seg.uMin);
      prev.uMax = Math.max(prev.uMax, seg.uMax);
    } else {
      horizDashed.push({ ...seg });
    }
  }

  const consumedVertIdx = new Set<number>();
  const consumedHorizIdx = new Set<number>();
  const uSlots: OpenDashedSlot[] = [];
  const uBands: ParallelDashedUBand[] = [];
  const vBands: ParallelDashedVBand[] = [];
  const taperedUBands: TaperedDashedBand[] = [];
  const taperedVBands: TaperedDashedVBand[] = [];
  const solidUBands: { u1: number; u2: number; vMin: number; vMax: number }[] = [];
  const solidVBands: { v1: number; v2: number; uMin: number; uMax: number }[] = [];

  for (let i = 0; i < vertDashed.length; i++) {
    for (let j = i + 1; j < vertDashed.length; j++) {
      const a = vertDashed[i];
      const b = vertDashed[j];
      const leftSeg = a.u <= b.u ? a : b;
      const rightSeg = a.u <= b.u ? b : a;
      const u1 = leftSeg.u;
      const u2 = rightSeg.u;
      if (u2 - u1 < 1.5) continue;
      const botAligned = Math.abs(leftSeg.vMin - rightSeg.vMin) <= 3.5;
      const topAligned = Math.abs(leftSeg.vMax - rightSeg.vMax) <= 3.5;
      if (botAligned && topAligned) {
        const vMin = Math.min(leftSeg.vMin, rightSeg.vMin);
        const vMax = Math.max(leftSeg.vMax, rightSeg.vMax);
        const botBridgeIdx = horizDashed.findIndex(
          (h) => Math.abs(h.v - vMin) <= 2.5 && Math.abs(h.uMin - u1) <= 2.5 && Math.abs(h.uMax - u2) <= 2.5
        );
        const topBridgeIdx = horizDashed.findIndex(
          (h) => Math.abs(h.v - vMax) <= 2.5 && Math.abs(h.uMin - u1) <= 2.5 && Math.abs(h.uMax - u2) <= 2.5
        );
        consumedVertIdx.add(i);
        consumedVertIdx.add(j);
        if (topBridgeIdx !== -1 && botBridgeIdx === -1) {
          consumedHorizIdx.add(topBridgeIdx);
          uSlots.push({ uMin: u1, uMax: u2, vMin: vMin - 2, vMax, openSide: 'vMin', lineType: 'thin_dashed' });
        } else if (botBridgeIdx !== -1 && topBridgeIdx === -1) {
          consumedHorizIdx.add(botBridgeIdx);
          uSlots.push({ uMin: u1, uMax: u2, vMin, vMax: vMax + 2, openSide: 'vMax', lineType: 'thin_dashed' });
        } else {
          uBands.push({ u1, u2, vMin, vMax });
        }
      }
    }
  }

  for (let i = 0; i < horizDashed.length; i++) {
    for (let j = i + 1; j < horizDashed.length; j++) {
      const a = horizDashed[i];
      const b = horizDashed[j];
      const botSeg = a.v <= b.v ? a : b;
      const topSeg = a.v <= b.v ? b : a;
      const v1 = botSeg.v;
      const v2 = topSeg.v;
      if (v2 - v1 < 1.5) continue;
      if (Math.abs(botSeg.uMin - topSeg.uMin) <= 3.5 && Math.abs(botSeg.uMax - topSeg.uMax) <= 3.5) {
        const uMin = Math.min(botSeg.uMin, topSeg.uMin);
        const uMax = Math.max(botSeg.uMax, topSeg.uMax);
        consumedHorizIdx.add(i);
        consumedHorizIdx.add(j);
        vBands.push({ v1, v2, uMin, uMax });
      }
    }
  }

  // Extract Tapered Dashed Bands (taperedUBands & taperedVBands)
  const uTaperCandidates = [
    ...slantedDashed
      .filter((s) => Math.abs(s.p2.v - s.p1.v) >= 3.0)
      .map((s) => ({
        pMinV: s.p1.v <= s.p2.v ? s.p1 : s.p2,
        pMaxV: s.p1.v <= s.p2.v ? s.p2 : s.p1,
        id: s.id,
        isSlanted: true,
      })),
    ...vertDashed
      .filter((_, idx) => !consumedVertIdx.has(idx) && vertDashed[idx].vMax - vertDashed[idx].vMin >= 3.0)
      .map((v) => ({
        pMinV: { u: v.u, v: v.vMin },
        pMaxV: { u: v.u, v: v.vMax },
        id: v.id,
        isSlanted: false,
      })),
  ];

  for (let i = 0; i < uTaperCandidates.length; i++) {
    for (let j = i + 1; j < uTaperCandidates.length; j++) {
      const a = uTaperCandidates[i];
      const b = uTaperCandidates[j];
      if (!a.isSlanted && !b.isSlanted) continue;
      if (Math.abs(a.pMinV.v - b.pMinV.v) <= 3.5 && Math.abs(a.pMaxV.v - b.pMaxV.v) <= 3.5) {
        const v1 = 0.5 * (a.pMinV.v + b.pMinV.v);
        const v2 = 0.5 * (a.pMaxV.v + b.pMaxV.v);
        if (v2 - v1 < 3.0) continue;
        if ((a.pMinV.u - b.pMinV.u) * (a.pMaxV.u - b.pMaxV.u) < -1.0) continue;
        const u1Min = Math.min(a.pMinV.u, b.pMinV.u);
        const u1Max = Math.max(a.pMinV.u, b.pMinV.u);
        const u2Min = Math.min(a.pMaxV.u, b.pMaxV.u);
        const u2Max = Math.max(a.pMaxV.u, b.pMaxV.u);
        if (
          Math.abs(u2Max - u2Min - (u1Max - u1Min)) >= 1.5 ||
          Math.abs(0.5 * (u2Min + u2Max) - 0.5 * (u1Min + u1Max)) >= 1.5
        ) {
          taperedUBands.push({
            v1,
            v2,
            u1Min,
            u1Max,
            u2Min,
            u2Max,
            ids: [a.id, b.id].filter(Boolean),
          });
        }
      }
    }
  }

  const vTaperCandidates = [
    ...slantedDashed
      .filter((s) => Math.abs(s.p2.u - s.p1.u) >= 3.0)
      .map((s) => ({
        pMinU: s.p1.u <= s.p2.u ? s.p1 : s.p2,
        pMaxU: s.p1.u <= s.p2.u ? s.p2 : s.p1,
        id: s.id,
        isSlanted: true,
      })),
    ...horizDashed
      .filter((_, idx) => !consumedHorizIdx.has(idx) && horizDashed[idx].uMax - horizDashed[idx].uMin >= 3.0)
      .map((h) => ({
        pMinU: { u: h.uMin, v: h.v },
        pMaxU: { u: h.uMax, v: h.v },
        id: h.id,
        isSlanted: false,
      })),
  ];

  for (let i = 0; i < vTaperCandidates.length; i++) {
    for (let j = i + 1; j < vTaperCandidates.length; j++) {
      const a = vTaperCandidates[i];
      const b = vTaperCandidates[j];
      if (!a.isSlanted && !b.isSlanted) continue;
      if (Math.abs(a.pMinU.u - b.pMinU.u) <= 3.5 && Math.abs(a.pMaxU.u - b.pMaxU.u) <= 3.5) {
        const u1 = 0.5 * (a.pMinU.u + b.pMinU.u);
        const u2 = 0.5 * (a.pMaxU.u + b.pMaxU.u);
        if (u2 - u1 < 3.0) continue;
        if ((a.pMinU.v - b.pMinU.v) * (a.pMaxU.v - b.pMaxU.v) < -1.0) continue;
        const v1Min = Math.min(a.pMinU.v, b.pMinU.v);
        const v1Max = Math.max(a.pMinU.v, b.pMinU.v);
        const v2Min = Math.min(a.pMaxU.v, b.pMaxU.v);
        const v2Max = Math.max(a.pMaxU.v, b.pMaxU.v);
        if (
          Math.abs(v2Max - v2Min - (v1Max - v1Min)) >= 1.5 ||
          Math.abs(0.5 * (v2Min + v2Max) - 0.5 * (v1Min + v1Max)) >= 1.5
        ) {
          taperedVBands.push({
            u1,
            u2,
            v1Min,
            v1Max,
            v2Min,
            v2Max,
            ids: [a.id, b.id].filter(Boolean),
          });
        }
      }
    }
  }

  for (let i = 0; i < rawVertSolid.length; i++) {
    for (let j = i + 1; j < rawVertSolid.length; j++) {
      const a = rawVertSolid[i];
      const b = rawVertSolid[j];
      const u1 = Math.min(a.u, b.u);
      const u2 = Math.max(a.u, b.u);
      if (u2 - u1 >= 2 && Math.abs(a.vMin - b.vMin) <= 3 && Math.abs(a.vMax - b.vMax) <= 3) {
        solidUBands.push({ u1, u2, vMin: Math.min(a.vMin, b.vMin), vMax: Math.max(a.vMax, b.vMax) });
      }
    }
  }

  for (let i = 0; i < rawHorizSolid.length; i++) {
    for (let j = i + 1; j < rawHorizSolid.length; j++) {
      const a = rawHorizSolid[i];
      const b = rawHorizSolid[j];
      const v1 = Math.min(a.v, b.v);
      const v2 = Math.max(a.v, b.v);
      if (v2 - v1 >= 2 && Math.abs(a.uMin - b.uMin) <= 3 && Math.abs(a.uMax - b.uMax) <= 3) {
        solidVBands.push({ v1, v2, uMin: Math.min(a.uMin, b.uMin), uMax: Math.max(a.uMax, b.uMax) });
      }
    }
  }

  return {
    view,
    uSlots,
    uBands,
    vBands,
    taperedUBands,
    taperedVBands,
    singleHorizDashed: horizDashed.map(({ v, uMin, uMax }, idx) => ({
      v,
      uMin,
      uMax,
      isStepPlane:
        !consumedHorizIdx.has(idx) &&
        isTouchingSolidBoundary({ u: uMin, v }, 2.5) &&
        isTouchingSolidBoundary({ u: uMax, v }, 2.5),
    })),
    singleVertDashed: vertDashed.map(({ u, vMin, vMax }, idx) => ({
      u,
      vMin,
      vMax,
      isStepPlane:
        !consumedVertIdx.has(idx) &&
        isTouchingSolidBoundary({ u, v: vMin }, 2.5) &&
        isTouchingSolidBoundary({ u, v: vMax }, 2.5),
    })),
    solidUBands,
    solidVBands,
  };
}
