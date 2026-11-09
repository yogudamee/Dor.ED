import { CadArcEntity, CadEntity, LineType, Point2D, ViewType } from '../../types/cad';
import {
  CompositeRegion2D,
  CurveSegment2D,
  DCELAtomicFace,
  DCELHalfEdge,
  DCELVertex,
  PlanarityDCELResult,
} from '../../types/kernel';
import {
  buildDensePolygonFromSegments,
  ccwSweepAngle,
  dist2D,
  getSegmentsExactBounds,
  pointToSegmentDist,
  polygonArea2D,
  polygonSignedArea2D,
  subdivideAndSnapCurves,
} from './curveIntersector';

function computeOutgoingTangentAngle(seg: CurveSegment2D): number {
  if (
    seg.kind === 'arc' &&
    seg.center &&
    seg.radius !== undefined &&
    seg.startAngle !== undefined &&
    seg.endAngle !== undefined
  ) {
    const isCcw = seg.ccw !== false;
    const sweep = ccwSweepAngle(seg.startAngle, seg.endAngle);
    // Sample slightly inside the arc (delta = min(0.08 rad, sweep * 0.15)) to avoid tangent degeneracy with a horizontal/vertical chord
    const delta = Math.min(0.08, sweep * 0.15);
    const sampleAng = isCcw ? seg.startAngle + delta : seg.startAngle + sweep - delta;
    const samplePt = {
      u: seg.center.u + seg.radius * Math.cos(sampleAng),
      v: seg.center.v + seg.radius * Math.sin(sampleAng),
    };
    return Math.atan2(samplePt.v - seg.p1.v, samplePt.u - seg.p1.u);
  }
  return Math.atan2(seg.p2.v - seg.p1.v, seg.p2.u - seg.p1.u);
}

/**
 * Builds a Doubly-Connected Edge List (DCEL) from subdivided 2D segments
 * and extracts minimal closed atomic faces using the Left-Turn Rule.
 */
export function buildPlanarArrangementDCEL(
  segments: CurveSegment2D[],
  vertexSnapTol = 1.2
): PlanarityDCELResult {
  const vertices: DCELVertex[] = [];
  const halfEdges: DCELHalfEdge[] = [];
  const atomicFaces: DCELAtomicFace[] = [];

  const findOrCreateVertex = (pt: Point2D): number => {
    for (const v of vertices) {
      if (dist2D(v.pt, pt) <= vertexSnapTol) {
        return v.id;
      }
    }
    const id = vertices.length;
    vertices.push({ id, pt: { ...pt }, outgoingHalfEdges: [] });
    return id;
  };

  for (const seg of segments) {
    const uId = findOrCreateVertex(seg.p1);
    const vId = findOrCreateVertex(seg.p2);
    if (uId === vId) continue;
    const pU = vertices[uId].pt;
    const pV = vertices[vId].pt;
    const fwdSeg: CurveSegment2D = {
      ...seg,
      p1: pU,
      p2: pV,
      ccw: seg.kind === 'arc' ? seg.ccw !== false : undefined,
    };
    const revSeg: CurveSegment2D = {
      ...seg,
      id: `${seg.id}_twin`,
      p1: pV,
      p2: pU,
      ccw: seg.kind === 'arc' ? !(seg.ccw !== false) : undefined,
    };
    const hFwdId = halfEdges.length;
    const hRevId = hFwdId + 1;
    const angFwd = computeOutgoingTangentAngle(fwdSeg);
    const angRev = computeOutgoingTangentAngle(revSeg);

    halfEdges.push(
      {
        id: hFwdId,
        origin: uId,
        twin: hRevId,
        next: -1,
        prev: -1,
        face: null,
        segment: fwdSeg,
        startTangentAngle: angFwd,
        endTangentAngle: angRev,
      },
      {
        id: hRevId,
        origin: vId,
        twin: hFwdId,
        next: -1,
        prev: -1,
        face: null,
        segment: revSeg,
        startTangentAngle: angRev,
        endTangentAngle: angFwd,
      }
    );
    vertices[uId].outgoingHalfEdges.push(hFwdId);
    vertices[vId].outgoingHalfEdges.push(hRevId);
  }

  // Iteratively prune degree-1 dangling filaments so they do not pollute face cycles
  const removedHalfEdges = new Set<number>();
  let pruned = true;
  while (pruned) {
    pruned = false;
    for (const v of vertices) {
      const activeOut = v.outgoingHalfEdges.filter((hId) => !removedHalfEdges.has(hId));
      if (activeOut.length === 1) {
        const hId = activeOut[0];
        const twinId = halfEdges[hId].twin;
        removedHalfEdges.add(hId);
        removedHalfEdges.add(twinId);
        pruned = true;
      }
    }
  }

  // Sort outgoing half-edges at each vertex strictly counter-clockwise by startTangentAngle
  for (const v of vertices) {
    v.outgoingHalfEdges = v.outgoingHalfEdges
      .filter((hId) => !removedHalfEdges.has(hId))
      .sort((a, b) => halfEdges[a].startTangentAngle - halfEdges[b].startTangentAngle);
  }

  // Link next/prev pointers using the Left-Turn Rule
  for (const h of halfEdges) {
    if (removedHalfEdges.has(h.id)) continue;
    const twin = halfEdges[h.twin];
    const targetV = vertices[twin.origin];
    const outList = targetV.outgoingHalfEdges;
    if (outList.length === 0) continue;
    const idx = outList.indexOf(h.twin);
    if (idx === -1) continue;
    const nextIdx = (idx - 1 + outList.length) % outList.length;
    const nextHId = outList[nextIdx];
    h.next = nextHId;
    halfEdges[nextHId].prev = h.id;
  }

  // Traverse minimal half-edge cycles
  const visited = new Set<number>();
  for (const h of halfEdges) {
    if (removedHalfEdges.has(h.id) || visited.has(h.id) || h.next === -1) continue;
    const cycle: number[] = [];
    let curr = h.id;
    let safeGuard = 0;
    while (!visited.has(curr) && curr !== -1 && safeGuard < halfEdges.length + 2) {
      visited.add(curr);
      cycle.push(curr);
      curr = halfEdges[curr].next;
      safeGuard++;
    }
    if (curr !== h.id || cycle.length < 2) continue;
    const cycleSegs = cycle.map((id) => halfEdges[id].segment);
    const poly = buildDensePolygonFromSegments(cycleSegs);
    if (poly.length < 3) continue;
    const sArea = polygonSignedArea2D(poly);
    const absArea = Math.abs(sArea);
    if (absArea < 1.5) continue;
    const bounds = getSegmentsExactBounds(cycleSegs);
    if (bounds.uMax - bounds.uMin < 1.0 || bounds.vMax - bounds.vMin < 1.0) continue;

    const faceId = atomicFaces.length;
    for (const id of cycle) halfEdges[id].face = faceId;
    atomicFaces.push({
      id: faceId,
      outerHalfEdges: cycle,
      holeHalfEdgeLoops: [],
      segments: cycleSegs,
      polygon: poly,
      signedArea: sArea,
      area: absArea,
      bounds,
      isUnboundedOuter: sArea < 0,
    });
  }

  return { vertices, halfEdges, atomicFaces };
}

/**
 * Extracts all valid closed loops and composite regions in a view using DCEL
 * plus Shared-Chord Semicircular Face Union (f_1 U f_2).
 */
export function extractCompositeRegionsInView(
  entities: CadEntity[],
  view: ViewType,
  lineType: LineType = 'thick_solid'
): CompositeRegion2D[] {
  const subdivided = subdivideAndSnapCurves(entities, view, lineType);
  const dcel = buildPlanarArrangementDCEL(subdivided);
  const regions: CompositeRegion2D[] = [];

  const addRegionIfUnique = (
    segs: CurveSegment2D[],
    atomicIds: number[],
    isSharedChordUnion: boolean
  ) => {
    const poly = buildDensePolygonFromSegments(segs);
    if (poly.length < 3) return;
    const area = polygonArea2D(poly);
    const bounds = getSegmentsExactBounds(segs);
    if (bounds.uMax - bounds.uMin <= 1.0 || bounds.vMax - bounds.vMin <= 1.0 || area < 1.5) return;

    const isDup = regions.some(
      (r) =>
        Math.abs(r.bounds.uMin - bounds.uMin) <= 1.2 &&
        Math.abs(r.bounds.uMax - bounds.uMax) <= 1.2 &&
        Math.abs(r.bounds.vMin - bounds.vMin) <= 1.2 &&
        Math.abs(r.bounds.vMax - bounds.vMax) <= 1.2 &&
        Math.abs(r.area - area) <= Math.max(4.0, 0.05 * area)
    );
    if (isDup) return;

    regions.push({
      id: `reg_${view}_${lineType}_${regions.length}`,
      view,
      lineType,
      atomicFaceIds: atomicIds,
      boundarySegments: segs,
      polygon: poly,
      area,
      bounds,
      nestingDepth: 0,
      parentRegionId: null,
      childRegionIds: [],
      isSharedChordUnion,
      profileKind: 'general_polygon',
    });
  };

  // 1. Add bounded atomic faces ( EXCLUDING crescent faces formed by two concentric arcs sharing a chord )
  for (const face of dcel.atomicFaces) {
    if (face.isUnboundedOuter) continue;
    const arcSegs = face.segments.filter((s) => s.kind === 'arc');
    // If an atomic face has 2 concentric/co-chord arcs (a crescent ring between two semicircles),
    // skip the raw crescent face because the Shared-Chord Union below reconstructs the full outer semicircle!
    const isCrescentBetweenCoChordArcs =
      arcSegs.length === 2 &&
      arcSegs[0].center &&
      arcSegs[1].center &&
      (Math.abs(arcSegs[0].center.v - arcSegs[1].center.v) <= 2.5 ||
        Math.abs(arcSegs[0].center.u - arcSegs[1].center.u) <= 2.5);
    if (!isCrescentBetweenCoChordArcs) {
      addRegionIfUnique(face.segments, [face.id], false);
    }
  }

  // 2. Shared-Chord Face Union (f_1 U f_2): Reconstruct complete semicircular/curved loops for every arc whose endpoints lie on a colinear baseline chord
  const viewEnts = entities.filter(
    (e) => e.view === view && e.source !== 'derived' && e.lineType === lineType
  );
  const rawArcs = viewEnts.filter((e) => e.type === 'arc') as CadArcEntity[];
  const rawLineSegs = subdivided.filter((s) => s.kind === 'line');

  for (const arc of rawArcs) {
    let pS = {
      u: arc.center.u + arc.radius * Math.cos(arc.startAngle),
      v: arc.center.v + arc.radius * Math.sin(arc.startAngle),
    };
    let pE = {
      u: arc.center.u + arc.radius * Math.cos(arc.endAngle),
      v: arc.center.v + arc.radius * Math.sin(arc.endAngle),
    };
    if (dist2D(pS, pE) < 1.5) continue;

    // Check if there is a straight chord path connecting pS and pE
    const dChord = dist2D(pS, pE);
    const ux = (pE.u - pS.u) / dChord;
    const uy = (pE.v - pS.v) / dChord;
    const colinearSubLines = rawLineSegs.filter((ln) => {
      const d1 = pointToSegmentDist(ln.p1, pS, pE).dist;
      const d2 = pointToSegmentDist(ln.p2, pS, pE).dist;
      const lenL = dist2D(ln.p1, ln.p2);
      if (lenL < 0.3) return false;
      const cross = Math.abs((ln.p2.u - ln.p1.u) * uy - (ln.p2.v - ln.p1.v) * ux) / lenL;
      return d1 <= 2.5 && d2 <= 2.5 && cross <= 0.08;
    });

    if (colinearSubLines.length > 0) {
      if (Math.abs(pS.v - pE.v) <= 3.0 && Math.abs(0.5 * (pS.v + pE.v) - arc.center.v) <= 3.5) {
        pS = { u: pS.u, v: arc.center.v };
        pE = { u: pE.u, v: arc.center.v };
      } else if (
        Math.abs(pS.u - pE.u) <= 3.0 &&
        Math.abs(0.5 * (pS.u + pE.u) - arc.center.u) <= 3.5
      ) {
        pS = { u: arc.center.u, v: pS.v };
        pE = { u: arc.center.u, v: pE.v };
      }
      const unionSegs: CurveSegment2D[] = [
        {
          id: `${arc.id}_union_arc`,
          kind: 'arc',
          p1: pS,
          p2: pE,
          center: { ...arc.center },
          radius: arc.radius,
          startAngle: arc.startAngle,
          endAngle: arc.endAngle,
          ccw: true,
          lineType,
          sourceEntityId: arc.id,
        },
        {
          id: `${arc.id}_union_chord`,
          kind: 'line',
          p1: pE,
          p2: pS,
          lineType,
          sourceEntityId: colinearSubLines[0].sourceEntityId,
        },
      ];
      addRegionIfUnique(unionSegs, [], true);
    }
  }

  return regions;
}
